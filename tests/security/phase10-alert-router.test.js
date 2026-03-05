"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAlertRouter } = require("../../workflows/observability/alert-router.js");
const { setupPhase10Harness } = require("./_phase10-helpers.js");

test("phase10 alert router routes alerts to configured channels and records ack", async () => {
  const harness = await setupPhase10Harness();

  const router = createAlertRouter({
    sloAlertEngine: { evaluateSlos: () => ({ breaches: [], alerts: [] }) },
    apiGovernance: harness.governance,
    timeProvider: harness.timeProvider
  });

  const routed = await router.routeAlert({
    alert_id: "phase10-alert-1",
    severity: "critical"
  }, ["email", "cline", "unsupported"]);

  assert.equal(routed.routed, true);
  assert.equal(routed.delivery_ids.length, 2);
  assert.equal(routed.deliveries.every((entry) => entry.advisory_only === true), true);
  assert.equal(routed.deliveries.every((entry) => entry.auto_remediation_blocked === true), true);

  await router.recordAlertAcknowledgment("phase10-alert-1", "op-1", "2026-03-05T00:00:00.000Z");
  const state = await harness.governance.readState();
  const records = state.complianceGovernance.operationalDecisionLedger.records;
  assert.ok(records.some((entry) => entry.event_type === "alert.routed"));
  assert.ok(records.some((entry) => entry.event_type === "alert.acknowledged"));
});
