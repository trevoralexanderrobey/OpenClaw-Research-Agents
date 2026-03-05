"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString } = require("../workflows/governance-automation/common.js");
const { createInteractionLog } = require("../openclaw-bridge/core/interaction-log.js");
const { createLLMAdapter } = require("../openclaw-bridge/core/llm-adapter.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 14 startup integrity failure"));
  error.code = String(code || "PHASE14_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function requiredFiles(rootDir) {
  return [
    "openclaw-bridge/core/agent-engine.js",
    "openclaw-bridge/core/governance-bridge.js",
    "openclaw-bridge/core/supervisor-authority.js",
    "openclaw-bridge/core/llm-adapter.js",
    "openclaw-bridge/core/interaction-log.js",
    "openclaw-bridge/core/task-definition-schema.js",
    "openclaw-bridge/core/research-output-manager.js",
    "scripts/run-research-task.js",
    "scripts/verify-phase14-policy.sh",
    "config/agent-config.json",
    "config/llm-providers.json"
  ].map((rel) => ({ rel, abs: path.join(rootDir, rel) }));
}

async function verifyPhase14StartupIntegrity(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();
  const failures = [];

  for (const file of requiredFiles(rootDir)) {
    if (!fs.existsSync(file.abs)) {
      failures.push({ check: "required_file", file: file.rel, reason: "missing" });
    }
  }

  const workspaceDirs = [
    path.join(rootDir, "workspace", "research-input"),
    path.join(rootDir, "workspace", "research-output")
  ];

  for (const dirPath of workspaceDirs) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const probePath = path.join(dirPath, ".phase14-startup-probe");
      fs.writeFileSync(probePath, "probe\n", "utf8");
      fs.unlinkSync(probePath);
    } catch (error) {
      failures.push({ check: "workspace_dir", file: path.relative(rootDir, dirPath), reason: error && error.message ? error.message : String(error) });
    }
  }

  try {
    const interactionLog = createInteractionLog({
      logger,
      timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" },
      storePath: path.join(rootDir, "security", "interaction-log.json")
    });

    const adapter = createLLMAdapter({
      provider: safeString(options.provider) || "mock",
      config: {},
      logger,
      interactionLog,
      timeProvider: { nowMs: () => 0 }
    });

    if (!adapter || typeof adapter.complete !== "function") {
      failures.push({ check: "llm_adapter", reason: "adapter_missing_contract" });
    }
  } catch (error) {
    failures.push({ check: "llm_adapter", reason: error && error.message ? error.message : String(error) });
  }

  const result = {
    healthy: failures.length === 0,
    failures
  };

  if (!result.healthy) {
    logger.error({ event: "phase14_startup_integrity_failed", failures });
    return result;
  }

  logger.info({ event: "phase14_startup_integrity_verified", checks: "all", healthy: true });
  return result;
}

module.exports = {
  verifyPhase14StartupIntegrity,
  makeError
};
