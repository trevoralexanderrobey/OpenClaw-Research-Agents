"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupPhase13Harness, issueToken } = require("./_phase13-helpers.js");

test("phase13 token lifecycle rejects missing confirmation and logs decision", async () => {
  const harness = await setupPhase13Harness();

  const result = await harness.tokenManager.issueToken({
    role: "operator_standard",
    scopes: ["governance.sbom.generate"],
    expiresInHours: 24,
    confirm: false
  }, {
    role: "operator",
    requester: "tester",
    confirm: false,
    correlationId: "phase13-token-missing-confirm"
  });

  assert.equal(result.rejected, true);
  assert.equal(result.ledger_entry.entry.reason, "missing_confirm");

  const decisions = harness.accessDecisionLedger.getDecisions({ action: "issue_token" });
  assert.ok(decisions.some((entry) => entry.reason === "missing_confirm"));
});

test("phase13 token lifecycle rejects missing required role/scopes", async () => {
  const harness = await setupPhase13Harness();

  const noRole = await harness.tokenManager.issueToken({
    role: "",
    scopes: ["governance.sbom.generate"],
    expiresInHours: 24,
    confirm: true
  }, {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-token-missing-role"
  });

  assert.equal(noRole.rejected, true);
  assert.equal(noRole.ledger_entry.entry.reason, "missing_role_or_scopes");

  const noScopes = await harness.tokenManager.issueToken({
    role: "operator_standard",
    scopes: [],
    expiresInHours: 24,
    confirm: true
  }, {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-token-missing-scopes"
  });

  assert.equal(noScopes.rejected, true);
  assert.equal(noScopes.ledger_entry.entry.reason, "missing_role_or_scopes");
});

test("phase13 token lifecycle issues, rotates, and revokes tokens with operator gating", async () => {
  const harness = await setupPhase13Harness();

  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate", "governance.vulnerability.scan"]
  });
  assert.ok(issued.token_record && issued.token_record.token_id);

  const rotateRejected = await harness.tokenManager.rotateToken(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: false,
    correlationId: "phase13-rotate-missing-confirm"
  });
  assert.equal(rotateRejected.rejected, true);

  const rotated = await harness.tokenManager.rotateToken(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-rotate-ok"
  });
  assert.ok(rotated.new_token_record.token_id);
  assert.equal(rotated.old_token_record.revoked, true);

  const revoked = await harness.tokenManager.revokeToken(rotated.new_token_record.token_id, "test_revoke", {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-revoke-ok"
  });
  assert.equal(revoked.revoked_record.revoked, true);

  const validation = harness.tokenManager.validateToken(rotated.new_token_record.token_id);
  assert.equal(validation.valid, false);
  assert.equal(validation.revoked, true);
});

test("phase13 token validation marks token expired after deterministic time advance", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    expiresInHours: 1,
    scopes: ["governance.sbom.generate"]
  });

  const before = harness.tokenManager.validateToken(issued.token_record.token_id);
  assert.equal(before.valid, true);
  assert.equal(before.expired, false);

  harness.timeProvider.advanceHours(2);
  const after = harness.tokenManager.validateToken(issued.token_record.token_id);
  assert.equal(after.valid, false);
  assert.equal(after.expired, true);
});
