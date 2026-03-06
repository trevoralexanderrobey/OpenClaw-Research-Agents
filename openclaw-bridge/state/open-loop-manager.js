"use strict";

const { loadRuntimeState } = require("./persistent-store.js");
const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");

function createOpenLoopManager(options = {}) {
  const statePath = options.path || "state/runtime/state.json";
  const laneQueue = options.laneQueue || null;

  async function loadRuntimePayload() {
    const loaded = await loadRuntimeState({ path: statePath });
    const state = loaded && loaded.state && typeof loaded.state === "object" ? loaded.state : {};
    if (!Array.isArray(state.openLoops)) {
      state.openLoops = [];
    }
    return state;
  }

  async function listOpenLoops() {
    const state = await loadRuntimePayload();
    return canonicalize(state.openLoops.slice().sort((left, right) => String(left.loopId || "").localeCompare(String(right.loopId || ""))));
  }

  async function requeueOpenLoops() {
    const loops = await listOpenLoops();
    const requeued = [];

    if (!laneQueue || typeof laneQueue.enqueue !== "function") {
      return canonicalize({ ok: true, requeued_count: 0, requeued });
    }

    for (const loop of loops.slice().sort((left, right) => String(left.loopId || "").localeCompare(String(right.loopId || "")))) {
      const sessionId = safeString(loop.sessionId) || "default";
      const taskEnvelope = loop && typeof loop.taskEnvelope === "object" && loop.taskEnvelope
        ? canonicalize(loop.taskEnvelope)
        : {};
      const enqueued = laneQueue.enqueue(sessionId, {
        loopId: String(loop.loopId || ""),
        mission_id: safeString(loop.missionId || loop.mission_id),
        agent_id: safeString(loop.agentId || loop.agent_id),
        lane_key: safeString(loop.laneKey || loop.lane_key),
        taskEnvelope,
        resume: true
      });
      requeued.push({
        session_id: sessionId,
        queue_sequence: enqueued.queue_sequence,
        loop_id: String(loop.loopId || ""),
        mission_id: safeString(loop.missionId || loop.mission_id),
        agent_id: safeString(loop.agentId || loop.agent_id),
        lane_key: safeString(loop.laneKey || loop.lane_key),
        task_envelope: taskEnvelope
      });
    }

    requeued.sort((left, right) => Number(left.queue_sequence || 0) - Number(right.queue_sequence || 0));
    return canonicalize({ ok: true, requeued_count: requeued.length, requeued });
  }

  return Object.freeze({
    listOpenLoops,
    requeueOpenLoops
  });
}

module.exports = {
  createOpenLoopManager
};
