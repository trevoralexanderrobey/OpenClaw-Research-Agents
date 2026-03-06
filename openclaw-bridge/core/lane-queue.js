"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize, canonicalJson } = require("../../workflows/governance-automation/common.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { schema_version: "phase15-lane-queue-v1", sessions: {}, next_sequence: 0 };
    }
    throw error;
  }
}

function writeState(filePath, state) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(state)), "utf8");
}

function normalizeSessionId(sessionId) {
  return safeString(sessionId) || "default";
}

function normalizeQueueEnvelope(envelope = {}) {
  const source = envelope && typeof envelope === "object" ? envelope : {};
  return canonicalize({
    ...source,
    mission_id: safeString(source.mission_id || source.missionId || source.missionID),
    lane_key: safeString(source.lane_key || source.laneKey),
    concurrency_key: safeString(source.concurrency_key || source.concurrencyKey),
    agent_id: safeString(source.agent_id || source.agentId),
    subtask_id: safeString(source.subtask_id || source.subtaskId),
    task_envelope: source.task_envelope && typeof source.task_envelope === "object"
      ? canonicalize(source.task_envelope)
      : source.taskEnvelope && typeof source.taskEnvelope === "object"
        ? canonicalize(source.taskEnvelope)
        : {}
  });
}

function createLaneQueue(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const persistencePath = path.resolve(safeString(options.persistencePath) || path.join(process.cwd(), "workspace", "comms", "events", "lane-queue.json"));

  function mutate(handler) {
    const state = readState(persistencePath);
    const output = handler(state);
    writeState(persistencePath, state);
    return output;
  }

  function enqueue(sessionId, envelope = {}) {
    return mutate((state) => {
      const sid = normalizeSessionId(sessionId);
      if (!state.sessions[sid]) {
        state.sessions[sid] = [];
      }
      const nextSequence = Math.max(0, Number(state.next_sequence || 0)) + 1;
      state.next_sequence = nextSequence;
      const queued = canonicalize({
        queue_sequence: nextSequence,
        session_id: sid,
        enqueued_at: safeString(timeProvider.nowIso()),
        mission_id: safeString(envelope && (envelope.mission_id || envelope.missionId)),
        lane_key: safeString(envelope && (envelope.lane_key || envelope.laneKey)),
        concurrency_key: safeString(envelope && (envelope.concurrency_key || envelope.concurrencyKey)),
        agent_id: safeString(envelope && (envelope.agent_id || envelope.agentId)),
        subtask_id: safeString(envelope && (envelope.subtask_id || envelope.subtaskId)),
        envelope: normalizeQueueEnvelope(envelope)
      });
      state.sessions[sid].push(queued);
      state.sessions[sid].sort((left, right) => Number(left.queue_sequence) - Number(right.queue_sequence));
      logger.info({ event: "phase15_lane_enqueue", session_id: sid, queue_sequence: nextSequence });
      return queued;
    });
  }

  function dequeue(sessionId) {
    return mutate((state) => {
      const sid = normalizeSessionId(sessionId);
      const queue = Array.isArray(state.sessions[sid]) ? state.sessions[sid] : [];
      if (queue.length === 0) {
        return null;
      }
      queue.sort((left, right) => Number(left.queue_sequence) - Number(right.queue_sequence));
      const item = queue.shift() || null;
      state.sessions[sid] = queue;
      logger.info({ event: "phase15_lane_dequeue", session_id: sid, queue_sequence: item ? item.queue_sequence : -1 });
      return item;
    });
  }

  function peek(sessionId) {
    const state = readState(persistencePath);
    const sid = normalizeSessionId(sessionId);
    const queue = Array.isArray(state.sessions[sid]) ? state.sessions[sid].slice() : [];
    queue.sort((left, right) => Number(left.queue_sequence) - Number(right.queue_sequence));
    return queue[0] || null;
  }

  function getQueueState(sessionId) {
    const state = readState(persistencePath);
    const sid = normalizeSessionId(sessionId);
    const queue = Array.isArray(state.sessions[sid]) ? state.sessions[sid].slice() : [];
    queue.sort((left, right) => Number(left.queue_sequence) - Number(right.queue_sequence));
    return canonicalize({
      session_id: sid,
      queue_length: queue.length,
      items: queue
    });
  }

  function getMissionQueueState(missionId) {
    const state = readState(persistencePath);
    const normalizedMissionId = safeString(missionId);
    const items = [];
    for (const queue of Object.values(state.sessions || {})) {
      for (const entry of Array.isArray(queue) ? queue : []) {
        if (safeString(entry.mission_id || entry.envelope && entry.envelope.mission_id) !== normalizedMissionId) {
          continue;
        }
        items.push(canonicalize(entry));
      }
    }
    items.sort((left, right) => Number(left.queue_sequence || 0) - Number(right.queue_sequence || 0));
    return canonicalize({
      mission_id: normalizedMissionId,
      queue_length: items.length,
      items
    });
  }

  return Object.freeze({
    enqueue,
    dequeue,
    peek,
    getQueueState,
    getMissionQueueState,
    persistencePath
  });
}

module.exports = {
  createLaneQueue
};
