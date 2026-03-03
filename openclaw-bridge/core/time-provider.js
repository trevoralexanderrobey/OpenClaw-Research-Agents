"use strict";

let deterministicNowMs = null;
let deterministicStepMs = 0;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function readEnvFixedNowMs() {
  if (!process.env.OPENCLAW_FIXED_TIME_MS) {
    return null;
  }
  return parseNumber(process.env.OPENCLAW_FIXED_TIME_MS, null);
}

function nowMs() {
  if (deterministicNowMs !== null) {
    const current = deterministicNowMs;
    deterministicNowMs += deterministicStepMs;
    return current;
  }

  const envFixed = readEnvFixedNowMs();
  if (envFixed !== null) {
    return envFixed;
  }

  return Date.now();
}

function nowIso() {
  return new Date(nowMs()).toISOString();
}

function setDeterministicTime(fixedNowMs, stepMs = 0) {
  const normalizedNow = parseNumber(fixedNowMs, null);
  if (normalizedNow === null) {
    const error = new Error("fixedNowMs must be a finite number");
    error.code = "INVALID_TIME_OVERRIDE";
    throw error;
  }
  deterministicNowMs = normalizedNow;
  deterministicStepMs = parseNumber(stepMs, 0);
}

function clearDeterministicTime() {
  deterministicNowMs = null;
  deterministicStepMs = 0;
}

function createTimeProvider(options = {}) {
  const hasFixed = Object.prototype.hasOwnProperty.call(options, "fixedNowMs");
  let localNow = hasFixed ? parseNumber(options.fixedNowMs, null) : null;
  const localStep = parseNumber(options.stepMs, 0);

  function localNowMs() {
    if (localNow !== null) {
      const value = localNow;
      localNow += localStep;
      return value;
    }
    return nowMs();
  }

  return Object.freeze({
    nowMs: localNowMs,
    nowIso() {
      return new Date(localNowMs()).toISOString();
    },
  });
}

module.exports = {
  nowMs,
  nowIso,
  setDeterministicTime,
  clearDeterministicTime,
  createTimeProvider,
};
