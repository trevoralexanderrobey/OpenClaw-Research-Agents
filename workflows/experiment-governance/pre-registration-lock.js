"use strict";

const crypto = require("node:crypto");

const PREREG_HASH_PREFIX = "phase7-prereg-v1|";
const LOCKED_FIELDS_AFTER_START = Object.freeze([
  "treatment",
  "control",
  "guardrails",
  "window",
  "analysisPlanVersion"
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 7 pre-registration lock error"));
  error.code = String(code || "EXPERIMENT_PREREG_LOCK_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function extractPreRegistrationFields(experiment = {}) {
  return canonicalize({
    treatment: isPlainObject(experiment.treatment) ? experiment.treatment : {},
    control: isPlainObject(experiment.control) ? experiment.control : {},
    guardrails: isPlainObject(experiment.guardrails) ? experiment.guardrails : {},
    window: isPlainObject(experiment.window) ? experiment.window : {},
    analysisPlanVersion: typeof experiment.analysisPlanVersion === "string"
      ? experiment.analysisPlanVersion
      : "v1"
  });
}

function computePreRegistrationLockHash(experiment = {}) {
  const prereg = extractPreRegistrationFields(experiment);
  return sha256(`${PREREG_HASH_PREFIX}${canonicalStringify(prereg)}`);
}

function shouldEnforcePreRegistrationLock(status) {
  const normalized = typeof status === "string" ? status.trim() : "";
  return normalized === "running"
    || normalized === "paused"
    || normalized === "completed"
    || normalized === "archived";
}

function verifyPreRegistrationLock(experiment = {}) {
  if (!shouldEnforcePreRegistrationLock(experiment.status)) {
    return {
      ok: true,
      enforced: false,
      expectedHash: "",
      actualHash: typeof experiment.preRegistrationLockHash === "string" ? experiment.preRegistrationLockHash : ""
    };
  }
  const expectedHash = computePreRegistrationLockHash(experiment);
  const actualHash = typeof experiment.preRegistrationLockHash === "string"
    ? experiment.preRegistrationLockHash.trim().toLowerCase()
    : "";
  if (!actualHash || !/^[a-f0-9]{64}$/.test(actualHash)) {
    throw makeError("EXPERIMENT_PREREG_LOCK_BREACH", "Missing or invalid pre-registration lock hash", {
      sequence: Number(experiment.sequence || 0),
      fields: LOCKED_FIELDS_AFTER_START
    });
  }
  if (actualHash !== expectedHash) {
    throw makeError("EXPERIMENT_PREREG_LOCK_BREACH", "Pre-registration lock hash mismatch", {
      sequence: Number(experiment.sequence || 0),
      expectedHash,
      actualHash,
      fields: LOCKED_FIELDS_AFTER_START
    });
  }
  return {
    ok: true,
    enforced: true,
    expectedHash,
    actualHash
  };
}

module.exports = {
  PREREG_HASH_PREFIX,
  LOCKED_FIELDS_AFTER_START,
  canonicalize,
  canonicalStringify,
  makeError,
  extractPreRegistrationFields,
  computePreRegistrationLockHash,
  shouldEnforcePreRegistrationLock,
  verifyPreRegistrationLock
};
