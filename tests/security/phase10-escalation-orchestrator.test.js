"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAlertRouter } = require("../../workflows/observability/alert-router.js");
const { createEscalationOrchestrator } = require("../../workflows/incident-management/escalation-orchestrator.js");
const { setupPhase10Harness } = require("./_phase10-helpers.js");

test("phase10 escalation orchestrator maps severity to expected notification tiers", async () => {
  const harness = await setupPhase10Harness();
  const alertRouter = createAlertRouter({
    sloAlertEngine: { evaluateSlos: () => ({ breaches: [], alerts: [] }) },
    apiGovernance: harness.governance,
    timeProvider: harness.timeProvider
  });

  const orchestrator = createEscalationOrchestrator({
    alertRouter,
    apiGovernance: harness.governance,
    timeProvider: harness.timeProvider
  });

  const incident = {
    incident_id: "INC-20260304-001",
    timestamp: "2026-03-04T00:00:00.000Z"
  };

  const low = await orchestrator.initiateEscalation({ ...incident, severity: "low" }, {});
  const medium = await orchestrator.initiateEscalation({ ...incident, severity: "medium" }, {});
  const high = await orchestrator.initiateEscalation({ ...incident, severity: "high" }, {});
  const critical = await orchestrator.initiateEscalation({ ...incident, severity: "critical" }, {
    re_escalation_opt_in: true
  });

  assert.deepEqual(low.channels_notified, ["email"]);
  assert.deepEqual(medium.channels_notified, ["email", "slack"]);
  assert.deepEqual(high.channels_notified, ["email", "slack", "cline"]);
  assert.deepEqual(critical.channels_notified, ["email", "slack", "cline", "pager"]);
  assert.equal(critical.auto_remediation_blocked, true);
});

test("phase10 escalation orchestrator records acknowledgments", async () => {
  const harness = await setupPhase10Harness();
  const alertRouter = createAlertRouter({
    sloAlertEngine: { evaluateSlos: () => ({ breaches: [], alerts: [] }) },
    apiGovernance: harness.governance,
    timeProvider: harness.timeProvider
  });
  const orchestrator = createEscalationOrchestrator({
    alertRouter,
    apiGovernance: harness.governance,
    timeProvider: harness.timeProvider
  });

  await orchestrator.recordEscalationAck("ESC-INC-20260304-001", "op-1", "2026-03-05T00:00:00.000Z");
  const state = await harness.governance.readState();
  const records = state.complianceGovernance.operationalDecisionLedger.records;
  assert.ok(records.some((entry) => entry.event_type === "incident.escalation_ack"));
  assert.ok(records.some((entry) => entry.event_type === "alert.acknowledged"));
});
