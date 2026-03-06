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

function normalizePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Math.max(1, Number(fallback) || 1);
  }
  return Math.max(1, Math.floor(parsed));
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
  const synthesisMode = safeString(options.synthesisMode) || "orchestrator_aggregation";
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const runtimeStatePath = safeString(options.runtimeStatePath) || path.join(process.cwd(), "state", "runtime", "state.json");
  const missionBasePath = path.resolve(safeString(options.missionBasePath) || path.join(process.cwd(), "workspace", "missions"));

  if (!laneQueue || typeof laneQueue.enqueue !== "function" || typeof laneQueue.dequeue !== "function") {
    throw new Error("laneQueue.enqueue/dequeue are required");
  }
  if (typeof laneQueue.peek !== "function") {
    throw new Error("laneQueue.peek is required");
  }
  if (!roleRouter || typeof roleRouter.dispatch !== "function") {
    throw new Error("roleRouter.dispatch is required");
  }
  if (synthesisMode !== "orchestrator_aggregation") {
    const error = new Error(`Unsupported mission synthesis mode '${synthesisMode}'`);
    error.code = "PHASE18_SYNTHESIS_MODE_UNSUPPORTED";
    throw error;
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

  function normalizeQueuedSubtask(queued = {}) {
    return canonicalize(queued.task_envelope || queued.envelope && queued.envelope.task_envelope || {});
  }

  function buildLaneLimitMap(spawnPlan) {
    const limits = new Map();
    for (const lane of Array.isArray(spawnPlan.lanes) ? spawnPlan.lanes : []) {
      const laneKey = safeString(lane.lane_key || lane.laneKey);
      if (!laneKey) {
        continue;
      }
      limits.set(laneKey, normalizePositiveInteger(lane.max_inflight, 1));
    }
    return limits;
  }

  function buildConcurrencyLimitMap(spawnPlan, laneLimitMap) {
    const limits = new Map();
    for (const lane of Array.isArray(spawnPlan.lanes) ? spawnPlan.lanes : []) {
      const laneKey = safeString(lane.lane_key || lane.laneKey);
      const concurrencyKey = safeString(lane.concurrency_key || lane.concurrencyKey) || laneKey;
      if (!concurrencyKey) {
        continue;
      }
      const laneLimit = normalizePositiveInteger(lane.max_inflight, laneLimitMap.get(laneKey) || 1);
      if (!limits.has(concurrencyKey)) {
        limits.set(concurrencyKey, laneLimit);
        continue;
      }
      limits.set(concurrencyKey, Math.min(limits.get(concurrencyKey), laneLimit));
    }
    return limits;
  }

  function incrementCounter(counterMap, key) {
    const normalizedKey = safeString(key);
    if (!normalizedKey) {
      return;
    }
    const current = Number(counterMap.get(normalizedKey) || 0);
    counterMap.set(normalizedKey, current + 1);
  }

  function decrementCounter(counterMap, key) {
    const normalizedKey = safeString(key);
    if (!normalizedKey) {
      return;
    }
    const current = Number(counterMap.get(normalizedKey) || 0);
    const next = Math.max(0, current - 1);
    if (next === 0) {
      counterMap.delete(normalizedKey);
      return;
    }
    counterMap.set(normalizedKey, next);
  }

  async function executePlan(spawnPlan, context = {}) {
    const missionEnvelope = spawnPlan.mission;
    const missionId = safeString(missionEnvelope.mission_id);
    const sessionId = safeString(missionEnvelope.session_id) || missionEnvelope.mission_id;
    const results = new Map();
    const laneLimitByKey = buildLaneLimitMap(spawnPlan);
    const concurrencyLimitByKey = buildConcurrencyLimitMap(spawnPlan, laneLimitByKey);
    const laneInflight = new Map();
    const concurrencyInflight = new Map();
    const completedSubtasks = new Set();
    const failedSubtasks = new Set();
    const inFlight = new Set();
    let fatalError = null;

    const orderedSubtasks = spawnPlan.subtasks
      .slice()
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

    function dependenciesSatisfied(subtask) {
      const dependencies = Array.isArray(subtask.depends_on) ? subtask.depends_on : [];
      for (const dependencyId of dependencies) {
        if (!completedSubtasks.has(safeString(dependencyId))) {
          return false;
        }
      }
      return true;
    }

    function hasFailedDependency(subtask) {
      const dependencies = Array.isArray(subtask.depends_on) ? subtask.depends_on : [];
      for (const dependencyId of dependencies) {
        if (failedSubtasks.has(safeString(dependencyId))) {
          return true;
        }
      }
      return false;
    }

    function canDispatch(subtask) {
      if (hasFailedDependency(subtask)) {
        return false;
      }
      if (!dependenciesSatisfied(subtask)) {
        return false;
      }
      const laneKey = safeString(subtask.lane_key || subtask.laneKey) || `${missionId}:default-lane`;
      const laneLimit = laneLimitByKey.get(laneKey) || 1;
      const currentLaneInflight = Number(laneInflight.get(laneKey) || 0);
      if (currentLaneInflight >= laneLimit) {
        return false;
      }
      const concurrencyKey = safeString(subtask.concurrency_key || subtask.concurrencyKey || laneKey);
      const concurrencyLimit = concurrencyLimitByKey.get(concurrencyKey) || laneLimit;
      const currentConcurrencyInflight = Number(concurrencyInflight.get(concurrencyKey) || 0);
      if (currentConcurrencyInflight >= concurrencyLimit) {
        return false;
      }
      return true;
    }

    function trackInFlight(promise) {
      const wrapped = promise
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error }));
      inFlight.add(wrapped);
      wrapped.finally(() => {
        inFlight.delete(wrapped);
      });
      return wrapped;
    }

    function drainSessionQueue() {
      while (laneQueue.dequeue(sessionId)) {
        // No-op: pending mission tasks are represented durably by open loops.
      }
    }

    for (const subtask of orderedSubtasks) {
      laneQueue.enqueue(sessionId, {
        mission_id: missionId,
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
        missionId,
        agentId: subtask.agent_id,
        laneKey: subtask.lane_key
      }, { path: runtimeStatePath });
    }

    async function runSubtask(subtask) {
      const subtaskId = safeString(subtask.subtask_id || subtask.subtaskId);
      const laneKey = safeString(subtask.lane_key || subtask.laneKey) || `${missionId}:default-lane`;
      const concurrencyKey = safeString(subtask.concurrency_key || subtask.concurrencyKey || laneKey);
      const missionPaths = resolveMissionPaths(missionBasePath, missionId, subtask.agent_id);
      const dispatchEnvelope = canonicalize({
        agent_id: subtask.agent_id,
        subtask_id: subtaskId,
        mission_id: missionId,
        role: subtask.role,
        actionType: subtask.action_type,
        type: subtask.task_type,
        description: subtask.description,
        inputs: buildSubtaskInputs(missionEnvelope, subtask, results),
        outputFormat: subtask.output_format,
        constraints: canonicalize({
          ...(subtask.constraints || {}),
          mission_id: missionId,
          agent_id: subtask.agent_id,
          subtask_id: subtaskId
        }),
        createdAt: missionEnvelope.created_at
      });

      incrementCounter(laneInflight, laneKey);
      incrementCounter(concurrencyInflight, concurrencyKey);

      let reported = false;
      const emitReported = (normalizedResult) => {
        if (reported) {
          return;
        }
        reported = true;
        if (commsBus && typeof commsBus.writeOutboxMessage === "function") {
          commsBus.writeOutboxMessage(subtask.role, canonicalize({
            mission_id: missionId,
            agent_id: subtask.agent_id,
            subtask_id: subtaskId,
            phase18_projection: true,
            status: "reported",
            result: normalizedResult
          }));
        }
        if (missionPaths.agentOutboxPath) {
          appendJsonl(missionPaths.agentOutboxPath, canonicalize({
            timestamp: safeString(timeProvider.nowIso()),
            status: "reported",
            result: normalizedResult
          }));
        }
      };

      try {
        if (commsBus && typeof commsBus.writeInboxMessage === "function") {
          commsBus.writeInboxMessage(subtask.role, canonicalize({
            mission_id: missionId,
            agent_id: subtask.agent_id,
            subtask_id: subtaskId,
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

        if (commsBus && typeof commsBus.appendBlackboard === "function") {
          commsBus.appendBlackboard(canonicalize({
            mission_id: missionId,
            agent_id: subtask.agent_id,
            subtask_id: subtaskId,
            status: "running"
          }));
        }

        const routed = await roleRouter.dispatch(dispatchEnvelope, context);
        const rawResult = routed && routed.result ? routed.result : {};
        const taskResult = rawResult && rawResult.result ? rawResult.result : rawResult;
        const normalizedResult = canonicalize({
          ...taskResult,
          subtask_id: subtaskId,
          agent_id: subtask.agent_id,
          mission_id: missionId,
          status: safeString(taskResult.status) || "completed"
        });
        results.set(subtaskId, normalizedResult);

        emitReported(normalizedResult);
        if (commsBus && typeof commsBus.appendBlackboard === "function") {
          commsBus.appendBlackboard(canonicalize({
            mission_id: missionId,
            agent_id: subtask.agent_id,
            subtask_id: subtaskId,
            status: safeString(normalizedResult.status) || "completed",
            output_path: safeString(normalizedResult.output_path)
          }));
        }
        appendBlackboard(missionPaths.blackboardPath, [
          `- ${safeString(timeProvider.nowIso())} ${subtaskId} ${safeString(normalizedResult.status) || "completed"}`,
          safeString(normalizedResult.output_path) ? `  - output: ${safeString(normalizedResult.output_path)}` : "  - output: unavailable"
        ]);

        if (safeString(normalizedResult.status) === "completed") {
          completedSubtasks.add(subtaskId);
          await resolveOpenLoop(subtaskId, { path: runtimeStatePath });
          return normalizedResult;
        }

        failedSubtasks.add(subtaskId);
        const error = new Error(`Subtask '${subtaskId}' did not complete successfully`);
        error.code = "PHASE18_SUBTASK_FAILED";
        error.subtask_result = normalizedResult;
        throw error;
      } catch (error) {
        failedSubtasks.add(subtaskId);
        if (!results.has(subtaskId)) {
          const failedResult = canonicalize({
            subtask_id: subtaskId,
            agent_id: subtask.agent_id,
            mission_id: missionId,
            status: "failed",
            error_code: safeString(error && error.code) || "PHASE18_SUBTASK_FAILED",
            error_message: safeString(error && error.message) || "Mission subtask execution failed"
          });
          results.set(subtaskId, failedResult);
          emitReported(failedResult);
          if (commsBus && typeof commsBus.appendBlackboard === "function") {
            commsBus.appendBlackboard(canonicalize({
              mission_id: missionId,
              agent_id: subtask.agent_id,
              subtask_id: subtaskId,
              status: "failed"
            }));
          }
          appendBlackboard(missionPaths.blackboardPath, [
            `- ${safeString(timeProvider.nowIso())} ${subtaskId} failed`,
            `  - error: ${safeString(failedResult.error_message)}`
          ]);
        }
        throw error;
      } finally {
        decrementCounter(laneInflight, laneKey);
        decrementCounter(concurrencyInflight, concurrencyKey);
      }
    }

    while (true) {
      while (fatalError === null) {
        const peeked = laneQueue.peek(sessionId);
        if (!peeked) {
          break;
        }
        const nextSubtask = normalizeQueuedSubtask(peeked);
        const nextSubtaskId = safeString(nextSubtask.subtask_id || nextSubtask.subtaskId);
        if (!nextSubtaskId) {
          laneQueue.dequeue(sessionId);
          continue;
        }
        if (hasFailedDependency(nextSubtask)) {
          const dependencyError = new Error(`Subtask '${nextSubtaskId}' has failed dependencies`);
          dependencyError.code = "PHASE18_SUBTASK_DEPENDENCY_FAILED";
          fatalError = dependencyError;
          break;
        }
        if (!dependenciesSatisfied(nextSubtask)) {
          break;
        }
        if (!canDispatch(nextSubtask)) {
          break;
        }
        laneQueue.dequeue(sessionId);
        trackInFlight(runSubtask(nextSubtask));
      }

      if (inFlight.size === 0) {
        const remaining = laneQueue.peek(sessionId);
        if (!remaining) {
          break;
        }
        if (fatalError) {
          break;
        }
        const blocked = normalizeQueuedSubtask(remaining);
        const blockedId = safeString(blocked.subtask_id || blocked.subtaskId);
        if (hasFailedDependency(blocked)) {
          const dependencyError = new Error(`Subtask '${blockedId}' is blocked by failed dependencies`);
          dependencyError.code = "PHASE18_SUBTASK_DEPENDENCY_FAILED";
          fatalError = dependencyError;
          break;
        }
        const deadlockError = new Error(`Subtask '${blockedId}' is not dispatchable and no tasks are in flight`);
        deadlockError.code = "PHASE18_SUBTASK_DEADLOCK";
        fatalError = deadlockError;
        break;
      }

      const settled = await Promise.race(Array.from(inFlight));
      if (!settled.ok && fatalError === null) {
        fatalError = settled.error;
      }
    }

    if (inFlight.size > 0) {
      const settledBatch = await Promise.all(Array.from(inFlight));
      for (const settled of settledBatch) {
        if (!settled.ok && fatalError === null) {
          fatalError = settled.error;
        }
      }
    }

    if (fatalError) {
      drainSessionQueue();
      const orderedFailureResults = orderedSubtasks
        .map((subtask) => results.get(safeString(subtask.subtask_id || subtask.subtaskId)))
        .filter(Boolean);
      const missionError = new Error(`Mission '${missionId}' failed during execution`);
      missionError.code = safeString(fatalError.code) || "PHASE18_MISSION_EXECUTION_FAILED";
      missionError.cause = fatalError;
      missionError.mission_id = missionId;
      missionError.subtask_results = canonicalize(orderedFailureResults);
      throw missionError;
    }

    const orderedResults = orderedSubtasks
      .map((subtask) => results.get(safeString(subtask.subtask_id || subtask.subtaskId)))
      .filter(Boolean);
    const synthesisBody = canonicalize({
      mission_id: missionId,
      template_id: missionEnvelope.template_id,
      synthesis_mode: synthesisMode,
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
      mission_id: missionId,
      synthesis_mode: synthesisMode
    });
    const missionPaths = resolveMissionPaths(missionBasePath, missionId);
    ensureDir(missionPaths.artifactsPath);
    fs.writeFileSync(path.join(missionPaths.artifactsPath, "final-output.json"), canonicalJson(canonicalize({
      ...synthesisBody,
      output_path: finalTask.output_path
    })), "utf8");

    logger.info({
      event: "phase18_plan_executed",
      mission_id: missionId,
      result_count: orderedResults.length,
      synthesis_mode: synthesisMode
    });
    return canonicalize({
      output_path: finalTask.output_path,
      metadata_path: finalTask.metadata_path,
      manifest_path: finalTask.manifest_path,
      results: orderedResults,
      synthesis_mode: synthesisMode
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
