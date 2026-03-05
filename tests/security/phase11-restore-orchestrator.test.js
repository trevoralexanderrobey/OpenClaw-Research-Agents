"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRestoreOrchestrator, RESTORE_SCOPE } = require("../../workflows/recovery-assurance/restore-orchestrator.js");
const { setupPhase11Harness, issueToken } = require("./_phase11-helpers.js");

function sampleRequest() {
  return {
    schema_version: "phase11-recovery-v1",
    request_id: "RST-20260305-001",
    checkpoint_id: "CHK-20260305-abcdef123456",
    manifest_id: "MAN-20260305-abcdef123456",
    requested_by: "op-1",
    requested_scope: RESTORE_SCOPE,
    confirm_required: true,
    reason: "test",
    restore_targets: ["workspace/runtime/state.json"],
    risk_tags: ["operational"]
  };
}

test("phase11 restore orchestrator presents operator-gated restore plan", async () => {
  const harness = await setupPhase11Harness();
  const orchestrator = createRestoreOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  const presented = orchestrator.presentRestorePlan(sampleRequest());
  assert.equal(presented.plan.operator_approval_token_required, true);
  assert.equal(presented.plan.explicit_confirm_required, true);
  assert.equal(Array.isArray(presented.acceptance_criteria), true);
});

test("phase11 restore orchestrator logs rejection when confirm is missing", async () => {
  const harness = await setupPhase11Harness();
  const orchestrator = createRestoreOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  const result = await orchestrator.executeRestore({
    restoreRequest: sampleRequest(),
    confirm: false
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "phase11-restore-missing-confirm"
  });

  assert.equal(result.result.status, "rejected");
  assert.equal(result.result.reason, "missing_confirm");

  const state = await harness.governance.readState();
  assert.ok(state.complianceGovernance.operatorOverrideLedger.records.length >= 1);
  assert.ok(state.complianceGovernance.operationalDecisionLedger.records.length >= 1);
});

test("phase11 restore orchestrator logs rejection when token is missing", async () => {
  const harness = await setupPhase11Harness();
  const orchestrator = createRestoreOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  const result = await orchestrator.executeRestore({
    restoreRequest: sampleRequest(),
    confirm: true
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "phase11-restore-missing-token",
    confirm: true
  });

  assert.equal(result.result.status, "rejected");
  assert.equal(result.result.reason, "missing_approval_token");

  const state = await harness.governance.readState();
  assert.ok(state.complianceGovernance.operatorOverrideLedger.records.length >= 1);
  assert.ok(state.complianceGovernance.operationalDecisionLedger.records.length >= 1);
});

test("phase11 restore orchestrator executes simulation by default after token+confirm", async () => {
  const harness = await setupPhase11Harness();
  const orchestrator = createRestoreOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  const token = issueToken(harness.authorization, RESTORE_SCOPE);
  const result = await orchestrator.executeRestore({
    restoreRequest: sampleRequest(),
    confirm: true,
    approvalToken: token
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "phase11-restore-simulated",
    confirm: true,
    approvalToken: token
  });

  assert.equal(result.result.result, "simulated");
  assert.equal(result.result.execution_mode, "simulation");
  assert.equal(result.result.auto_restore_blocked, true);

  const state = await harness.governance.readState();
  assert.ok(state.complianceGovernance.operatorOverrideLedger.records.length >= 1);
  assert.ok(state.complianceGovernance.operationalDecisionLedger.records.length >= 1);
});
