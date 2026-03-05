"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function parseHeartbeat(text) {
  const source = String(text || "");
  const lines = source.split("\n");
  const initiatives = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      initiatives.push(trimmed.slice(2));
    }
  }
  return initiatives;
}

function renderHeartbeat(phase, mission, guardrails, initiatives) {
  const initiativeLines = initiatives.map((item) => `- ${item}`);
  return [
    "# HEARTBEAT",
    "",
    "## Phase",
    `- Current phase: ${phase}`,
    "",
    "## Mission",
    `- ${mission}`,
    "",
    "## Guardrails",
    ...guardrails.map((entry) => `- ${entry}`),
    "",
    "## Active Initiatives",
    ...(initiativeLines.length > 0 ? initiativeLines : ["- none"]),
    ""
  ].join("\n");
}

function createHeartbeatState(options = {}) {
  const heartbeatPath = path.resolve(safeString(options.heartbeatPath) || path.join(process.cwd(), "workspace", "HEARTBEAT.md"));

  function loadHeartbeat() {
    const text = fs.existsSync(heartbeatPath) ? fs.readFileSync(heartbeatPath, "utf8") : "";
    const initiatives = parseHeartbeat(text);
    return canonicalize({ path: heartbeatPath, content: text, initiatives });
  }

  function updateHeartbeat(update = {}) {
    const current = loadHeartbeat();
    const currentText = current.content || "";

    const phaseMatch = currentText.match(/Current phase:\s*(.+)/i);
    const missionMatch = currentText.match(/## Mission\n-\s*(.+)/i);

    const phase = safeString(update.phase) || safeString(phaseMatch && phaseMatch[1]) || "unknown";
    const mission = safeString(update.mission) || safeString(missionMatch && missionMatch[1]) || "Maintain deterministic local-first orchestration";
    const guardrails = Array.isArray(update.guardrails) && update.guardrails.length > 0
      ? update.guardrails.map((entry) => safeString(entry)).filter(Boolean)
      : [
          "No offensive cybersecurity execution paths.",
          "Supervisor does not call external tools directly.",
          "File-based inter-agent communication only."
        ];

    const initiatives = Array.isArray(update.initiatives)
      ? update.initiatives.map((entry) => safeString(entry)).filter(Boolean)
      : current.initiatives;

    const body = renderHeartbeat(phase, mission, guardrails, initiatives);
    fs.writeFileSync(heartbeatPath, body, "utf8");

    return canonicalize({ ok: true, path: heartbeatPath, initiatives });
  }

  function listActiveInitiatives() {
    return loadHeartbeat().initiatives;
  }

  return Object.freeze({
    loadHeartbeat,
    updateHeartbeat,
    listActiveInitiatives
  });
}

module.exports = {
  createHeartbeatState
};
