"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPrivilegeEscalationDetector } = require("../../workflows/access-control/privilege-escalation-detector.js");

test("phase13 escalation detector stays advisory-only and blocks auto-revocation", () => {
  const detector = createPrivilegeEscalationDetector({
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const decisions = [
    {
      sequence: 1,
      decision_id: "acd-1",
      actor: "tok-a",
      action: "execute",
      role: "operator_standard",
      result: "deny",
      reason: "deny_insufficient_role"
    },
    {
      sequence: 2,
      decision_id: "acd-2",
      actor: "tok-a",
      action: "write",
      role: "operator_standard",
      result: "deny",
      reason: "deny_scope_not_granted"
    },
    {
      sequence: 3,
      decision_id: "acd-3",
      actor: "tok-a",
      action: "write",
      role: "operator_standard",
      result: "deny",
      reason: "deny_revoked_token"
    }
  ];

  const result = detector.detectEscalation(decisions);
  assert.equal(result.advisory_only, true);
  assert.equal(result.auto_revoke_blocked, true);
  assert.ok(Array.isArray(result.events));
  assert.ok(result.events.length >= 3);
  assert.ok(result.report_hash.startsWith("sha256:"));
});

test("phase13 escalation detector is deterministic for same input", () => {
  const detector = createPrivilegeEscalationDetector({
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const decisions = [
    { sequence: 1, decision_id: "acd-1", actor: "tok-1", action: "x", role: "operator_readonly", result: "deny", reason: "deny_permission_mismatch" },
    { sequence: 2, decision_id: "acd-2", actor: "tok-1", action: "x", role: "operator_readonly", result: "deny", reason: "deny_permission_mismatch" },
    { sequence: 3, decision_id: "acd-3", actor: "tok-1", action: "x", role: "operator_readonly", result: "deny", reason: "deny_permission_mismatch" }
  ];

  const first = detector.detectEscalation(decisions);
  const second = detector.detectEscalation(decisions);
  assert.deepEqual(second, first);
});
