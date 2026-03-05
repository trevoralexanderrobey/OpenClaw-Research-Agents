"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RECOVERY_SCHEMA_VERSION,
  getRecoverySchema,
  validateRecoveryPayload
} = require("../../workflows/recovery-assurance/recovery-schema.js");

test("phase11 recovery schema exposes required entities", () => {
  const schema = getRecoverySchema();
  assert.equal(schema.schema_version, RECOVERY_SCHEMA_VERSION);
  assert.ok(schema.entities.checkpoint);
  assert.ok(schema.entities.backup_manifest);
  assert.ok(schema.entities.restore_request);
  assert.ok(schema.entities.restore_result);
  assert.ok(schema.entities.drill_result);
  assert.ok(schema.entities.readiness_report);
});

test("phase11 recovery schema validation fails on missing required fields", () => {
  const result = validateRecoveryPayload("checkpoint", {
    schema_version: RECOVERY_SCHEMA_VERSION,
    checkpoint_id: "CHK-20260305-abcdef123456"
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((entry) => entry.code === "PHASE11_SCHEMA_FIELD_REQUIRED"));
});

test("phase11 recovery schema validation is deterministic", () => {
  const payload = {
    schema_version: RECOVERY_SCHEMA_VERSION,
    request_id: "RST-1",
    checkpoint_id: "CHK-1",
    manifest_id: "MAN-1",
    requested_by: "op",
    requested_scope: "governance.recovery.restore",
    confirm_required: true
  };
  const first = validateRecoveryPayload("restore_request", payload);
  const second = validateRecoveryPayload("restore_request", payload);
  assert.deepEqual(second, first);
});
