"use strict";

const { canonicalize, safeString } = require("../governance-automation/common.js");
const { ACCESS_CONTROL_SCHEMA_VERSION } = require("./access-control-common.js");

const REQUIRED_BY_TYPE = Object.freeze({
  role_definition: Object.freeze(["role_id", "permissions", "scopes", "description"]),
  permission_entry: Object.freeze(["permission_id", "action", "resource", "conditions"]),
  scope_registry_entry: Object.freeze(["scope_id", "phase", "description", "required_role"]),
  token_record: Object.freeze(["token_id", "role", "scopes", "issued_at", "expires_at", "revoked", "issuer"]),
  access_decision: Object.freeze(["decision_id", "actor", "action", "resource", "result", "reason"]),
  session_record: Object.freeze(["session_id", "token_id", "created_at", "expires_at", "active"]),
  escalation_event: Object.freeze(["event_id", "actor", "attempted_action", "required_role", "actual_role"])
});

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getAccessControlSchema() {
  return canonicalize({
    schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
    entities: Object.fromEntries(
      Object.keys(REQUIRED_BY_TYPE)
        .sort((left, right) => left.localeCompare(right))
        .map((entity) => [entity, {
          required: REQUIRED_BY_TYPE[entity],
          additional_properties: true
        }])
    )
  });
}

function validateAccessControlPayload(type, payload) {
  const normalizedType = safeString(type).toLowerCase();
  const required = REQUIRED_BY_TYPE[normalizedType] || [];

  if (!required.length) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE13_SCHEMA_TYPE_UNKNOWN",
        message: `Unknown schema type: ${normalizedType || "(empty)"}`
      }]
    });
  }

  if (!isPlainObject(payload)) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE13_SCHEMA_PAYLOAD_INVALID",
        message: "Payload must be a plain object"
      }]
    });
  }

  const violations = [];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      violations.push({
        code: "PHASE13_SCHEMA_FIELD_REQUIRED",
        field,
        message: `Missing required field '${field}' for ${normalizedType}`
      });
    }
  }

  const schemaVersion = safeString(payload.schema_version);
  if (schemaVersion && schemaVersion !== ACCESS_CONTROL_SCHEMA_VERSION) {
    violations.push({
      code: "PHASE13_SCHEMA_VERSION_MISMATCH",
      field: "schema_version",
      message: `schema_version must be ${ACCESS_CONTROL_SCHEMA_VERSION}`
    });
  }

  return canonicalize({
    valid: violations.length === 0,
    violations
  });
}

module.exports = {
  ACCESS_CONTROL_SCHEMA_VERSION,
  REQUIRED_BY_TYPE,
  getAccessControlSchema,
  validateAccessControlPayload
};
