"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createChaosDrillSimulator } = require("../../workflows/recovery-assurance/chaos-drill-simulator.js");

test("phase11 chaos drill simulator generates deterministic tabletop artifact", () => {
  const simulator = createChaosDrillSimulator({
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const first = simulator.runDrill({ scenario: "integrity_drift", checkpoint_id: "CHK-1" });
  const second = simulator.runDrill({ scenario: "integrity_drift", checkpoint_id: "CHK-1" });
  assert.deepEqual(second, first);
  assert.equal(first.outcome, "simulated_success");
  assert.ok(first.drill_id.startsWith("DRL-20260305-"));
});

test("phase11 chaos drill simulator does not trigger protected mutation behavior", () => {
  const simulator = createChaosDrillSimulator({
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const result = simulator.runDrill({ scenario: "component_failure" });
  assert.equal(result.drill.tabletop_mode, true);
  assert.equal(result.drill.auto_remediation_blocked, true);
  assert.equal(result.drill.advisory_only, true);
});
