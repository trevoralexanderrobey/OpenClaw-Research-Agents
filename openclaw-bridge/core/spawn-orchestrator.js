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

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Number(fallback) || 0);
  }
  return Math.max(0, Math.floor(parsed));
}

function sleep(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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
  const missionRuntimeConfig = options.missionRuntimeConfig && typeof options.missionRuntimeConfig === "object" ? options.missionRuntimeConfig : {};
  const checkpointConfig = options.checkpointConfig && typeof options.checkpointConfig === "object" ? options.checkpointConfig : {};
  const laneScalingConfig = options.laneScalingConfig && typeof options.laneScalingConfig === "object" ? options.laneScalingConfig : {};
  const defaultMissionMaxRuntimeMs = normalizeNonNegativeInteger(missionRuntimeConfig.maxRuntimeMs, 0);
  const defaultSubtaskTimeoutMs = normalizeNonNegativeInteger(missionRuntimeConfig.defaultSubtaskTimeoutMs, 0);
  const defaultStallIntervalMs = normalizeNonNegativeInteger(missionRuntimeConfig.stallIntervalMs, 0);
  const defaultSchedulerTickMs = normalizePositiveInteger(missionRuntimeConfig.schedulerTickMs, 50);
  const defaultCheckpointEnabled = checkpointConfig.enabled !== false;
  const defaultCheckpointThreshold = normalizeNonNegativeInteger(checkpointConfig.completedSubtaskThreshold, 0);
  const defaultCheckpointStageBoundaries = checkpointConfig.stageBoundaries !== false;
  const defaultLaneScalingEnabled = laneScalingConfig.enabled !== false;
  const defaultLaneScaleStep = normalizePositiveInteger(laneScalingConfig.scaleStep, 1);

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

  function nowMs() {
    const parsed = Date.parse(safeString(timeProvider.nowIso()));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    return 0;
  }

  function normalizeQueuedSubtask(queued = {}) {
    return canonicalize(queued.task_envelope || queued.envelope && queued.envelope.task_envelope || {});
  }

  function resolveRuntimeSettings(spawnPlan) {
    const runtime = spawnPlan && spawnPlan.runtime && typeof spawnPlan.runtime === "object" ? spawnPlan.runtime : {};
    const runtimeCheckpoint = runtime && runtime.checkpointing && typeof runtime.checkpointing === "object" ? runtime.checkpointing : {};
    const runtimeLaneScaling = runtime && runtime.lane_scaling && typeof runtime.lane_scaling === "object" ? runtime.lane_scaling : {};
    return canonicalize({
      mission_max_runtime_ms: normalizeNonNegativeInteger(runtime.mission_max_runtime_ms, defaultMissionMaxRuntimeMs),
      default_subtask_timeout_ms: normalizeNonNegativeInteger(runtime.default_subtask_timeout_ms, defaultSubtaskTimeoutMs),
      stall_interval_ms: normalizeNonNegativeInteger(runtime.stall_interval_ms, defaultStallIntervalMs),
      scheduler_tick_ms: normalizePositiveInteger(runtime.scheduler_tick_ms, defaultSchedulerTickMs),
      checkpointing: canonicalize({
        enabled: runtimeCheckpoint.enabled !== false && defaultCheckpointEnabled !== false,
        completed_subtask_threshold: normalizeNonNegativeInteger(runtimeCheckpoint.completed_subtask_threshold, defaultCheckpointThreshold),
        stage_boundaries: runtimeCheckpoint.stage_boundaries !== false && defaultCheckpointStageBoundaries !== false
      }),
      lane_scaling: canonicalize({
        enabled: runtimeLaneScaling.enabled !== false && defaultLaneScalingEnabled !== false,
        scale_step: normalizePositiveInteger(runtimeLaneScaling.scale_step, defaultLaneScaleStep)
      })
    });
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

  function buildLaneStateMap(spawnPlan) {
    const laneStates = new Map();
    for (const lane of Array.isArray(spawnPlan.lanes) ? spawnPlan.lanes : []) {
      const laneKey = safeString(lane.lane_key || lane.laneKey);
      if (!laneKey) {
        continue;
      }
      const minInflight = normalizePositiveInteger(lane.min_inflight, 1);
      const maxInflight = Math.max(minInflight, normalizePositiveInteger(lane.max_inflight, minInflight));
      const initialInflight = Math.min(maxInflight, Math.max(minInflight, normalizePositiveInteger(lane.initial_inflight, minInflight)));
      laneStates.set(laneKey, canonicalize({
        lane_key: laneKey,
        role: safeString(lane.role),
        order: normalizePositiveInteger(lane.order, laneStates.size + 1),
        concurrency_key: safeString(lane.concurrency_key || lane.concurrencyKey) || laneKey,
        min_inflight: minInflight,
        max_inflight: maxInflight,
        current_inflight: initialInflight
      }));
    }
    return laneStates;
  }

  function ensureLaneState(laneStateByKey, laneKey, concurrencyKey) {
    const normalizedLaneKey = safeString(laneKey);
    if (laneStateByKey.has(normalizedLaneKey)) {
      return laneStateByKey.get(normalizedLaneKey);
    }
    const fallback = canonicalize({
      lane_key: normalizedLaneKey,
      role: "",
      order: laneStateByKey.size + 1,
      concurrency_key: safeString(concurrencyKey) || normalizedLaneKey,
      min_inflight: 1,
      max_inflight: 1,
      current_inflight: 1
    });
    laneStateByKey.set(normalizedLaneKey, fallback);
    return fallback;
  }

  function buildCurrentConcurrencyLimitMap(laneStateByKey) {
    const limits = new Map();
    for (const laneState of laneStateByKey.values()) {
      const concurrencyKey = safeString(laneState.concurrency_key) || safeString(laneState.lane_key);
      const laneLimit = normalizePositiveInteger(laneState.current_inflight, 1);
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

  function computeSubtaskStages(orderedSubtasks) {
    const stageBySubtaskId = new Map();
    const stageMembers = new Map();
    for (const subtask of orderedSubtasks) {
      const subtaskId = safeString(subtask.subtask_id || subtask.subtaskId);
      if (!subtaskId) {
        continue;
      }
      const dependencies = Array.isArray(subtask.depends_on) ? subtask.depends_on : [];
      let stage = 1;
      for (const dependencyId of dependencies) {
        const dependencyStage = Number(stageBySubtaskId.get(safeString(dependencyId)) || 0);
        stage = Math.max(stage, dependencyStage + 1);
      }
      stageBySubtaskId.set(subtaskId, stage);
      if (!stageMembers.has(stage)) {
        stageMembers.set(stage, []);
      }
      stageMembers.get(stage).push(subtaskId);
    }
    return { stageBySubtaskId, stageMembers };
  }

  async function executePlan(spawnPlan, context = {}) {
    const missionEnvelope = spawnPlan.mission;
    const missionId = safeString(missionEnvelope.mission_id);
    const sessionId = safeString(missionEnvelope.session_id) || missionEnvelope.mission_id;
    const missionPathsRoot = resolveMissionPaths(missionBasePath, missionId);
    const runtimeSettings = resolveRuntimeSettings(spawnPlan);
    const results = new Map();
    const laneStateByKey = buildLaneStateMap(spawnPlan);
    let concurrencyLimitByKey = buildCurrentConcurrencyLimitMap(laneStateByKey);
    const laneInflight = new Map();
    const concurrencyInflight = new Map();
    const completedSubtasks = new Set();
    const failedSubtasks = new Set();
    const inFlight = new Set();
    const laneScalingEvents = [];
    const checkpointArtifacts = [];
    const writtenCheckpointIds = new Set();
    let nextCheckpointThreshold = runtimeSettings.checkpointing.completed_subtask_threshold;
    let fatalError = null;
    const missionStartedAtMs = nowMs();
    let lastProgressAtMs = missionStartedAtMs;

    const orderedSubtasks = spawnPlan.subtasks
      .slice()
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
    const { stageBySubtaskId, stageMembers } = computeSubtaskStages(orderedSubtasks);

    function makeMissionError(code, message, details = {}) {
      const error = new Error(message);
      error.code = code;
      for (const [key, value] of Object.entries(details)) {
        error[key] = value;
      }
      return error;
    }

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

    function ensureLaneForSubtask(subtask) {
      const laneKey = safeString(subtask.lane_key || subtask.laneKey) || `${missionId}:default-lane`;
      const fallbackConcurrencyKey = safeString(subtask.concurrency_key || subtask.concurrencyKey || laneKey);
      const laneState = ensureLaneState(laneStateByKey, laneKey, fallbackConcurrencyKey);
      if (!concurrencyLimitByKey.has(safeString(laneState.concurrency_key))) {
        concurrencyLimitByKey = buildCurrentConcurrencyLimitMap(laneStateByKey);
      }
      return laneState;
    }

    function canDispatch(subtask) {
      if (hasFailedDependency(subtask)) {
        return false;
      }
      if (!dependenciesSatisfied(subtask)) {
        return false;
      }
      const laneState = ensureLaneForSubtask(subtask);
      const laneKey = safeString(laneState.lane_key);
      const laneLimit = normalizePositiveInteger(laneState.current_inflight, 1);
      const currentLaneInflight = Number(laneInflight.get(laneKey) || 0);
      if (currentLaneInflight >= laneLimit) {
        return false;
      }
      const concurrencyKey = safeString(laneState.concurrency_key) || laneKey;
      const concurrencyLimit = Number(concurrencyLimitByKey.get(concurrencyKey) || laneLimit);
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
        // Pending mission tasks remain durable in open loops.
      }
    }

    function buildCompletedCheckpointResults() {
      return orderedSubtasks
        .map((subtask) => {
          const subtaskId = safeString(subtask.subtask_id || subtask.subtaskId);
          const result = results.get(subtaskId);
          if (!result || safeString(result.status) !== "completed") {
            return null;
          }
          return canonicalize({
            subtask_id: subtaskId,
            role: safeString(subtask.role),
            agent_id: safeString(subtask.agent_id),
            output_path: safeString(result.output_path)
          });
        })
        .filter(Boolean);
    }

    function writeCheckpoint(triggerType, triggerValue) {
      if (!runtimeSettings.checkpointing.enabled) {
        return;
      }
      const completedResults = buildCompletedCheckpointResults();
      if (completedResults.length === 0) {
        return;
      }
      const checkpointId = `checkpoint-${safeString(triggerType)}-${String(triggerValue).padStart(4, "0")}`;
      if (writtenCheckpointIds.has(checkpointId)) {
        return;
      }
      const checkpointDir = path.join(missionPathsRoot.artifactsPath, "checkpoints");
      ensureDir(checkpointDir);
      const checkpointPath = path.join(checkpointDir, `${checkpointId}.json`);
      const checkpointBody = canonicalize({
        schema_version: "phase18-checkpoint-v1",
        mission_id: missionId,
        checkpoint_id: checkpointId,
        trigger: canonicalize({
          type: safeString(triggerType),
          value: triggerValue
        }),
        completed_subtask_count: completedResults.length,
        generated_at: safeString(timeProvider.nowIso()),
        completed_results: completedResults
      });
      fs.writeFileSync(checkpointPath, canonicalJson(checkpointBody), "utf8");
      writtenCheckpointIds.add(checkpointId);
      checkpointArtifacts.push(canonicalize({
        checkpoint_id: checkpointId,
        path: checkpointPath,
        trigger_type: safeString(triggerType),
        trigger_value: triggerValue,
        completed_subtask_count: completedResults.length
      }));

      if (commsBus && typeof commsBus.appendBlackboard === "function") {
        commsBus.appendBlackboard(canonicalize({
          mission_id: missionId,
          status: "checkpoint_written",
          checkpoint_id: checkpointId,
          checkpoint_path: checkpointPath
        }));
      }
      appendBlackboard(missionPathsRoot.blackboardPath, [
        `- ${safeString(timeProvider.nowIso())} checkpoint ${checkpointId}`,
        `  - path: ${checkpointPath}`
      ]);
    }

    function contiguousCompletedCount() {
      let count = 0;
      for (const subtask of orderedSubtasks) {
        const subtaskId = safeString(subtask.subtask_id || subtask.subtaskId);
        if (!completedSubtasks.has(subtaskId)) {
          break;
        }
        count += 1;
      }
      return count;
    }

    function maybeWriteCheckpointsForSubtask(subtaskId) {
      if (!runtimeSettings.checkpointing.enabled) {
        return;
      }

      if (runtimeSettings.checkpointing.stage_boundaries) {
        const stage = Number(stageBySubtaskId.get(subtaskId) || 0);
        if (stage > 0) {
          const members = Array.isArray(stageMembers.get(stage)) ? stageMembers.get(stage) : [];
          if (members.length > 0 && members.every((memberId) => completedSubtasks.has(safeString(memberId)))) {
            writeCheckpoint("stage", stage);
          }
        }
      }

      const threshold = Number(runtimeSettings.checkpointing.completed_subtask_threshold || 0);
      if (threshold > 0) {
        const contiguousCount = contiguousCompletedCount();
        while (nextCheckpointThreshold > 0 && contiguousCount >= nextCheckpointThreshold) {
          writeCheckpoint("threshold", nextCheckpointThreshold);
          nextCheckpointThreshold += threshold;
        }
      }
    }

    function queueItemsForSession() {
      if (typeof laneQueue.getQueueState === "function") {
        const queueState = laneQueue.getQueueState(sessionId);
        return Array.isArray(queueState.items) ? queueState.items : [];
      }
      const head = laneQueue.peek(sessionId);
      return head ? [head] : [];
    }

    function countReadyQueuedByLane() {
      const counts = new Map();
      const queueItems = queueItemsForSession()
        .slice()
        .sort((left, right) => Number(left.queue_sequence || 0) - Number(right.queue_sequence || 0));
      for (const queued of queueItems) {
        const subtask = normalizeQueuedSubtask(queued);
        const subtaskId = safeString(subtask.subtask_id || subtask.subtaskId);
        if (!subtaskId || hasFailedDependency(subtask) || !dependenciesSatisfied(subtask)) {
          continue;
        }
        const laneState = ensureLaneForSubtask(subtask);
        const laneKey = safeString(laneState.lane_key);
        counts.set(laneKey, Number(counts.get(laneKey) || 0) + 1);
      }
      return counts;
    }

    function recordLaneScalingEvent(event) {
      const normalized = canonicalize(event);
      laneScalingEvents.push(normalized);
      if (commsBus && typeof commsBus.appendBlackboard === "function") {
        commsBus.appendBlackboard(canonicalize({
          mission_id: missionId,
          status: "lane_scaled",
          lane_key: normalized.lane_key,
          previous_inflight: normalized.previous_inflight,
          next_inflight: normalized.next_inflight,
          reason: normalized.reason
        }));
      }
      appendBlackboard(missionPathsRoot.blackboardPath, [
        `- ${safeString(normalized.timestamp)} lane ${safeString(normalized.lane_key)} scaled ${Number(normalized.previous_inflight)} -> ${Number(normalized.next_inflight)}`,
        `  - reason: ${safeString(normalized.reason)}`
      ]);
    }

    function applyLaneScalingIfNeeded() {
      if (!runtimeSettings.lane_scaling.enabled) {
        return;
      }
      const readyByLane = countReadyQueuedByLane();
      let updated = false;
      for (const laneState of laneStateByKey.values()) {
        const laneKey = safeString(laneState.lane_key);
        const readyQueued = Number(readyByLane.get(laneKey) || 0);
        const inFlightCount = Number(laneInflight.get(laneKey) || 0);
        const previousInflight = Number(laneState.current_inflight || 1);
        let nextInflight = previousInflight;
        let reason = "";

        if (readyQueued > previousInflight && previousInflight < Number(laneState.max_inflight)) {
          nextInflight = Math.min(Number(laneState.max_inflight), previousInflight + Number(runtimeSettings.lane_scaling.scale_step || 1));
          reason = "scale_up_queue_pressure";
        } else if (readyQueued === 0 && inFlightCount === 0 && previousInflight > Number(laneState.min_inflight)) {
          nextInflight = Math.max(Number(laneState.min_inflight), previousInflight - Number(runtimeSettings.lane_scaling.scale_step || 1));
          reason = "scale_down_idle";
        }

        if (nextInflight !== previousInflight) {
          laneState.current_inflight = nextInflight;
          updated = true;
          recordLaneScalingEvent({
            timestamp: safeString(timeProvider.nowIso()),
            lane_key: laneKey,
            previous_inflight: previousInflight,
            next_inflight: nextInflight,
            reason,
            ready_queued: readyQueued,
            in_flight: inFlightCount
          });
        }
      }
      if (updated) {
        concurrencyLimitByKey = buildCurrentConcurrencyLimitMap(laneStateByKey);
      }
    }

    function evaluateExecutionGuards() {
      const currentMs = nowMs();
      const queueHasPending = Boolean(laneQueue.peek(sessionId));
      if (runtimeSettings.mission_max_runtime_ms > 0 && currentMs - missionStartedAtMs >= runtimeSettings.mission_max_runtime_ms) {
        return makeMissionError(
          "PHASE18_MISSION_TIMEOUT",
          `Mission '${missionId}' exceeded max runtime (${runtimeSettings.mission_max_runtime_ms} ms)`,
          {
            mission_id: missionId,
            timeout_ms: runtimeSettings.mission_max_runtime_ms,
            status_hint: "paused"
          }
        );
      }
      if (runtimeSettings.stall_interval_ms > 0 && queueHasPending && currentMs - lastProgressAtMs >= runtimeSettings.stall_interval_ms) {
        return makeMissionError(
          "PHASE18_MISSION_STALLED",
          `Mission '${missionId}' stalled with queued work for ${runtimeSettings.stall_interval_ms} ms`,
          {
            mission_id: missionId,
            stall_interval_ms: runtimeSettings.stall_interval_ms,
            status_hint: "paused"
          }
        );
      }
      return null;
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
      const laneState = ensureLaneForSubtask(subtask);
      const laneKey = safeString(laneState.lane_key);
      const concurrencyKey = safeString(laneState.concurrency_key) || laneKey;
      const missionPaths = resolveMissionPaths(missionBasePath, missionId, subtask.agent_id);
      const subtaskTimeoutMs = normalizeNonNegativeInteger(subtask.timeout_ms, runtimeSettings.default_subtask_timeout_ms);
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
          subtask_id: subtaskId,
          timeout_ms: subtaskTimeoutMs
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

        const dispatchPromise = roleRouter.dispatch(dispatchEnvelope, context);
        let routed;
        if (subtaskTimeoutMs > 0) {
          dispatchPromise.catch(() => {});
          routed = await Promise.race([
            dispatchPromise,
            sleep(subtaskTimeoutMs).then(() => {
              const timeoutError = new Error(`Subtask '${subtaskId}' exceeded timeout (${subtaskTimeoutMs} ms)`);
              timeoutError.code = "PHASE18_SUBTASK_TIMEOUT";
              timeoutError.timeout_ms = subtaskTimeoutMs;
              timeoutError.status_hint = "paused";
              throw timeoutError;
            })
          ]);
        } else {
          routed = await dispatchPromise;
        }

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
          maybeWriteCheckpointsForSubtask(subtaskId);
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
          const status = safeString(error && error.code) === "PHASE18_SUBTASK_TIMEOUT" ? "paused" : "failed";
          const failedResult = canonicalize({
            subtask_id: subtaskId,
            agent_id: subtask.agent_id,
            mission_id: missionId,
            status,
            error_code: safeString(error && error.code) || "PHASE18_SUBTASK_FAILED",
            error_message: safeString(error && error.message) || "Mission subtask execution failed",
            timeout_ms: normalizeNonNegativeInteger(error && error.timeout_ms, 0)
          });
          results.set(subtaskId, failedResult);
          emitReported(failedResult);
          if (commsBus && typeof commsBus.appendBlackboard === "function") {
            commsBus.appendBlackboard(canonicalize({
              mission_id: missionId,
              agent_id: subtask.agent_id,
              subtask_id: subtaskId,
              status
            }));
          }
          appendBlackboard(missionPaths.blackboardPath, [
            `- ${safeString(timeProvider.nowIso())} ${subtaskId} ${status}`,
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
      applyLaneScalingIfNeeded();
      if (fatalError === null) {
        const guardError = evaluateExecutionGuards();
        if (guardError) {
          fatalError = guardError;
        }
      }

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
          fatalError = makeMissionError(
            "PHASE18_SUBTASK_DEPENDENCY_FAILED",
            `Subtask '${nextSubtaskId}' has failed dependencies`
          );
          break;
        }
        if (!dependenciesSatisfied(nextSubtask)) {
          break;
        }
        if (!canDispatch(nextSubtask)) {
          break;
        }
        laneQueue.dequeue(sessionId);
        lastProgressAtMs = nowMs();
        trackInFlight(runSubtask(nextSubtask));
      }

      if (fatalError) {
        break;
      }

      if (inFlight.size === 0) {
        const remaining = laneQueue.peek(sessionId);
        if (!remaining) {
          break;
        }
        const guardError = evaluateExecutionGuards();
        if (guardError) {
          fatalError = guardError;
          break;
        }
        const blocked = normalizeQueuedSubtask(remaining);
        const blockedId = safeString(blocked.subtask_id || blocked.subtaskId);
        if (hasFailedDependency(blocked)) {
          fatalError = makeMissionError(
            "PHASE18_SUBTASK_DEPENDENCY_FAILED",
            `Subtask '${blockedId}' is blocked by failed dependencies`
          );
          break;
        }
        fatalError = makeMissionError(
          "PHASE18_SUBTASK_DEADLOCK",
          `Subtask '${blockedId}' is not dispatchable and no tasks are in flight`
        );
        break;
      }

      const settled = await Promise.race([
        Promise.race(Array.from(inFlight)),
        sleep(runtimeSettings.scheduler_tick_ms).then(() => ({ ok: true, heartbeat: true }))
      ]);

      if (settled && settled.heartbeat) {
        applyLaneScalingIfNeeded();
        const guardError = evaluateExecutionGuards();
        if (guardError && fatalError === null) {
          fatalError = guardError;
        }
        continue;
      }

      lastProgressAtMs = nowMs();
      if (!settled.ok && fatalError === null) {
        fatalError = settled.error;
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
      missionError.lane_scaling_events = canonicalize(laneScalingEvents);
      missionError.checkpoint_artifacts = canonicalize(checkpointArtifacts);
      missionError.status_hint = safeString(fatalError.status_hint);
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
      lane_scaling_event_count: laneScalingEvents.length,
      checkpoint_count: checkpointArtifacts.length,
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
    ensureDir(missionPathsRoot.artifactsPath);
    fs.writeFileSync(path.join(missionPathsRoot.artifactsPath, "final-output.json"), canonicalJson(canonicalize({
      ...synthesisBody,
      output_path: finalTask.output_path
    })), "utf8");

    logger.info({
      event: "phase18_plan_executed",
      mission_id: missionId,
      result_count: orderedResults.length,
      synthesis_mode: synthesisMode,
      checkpoint_count: checkpointArtifacts.length,
      lane_scaling_event_count: laneScalingEvents.length
    });
    return canonicalize({
      output_path: finalTask.output_path,
      metadata_path: finalTask.metadata_path,
      manifest_path: finalTask.manifest_path,
      results: orderedResults,
      synthesis_mode: synthesisMode,
      lane_scaling_events: laneScalingEvents,
      checkpoint_artifacts: checkpointArtifacts
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
