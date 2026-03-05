"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase8Harness,
  issueToken,
  createAttestation,
  createBundle
} = require("./_phase8-helpers.js");
const {
  buildReleaseGateIdempotencyFingerprint
} = require("../../workflows/compliance-governance/compliance-validator.js");

async function seedAllowPath(harness, prefix = "seed") {
  await createAttestation(harness, { idempotencyKey: `${prefix}-attest` });
  await createBundle(harness, {
    idempotencyKey: `${prefix}-bundle`,
    asOfIso: "2026-03-04T10:00:00.000Z",
    checkResults: {
      "phase2-gates": "pass",
      "mcp-policy": "pass",
      "phase6-policy": "pass",
      "phase7-policy": "pass"
    }
  });
}

test("gate evaluation returns block when required checks are missing", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "eval-block-attest" });
  await createBundle(harness, {
    idempotencyKey: "eval-block-bundle",
    checkResults: {
      "phase2-gates": "pass",
      "mcp-policy": "unknown",
      "phase6-policy": "pass",
      "phase7-policy": "pass"
    }
  });

  const evaluation = await harness.governor.evaluateReleaseGate({
    targetRef: "refs/heads/main",
    targetSha: "a".repeat(64),
    asOfIso: "2026-03-04T10:00:01.000Z"
  });

  assert.equal(evaluation.decision, "block");
  assert.equal(evaluation.reasonCode, "missing_evidence");
});

test("gate evaluation returns hold on stale evidence", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "eval-hold");

  const evaluation = await harness.governor.evaluateReleaseGate({
    targetRef: "refs/heads/main",
    targetSha: "b".repeat(64),
    asOfIso: "2026-03-06T12:00:00.000Z"
  });

  assert.equal(evaluation.decision, "hold");
  assert.equal(evaluation.reasonCode, "policy_violation");
});

test("gate evaluation returns allow only when all deterministic conditions pass", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "eval-allow");

  const evaluation = await harness.governor.evaluateReleaseGate({
    targetRef: "refs/heads/main",
    targetSha: "c".repeat(64),
    asOfIso: "2026-03-04T10:00:05.000Z"
  });

  assert.equal(evaluation.decision, "allow");
  assert.equal(evaluation.reasonCode, "all_checks_passed");
});

test("kill-switch blocks release gate apply path", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "kill-switch");

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = true;
  });

  await assert.rejects(
    () => harness.governor.applyReleaseGateDecision({
      approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
      idempotencyKey: "apply-kill",
      targetRef: "refs/heads/main",
      targetSha: "d".repeat(64)
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "COMPLIANCE_KILL_SWITCH_ACTIVE"
  );
});

test("gate apply writes are transaction-bound and idempotent", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "apply-idem");

  const first = await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "apply-idem",
    targetRef: "refs/heads/main",
    targetSha: "e".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  const replay = await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "apply-idem",
    targetRef: "refs/heads/main",
    targetSha: "e".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);

  const state = await harness.governance.readState();
  assert.equal(state.complianceGovernance.releaseGates.length, 1);
});

test("supervisor cannot mutate release gate decisions", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "supervisor-deny");

  await assert.rejects(
    () => harness.governor.applyReleaseGateDecision({
      approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
      idempotencyKey: "apply-supervisor",
      targetRef: "refs/heads/main",
      targetSha: "f".repeat(64)
    }, {
      role: "supervisor",
      requester: "sup-1"
    }),
    (error) => error && error.code === "COMPLIANCE_ROLE_DENIED"
  );
});

test("release gate apply rejects missing approvalToken", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "missing-token-apply");

  await assert.rejects(
    () => harness.governor.applyReleaseGateDecision({
      idempotencyKey: "apply-missing-token",
      targetRef: "refs/heads/main",
      targetSha: "1".repeat(64)
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("release gate apply rejects invalid approvalToken scope", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "bad-scope-apply");

  await assert.rejects(
    () => harness.governor.applyReleaseGateDecision({
      approvalToken: issueToken(harness.authorization, "compliance.bundle.build"),
      idempotencyKey: "apply-bad-scope",
      targetRef: "refs/heads/main",
      targetSha: "2".repeat(64)
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});

test("repair compliance ledger tail rejects missing approvalToken", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "repair-missing-token");

  await assert.rejects(
    () => harness.governor.repairComplianceLedgerTail({}, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("repair compliance ledger tail rejects invalid approvalToken scope", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "repair-bad-scope");

  await assert.rejects(
    () => harness.governor.repairComplianceLedgerTail({
      approvalToken: issueToken(harness.authorization, "compliance.release.apply")
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});

test("truncated-tail repair requires explicit operator action", async () => {
  const harness = await setupPhase8Harness();
  await seedAllowPath(harness, "repair-explicit");

  await harness.governor.applyReleaseGateDecision({
    approvalToken: issueToken(harness.authorization, "compliance.release.apply"),
    idempotencyKey: "repair-decision",
    targetRef: "refs/heads/main",
    targetSha: "3".repeat(64)
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.complianceGovernance.decisionLedger.records = [];
    tx.state.complianceGovernance.decisionLedger.chainHead = "";
    tx.state.complianceGovernance.decisionLedger.nextSequence = 0;
  });

  const repaired = await harness.governor.repairComplianceLedgerTail({
    approvalToken: issueToken(harness.authorization, "compliance.release.repair")
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(repaired.repaired, true);
});

test("release-gate idempotency fingerprint is pinned to frozen field list", () => {
  const base = {
    targetRef: "refs/heads/main",
    targetSha: "4".repeat(64),
    decision: "allow",
    reasonCode: "all_checks_passed",
    asOfIso: "2026-03-04T10:00:00.000Z",
    policySnapshotHash: "5".repeat(64)
  };

  const one = buildReleaseGateIdempotencyFingerprint({
    ...base,
    sequence: 1,
    decidedAt: "2026-03-04T10:00:01.000Z",
    decidedBy: "op-1",
    approvalToken: "secret",
    decisionHash: "6".repeat(64),
    prevDecisionHash: ""
  });

  const two = buildReleaseGateIdempotencyFingerprint({
    ...base,
    sequence: 99,
    decidedAt: "2026-03-04T10:55:00.000Z",
    decidedBy: "op-2",
    approvalToken: "different",
    decisionHash: "7".repeat(64),
    prevDecisionHash: "8".repeat(64)
  });

  assert.equal(one, two);
});
