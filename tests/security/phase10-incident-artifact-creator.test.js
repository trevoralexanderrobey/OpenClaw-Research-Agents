"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createIncidentArtifactCreator } = require("../../workflows/incident-management/incident-artifact-creator.js");
const { setupPhase10Harness } = require("./_phase10-helpers.js");

test("phase10 incident artifact creator writes deterministic artifacts with audit trail", async () => {
  const harness = await setupPhase10Harness();
  const incidentDir = path.join(harness.dir, "incidents");

  const creator = createIncidentArtifactCreator({
    apiGovernance: harness.governance,
    artifactPath: incidentDir,
    timeProvider: {
      nowIso() {
        return "2026-03-04T12:34:56.000Z";
      }
    }
  });

  const first = await creator.createIncidentArtifact("critical_drift_detected", "critical", {
    actor: "op-1",
    affected_components: ["compliance-monitor", "policy-drift-detector"],
    escalation_path: ["operator-email", "cline-notification", "pager"]
  });

  const second = await creator.createIncidentArtifact("critical_drift_detected", "critical", {
    actor: "op-1",
    affected_components: ["compliance-monitor", "policy-drift-detector"],
    escalation_path: ["operator-email", "cline-notification", "pager"]
  });

  assert.equal(first.incident_id, "INC-20260304-001");
  assert.equal(second.incident_id, "INC-20260304-002");

  const payload = JSON.parse(fs.readFileSync(first.artifact_path, "utf8"));
  assert.equal(payload.auto_remediation_blocked, true);
  assert.equal(payload.requires_operator_action, true);
  assert.equal(typeof payload.ledger_entry_id, "string");
  assert.ok(payload.ledger_entry_id.length > 0);
});

test("phase10 incident artifact creation is read-only to protected mutation state", async () => {
  const harness = await setupPhase10Harness();
  const creator = createIncidentArtifactCreator({
    apiGovernance: harness.governance,
    artifactPath: path.join(harness.dir, "incidents"),
    timeProvider: {
      nowIso() {
        return "2026-03-04T00:00:00.000Z";
      }
    }
  });

  await creator.createIncidentArtifact("manual_operator_escalation", "high", {
    actor: "op-1",
    affected_components: ["compliance-monitor"]
  });

  const state = await harness.governance.readState();
  assert.equal(state.outboundMutation.enabled, false);
  assert.equal(state.outboundMutation.killSwitch, false);
  assert.equal(state.outboundMutation.pendingPublications.length, 0);
  assert.equal(state.outboundMutation.committedPublications.length, 0);
});
