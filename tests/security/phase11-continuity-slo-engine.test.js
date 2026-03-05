"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createContinuitySloEngine } = require("../../workflows/recovery-assurance/continuity-slo-engine.js");

test("phase11 continuity slo engine reports no breaches for healthy metrics", () => {
  const engine = createContinuitySloEngine({});
  const result = engine.evaluateContinuity({
    rto_actual_minutes: 20,
    rpo_actual_minutes: 10,
    backup_integrity_success_rate: 100,
    restore_drill_success_rate: 100
  });
  assert.equal(result.breaches.length, 0);
  assert.equal(result.alerts.length, 0);
});

test("phase11 continuity slo engine fails closed for missing metrics", () => {
  const engine = createContinuitySloEngine({});
  const result = engine.evaluateContinuity({});
  assert.ok(result.breaches.length >= 4);
  assert.ok(result.alerts.every((entry) => entry.advisory_only === true));
});

test("phase11 continuity slo output is deterministic", () => {
  const engine = createContinuitySloEngine({});
  const metrics = {
    rto_actual_minutes: 35,
    rpo_actual_minutes: 20,
    backup_integrity_success_rate: 95,
    restore_drill_success_rate: 90
  };
  const first = engine.evaluateContinuity(metrics);
  const second = engine.evaluateContinuity(metrics);
  assert.deepEqual(second, first);
});
