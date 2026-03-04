"use strict";

const RESULT_BASE_SIGNAL = Object.freeze({
  accepted: 90,
  rejected: 20,
  revise_requested: 55,
  pending: 0
});

function clampInt(value, min = 0, max = 100) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.max(min, Math.min(max, parsed));
}

function latestOutcomeMap(records = []) {
  const list = Array.isArray(records) ? records : [];
  const map = new Map();
  for (const record of list) {
    const draftSequence = Number(record && record.draftSequence ? record.draftSequence : 0);
    if (draftSequence <= 0) {
      continue;
    }
    const current = map.get(draftSequence);
    if (!current || Number(record.sequence || 0) > Number(current.sequence || 0)) {
      map.set(draftSequence, record);
    }
  }
  return map;
}

function computeOutcomeQualitySignal(outcome) {
  if (!outcome || typeof outcome !== "object") {
    return 0;
  }
  const result = typeof outcome.result === "string" ? outcome.result.trim() : "pending";
  const base = Object.prototype.hasOwnProperty.call(RESULT_BASE_SIGNAL, result) ? RESULT_BASE_SIGNAL[result] : 0;
  if (result === "pending") {
    return 0;
  }
  const score = clampInt(outcome.score, 0, 100);
  return clampInt(Math.floor((score * 0.7) + (base * 0.3)), 0, 100);
}

function computeDraftQualitySignal(input = {}) {
  const draft = input.draft && typeof input.draft === "object" ? input.draft : {};
  const outcome = input.outcome && typeof input.outcome === "object" ? input.outcome : null;

  if (!outcome) {
    return {
      result: "pending",
      score: 0,
      qualitySignal: 0,
      outcomeSequence: 0
    };
  }

  return {
    result: typeof outcome.result === "string" ? outcome.result.trim() : "pending",
    score: clampInt(outcome.score, 0, 100),
    qualitySignal: computeOutcomeQualitySignal(outcome),
    outcomeSequence: clampInt(outcome.sequence, 0, Number.MAX_SAFE_INTEGER)
  };
}

function aggregateResultCounts(records = []) {
  const base = {
    accepted: 0,
    rejected: 0,
    revise_requested: 0,
    pending: 0
  };
  for (const record of records) {
    const key = typeof record.result === "string" ? record.result.trim() : "pending";
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      base[key] += 1;
    } else {
      base.pending += 1;
    }
  }
  return base;
}

module.exports = {
  RESULT_BASE_SIGNAL,
  clampInt,
  latestOutcomeMap,
  computeOutcomeQualitySignal,
  computeDraftQualitySignal,
  aggregateResultCounts
};
