import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import YAML from "yaml";

const PORT = 3000;
const MODEL = "gemini-2.5-flash";
const REPORT_NARRATIVE_ENABLED = process.env.REPORT_USE_GEMINI !== "0";
const REPORT_NARRATIVE_MAX_CHARS = 800;
const DEFAULT_TEST = "find_one_chest";
const POS_EPS = 0.01;
const YAW_EPS = 0.5;
const FALL_Y = -1;
const OBJECTIVE_TIME_LIMIT_SEC = 5;
const MAX_OBJECTIVE_ATTEMPTS = 5;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[qa-bot] GEMINI_API_KEY is not set. Requests will fail.");
}

const genAI = new GoogleGenAI({ apiKey });

const session = {
  activeTest: null,
  stepsTaken: 0,
  idleSteps: 0,
  lastPosition: null,
  lastYaw: null,
  chestsFound: 0,
  totalChests: 0,
  history: [],
  done: false,
  doneReason: null,
  startedAt: null,
  objectiveIndex: 0,
  objectiveAttempts: 0,
  objectiveStartedAtMs: null,
  objectiveResults: []
};

function resetSession(testSpec) {
  session.activeTest = testSpec;
  session.stepsTaken = 0;
  session.idleSteps = 0;
  session.lastPosition = null;
  session.lastYaw = null;
  session.chestsFound = 0;
  session.totalChests = 0;
  session.history = [];
  session.done = false;
  session.doneReason = null;
  session.startedAt = new Date().toISOString();
  session.objectiveIndex = 0;
  session.objectiveAttempts = 0;
  session.objectiveStartedAtMs = Date.now();
  session.objectiveResults = [];
}

function loadTestSpec(name) {
  const testsDir = path.join(process.cwd(), "tests");
  const filePath = path.join(testsDir, `${name}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Test spec not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = YAML.parse(raw);

  return {
    name: data.name || name,
    description: data.description || "",
    maxSteps: Number.isFinite(data.maxSteps) ? data.maxSteps : 100,
    objectives: Array.isArray(data.objectives) ? data.objectives : [],
    constraints: data.constraints || {},
    prompt: data.prompt || { system: "", userTemplate: "" }
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return `{${key}}`;
  });
}

function ensureActiveTest() {
  if (session.activeTest) return;
  const spec = loadTestSpec(DEFAULT_TEST);
  resetSession(spec);
  console.log("[QA-BOT] auto-loaded test", spec.name);
}

function parseObservation(reqBody) {
  if (reqBody && typeof reqBody === "object") {
    if (typeof reqBody.observationJson === "string") return reqBody.observationJson;
    if (typeof reqBody.observation === "string") return reqBody.observation;
  }
  if (typeof reqBody === "string") return reqBody;
  return "";
}

function extractObservationFields(observationJson) {
  const obs = safeJsonParse(observationJson) || {};
  const position = obs.position || { x: 0, y: 0, z: 0 };
  const yaw = Number.isFinite(obs.yaw) ? obs.yaw : 0;
  const foundChests = Number.isFinite(obs.chestsFound)
    ? obs.chestsFound
    : (Number.isFinite(obs.foundChests) ? obs.foundChests : 0);
  const totalChests = Number.isFinite(obs.totalChests) ? obs.totalChests : 0;
  return { position, yaw, foundChests, totalChests };
}

function isIdle(pos, yaw) {
  if (!session.lastPosition || session.lastYaw === null) return false;
  const dx = Math.abs(pos.x - session.lastPosition.x);
  const dy = Math.abs(pos.y - session.lastPosition.y);
  const dz = Math.abs(pos.z - session.lastPosition.z);
  const dyaw = Math.abs(yaw - session.lastYaw);
  return dx < POS_EPS && dy < POS_EPS && dz < POS_EPS && dyaw < YAW_EPS;
}

function updateIdle(pos, yaw) {
  if (isIdle(pos, yaw)) {
    session.idleSteps += 1;
  } else {
    session.idleSteps = 0;
  }
  session.lastPosition = pos;
  session.lastYaw = yaw;
}

function getCurrentObjective() {
  const objectives = session.activeTest?.objectives || [];
  if (session.objectiveIndex >= objectives.length) return null;
  return objectives[session.objectiveIndex];
}

function isObjectiveMet(obj) {
  if (!obj || !obj.type) return false;
  if (obj.type === "chest_count_at_least") {
    const min = Number.isFinite(obj.minimum) ? obj.minimum : 1;
    return session.chestsFound >= min;
  }
  return false;
}

function recordObjectiveResult(obj, status, elapsedSec) {
  session.objectiveResults.push({
    id: obj?.id || `objective_${session.objectiveIndex + 1}`,
    type: obj?.type || "unknown",
    status,
    elapsedSec: Number.isFinite(elapsedSec) ? Number(elapsedSec.toFixed(2)) : null
  });
}

function evaluateDone(positionY) {
  if (!session.activeTest) return;

  const objectives = session.activeTest.objectives || [];
  if (objectives.length > 0) {
    if (!session.objectiveStartedAtMs) {
      session.objectiveStartedAtMs = Date.now();
    }

    const current = getCurrentObjective();
    if (current) {
      const elapsedSec = (Date.now() - session.objectiveStartedAtMs) / 1000;
      const met = isObjectiveMet(current);

      if (met) {
        recordObjectiveResult(current, "success", elapsedSec);
        session.objectiveAttempts += 1;
        session.objectiveIndex += 1;
        session.objectiveStartedAtMs = Date.now();
      } else if (elapsedSec >= OBJECTIVE_TIME_LIMIT_SEC) {
        recordObjectiveResult(current, "timeout", elapsedSec);
        session.objectiveAttempts += 1;
        session.objectiveIndex += 1;
        session.objectiveStartedAtMs = Date.now();
      }
    }

    if (session.objectiveAttempts >= MAX_OBJECTIVE_ATTEMPTS) {
      session.done = true;
      session.doneReason = "attemptsComplete";
      return;
    }

    if (session.objectiveIndex >= objectives.length) {
      session.objectiveIndex = 0;
      session.objectiveStartedAtMs = Date.now();
    }
  }

  const constraints = session.activeTest.constraints || {};
  if (session.stepsTaken >= session.activeTest.maxSteps) {
    session.done = true;
    session.doneReason = "maxSteps";
    return;
  }

  if (Number.isFinite(constraints.maxIdleSteps) && session.idleSteps > constraints.maxIdleSteps) {
    session.done = true;
    session.doneReason = "idleTooLong";
    return;
  }

  if (constraints.avoidFalling && positionY < FALL_Y) {
    session.done = true;
    session.doneReason = "fellOutOfLevel";
  }
}

async function generateStepCommand(observationJson) {
  const spec = session.activeTest;
  const vars = {
    observationJson,
    testName: spec.name,
    description: spec.description,
    objectivesJson: JSON.stringify(spec.objectives || []),
    stepsTaken: session.stepsTaken,
    chestsFound: session.chestsFound,
    totalChests: session.totalChests,
    idleSteps: session.idleSteps
  };

  const system = spec.prompt?.system || "";
  const userTemplate = spec.prompt?.userTemplate || "";
  const user = fillTemplate(userTemplate, vars);
  const combined = `${system}\n\n${user}`;

  const response = await genAI.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: combined }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          note: { type: "string" }
        },
        required: ["command", "note"]
      }
    }
  });

  const text = response.text;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed.command !== "string") {
    return { command: "move_fwd:0.5", note: "fallback: invalid model response" };
  }
  return parsed;
}

function countCommands() {
  const counts = {};
  for (const entry of session.history) {
    const cmd = entry.commandIssued || "";
    const key = cmd.split(":")[0] || "";
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatCheckbox(ok) {
  return ok ? "x" : " ";
}

async function generateReportNarrative(context) {
  if (!REPORT_NARRATIVE_ENABLED) return "";
  if (!apiKey) return "Gemini narrative unavailable: GEMINI_API_KEY is not set.";

  const prompt = [
    "You are generating a concise QA report narrative.",
    "Write 4-7 bullet points max. Be factual, no speculation.",
    "If data is missing, say 'n/a' for that detail.",
    "Focus on outcomes, constraints, and behavior.",
    "",
    "Context (JSON):",
    JSON.stringify(context)
  ].join("\n");

  try {
    const response = await genAI.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const text = (response?.text || "").trim();
    if (!text) return "Gemini narrative unavailable: empty response.";
    return text.slice(0, REPORT_NARRATIVE_MAX_CHARS);
  } catch (err) {
    console.warn("[qa-bot] narrative generation failed:", err?.message || err);
    return "Gemini narrative unavailable: request failed.";
  }
}

async function buildReportMarkdown() {
  const spec = session.activeTest;
  const objectives = spec?.objectives || [];
  const constraints = spec?.constraints || {};
  const commandCounts = countCommands();
  const reportTime = new Date().toISOString();
  const startedAt = session.startedAt;
  const durationMs = startedAt ? (Date.now() - new Date(startedAt).getTime()) : null;
  const duration = formatDurationMs(durationMs);
  const historyCount = session.history.length;

  const objectivesLines = objectives.map((obj) => {
    if (obj.type === "chest_count_at_least") {
      const min = Number(obj.minimum || 0);
      const ok = session.chestsFound >= min;
      return `- [${formatCheckbox(ok)}] Found at least ${min} chest(s) (found ${session.chestsFound}/${session.totalChests})`;
    }
    return `- [ ] ${obj.id || obj.type}`;
  });
  const objectiveAttemptLines = (session.objectiveResults || []).map((result, idx) => {
    const elapsed = result.elapsedSec !== null ? `${result.elapsedSec}s` : "n/a";
    return `- ${idx + 1}. ${result.id} (${result.type}) => ${result.status} in ${elapsed}`;
  });

  const maxIdle = Number.isFinite(constraints.maxIdleSteps) ? constraints.maxIdleSteps : "n/a";
  const avoidFalling = constraints.avoidFalling ? "OK" : "n/a";
  const status = (session.doneReason === "success" || session.doneReason === "attemptsComplete")
    ? "PASS"
    : "FAIL";

  const commandSummary = Object.keys(commandCounts)
    .sort()
    .map((k) => `| ${k} | ${commandCounts[k]} |`)
    .join("\n");

  const objectivesTableRows = objectives.map((obj, idx) => {
    if (obj.type === "chest_count_at_least") {
      const min = Number.isFinite(obj.minimum) ? obj.minimum : 1;
      const ok = session.chestsFound >= min;
      const target = `>= ${min}`;
      const result = `${session.chestsFound}/${session.totalChests}`;
      const elapsed = (session.objectiveResults || [])
        .find((r) => r.id === (obj.id || `objective_${idx + 1}`))?.elapsedSec;
      const elapsedText = Number.isFinite(elapsed) ? `${elapsed}s` : "n/a";
      return `| ${obj.id || `objective_${idx + 1}`} | ${target} | ${result} | ${elapsedText} | ${ok ? "PASS" : "FAIL"} |`;
    }
    return `| ${obj.id || `objective_${idx + 1}`} | (custom) | n/a | n/a | n/a |`;
  });

  const stepsPerChest = session.totalChests > 0
    ? (session.stepsTaken / Math.max(session.chestsFound, 1)).toFixed(2)
    : "n/a";

  const stepsPct = spec?.maxSteps ? ((session.stepsTaken / spec.maxSteps) * 100).toFixed(1) : "n/a";
  const idlePct = Number.isFinite(maxIdle)
    ? ((session.idleSteps / Math.max(maxIdle, 1)) * 100).toFixed(1)
    : "n/a";
  const chestPct = session.totalChests > 0
    ? ((session.chestsFound / session.totalChests) * 100).toFixed(1)
    : "n/a";

  const lastHistory = historyCount > 0 ? session.history[historyCount - 1] : null;
  const lastObs = lastHistory?.observationJson ? safeJsonParse(lastHistory.observationJson) : null;
  const lastPos = lastObs?.position
    ? `(${lastObs.position.x}, ${lastObs.position.y}, ${lastObs.position.z})`
    : "n/a";
  const lastYaw = Number.isFinite(lastObs?.yaw) ? lastObs.yaw : "n/a";

  const recentHistory = session.history
    .filter((h) => h.commandIssued)
    .slice(-10);
  const recentStartIndex = Math.max(1, historyCount - recentHistory.length + 1);
  const recentCommands = recentHistory.map((h, idx) => {
    const time = h.time || "n/a";
    return `- ${recentStartIndex + idx}. ${time} => ${h.commandIssued}`;
  });

  const narrativeContext = {
    testName: spec?.name || null,
    description: spec?.description || null,
    status,
    doneReason: session.doneReason,
    stepsTaken: session.stepsTaken,
    maxSteps: spec?.maxSteps ?? null,
    idleSteps: session.idleSteps,
    maxIdleSteps: Number.isFinite(maxIdle) ? maxIdle : null,
    chestsFound: session.chestsFound,
    totalChests: session.totalChests,
    startedAt,
    reportedAt: reportTime,
    duration,
    lastPosition: lastPos,
    lastYaw
  };
  const narrativeText = await generateReportNarrative(narrativeContext);

  let issueLine = "No blocking issues detected.";
  if (status !== "PASS") {
    const reason = session.doneReason || "unknown";
    const reasonMap = {
      maxSteps: "Reached max steps before completing objectives.",
      idleTooLong: "Bot became idle for too long.",
      fellOutOfLevel: "Bot fell out of the level.",
      attemptsComplete: "Objective attempts exhausted before success."
    };
    issueLine = reasonMap[reason] ? `${reasonMap[reason]} (reason: ${reason})` : `Scenario ended with: ${reason}`;
  }

  const recommendations = [];
  if (status === "PASS") {
    recommendations.push("Consider adding more chest placements to expand coverage.");
  } else {
    switch (session.doneReason) {
      case "maxSteps":
        recommendations.push("Increase step budget or improve navigation efficiency.");
        break;
      case "idleTooLong":
        recommendations.push("Add stuck recovery or diversify movement choices.");
        break;
      case "fellOutOfLevel":
        recommendations.push("Add guard rails or improve fall detection avoidance.");
        break;
      case "attemptsComplete":
        recommendations.push("Adjust objective time limits or attempt caps.");
        break;
      default:
        recommendations.push("Review completed with conditinos.");
        break;
    }
  }

  return `# QA Report\n\n` +
    `Status: ${status}\n\n` +
    (narrativeText ? `## Narrative (Gemini)\n${narrativeText}\n\n` : "") +
    `## Run Metadata\n` +
    `- Test: ${spec?.name || "(none)"}\n` +
    `- Description: ${spec?.description || ""}\n` +
    `- Started: ${startedAt || "n/a"}\n` +
    `- Reported: ${reportTime}\n` +
    `- Duration: ${duration}\n` +
    `- History entries: ${historyCount}\n\n` +
    `## Objectives\n` +
    (objectivesTableRows.length > 0
      ? `| Objective | Target | Result | Elapsed | Status |\n| --- | --- | --- | --- | --- |\n${objectivesTableRows.join("\n")}\n\n`
      : `- (none)\n\n`) +
    `## Objective Attempts\n` +
    `- Attempts: ${session.objectiveAttempts} / ${MAX_OBJECTIVE_ATTEMPTS}\n` +
    (objectiveAttemptLines.length > 0 ? `${objectiveAttemptLines.join("\n")}\n\n` : `- (none)\n\n`) +
    `## Constraints\n` +
    `| Constraint | Limit | Actual | Status |\n` +
    `| --- | --- | --- | --- |\n` +
    `| maxSteps | ${spec?.maxSteps ?? "n/a"} | ${session.stepsTaken} | ${session.stepsTaken <= spec.maxSteps ? "PASS" : "FAIL"} |\n` +
    `| maxIdleSteps | ${Number.isFinite(maxIdle) ? maxIdle : "n/a"} | ${session.idleSteps} | ${Number.isFinite(maxIdle) ? (session.idleSteps <= maxIdle ? "PASS" : "FAIL") : "n/a"} |\n` +
    `| avoidFalling | ${constraints.avoidFalling ? "enabled" : "disabled"} | ${avoidFalling} | ${constraints.avoidFalling ? (session.doneReason === "fellOutOfLevel" ? "FAIL" : "PASS") : "n/a"} |\n\n` +
    `## Progress\n` +
    `- Steps used: ${session.stepsTaken} / ${spec?.maxSteps ?? "n/a"} (${stepsPct}%)\n` +
    `- Idle steps: ${session.idleSteps} / ${Number.isFinite(maxIdle) ? maxIdle : "n/a"} (${idlePct}%)\n` +
    `- Chest progress: ${session.chestsFound} / ${session.totalChests} (${chestPct}%)\n\n` +
    `## Key Metrics\n` +
    `- Steps taken: ${session.stepsTaken}\n` +
    `- Idle steps: ${session.idleSteps}\n` +
    `- Chests found: ${session.chestsFound} / ${session.totalChests}\n` +
    `- Steps per chest: ${stepsPerChest}\n\n` +
    `## Last Observation\n` +
    `- Position: ${lastPos}\n` +
    `- Yaw: ${lastYaw}\n\n` +
    `## Command Summary\n` +
    (commandSummary
      ? `| Command | Count |\n| --- | --- |\n${commandSummary}\n\n`
      : `- (none)\n\n`) +
    `## Recent Commands (last 10)\n` +
    (recentCommands.length > 0 ? `${recentCommands.join("\n")}\n\n` : `- (none)\n\n`) +
    `## Issues\n` +
    `- ${issueLine}\n\n` +
    `## Recommendations\n` +
    recommendations.map((r) => `- ${r}`).join("\n") +
    `\n`;
}

app.post("/start", (req, res) => {
  const testName = req.body?.testName || DEFAULT_TEST;
  try {
    const spec = loadTestSpec(testName);
    resetSession(spec);
    console.log("[QA-BOT] /start", { testName: spec.name });
    res.json({ ok: true, activeTest: spec.name });
  } catch (err) {
    console.warn("[qa-bot] /start error:", err?.message || err);
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/step", async (req, res) => {
  const observationJson = parseObservation(req.body);
  const time = new Date().toISOString();

  ensureActiveTest();

  const { position, yaw, foundChests, totalChests } = extractObservationFields(observationJson);
  session.stepsTaken += 1;
  updateIdle(position, yaw);
  session.chestsFound = foundChests;
  session.totalChests = totalChests;

  session.history.push({ time, observationJson, commandIssued: null });

  evaluateDone(position.y);
  if (session.done) {
    console.log("[QA-BOT] /step done", { reason: session.doneReason, steps: session.stepsTaken });
    return res.json({ command: "", note: session.doneReason || "done" });
  }

  try {
    const result = await generateStepCommand(observationJson);
    session.history[session.history.length - 1].commandIssued = result.command;
    res.json({ command: result.command, note: result.note });
  } catch (err) {
    console.warn("[qa-bot] /step error:", err?.message || err);
    res.status(500).json({ command: "move_fwd:0.5", note: "server error; using fallback" });
  }
});

app.post("/report", async (req, res) => {
  ensureActiveTest();
  const reportMarkdown = await buildReportMarkdown();

  res.json({
    reportMarkdown,
    testName: session.activeTest?.name || null,
    doneReason: session.doneReason,
    stepsTaken: session.stepsTaken,
    chestsFound: session.chestsFound,
    totalChests: session.totalChests
  });
});

app.get("/report", async (req, res) => {
  ensureActiveTest();
  const reportMarkdown = await buildReportMarkdown();
  res.set("Content-Type", "text/markdown; charset=utf-8");
  res.send(reportMarkdown);
});

app.listen(PORT, () => {
  console.log(`[qa-bot] listening on http://localhost:${PORT}`);
});
