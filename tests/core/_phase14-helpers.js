"use strict";

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createInteractionLog } = require("../../openclaw-bridge/core/interaction-log.js");
const { createLLMAdapter } = require("../../openclaw-bridge/core/llm-adapter.js");
const { createResearchOutputManager } = require("../../openclaw-bridge/core/research-output-manager.js");
const { createGovernanceBridge } = require("../../openclaw-bridge/core/governance-bridge.js");
const { createAgentEngine } = require("../../openclaw-bridge/core/agent-engine.js");
const { createSupervisorAuthority } = require("../../openclaw-bridge/core/supervisor-authority.js");

function createMutableTimeProvider(startIso = "2026-03-05T00:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    nowIso() {
      return new Date(currentMs).toISOString();
    },
    nowMs() {
      return currentMs;
    },
    advanceMs(ms) {
      currentMs += Number(ms || 0);
    }
  };
}

async function makeTmpDir(prefix = "openclaw-phase14-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPhase14Harness() {
  const dir = await makeTmpDir();
  const timeProvider = createMutableTimeProvider();
  const logger = { info() {}, warn() {}, error() {} };

  const interactionLog = createInteractionLog({
    logger,
    timeProvider,
    storePath: path.join(dir, "interaction-log.json")
  });

  const llmAdapter = createLLMAdapter({
    provider: "mock",
    config: { model: "mock-v1" },
    logger,
    interactionLog,
    timeProvider
  });

  const outputManager = createResearchOutputManager({
    logger,
    timeProvider,
    outputDir: path.join(dir, "research-output")
  });

  let engine = null;
  const supervisorAuthority = createSupervisorAuthority({
    logger,
    timeProvider,
    executeHandler: async (taskEnvelope, context) => {
      if (!engine) {
        const error = new Error("engine not initialized");
        error.code = "PHASE14_ENGINE_UNINITIALIZED";
        throw error;
      }
      return engine.executeTask(taskEnvelope, context);
    },
    approvalPolicy: { requireConfirm: true }
  });
  await supervisorAuthority.initialize();

  const governanceBridge = createGovernanceBridge({
    logger,
    timeProvider,
    supervisorAuthority
  });

  engine = createAgentEngine({
    logger,
    timeProvider,
    config: { maxTokensPerRequest: 2048 },
    governanceBridge,
    llmAdapter,
    outputManager
  });

  return {
    dir,
    logger,
    timeProvider,
    interactionLog,
    llmAdapter,
    outputManager,
    supervisorAuthority,
    governanceBridge,
    engine
  };
}

module.exports = {
  createMutableTimeProvider,
  makeTmpDir,
  createPhase14Harness
};
