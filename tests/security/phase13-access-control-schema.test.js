"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  getAccessControlSchema,
  validateAccessControlPayload
} = require("../../workflows/access-control/access-control-schema.js");

test("phase13 access-control schema exposes expected entities", () => {
  const schema = getAccessControlSchema();
  assert.equal(schema.schema_version, ACCESS_CONTROL_SCHEMA_VERSION);
  assert.ok(schema.entities.role_definition);
  assert.ok(schema.entities.permission_entry);
  assert.ok(schema.entities.scope_registry_entry);
  assert.ok(schema.entities.token_record);
  assert.ok(schema.entities.access_decision);
  assert.ok(schema.entities.session_record);
  assert.ok(schema.entities.escalation_event);
});

test("phase13 access-control schema validates payload shape", () => {
  const valid = validateAccessControlPayload("token_record", {
    schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
    token_id: "tok-1",
    role: "operator_admin",
    scopes: ["governance.token.issue"],
    issued_at: "2026-03-05T00:00:00.000Z",
    expires_at: "2026-03-06T00:00:00.000Z",
    revoked: false,
    issuer: "operator"
  });
  assert.equal(valid.valid, true, JSON.stringify(valid.violations, null, 2));

  const invalid = validateAccessControlPayload("token_record", {
    schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
    token_id: "tok-1"
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.violations.some((entry) => entry.field === "role"));
});

test("phase13 access-control schema output is deterministic", () => {
  const first = getAccessControlSchema();
  const second = getAccessControlSchema();
  assert.deepEqual(second, first);
});
