"use strict";

const {
  canonicalize,
  safeString
} = require("../governance-automation/common.js");

const RECOVERY_SCHEMA_VERSION = "phase11-recovery-v1";

const REQUIRED_BY_TYPE = Object.freeze({
  checkpoint: Object.freeze([
    "schema_version",
    "checkpoint_id",
    "timestamp",
    "checkpoint_hash",
    "prev_checkpoint_hash",
    "artifacts",
    "runtime_summary"
  ]),
  backup_manifest: Object.freeze([
    "schema_version",
    "manifest_id",
    "manifest_hash",
    "checkpoint_id",
    "checkpoint_hash",
    "artifacts",
    "policy_version",
    "provenance"
  ]),
  restore_request: Object.freeze([
    "schema_version",
    "request_id",
    "checkpoint_id",
    "manifest_id",
    "requested_by",
    "requested_scope",
    "confirm_required"
  ]),
  restore_result: Object.freeze([
    "schema_version",
    "request_id",
    "result",
    "execution_mode",
    "operator_confirmed",
    "token_scope"
  ]),
  drill_result: Object.freeze([
    "schema_version",
    "drill_id",
    "timestamp",
    "scenario",
    "outcome",
    "findings"
  ]),
  readiness_report: Object.freeze([
    "schema_version",
    "timestamp",
    "ready",
    "score",
    "blockers",
    "recommendations"
  ])
});

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRecoverySchema() {
  return canonicalize({
    schema_version: RECOVERY_SCHEMA_VERSION,
    entities: {
      checkpoint: {
        required: REQUIRED_BY_TYPE.checkpoint,
        additional_properties: true
      },
      backup_manifest: {
        required: REQUIRED_BY_TYPE.backup_manifest,
        additional_properties: true
      },
      restore_request: {
        required: REQUIRED_BY_TYPE.restore_request,
        additional_properties: true
      },
      restore_result: {
        required: REQUIRED_BY_TYPE.restore_result,
        additional_properties: true
      },
      drill_result: {
        required: REQUIRED_BY_TYPE.drill_result,
        additional_properties: true
      },
      readiness_report: {
        required: REQUIRED_BY_TYPE.readiness_report,
        additional_properties: true
      }
    }
  });
}

function validateRecoveryPayload(type, payload) {
  const normalizedType = safeString(type).toLowerCase();
  const required = REQUIRED_BY_TYPE[normalizedType] || [];

  if (!required.length) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE11_SCHEMA_TYPE_UNKNOWN",
        message: `Unknown schema type: ${normalizedType || "(empty)"}`
      }]
    });
  }

  if (!isPlainObject(payload)) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE11_SCHEMA_PAYLOAD_INVALID",
        message: "Payload must be a plain object"
      }]
    });
  }

  const violations = [];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      violations.push({
        code: "PHASE11_SCHEMA_FIELD_REQUIRED",
        field,
        message: `Missing required field '${field}' for ${normalizedType}`
      });
    }
  }

  const schemaVersion = safeString(payload.schema_version);
  if (schemaVersion && schemaVersion !== RECOVERY_SCHEMA_VERSION) {
    violations.push({
      code: "PHASE11_SCHEMA_VERSION_MISMATCH",
      field: "schema_version",
      message: `schema_version must be ${RECOVERY_SCHEMA_VERSION}`
    });
  }

  return canonicalize({
    valid: violations.length === 0,
    violations
  });
}

module.exports = {
  RECOVERY_SCHEMA_VERSION,
  REQUIRED_BY_TYPE,
  getRecoverySchema,
  validateRecoveryPayload
};
