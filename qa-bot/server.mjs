import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import YAML from "yaml";

const PORT = 3000;
const MODEL = "gemini-2.5-flash";
const DEFAULT_TEST = "find_one_chest";
const POS_EPS = 0.01;
const YAW_EPS = 0.5;
const FALL_Y = -1;

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
  startedAt: null
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
  const foundChests = Number.isFinite(obs.foundChests) ? obs.foundChests : 0;
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

function evaluateDone(positionY) {
  if (!session.activeTest) return;

  const objectives = session.activeTest.objectives || [];
  let objectivesMet = true;

  for (const obj of objectives) {
    if (obj.type === "chest_count_at_least") {
      const min = Number(obj.minimum || 0);
      if (session.chestsFound < min) {
        objectivesMet = false;
      }
    }
  }

  if (objectivesMet && objectives.length > 0) {
    session.done = true;
    session.doneReason = "success";
    return;
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

function buildReportMarkdown() {
  const spec = session.activeTest;
  const objectives = spec?.objectives || [];
  const constraints = spec?.constraints || {};
  const commandCounts = countCommands();

  const objectivesLines = objectives.map((obj) => {
    if (obj.type === "chest_count_at_least") {
      const min = Number(obj.minimum || 0);
      const ok = session.chestsFound >= min;
      return `- [${ok ? "x" : " "}] Found at least ${min} chest(s) (found ${session.chestsFound}/${session.totalChests})`;
    }
    return `- [ ] ${obj.id || obj.type}`;
  });

  const maxIdle = Number.isFinite(constraints.maxIdleSteps) ? constraints.maxIdleSteps : "n/a";
  const avoidFalling = constraints.avoidFalling ? "OK" : "n/a";
  const status = session.doneReason === "success" ? "PASS" : "FAIL";

  const commandSummary = Object.keys(commandCounts)
    .sort()
    .map((k) => `- ${k}: ${commandCounts[k]}`)
    .join("\n");

  return `# QA Report\n\n` +
    `## Summary\n` +
    `- Test: ${spec?.name || "(none)"}\n` +
    `- Status: ${status}\n` +
    `- DoneReason: ${session.doneReason || "(none)"}\n\n` +
    `## Description\n${spec?.description || ""}\n\n` +
    `## Objectives\n${objectivesLines.join("\n") || "- (none)"}\n\n` +
    `## Constraints\n` +
    `- [${session.stepsTaken <= spec.maxSteps ? "x" : " "}] maxSteps: ${session.stepsTaken} / ${spec.maxSteps}\n` +
    `- [${Number.isFinite(maxIdle) ? (session.idleSteps <= maxIdle ? "x" : " ") : " "}] maxIdleSteps: ${session.idleSteps} / ${maxIdle}\n` +
    `- [${constraints.avoidFalling ? (session.doneReason === "fellOutOfLevel" ? " " : "x") : " "}] avoidFalling: ${avoidFalling}\n\n` +
    `## Movement Summary\n` +
    `- Steps taken: ${session.stepsTaken}\n` +
    (commandSummary ? `${commandSummary}\n\n` : "\n") +
    `## Issues Found\n` +
    `- ${status === "PASS" ? "No blocking issues detected." : `Scenario ended with: ${session.doneReason}`}\n\n` +
    `## Suggestions\n` +
    `- Add more chest placements to improve coverage.\n`;
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
  const reportMarkdown = buildReportMarkdown();

  res.json({
    reportMarkdown,
    testName: session.activeTest?.name || null,
    doneReason: session.doneReason,
    stepsTaken: session.stepsTaken,
    chestsFound: session.chestsFound,
    totalChests: session.totalChests
  });
});

app.listen(PORT, () => {
  console.log(`[qa-bot] listening on http://localhost:${PORT}`);
});
