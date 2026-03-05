"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRunbookOrchestrator } = require("../../workflows/runbook-automation/runbook-orchestrator.js");
const { setupPhase10Harness, issueToken } = require("./_phase10-helpers.js");

function sampleRequest() {
  return {
    schema_version: "phase9-remediation-request-v1",
    baseline_commit: "f5632129500596f3b4d898b79d03b93037d94d14",
    recommendations: [
      {
        drift_id: "drift-1",
        severity: "critical",
        rationale: "restore frozen policy clause",
        acceptance_criteria: ["phase9 policy gate passes"]
      }
    ],
    operator_approval_token_required: true,
    governance_transaction_wrapper_required: true,
    generated_without_autonomous_execution: true
  };
}

test("phase10 runbook orchestrator presents remediation request", async () => {
  const harness = await setupPhase10Harness();
  const orchestrator = createRunbookOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  const presented = orchestrator.presentRunbook(sampleRequest());
  assert.equal(presented.prompt.requires_approval_token, true);
  assert.equal(presented.prompt.requires_confirmation, true);
  assert.equal(Array.isArray(presented.helpers), true);
  assert.equal(presented.prompt.recommendations_count, 1);
});

test("phase10 runbook orchestrator requires approval token when confirm is set", async () => {
  const harness = await setupPhase10Harness();
  const orchestrator = createRunbookOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider
  });

  await assert.rejects(
    () => orchestrator.executeRunbookAction({
      remediation_request_path: "/tmp/remediation-request.json",
      remediationRequest: sampleRequest(),
      confirm: true
    }, {
      role: "operator",
      requester: "op-1",
      correlationId: "phase10-runbook-missing-token"
    }),
    (error) => error && error.code === "PHASE10_RUNBOOK_APPROVAL_TOKEN_REQUIRED"
  );
});

test("phase10 runbook executes only after explicit approval and logs ledgers", async () => {
  const harness = await setupPhase10Harness();
  const calls = [];
  const orchestrator = createRunbookOrchestrator({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    timeProvider: harness.timeProvider,
    applyRemediationExecutor(input) {
      calls.push(input);
      return {
        status: 0,
        ok: true,
        stdout: "ok",
        stderr: ""
      };
    }
  });

  const notConfirmed = await orchestrator.executeRunbookAction({
    remediation_request_path: "/tmp/remediation-request.json",
    remediationRequest: sampleRequest(),
    confirm: false
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "phase10-runbook-not-confirmed"
  });

  assert.equal(notConfirmed.decision.decision, "rejected");
  assert.equal(calls.length, 0, "executor must not run without confirm");

  const approvalToken = issueToken(harness.authorization, "governance.remediation.apply");
  const executed = await orchestrator.executeRunbookAction({
    remediation_request_path: "/tmp/remediation-request.json",
    remediationRequest: sampleRequest(),
    approvalToken,
    confirm: true
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "phase10-runbook-confirmed"
  });

  assert.equal(executed.decision.decision, "applied");
  assert.equal(calls.length, 1);

  const state = await harness.governance.readState();
  assert.ok(state.complianceGovernance.operatorOverrideLedger.records.length >= 1);
  assert.ok(state.complianceGovernance.operationalDecisionLedger.records.length >= 2);
});
