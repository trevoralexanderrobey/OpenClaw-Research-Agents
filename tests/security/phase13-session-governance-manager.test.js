"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupPhase13Harness, issueToken } = require("./_phase13-helpers.js");

test("phase13 session manager creates and validates session with operator confirmation", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const created = await harness.sessionManager.createSession(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-session-create"
  });

  assert.ok(created.session_record.session_id);

  const valid = harness.sessionManager.validateSession(created.session_record.session_id);
  assert.equal(valid.valid, true);
  assert.equal(valid.expired, false);
  assert.equal(valid.token_valid, true);
});

test("phase13 session manager rejects missing confirmation and logs denial", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const result = await harness.sessionManager.createSession(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: false,
    correlationId: "phase13-session-missing-confirm"
  });

  assert.equal(result.rejected, true);
  assert.equal(result.ledger_entry.entry.reason, "missing_confirm");
});

test("phase13 session validation fails when underlying token is revoked", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const created = await harness.sessionManager.createSession(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-session-revoke"
  });

  await harness.tokenManager.revokeToken(issued.token_record.token_id, "token_compromised", {
    role: "operator",
    requester: "tester",
    confirm: true,
    correlationId: "phase13-token-revoke-for-session"
  });

  const validation = harness.sessionManager.validateSession(created.session_record.session_id);
  assert.equal(validation.valid, false);
  assert.equal(validation.token_valid, false);
});

test("phase13 session manager marks expired sessions invalid", async () => {
  const harness = await setupPhase13Harness();
  const issued = await issueToken(harness, {
    role: "operator_standard",
    scopes: ["governance.sbom.generate"]
  });

  const created = await harness.sessionManager.createSession(issued.token_record.token_id, {
    role: "operator",
    requester: "tester",
    confirm: true,
    expiresInHours: 1,
    correlationId: "phase13-session-expire"
  });

  harness.timeProvider.advanceHours(2);
  const validation = harness.sessionManager.validateSession(created.session_record.session_id);
  assert.equal(validation.valid, false);
  assert.equal(validation.expired, true);
});
