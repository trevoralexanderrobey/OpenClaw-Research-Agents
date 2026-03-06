"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createResearchOutputManager } = require("../../openclaw-bridge/core/research-output-manager.js");
const { createLaneQueue } = require("../../openclaw-bridge/core/lane-queue.js");
const { createCommsBus } = require("../../openclaw-bridge/core/comms-bus.js");
const { createAutonomyLadder } = require("../../openclaw-bridge/core/autonomy-ladder.js");
const { createAgentRegistry } = require("../../openclaw-bridge/core/agent-registry.js");
const { createRoleRouter } = require("../../openclaw-bridge/core/role-router.js");
const { createSkillProvider } = require("../../openclaw-bridge/core/skill-provider.js");
const { createSpawnPlanner } = require("../../openclaw-bridge/core/spawn-planner.js");
const { createSpawnOrchestrator } = require("../../openclaw-bridge/core/spawn-orchestrator.js");
const { createAgentSpawner } = require("../../openclaw-bridge/core/agent-spawner.js");
const { validateMissionEnvelope } = require("../../openclaw-bridge/core/mission-envelope-schema.js");
const { loadRuntimeState, loadMissionRuntime } = require("../../openclaw-bridge/state/persistent-store.js");

function createTimeProvider() {
  return {
    nowIso: () => "2026-03-06T00:00:00.000Z"
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-root-"));
}

test("phase18 spawn planner is deterministic for the same mission envelope", () => {
  const missionTemplates = {
    templates: {
      academic_trend_scan: {
        id: "academic_trend_scan",
        enabled: true,
        safety_class: "research_only",
        spawned_roles: ["scout", "analyst", "synthesizer"],
        steps: [
          { role: "scout", action_type: "collect_sources", task_type: "extract" },
          { role: "analyst", action_type: "analyze_documents", task_type: "analyze", depends_on: [1] },
          { role: "synthesizer", action_type: "synthesize_output", task_type: "synthesize", depends_on: [2], input_strategy: "dependency_outputs" }
        ]
      }
    }
  };
  const planner = createSpawnPlanner({
    config: { plannerVersion: "phase18-planner-v1" },
    missionTemplates,
    agentTopology: { roles: ["orchestrator", "scout", "analyst", "synthesizer"] },
    skillProvider: {
      resolveSkills: () => ({ local_skills: [], hosted_skill_refs: [] })
    }
  });
  const mission = {
    template_id: "academic_trend_scan",
    description: "Track a topic",
    inputs: [{ path: "/tmp/input-a", type: "path" }],
    created_at: "2026-03-06T00:00:00.000Z"
  };

  const first = planner.buildPlan(mission, {});
  const second = planner.buildPlan(mission, {});
  assert.deepEqual(second, first);
});

test("phase18 agent spawner writes mission artifacts and leaves global runtime state as the single index", async () => {
  const root = await makeRoot();
  const missionBase = path.join(root, "workspace", "missions");
  const outputDir = path.join(root, "workspace", "research-output");
  const runtimeStatePath = path.join(root, "state", "runtime", "state.json");
  await fsp.mkdir(path.join(root, "workspace", "comms"), { recursive: true });
  await fsp.mkdir(path.join(root, "state", "runtime"), { recursive: true });
  await fsp.mkdir(path.join(root, "workspace", "research-input"), { recursive: true });
  const inputPath = path.join(root, "workspace", "research-input", "source.txt");
  await fsp.writeFile(inputPath, "sample", "utf8");
  const autonomyPath = path.join(root, "autonomy.json");
  await fsp.writeFile(autonomyPath, JSON.stringify({
    roles: {
      scout: { allowedActions: ["collect_sources"], requireHumanApproval: [] },
      analyst: { allowedActions: ["analyze_documents"], requireHumanApproval: [] },
      synthesizer: { allowedActions: ["synthesize_output"], requireHumanApproval: [] },
      orchestrator: { allowedActions: ["plan_mission", "spawn_agents", "resume_mission", "synthesize_mission"], requireHumanApproval: [] }
    }
  }, null, 2), "utf8");

  const outputManager = createResearchOutputManager({
    outputDir,
    timeProvider: createTimeProvider()
  });
  const laneQueue = createLaneQueue({
    persistencePath: path.join(root, "workspace", "comms", "events", "lane-queue.json"),
    timeProvider: createTimeProvider()
  });
  const commsBus = createCommsBus({
    basePath: path.join(root, "workspace", "comms"),
    missionBasePath: missionBase,
    timeProvider: createTimeProvider()
  });
  const agentRegistry = createAgentRegistry({
    topologyConfig: { roles: ["orchestrator", "scout", "analyst", "synthesizer"] }
  });
  const autonomyLadder = createAutonomyLadder({ policyPath: autonomyPath });
  const roleRouter = createRoleRouter({ registry: agentRegistry, autonomyLadder });

  for (const [role, actionType] of [["scout", "collect_sources"], ["analyst", "analyze_documents"], ["synthesizer", "synthesize_output"]]) {
    agentRegistry.registerRole(role, async (taskEnvelope) => outputManager.saveOutput(`${taskEnvelope.subtask_id}-task`, `${role} output`, {
      status: "completed",
      type: taskEnvelope.type,
      output_format: taskEnvelope.outputFormat,
      provider: "mock",
      model: "mock-v1",
      started_at: "2026-03-06T00:00:00.000Z",
      completed_at: "2026-03-06T00:00:00.000Z",
      mission_id: taskEnvelope.mission_id,
      agent_id: taskEnvelope.agent_id,
      subtask_id: taskEnvelope.subtask_id
    }));
  }

  const skillProvider = createSkillProvider({
    rootDir: root,
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: { bundled: [], shared: [], workspace: [] }
    },
    skillLock: { hostedSkillsEnabled: false, workspaceOverridesAllowed: [], skills: [] }
  });
  const planner = createSpawnPlanner({
    config: { plannerVersion: "phase18-planner-v1" },
    missionTemplates: {
      templates: {
        academic_trend_scan: {
          id: "academic_trend_scan",
          enabled: true,
          safety_class: "research_only",
          spawned_roles: ["scout", "analyst", "synthesizer"],
          steps: [
            { role: "scout", action_type: "collect_sources", task_type: "extract", input_strategy: "mission_inputs" },
            { role: "analyst", action_type: "analyze_documents", task_type: "analyze", input_strategy: "mission_and_dependency_outputs", depends_on: [1] },
            { role: "synthesizer", action_type: "synthesize_output", task_type: "synthesize", input_strategy: "dependency_outputs", depends_on: [2] }
          ]
        }
      }
    },
    agentTopology: { roles: ["orchestrator", "scout", "analyst", "synthesizer"] },
    skillProvider
  });
  const orchestrator = createSpawnOrchestrator({
    laneQueue,
    commsBus,
    roleRouter,
    outputManager,
    missionBasePath: missionBase,
    runtimeStatePath,
    timeProvider: createTimeProvider()
  });
  const spawner = createAgentSpawner({
    governanceBridge: {
      requestTaskApproval: async () => ({ approved: true, reason: "governance_approved" })
    },
    agentRegistry,
    roleRouter,
    researchOutputManager: outputManager,
    restartResumeOrchestrator: {
      resumeMission: async () => ({ ok: true })
    },
    spawnPlanner: planner,
    spawnOrchestrator: orchestrator,
    persistentStore: {
      upsertMissionRuntime: (record) => require("../../openclaw-bridge/state/persistent-store.js").upsertMissionRuntime(record, { path: runtimeStatePath }),
      loadMissionRuntime: (missionId) => loadMissionRuntime(missionId, { path: runtimeStatePath })
    },
    config: {
      enabled: true,
      missionWorkspaceDir: missionBase
    },
    timeProvider: createTimeProvider()
  });

  const result = await spawner.spawnMission({
    template_id: "academic_trend_scan",
    description: "Analyze a topic",
    inputs: [{ path: inputPath, type: "path" }],
    created_at: "2026-03-06T00:00:00.000Z"
  }, {
    supervisorDecision: { approved: true, decision_id: "sup-1" },
    governanceDecision: { approved: true, reason: "governance_approved" }
  });

  assert.equal(result.ok, true);
  const missionRoot = path.join(missionBase, result.mission_id);
  const missionJson = JSON.parse(await fsp.readFile(path.join(missionRoot, "mission.json"), "utf8"));
  const statusJson = JSON.parse(await fsp.readFile(path.join(missionRoot, "status.json"), "utf8"));
  const runtimeState = await loadRuntimeState({ path: runtimeStatePath });
  assert.equal(missionJson.template_id, "academic_trend_scan");
  assert.equal(statusJson.status, "completed");
  assert.deepEqual(statusJson.status_history.map((entry) => entry.status), [
    "draft",
    "supervisor_approved",
    "governance_approved",
    "planning",
    "spawned",
    "running",
    "synthesizing",
    "completed"
  ]);
  assert.ok(runtimeState.state.missions[result.mission_id]);
  assert.equal(Array.isArray(runtimeState.state.openLoops) ? runtimeState.state.openLoops.length : -1, 0);
  assert.match(await fsp.readFile(path.join(missionRoot, "blackboard.md"), "utf8"), /completed/);
});

test("phase18 agent spawner records rejected lifecycle when governance approval is denied", async () => {
  const root = await makeRoot();
  const missionBase = path.join(root, "workspace", "missions");
  const runtimeStatePath = path.join(root, "state", "runtime", "state.json");
  await fsp.mkdir(path.join(root, "workspace", "comms"), { recursive: true });
  await fsp.mkdir(path.join(root, "state", "runtime"), { recursive: true });
  await fsp.mkdir(path.join(root, "workspace", "research-input"), { recursive: true });
  const inputPath = path.join(root, "workspace", "research-input", "source.txt");
  await fsp.writeFile(inputPath, "sample", "utf8");
  const autonomyPath = path.join(root, "autonomy.json");
  await fsp.writeFile(autonomyPath, JSON.stringify({
    roles: {
      scout: { allowedActions: ["collect_sources"], requireHumanApproval: [] },
      orchestrator: { allowedActions: ["plan_mission", "spawn_agents", "resume_mission", "synthesize_mission"], requireHumanApproval: [] }
    }
  }, null, 2), "utf8");

  const outputManager = createResearchOutputManager({
    outputDir: path.join(root, "workspace", "research-output"),
    timeProvider: createTimeProvider()
  });
  const laneQueue = createLaneQueue({
    persistencePath: path.join(root, "workspace", "comms", "events", "lane-queue.json"),
    timeProvider: createTimeProvider()
  });
  const commsBus = createCommsBus({
    basePath: path.join(root, "workspace", "comms"),
    missionBasePath: missionBase,
    timeProvider: createTimeProvider()
  });
  const agentRegistry = createAgentRegistry({
    topologyConfig: { roles: ["orchestrator", "scout"] }
  });
  const autonomyLadder = createAutonomyLadder({ policyPath: autonomyPath });
  const roleRouter = createRoleRouter({ registry: agentRegistry, autonomyLadder });
  agentRegistry.registerRole("scout", async (taskEnvelope) => outputManager.saveOutput(`${taskEnvelope.subtask_id}-task`, "scout output", {
    status: "completed",
    type: taskEnvelope.type,
    output_format: taskEnvelope.outputFormat,
    provider: "mock",
    model: "mock-v1",
    started_at: "2026-03-06T00:00:00.000Z",
    completed_at: "2026-03-06T00:00:00.000Z",
    mission_id: taskEnvelope.mission_id,
    agent_id: taskEnvelope.agent_id,
    subtask_id: taskEnvelope.subtask_id
  }));

  const skillProvider = createSkillProvider({
    rootDir: root,
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: { bundled: [], shared: [], workspace: [] }
    },
    skillLock: { hostedSkillsEnabled: false, workspaceOverridesAllowed: [], skills: [] }
  });
  const planner = createSpawnPlanner({
    config: { plannerVersion: "phase18-planner-v1" },
    missionTemplates: {
      templates: {
        academic_trend_scan: {
          id: "academic_trend_scan",
          enabled: true,
          safety_class: "research_only",
          spawned_roles: ["scout"],
          steps: [
            { role: "scout", action_type: "collect_sources", task_type: "extract", input_strategy: "mission_inputs" }
          ]
        }
      }
    },
    agentTopology: { roles: ["orchestrator", "scout"] },
    skillProvider
  });
  const orchestrator = createSpawnOrchestrator({
    laneQueue,
    commsBus,
    roleRouter,
    outputManager,
    missionBasePath: missionBase,
    runtimeStatePath,
    timeProvider: createTimeProvider()
  });
  const spawner = createAgentSpawner({
    governanceBridge: {
      requestTaskApproval: async () => ({ approved: false, reason: "governance_rejected" })
    },
    agentRegistry,
    roleRouter,
    researchOutputManager: outputManager,
    restartResumeOrchestrator: {
      resumeMission: async () => ({ ok: true })
    },
    spawnPlanner: planner,
    spawnOrchestrator: orchestrator,
    persistentStore: {
      upsertMissionRuntime: (record) => require("../../openclaw-bridge/state/persistent-store.js").upsertMissionRuntime(record, { path: runtimeStatePath }),
      loadMissionRuntime: (missionId) => loadMissionRuntime(missionId, { path: runtimeStatePath })
    },
    config: {
      enabled: true,
      missionWorkspaceDir: missionBase
    },
    timeProvider: createTimeProvider()
  });

  const missionInput = {
    template_id: "academic_trend_scan",
    description: "Analyze a topic",
    inputs: [{ path: inputPath, type: "path" }],
    created_at: "2026-03-06T00:00:00.000Z"
  };
  const missionEnvelope = validateMissionEnvelope(missionInput);
  await assert.rejects(
    async () => spawner.spawnMission(missionInput, {
      supervisorDecision: { approved: true, decision_id: "sup-1" }
    }),
    (error) => error && error.code === "PHASE18_GOVERNANCE_REQUIRED"
  );

  const statusJson = JSON.parse(await fsp.readFile(path.join(missionBase, missionEnvelope.mission_id, "status.json"), "utf8"));
  assert.equal(statusJson.status, "rejected");
  assert.deepEqual(statusJson.status_history.map((entry) => entry.status), [
    "draft",
    "supervisor_approved",
    "rejected"
  ]);
});

test("phase18 spawn orchestration dispatches independent subtasks with bounded lane concurrency", async () => {
  const root = await makeRoot();
  const missionBase = path.join(root, "workspace", "missions");
  const outputDir = path.join(root, "workspace", "research-output");
  const runtimeStatePath = path.join(root, "state", "runtime", "state.json");
  await fsp.mkdir(path.join(root, "workspace", "comms"), { recursive: true });
  await fsp.mkdir(path.join(root, "state", "runtime"), { recursive: true });
  await fsp.mkdir(path.join(root, "workspace", "research-input"), { recursive: true });
  const inputPath = path.join(root, "workspace", "research-input", "source.txt");
  await fsp.writeFile(inputPath, "sample", "utf8");
  const autonomyPath = path.join(root, "autonomy.json");
  await fsp.writeFile(autonomyPath, JSON.stringify({
    roles: {
      scout: { allowedActions: ["collect_sources"], requireHumanApproval: [] },
      orchestrator: { allowedActions: ["plan_mission", "spawn_agents", "resume_mission", "synthesize_mission"], requireHumanApproval: [] }
    }
  }, null, 2), "utf8");

  const outputManager = createResearchOutputManager({
    outputDir,
    timeProvider: createTimeProvider()
  });
  const laneQueue = createLaneQueue({
    persistencePath: path.join(root, "workspace", "comms", "events", "lane-queue.json"),
    timeProvider: createTimeProvider()
  });
  const commsBus = createCommsBus({
    basePath: path.join(root, "workspace", "comms"),
    missionBasePath: missionBase,
    timeProvider: createTimeProvider()
  });
  const agentRegistry = createAgentRegistry({
    topologyConfig: { roles: ["orchestrator", "scout"] }
  });
  const autonomyLadder = createAutonomyLadder({ policyPath: autonomyPath });
  const roleRouter = createRoleRouter({ registry: agentRegistry, autonomyLadder });

  let active = 0;
  let maxActive = 0;
  let started = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });

  agentRegistry.registerRole("scout", async (taskEnvelope) => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (started >= 2) {
      releaseBarrier();
    }
    await Promise.race([barrier, delay(150)]);
    await delay(10);
    active = Math.max(0, active - 1);
    return outputManager.saveOutput(`${taskEnvelope.subtask_id}-task`, "scout output", {
      status: "completed",
      type: taskEnvelope.type,
      output_format: taskEnvelope.outputFormat,
      provider: "mock",
      model: "mock-v1",
      started_at: "2026-03-06T00:00:00.000Z",
      completed_at: "2026-03-06T00:00:00.000Z",
      mission_id: taskEnvelope.mission_id,
      agent_id: taskEnvelope.agent_id,
      subtask_id: taskEnvelope.subtask_id
    });
  });

  const skillProvider = createSkillProvider({
    rootDir: root,
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: { bundled: [], shared: [], workspace: [] }
    },
    skillLock: { hostedSkillsEnabled: false, workspaceOverridesAllowed: [], skills: [] }
  });
  const planner = createSpawnPlanner({
    config: { plannerVersion: "phase18-planner-v1" },
    missionTemplates: {
      templates: {
        academic_trend_scan: {
          id: "academic_trend_scan",
          enabled: true,
          safety_class: "research_only",
          spawned_roles: ["scout"],
          lane_max_inflight: { scout: 2 },
          steps: [
            { role: "scout", action_type: "collect_sources", task_type: "extract", input_strategy: "mission_inputs" },
            { role: "scout", action_type: "collect_sources", task_type: "extract", input_strategy: "mission_inputs" }
          ]
        }
      }
    },
    agentTopology: { roles: ["orchestrator", "scout"] },
    skillProvider
  });
  const orchestrator = createSpawnOrchestrator({
    laneQueue,
    commsBus,
    roleRouter,
    outputManager,
    missionBasePath: missionBase,
    runtimeStatePath,
    timeProvider: createTimeProvider()
  });
  const spawner = createAgentSpawner({
    governanceBridge: {
      requestTaskApproval: async () => ({ approved: true, reason: "governance_approved" })
    },
    agentRegistry,
    roleRouter,
    researchOutputManager: outputManager,
    restartResumeOrchestrator: {
      resumeMission: async () => ({ ok: true })
    },
    spawnPlanner: planner,
    spawnOrchestrator: orchestrator,
    persistentStore: {
      upsertMissionRuntime: (record) => require("../../openclaw-bridge/state/persistent-store.js").upsertMissionRuntime(record, { path: runtimeStatePath }),
      loadMissionRuntime: (missionId) => loadMissionRuntime(missionId, { path: runtimeStatePath })
    },
    config: {
      enabled: true,
      missionWorkspaceDir: missionBase
    },
    timeProvider: createTimeProvider()
  });

  const result = await spawner.spawnMission({
    template_id: "academic_trend_scan",
    description: "Run parallel scout tasks",
    inputs: [{ path: inputPath, type: "path" }],
    created_at: "2026-03-06T00:00:00.000Z"
  }, {
    supervisorDecision: { approved: true, decision_id: "sup-1" },
    governanceDecision: { approved: true, reason: "governance_approved" }
  });

  assert.equal(result.ok, true);
  assert.equal(maxActive, 2);
});
