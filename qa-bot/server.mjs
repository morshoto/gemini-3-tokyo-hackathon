import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const PORT = 3000;
const MODEL = "gemini-2.5-flash";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[qa-bot] GEMINI_API_KEY is not set. Requests will fail.");
}

const genAI = new GoogleGenAI({ apiKey });

const history = [];

function summarizeHistory(maxItems = 10) {
  const tail = history.slice(-maxItems);
  return tail
    .map((h, i) => {
      const ts = new Date(h.time).toISOString();
      const obs = h.observationJson ? h.observationJson.slice(0, 200) : "";
      const cmd = h.command || "(none)";
      return `#${history.length - tail.length + i + 1} ${ts} cmd=${cmd} obs=${obs}`;
    })
    .join("\n");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toShortObs(text, maxLen = 120) {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen)}...`;
}

async function generateStepCommand(observationJson) {
  const historySummary = summarizeHistory(10);
  const prompt = `You are a QA test bot in a Unity maze level.\n\n` +
    `You can issue commands: move_fwd:X, move_back:X, turn_left:deg, turn_right:deg, jump.\n` +
    `Goal: explore the map, try to reach the object named \"GoalPoint\", and detect bugs such as: getting stuck, falling off the level, weird rotations/camera, NavMesh issues or blocked paths.\n` +
    `Use short, safe movements. Avoid repeating the same command if no position change.\n\n` +
    `Recent history (summarized):\n${historySummary || "(none)"}\n\n` +
    `Latest observationJson:\n${observationJson}\n\n` +
    `Return JSON with fields: command, note.`;

  const response = await genAI.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
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

async function generateReport() {
  const historySummary = summarizeHistory(50);
  const prompt = `You are a QA tester. Based on this history of observations and actions, produce a Markdown bug report.\n` +
    `The report must include sections: ## Summary, ## Environment, ## Steps Performed, ## Issues Found, ## Suggestions.\n` +
    `Be concise and specific. If no issues are found, say so in ## Issues Found.\n\n` +
    `History summary:\n${historySummary || "(none)"}`;

  const response = await genAI.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          reportMarkdown: { type: "string" }
        },
        required: ["reportMarkdown"]
      }
    }
  });

  const text = response.text;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed.reportMarkdown !== "string") {
    return { reportMarkdown: "## Summary\n- Failed to generate report (invalid model response)." };
  }
  return parsed;
}

app.post("/step", async (req, res) => {
  const observationJson = req.body?.observationJson || "";
  const runId = req.body?.runId || "";

  const time = new Date().toISOString();
  const shortObs = toShortObs(observationJson);
  console.log("[QA-BOT] /step", { time, shortObs });
  history.push({ time: Date.now(), observationJson });

  try {
    const result = await generateStepCommand(observationJson);
    history[history.length - 1].command = result.command;
    res.json({ command: result.command, note: result.note });
  } catch (err) {
    console.warn("[qa-bot] /step error:", err?.message || err);
    res.status(500).json({ command: "move_fwd:0.5", note: "server error; using fallback" });
  }
});

app.post("/report", async (req, res) => {
  const runId = req.body?.runId || "";
  console.log("[QA-BOT] /report", { historyLength: history.length });

  try {
    const result = await generateReport();
    res.json({ reportMarkdown: result.reportMarkdown });
  } catch (err) {
    console.warn("[qa-bot] /report error:", err?.message || err);
    res.status(500).json({ reportMarkdown: "## Summary\n- Server error while generating report." });
  }
});

app.listen(PORT, () => {
  console.log(`[qa-bot] listening on http://localhost:${PORT}`);
});
