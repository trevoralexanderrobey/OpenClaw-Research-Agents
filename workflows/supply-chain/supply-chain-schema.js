"use strict";

const {
  canonicalize,
  safeString
} = require("../governance-automation/common.js");

const SUPPLY_CHAIN_SCHEMA_VERSION = "phase12-supply-chain-v1";

const REQUIRED_BY_TYPE = Object.freeze({
  sbom: Object.freeze([
    "schema_version",
    "bomFormat",
    "specVersion",
    "metadata",
    "components"
  ]),
  dependency_manifest: Object.freeze([
    "schema_version",
    "generated_at",
    "components"
  ]),
  provenance_record: Object.freeze([
    "schema_version",
    "commit_sha",
    "builder_identity",
    "sbom_hash",
    "artifacts",
    "generated_at"
  ]),
  dependency_update_request: Object.freeze([
    "schema_version",
    "request_id",
    "requested_by",
    "reason",
    "updates"
  ]),
  dependency_update_result: Object.freeze([
    "schema_version",
    "request_id",
    "result",
    "approved",
    "approval_scope"
  ]),
  vulnerability_report: Object.freeze([
    "schema_version",
    "advisory_only",
    "auto_patch_blocked",
    "vulnerabilities"
  ]),
  policy_evaluation: Object.freeze([
    "schema_version",
    "compliant",
    "violations",
    "score"
  ]),
  signature_record: Object.freeze([
    "schema_version",
    "artifact_path",
    "artifact_hash",
    "sbom_hash",
    "provenance_hash",
    "signer_key_id",
    "timestamp",
    "signature"
  ])
});

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getSupplyChainSchema() {
  return canonicalize({
    schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
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

function validateSupplyChainPayload(type, payload) {
  const normalizedType = safeString(type).toLowerCase();
  const required = REQUIRED_BY_TYPE[normalizedType] || [];

  if (!required.length) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE12_SCHEMA_TYPE_UNKNOWN",
        message: `Unknown schema type: ${normalizedType || "(empty)"}`
      }]
    });
  }

  if (!isPlainObject(payload)) {
    return canonicalize({
      valid: false,
      violations: [{
        code: "PHASE12_SCHEMA_PAYLOAD_INVALID",
        message: "Payload must be a plain object"
      }]
    });
  }

  const violations = [];

  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      violations.push({
        code: "PHASE12_SCHEMA_FIELD_REQUIRED",
        field,
        message: `Missing required field '${field}' for ${normalizedType}`
      });
    }
  }

  const schemaVersion = safeString(payload.schema_version);
  if (schemaVersion && schemaVersion !== SUPPLY_CHAIN_SCHEMA_VERSION) {
    violations.push({
      code: "PHASE12_SCHEMA_VERSION_MISMATCH",
      field: "schema_version",
      message: `schema_version must be ${SUPPLY_CHAIN_SCHEMA_VERSION}`
    });
  }

  return canonicalize({
    valid: violations.length === 0,
    violations
  });
}

module.exports = {
  SUPPLY_CHAIN_SCHEMA_VERSION,
  REQUIRED_BY_TYPE,
  getSupplyChainSchema,
  validateSupplyChainPayload
};
