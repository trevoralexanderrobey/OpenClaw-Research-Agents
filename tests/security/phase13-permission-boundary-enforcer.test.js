"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupPhase13Harness, issueToken } = require("./_phase13-helpers.js");

test("phase13 permission boundary allows valid access and stays deterministic", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const input = {
    token_id: issued.token_record.token_id,
    action: "generate",
    resource: "governance.sbom",
    scope: "governance.sbom.generate"
  };

  const first = await harness.permissionEnforcer.evaluateAccess(input);
  const second = await harness.permissionEnforcer.evaluateAccess(input);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(first.reason, "allow");
  assert.equal(second.reason, "allow");
});

test("phase13 permission boundary fails closed on unknown scope", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const result = await harness.permissionEnforcer.evaluateAccess({
    token_id: issued.token_record.token_id,
    action: "generate",
    resource: "governance.sbom",
    scope: "unknown.scope"
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "deny_unknown_scope");
});

test("phase13 permission boundary fails closed for revoked token", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  await harness.tokenManager.revokeToken(issued.token_record.token_id, "test_revoke", {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-enforcer-revoke"
  });

  const result = await harness.permissionEnforcer.evaluateAccess({
    token_id: issued.token_record.token_id,
    action: "generate",
    resource: "governance.sbom",
    scope: "governance.sbom.generate"
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "deny_revoked_token");
});

test("phase13 permission boundary denies unknown token", async () => {
  const harness = await setupPhase13Harness();
  const result = await harness.permissionEnforcer.evaluateAccess({
    token_id: "tok-does-not-exist",
    action: "read",
    resource: "governance.report"
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "deny_unknown_token");
});
