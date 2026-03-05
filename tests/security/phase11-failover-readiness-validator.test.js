"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFailoverReadinessValidator } = require("../../workflows/recovery-assurance/failover-readiness-validator.js");

test("phase11 readiness validator reports ready when all prerequisites are satisfied", () => {
  const validator = createFailoverReadinessValidator({});
  const result = validator.validateReadiness({
    timestamp: "2026-03-05T00:00:00.000Z",
    checkpoint_available: true,
    manifest_valid: true,
    restore_path_healthy: true,
    runbook_complete: true,
    recent_drill_successful: true
  });

  assert.equal(result.ready, true);
  assert.equal(result.score, 100);
  assert.equal(result.blockers.length, 0);
});

test("phase11 readiness validator returns blockers without triggering failover", () => {
  const validator = createFailoverReadinessValidator({});
  const result = validator.validateReadiness({
    timestamp: "2026-03-05T00:00:00.000Z",
    checkpoint_available: false,
    manifest_valid: true,
    restore_path_healthy: false,
    runbook_complete: true,
    recent_drill_successful: false
  });

  assert.equal(result.ready, false);
  assert.ok(result.blockers.length >= 1);
  assert.equal(result.report.failover_triggered, false);
  assert.equal(result.report.advisory_only, true);
});

test("phase11 readiness validator output is deterministic", () => {
  const validator = createFailoverReadinessValidator({});
  const input = {
    timestamp: "2026-03-05T00:00:00.000Z",
    checkpoint_available: false,
    manifest_valid: false,
    restore_path_healthy: false,
    runbook_complete: false,
    recent_drill_successful: false
  };
  const first = validator.validateReadiness(input);
  const second = validator.validateReadiness(input);
  assert.deepEqual(second, first);
});
