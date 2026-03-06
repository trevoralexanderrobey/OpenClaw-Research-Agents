"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString } = require("../../workflows/governance-automation/common.js");
const { MISSION_STATUSES, validateMissionEnvelope } = require("./mission-envelope-schema.js");
const { resolveMissionPaths } = require("./spawn-orchestrator.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function createAgentSpawner(options = {}) {
  const supervisorAuthority = options.supervisorAuthority;
  const governanceBridge = options.governanceBridge;
  const agentRegistry = options.agentRegistry;
  const roleRouter = options.roleRouter;
  const researchOutputManager = options.researchOutputManager;
  const restartResumeOrchestrator = options.restartResumeOrchestrator;
  const spawnPlanner = options.spawnPlanner;
  const spawnOrchestrator = options.spawnOrchestrator;
  const persistentStore = options.persistentStore || {};
  const config = options.config && typeof options.config === "object" ? options.config : {};
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const missionBasePath = path.resolve(safeString(config.missionWorkspaceDir) || path.join(process.cwd(), "workspace", "missions"));

  if (!spawnPlanner || typeof spawnPlanner.buildPlan !== "function") {
    throw new Error("spawnPlanner.buildPlan is required");
  }
  if (!spawnOrchestrator || typeof spawnOrchestrator.executePlan !== "function") {
    throw new Error("spawnOrchestrator.executePlan is required");
  }

  function assertPhase18Enabled() {
    if (config.enabled !== true) {
      const error = new Error("Phase 18 mission mode is disabled until live evidence is verified");
      error.code = "PHASE18_DISABLED";
      throw error;
    }
  }

  function persistMissionFileSet(missionEnvelope, spawnPlan) {
    const paths = resolveMissionPaths(missionBasePath, missionEnvelope.mission_id);
    ensureDir(paths.missionRoot);
    ensureDir(path.join(paths.missionRoot, "agents"));
    ensureDir(paths.artifactsPath);
    writeJson(path.join(paths.missionRoot, "mission.json"), missionEnvelope);
    writeJson(path.join(paths.missionRoot, "spawn-plan.json"), spawnPlan);
    if (!fs.existsSync(paths.blackboardPath)) {
      fs.writeFileSync(paths.blackboardPath, "# Mission Blackboard\n", "utf8");
    }
    return paths;
  }

  async function writeMissionStatus(missionId, partial = {}) {
    const paths = resolveMissionPaths(missionBasePath, missionId);
    const existing = readJson(paths.statusPath, {
      mission_id: missionId,
      status: "draft",
      subtasks: []
    });
    const next = canonicalize({
      ...existing,
      ...partial,
      mission_id: missionId,
      updated_at: safeString(timeProvider.nowIso())
    });
    writeJson(paths.statusPath, next);
    if (typeof persistentStore.upsertMissionRuntime === "function") {
      await persistentStore.upsertMissionRuntime(next);
    }
    return next;
  }

  async function assertMandatoryApprovals(missionEnvelope, context = {}) {
    const supervisorDecision = context.supervisorDecision || null;
    if (!supervisorDecision || supervisorDecision.approved !== true) {
      const error = new Error("Mission requires supervisor approval");
      error.code = "SUPERVISOR_APPROVAL_REQUIRED";
      throw error;
    }
    const governanceDecision = context.governanceDecision || await governanceBridge.requestTaskApproval({
      task_id: missionEnvelope.mission_id,
      description: missionEnvelope.description,
      type: "freeform",
      output_format: "json",
      constraints: canonicalize({ mission_template_id: missionEnvelope.template_id })
    }, {
      ...context,
      supervisorDecision
    });
    if (!governanceDecision || governanceDecision.approved !== true) {
      const error = new Error("Mission requires governance approval");
      error.code = "PHASE18_GOVERNANCE_REQUIRED";
      throw error;
    }
    return canonicalize({ supervisorDecision, governanceDecision });
  }

  async function buildCanonicalPlan(missionEnvelope, context = {}) {
    return spawnPlanner.buildPlan(missionEnvelope, context);
  }

  async function persistMissionState(spawnPlan) {
    const missionEnvelope = validateMissionEnvelope(spawnPlan.mission);
    const paths = persistMissionFileSet(missionEnvelope, spawnPlan);
    await writeMissionStatus(missionEnvelope.mission_id, {
      template_id: missionEnvelope.template_id,
      status: "planning",
      subtasks: spawnPlan.subtasks.map((subtask) => canonicalize({
        subtask_id: subtask.subtask_id,
        agent_id: subtask.agent_id,
        role: subtask.role,
        status: subtask.status
      }))
    });
    return paths;
  }

  async function registerSpawnedAgents(spawnPlan) {
    if (!agentRegistry || typeof agentRegistry.registerAgent !== "function") {
      return [];
    }
    const registered = [];
    for (const agent of spawnPlan.agents) {
      registered.push(agentRegistry.registerAgent(agent.agent_id, agent));
      const agentPaths = resolveMissionPaths(missionBasePath, spawnPlan.mission.mission_id, agent.agent_id);
      ensureDir(path.dirname(agentPaths.agentInboxPath));
      if (!fs.existsSync(agentPaths.agentInboxPath)) {
        fs.writeFileSync(agentPaths.agentInboxPath, "", "utf8");
      }
      if (!fs.existsSync(agentPaths.agentOutboxPath)) {
        fs.writeFileSync(agentPaths.agentOutboxPath, "", "utf8");
      }
    }
    await writeMissionStatus(spawnPlan.mission.mission_id, {
      status: "spawned",
      spawned_agents: spawnPlan.agents.map((agent) => canonicalize({
        agent_id: agent.agent_id,
        role: agent.role
      }))
    });
    return canonicalize(registered);
  }

  async function executePlan(spawnPlan, context = {}) {
    await writeMissionStatus(spawnPlan.mission.mission_id, { status: "running" });
    const result = await spawnOrchestrator.executePlan(spawnPlan, context);
    await writeMissionStatus(spawnPlan.mission.mission_id, {
      status: "synthesizing",
      output_path: safeString(result.output_path)
    });
    return result;
  }

  async function synthesizeAndPersist(spawnPlan, results) {
    const missionId = spawnPlan.mission.mission_id;
    const summary = canonicalize({
      ok: true,
      mission_id: missionId,
      status: "completed",
      output_path: safeString(results.output_path),
      metadata_path: safeString(results.metadata_path),
      manifest_path: safeString(results.manifest_path),
      subtask_results: Array.isArray(results.results) ? results.results : []
    });
    writeJson(path.join(resolveMissionPaths(missionBasePath, missionId).artifactsPath, "mission-summary.json"), summary);
    await writeMissionStatus(missionId, summary);
    await writeMissionStatus(missionId, { status: "completed" });
    if (agentRegistry && typeof agentRegistry.teardownMissionAgents === "function") {
      agentRegistry.teardownMissionAgents(missionId);
    }
    return summary;
  }

  async function spawnMission(missionEnvelope, context = {}) {
    assertPhase18Enabled();
    const normalizedMission = validateMissionEnvelope(missionEnvelope);
    await writeMissionStatus(normalizedMission.mission_id, {
      status: "draft",
      template_id: normalizedMission.template_id,
      created_at: normalizedMission.created_at
    });
    const approvals = await assertMandatoryApprovals(normalizedMission, context);
    await writeMissionStatus(normalizedMission.mission_id, { status: "governance_approved" });
    const spawnPlan = await buildCanonicalPlan(normalizedMission, context);
    await persistMissionState(spawnPlan);
    await registerSpawnedAgents(spawnPlan);
    const results = await executePlan(spawnPlan, {
      ...context,
      supervisorDecision: approvals.supervisorDecision,
      governanceDecision: approvals.governanceDecision
    });
    logger.info({ event: "phase18_mission_spawned", mission_id: normalizedMission.mission_id });
    return synthesizeAndPersist(spawnPlan, results);
  }

  async function resumeMission(missionId, context = {}) {
    assertPhase18Enabled();
    const normalizedMissionId = safeString(missionId);
    if (!normalizedMissionId) {
      const error = new Error("missionId is required");
      error.code = "PHASE18_MISSION_ID_REQUIRED";
      throw error;
    }
    const paths = resolveMissionPaths(missionBasePath, normalizedMissionId);
    const missionState = readJson(paths.statusPath, null);
    if (!missionState) {
      const error = new Error(`Mission '${normalizedMissionId}' not found`);
      error.code = "PHASE18_MISSION_NOT_FOUND";
      throw error;
    }
    await writeMissionStatus(normalizedMissionId, { status: "paused" });
    if (!restartResumeOrchestrator || typeof restartResumeOrchestrator.resumeMission !== "function") {
      return restartResumeOrchestrator.resumePendingWork({
        ...context,
        sessionId: normalizedMissionId,
        executeResumedTasks: true,
        executeHandler: context.executeHandler
      });
    }
    return restartResumeOrchestrator.resumeMission(missionState, {
      ...context,
      executeResumedTasks: true,
      executeHandler: typeof context.executeHandler === "function"
        ? context.executeHandler
        : async (taskEnvelope, resumeContext) => {
          if (!roleRouter || typeof roleRouter.dispatch !== "function") {
            return { ok: true, skipped: true };
          }
          return roleRouter.dispatch(taskEnvelope, resumeContext);
        }
    });
  }

  return Object.freeze({
    spawnMission,
    resumeMission,
    assertMandatoryApprovals,
    buildCanonicalPlan,
    persistMissionState,
    registerSpawnedAgents,
    executePlan,
    synthesizeAndPersist,
    resolveMissionPaths: (missionId) => resolveMissionPaths(missionBasePath, missionId)
  });
}

module.exports = {
  createAgentSpawner
};
