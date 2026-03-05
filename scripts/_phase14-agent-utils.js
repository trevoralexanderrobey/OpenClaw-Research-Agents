#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createMetricsExporter } = require("../workflows/observability/metrics-schema.js");
const { createTelemetryEmitter } = require("../workflows/observability/telemetry-emitter.js");
const { createOperationalDecisionLedger } = require("../workflows/observability/operational-decision-ledger.js");
const { buildPhase13Runtime, logCliRejection } = require("./_phase13-access-utils.js");
const { createInteractionLog } = require("../openclaw-bridge/core/interaction-log.js");
const { createLLMAdapter } = require("../openclaw-bridge/core/llm-adapter.js");
const { createGovernanceBridge } = require("../openclaw-bridge/core/governance-bridge.js");
const { createResearchOutputManager } = require("../openclaw-bridge/core/research-output-manager.js");
const { createAgentEngine } = require("../openclaw-bridge/core/agent-engine.js");
const { createSupervisorAuthority } = require("../openclaw-bridge/core/supervisor-authority.js");
const { createLaneQueue } = require("../openclaw-bridge/core/lane-queue.js");
const { createAutonomyLadder } = require("../openclaw-bridge/core/autonomy-ladder.js");
const { createRoleRouter } = require("../openclaw-bridge/core/role-router.js");
const { createAgentRegistry } = require("../openclaw-bridge/core/agent-registry.js");

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function resolveAgentConfig(rootDir, overrides = {}) {
  const configPath = path.join(rootDir, "config", "agent-config.json");
  const base = readJson(configPath, {
    defaultProvider: "mock",
    defaultModel: "mock-v1",
    inputDir: "workspace/research-input/",
    outputDir: "workspace/research-output/",
    interactionLogPath: "security/interaction-log.json",
    taskTimeoutMs: 120000,
    maxTokensPerRequest: 4000,
    rlhfAutoGenerate: true,
    requireSupervisorApproval: true,
    statusIndexFile: "tasks-index.json"
  });

  return {
    ...base,
    ...overrides,
    inputDir: safeString(overrides.inputDir) || safeString(base.inputDir) || "workspace/research-input/",
    outputDir: safeString(overrides.outputDir) || safeString(base.outputDir) || "workspace/research-output/",
    defaultProvider: safeString(overrides.provider) || safeString(base.defaultProvider) || "mock",
    defaultModel: safeString(overrides.model) || safeString(base.defaultModel) || "mock-v1",
    interactionLogPath: safeString(overrides.interactionLogPath) || safeString(base.interactionLogPath) || "security/interaction-log.json"
  };
}

async function buildPhase14Runtime(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();

  const config = resolveAgentConfig(rootDir, options.config || {});
  const governance = options.apiGovernance || createApiGovernance({ logger });

  const phase13 = buildPhase13Runtime({
    rootDir,
    logger,
    apiGovernance: governance
  });

  const metricsExporter = createMetricsExporter({
    logger,
    metricsPath: path.join(rootDir, "audit", "evidence", "observability")
  });
  const telemetryEmitter = createTelemetryEmitter({ logger, metricsExporter });
  const operationalDecisionLedger = createOperationalDecisionLedger({
    apiGovernance: governance,
    logger
  });

  const interactionLog = createInteractionLog({
    logger,
    timeProvider: options.timeProvider,
    storePath: path.join(rootDir, config.interactionLogPath)
  });

  const llmAdapter = createLLMAdapter({
    provider: safeString(config.defaultProvider) || "mock",
    config: {
      model: safeString(config.defaultModel) || "mock-v1"
    },
    logger,
    interactionLog,
    timeProvider: options.timeProvider
  });

  const outputManager = createResearchOutputManager({
    logger,
    timeProvider: options.timeProvider,
    outputDir: path.join(rootDir, config.outputDir)
  });

  let engine = null;
  const supervisorAuthority = createSupervisorAuthority({
    logger,
    timeProvider: options.timeProvider,
    supervisorConfig: {
      maxQueueLength: 200,
      failureThreshold: 3,
      successThreshold: 1,
      timeoutMs: 30000
    },
    approvalPolicy: {
      requireConfirm: true
    },
    executeHandler: async (taskEnvelope, context) => {
      if (!engine) {
        const error = new Error("agent engine not initialized");
        error.code = "PHASE14_ENGINE_UNINITIALIZED";
        throw error;
      }
      return engine.executeTask(taskEnvelope, context);
    }
  });

  const governanceBridge = createGovernanceBridge({
    logger,
    timeProvider: options.timeProvider,
    apiGovernance: governance,
    permissionEnforcer: phase13.permissionEnforcer,
    complianceGate: null,
    experimentValidator: null,
    operationalDecisionLedger,
    telemetryEmitter,
    supervisorAuthority
  });

  engine = createAgentEngine({
    logger,
    timeProvider: options.timeProvider,
    config,
    governanceBridge,
    llmAdapter,
    outputManager
  });

  const laneQueue = createLaneQueue({
    logger,
    timeProvider: options.timeProvider,
    persistencePath: path.join(rootDir, "workspace", "comms", "events", "lane-queue.json")
  });

  const autonomyLadder = createAutonomyLadder({
    logger,
    policyPath: path.join(rootDir, "config", "autonomy-ladder.json")
  });
  const agentRegistry = createAgentRegistry({
    logger,
    topologyConfig: readJson(path.join(rootDir, "config", "agent-topology.json"), { roles: [] })
  });
  const roleRouter = createRoleRouter({
    logger,
    registry: agentRegistry,
    autonomyLadder
  });

  await supervisorAuthority.initialize();

  return {
    rootDir,
    logger,
    config,
    governance,
    phase13,
    interactionLog,
    llmAdapter,
    outputManager,
    supervisorAuthority,
    governanceBridge,
    engine,
    telemetryEmitter,
    operationalDecisionLedger,
    laneQueue,
    autonomyLadder,
    roleRouter,
    agentRegistry,
    logCliRejection: (input) => logCliRejection(phase13, input)
  };
}

module.exports = {
  buildPhase14Runtime,
  resolveAgentConfig
};
