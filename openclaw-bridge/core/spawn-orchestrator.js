"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString } = require("../../workflows/governance-automation/common.js");
const { registerOpenLoop, resolveOpenLoop } = require("../state/persistent-store.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(canonicalize(value))}\n`, "utf8");
}

function appendBlackboard(filePath, lines) {
  ensureDir(path.dirname(filePath));
  const body = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  fs.appendFileSync(filePath, `${body}\n`, "utf8");
}

function resolveMissionPaths(basePath, missionId, agentId = "") {
  const missionRoot = path.join(basePath, missionId);
  return {
    missionRoot,
    blackboardPath: path.join(missionRoot, "blackboard.md"),
    statusPath: path.join(missionRoot, "status.json"),
    artifactsPath: path.join(missionRoot, "artifacts"),
    agentInboxPath: agentId ? path.join(missionRoot, "agents", agentId, "inbox.jsonl") : "",
    agentOutboxPath: agentId ? path.join(missionRoot, "agents", agentId, "outbox.jsonl") : ""
  };
}

function createSpawnOrchestrator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const laneQueue = options.laneQueue;
  const commsBus = options.commsBus;
  const roleRouter = options.roleRouter;
  const outputManager = options.outputManager;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const runtimeStatePath = safeString(options.runtimeStatePath) || path.join(process.cwd(), "state", "runtime", "state.json");
  const missionBasePath = path.resolve(safeString(options.missionBasePath) || path.join(process.cwd(), "workspace", "missions"));

  if (!laneQueue || typeof laneQueue.enqueue !== "function" || typeof laneQueue.dequeue !== "function") {
    throw new Error("laneQueue.enqueue/dequeue are required");
  }
  if (!roleRouter || typeof roleRouter.dispatch !== "function") {
    throw new Error("roleRouter.dispatch is required");
  }

  function buildSubtaskInputs(missionEnvelope, subtask, results) {
    const missionInputs = Array.isArray(missionEnvelope.inputs) ? missionEnvelope.inputs : [];
    const dependencyOutputs = Array.isArray(subtask.depends_on)
      ? subtask.depends_on
        .map((subtaskId) => results.get(subtaskId))
        .filter(Boolean)
        .flatMap((result) => {
          const outputPath = safeString(result.output_path);
          return outputPath ? [{ path: outputPath, type: "path" }] : [];
        })
      : [];
    const strategy = safeString(subtask.input_strategy);
    if (strategy === "dependency_outputs") {
      return dependencyOutputs;
    }
    if (strategy === "mission_and_dependency_outputs") {
      return canonicalize([...missionInputs, ...dependencyOutputs].sort((left, right) => safeString(left.path).localeCompare(safeString(right.path))));
    }
    return missionInputs;
  }

  async function executePlan(spawnPlan, context = {}) {
    const missionEnvelope = spawnPlan.mission;
    const sessionId = safeString(missionEnvelope.session_id) || missionEnvelope.mission_id;
    const results = new Map();

    for (const subtask of spawnPlan.subtasks.slice().sort((left, right) => Number(left.order || 0) - Number(right.order || 0))) {
      laneQueue.enqueue(sessionId, {
        mission_id: missionEnvelope.mission_id,
        lane_key: subtask.lane_key,
        concurrency_key: subtask.concurrency_key,
        agent_id: subtask.agent_id,
        subtask_id: subtask.subtask_id,
        task_envelope: canonicalize(subtask)
      });
      await registerOpenLoop({
        loopId: subtask.subtask_id,
        sessionId,
        taskEnvelope: canonicalize(subtask),
        missionId: missionEnvelope.mission_id,
        agentId: subtask.agent_id,
        laneKey: subtask.lane_key
      }, { path: runtimeStatePath });
    }

    while (true) {
      const queued = laneQueue.dequeue(sessionId);
      if (!queued) {
        break;
      }
      const subtask = canonicalize(queued.task_envelope || queued.envelope && queued.envelope.task_envelope || {});
      const missionPaths = resolveMissionPaths(missionBasePath, missionEnvelope.mission_id, subtask.agent_id);
      const dispatchEnvelope = canonicalize({
        agent_id: subtask.agent_id,
        subtask_id: subtask.subtask_id,
        mission_id: missionEnvelope.mission_id,
        role: subtask.role,
        actionType: subtask.action_type,
        type: subtask.task_type,
        description: subtask.description,
        inputs: buildSubtaskInputs(missionEnvelope, subtask, results),
        outputFormat: subtask.output_format,
        constraints: canonicalize({
          ...(subtask.constraints || {}),
          mission_id: missionEnvelope.mission_id,
          agent_id: subtask.agent_id,
          subtask_id: subtask.subtask_id
        }),
        createdAt: missionEnvelope.created_at
      });

      if (commsBus && typeof commsBus.writeInboxMessage === "function") {
        commsBus.writeInboxMessage(subtask.role, canonicalize({
          mission_id: missionEnvelope.mission_id,
          agent_id: subtask.agent_id,
          subtask_id: subtask.subtask_id,
          phase18_projection: true,
          status: "dispatched",
          task_envelope: dispatchEnvelope
        }));
      }
      if (missionPaths.agentInboxPath) {
        appendJsonl(missionPaths.agentInboxPath, canonicalize({
          timestamp: safeString(timeProvider.nowIso()),
          status: "dispatched",
          task_envelope: dispatchEnvelope
        }));
      }

      const routed = await roleRouter.dispatch(dispatchEnvelope, context);
      const rawResult = routed && routed.result ? routed.result : {};
      const taskResult = rawResult && rawResult.result ? rawResult.result : rawResult;
      const normalizedResult = canonicalize({
        ...taskResult,
        subtask_id: subtask.subtask_id,
        agent_id: subtask.agent_id,
        mission_id: missionEnvelope.mission_id,
        status: safeString(taskResult.status) || "completed"
      });
      results.set(subtask.subtask_id, normalizedResult);

      if (commsBus && typeof commsBus.writeOutboxMessage === "function") {
        commsBus.writeOutboxMessage(subtask.role, canonicalize({
          mission_id: missionEnvelope.mission_id,
          agent_id: subtask.agent_id,
          subtask_id: subtask.subtask_id,
          phase18_projection: true,
          status: "reported",
          result: normalizedResult
        }));
      }
      if (commsBus && typeof commsBus.appendBlackboard === "function") {
        commsBus.appendBlackboard(canonicalize({
          mission_id: missionEnvelope.mission_id,
          agent_id: subtask.agent_id,
          subtask_id: subtask.subtask_id,
          status: "completed",
          output_path: safeString(normalizedResult.output_path)
        }));
      }
      if (missionPaths.agentOutboxPath) {
        appendJsonl(missionPaths.agentOutboxPath, canonicalize({
          timestamp: safeString(timeProvider.nowIso()),
          status: "reported",
          result: normalizedResult
        }));
      }
      appendBlackboard(missionPaths.blackboardPath, [
        `- ${safeString(timeProvider.nowIso())} ${subtask.subtask_id} completed`,
        safeString(normalizedResult.output_path) ? `  - output: ${safeString(normalizedResult.output_path)}` : "  - output: unavailable"
      ]);
      await resolveOpenLoop(subtask.subtask_id, { path: runtimeStatePath });
    }

    const orderedResults = spawnPlan.subtasks
      .slice()
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
      .map((subtask) => results.get(subtask.subtask_id))
      .filter(Boolean);
    const synthesisBody = canonicalize({
      mission_id: missionEnvelope.mission_id,
      template_id: missionEnvelope.template_id,
      result_count: orderedResults.length,
      results: orderedResults
    });
    const finalTask = outputManager.saveOutput(`${missionEnvelope.mission_id}-mission-output`, synthesisBody, {
      status: "completed",
      type: "synthesize",
      output_format: "json",
      provider: "mission-orchestrator",
      model: "phase18-planner-v1",
      started_at: missionEnvelope.created_at,
      completed_at: safeString(timeProvider.nowIso()),
      mission_id: missionEnvelope.mission_id
    });
    const missionPaths = resolveMissionPaths(missionBasePath, missionEnvelope.mission_id);
    ensureDir(missionPaths.artifactsPath);
    fs.writeFileSync(path.join(missionPaths.artifactsPath, "final-output.json"), canonicalJson(canonicalize({
      ...synthesisBody,
      output_path: finalTask.output_path
    })), "utf8");

    logger.info({ event: "phase18_plan_executed", mission_id: missionEnvelope.mission_id, result_count: orderedResults.length });
    return canonicalize({
      output_path: finalTask.output_path,
      metadata_path: finalTask.metadata_path,
      manifest_path: finalTask.manifest_path,
      results: orderedResults
    });
  }

  return Object.freeze({
    executePlan,
    resolveMissionPaths
  });
}

module.exports = {
  createSpawnOrchestrator,
  resolveMissionPaths
};
