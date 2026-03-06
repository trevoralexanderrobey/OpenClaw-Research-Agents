#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createMetricsExporter } = require("../workflows/observability/metrics-schema.js");
const { createTelemetryEmitter } = require("../workflows/observability/telemetry-emitter.js");
const { createOperationalDecisionLedger } = require("../workflows/observability/operational-decision-ledger.js");
const { buildPhase13Runtime, logCliRejection } = require("./_phase13-access-utils.js");
const { canonicalize, safeString } = require("../workflows/governance-automation/common.js");
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
const { createCommsBus } = require("../openclaw-bridge/core/comms-bus.js");
const { createStateHydrator } = require("../openclaw-bridge/state/state-hydrator.js");
const { createOpenLoopManager } = require("../openclaw-bridge/state/open-loop-manager.js");
const { createRestartResumeOrchestrator } = require("../openclaw-bridge/core/restart-resume-orchestrator.js");
const { createSkillProvider } = require("../openclaw-bridge/core/skill-provider.js");
const { createSpawnPlanner } = require("../openclaw-bridge/core/spawn-planner.js");
const { createSpawnOrchestrator } = require("../openclaw-bridge/core/spawn-orchestrator.js");
const { createAgentSpawner } = require("../openclaw-bridge/core/agent-spawner.js");
const {
  loadRuntimeState,
  upsertMissionRuntime,
  loadMissionRuntime
} = require("../openclaw-bridge/state/persistent-store.js");

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

function resolveSpawnerConfig(rootDir, overrides = {}) {
  const configPath = path.join(rootDir, "config", "agent-spawner.json");
  const base = readJson(configPath, {
    schemaVersion: "phase18-agent-spawner-v1",
    enabled: false,
    requireLiveVerificationEvidence: true,
    plannerVersion: "phase18-planner-v1",
    finalSynthesisMode: "orchestrator_aggregation",
    missionWorkspaceDir: path.join(rootDir, "workspace", "missions"),
    runtimeStatePath: path.join(rootDir, "state", "runtime", "state.json"),
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: {
        bundled: ["skills"],
        shared: ["$CODEX_HOME/skills", "~/.codex/skills"],
        workspace: [".codex/skills", "workspace/skills"]
      }
    }
  });
  return canonicalize({
    ...base,
    ...overrides,
    skillConfig: canonicalize({
      ...(base.skillConfig || {}),
      ...(overrides.skillConfig || {}),
      sources: canonicalize({
        ...((base.skillConfig && base.skillConfig.sources) || {}),
        ...((overrides.skillConfig && overrides.skillConfig.sources) || {})
      })
    })
  });
}

function resolveMissionTemplates(rootDir) {
  return readJson(path.join(rootDir, "config", "mission-templates.json"), { schemaVersion: "phase18-mission-templates-v1", templates: {} });
}

function registerDefaultRoleHandlers(agentRegistry, engine) {
  const roleDefaults = {
    scout: { taskType: "extract" },
    analyst: { taskType: "analyze" },
    synthesizer: { taskType: "synthesize" },
    operator: { taskType: "freeform" }
  };
  for (const [role, defaults] of Object.entries(roleDefaults)) {
    agentRegistry.registerRole(role, async (taskEnvelope = {}, context = {}) => engine.executeOrchestratedTask(taskEnvelope, {
      ...context,
      defaultTaskType: defaults.taskType
    }));
  }
}

async function buildResearchRuntime(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();
  const config = resolveAgentConfig(rootDir, options.config || {});
  const spawnerConfig = resolveSpawnerConfig(rootDir, options.spawnerConfig || {});
  const missionTemplates = resolveMissionTemplates(rootDir);
  const skillLock = readJson(path.join(rootDir, "security", "skill-registry.lock.json"), {
    schemaVersion: 1,
    hostedSkillsEnabled: false,
    workspaceOverridesAllowed: [],
    skills: []
  });
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
    config: { model: safeString(config.defaultModel) || "mock-v1" },
    logger,
    interactionLog,
    timeProvider: options.timeProvider
  });

  const outputManager = createResearchOutputManager({
    logger,
    timeProvider: options.timeProvider,
    outputDir: path.join(rootDir, config.outputDir)
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
  const agentTopology = readJson(path.join(rootDir, "config", "agent-topology.json"), { roles: [] });
  const agentRegistry = createAgentRegistry({
    logger,
    topologyConfig: agentTopology
  });
  const roleRouter = createRoleRouter({
    logger,
    registry: agentRegistry,
    autonomyLadder
  });
  const commsBus = createCommsBus({
    logger,
    timeProvider: options.timeProvider,
    basePath: path.join(rootDir, "workspace", "comms"),
    missionBasePath: spawnerConfig.missionWorkspaceDir
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
  registerDefaultRoleHandlers(agentRegistry, engine);

  const stateHydrator = createStateHydrator({ path: spawnerConfig.runtimeStatePath });
  const openLoopManager = createOpenLoopManager({
    path: spawnerConfig.runtimeStatePath,
    laneQueue
  });
  const restartResumeOrchestrator = createRestartResumeOrchestrator({
    logger,
    stateHydrator,
    openLoopManager,
    supervisorAuthority,
    governanceBridge,
    laneQueue
  });
  const skillProvider = createSkillProvider({
    rootDir,
    logger,
    skillConfig: spawnerConfig.skillConfig,
    skillLock
  });
  const spawnPlanner = createSpawnPlanner({
    logger,
    config: spawnerConfig,
    missionTemplates,
    agentTopology,
    skillProvider
  });
  const spawnOrchestrator = createSpawnOrchestrator({
    logger,
    laneQueue,
    commsBus,
    roleRouter,
    outputManager,
    synthesisMode: safeString(spawnerConfig.finalSynthesisMode) || "orchestrator_aggregation",
    timeProvider: options.timeProvider,
    missionBasePath: spawnerConfig.missionWorkspaceDir,
    runtimeStatePath: spawnerConfig.runtimeStatePath
  });
  const agentSpawner = createAgentSpawner({
    supervisorAuthority,
    governanceBridge,
    agentRegistry,
    roleRouter,
    laneQueue,
    commsBus,
    agentEngine: engine,
    researchOutputManager: outputManager,
    openLoopManager,
    persistentStore: {
      loadRuntimeState: (input = {}) => loadRuntimeState({ path: input.path || spawnerConfig.runtimeStatePath }),
      upsertMissionRuntime: (record) => upsertMissionRuntime(record, { path: spawnerConfig.runtimeStatePath }),
      loadMissionRuntime: (missionId) => loadMissionRuntime(missionId, { path: spawnerConfig.runtimeStatePath })
    },
    restartResumeOrchestrator,
    spawnPlanner,
    spawnOrchestrator,
    skillProvider,
    config: spawnerConfig,
    logger,
    timeProvider: options.timeProvider
  });

  await supervisorAuthority.initialize();

  return {
    rootDir,
    logger,
    config,
    spawnerConfig,
    missionTemplates,
    skillLock,
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
    commsBus,
    stateHydrator,
    openLoopManager,
    restartResumeOrchestrator,
    skillProvider,
    spawnPlanner,
    spawnOrchestrator,
    agentSpawner,
    logCliRejection: (input) => logCliRejection(phase13, input)
  };
}

module.exports = {
  buildResearchRuntime,
  createNoopLogger,
  readJson,
  resolveAgentConfig,
  resolveMissionTemplates,
  resolveSpawnerConfig
};
