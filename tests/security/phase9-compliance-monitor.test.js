"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createComplianceMonitor } = require("../../workflows/governance-automation/compliance-monitor.js");
const { buildBaselineContracts } = require("../../workflows/governance-automation/phase9-baseline-contracts.js");

const root = path.resolve(__dirname, "../..");

test("phase9 compliance monitor passes on current baseline state", () => {
  const baselines = buildBaselineContracts(root);
  const monitor = createComplianceMonitor({ phaseBaselines: baselines });
  const result = monitor.scanComplianceState({ rootDir: root });
  assert.equal(result.compliant, true, JSON.stringify(result.violations, null, 2));
});

test("phase9 compliance monitor detects baseline hash violations", () => {
  const baselines = buildBaselineContracts(root);
  baselines.phase8ModuleHashes["workflows/compliance-governance/compliance-schema.js"] = "f".repeat(64);
  const monitor = createComplianceMonitor({ phaseBaselines: baselines });
  const result = monitor.scanComplianceState({ rootDir: root });
  assert.equal(result.compliant, false);
  assert.ok(result.violations.some((entry) => entry.id === "phase8-module-hash-drift"));
});

test("phase9 compliance monitor output is deterministic", () => {
  const baselines = buildBaselineContracts(root);
  const monitor = createComplianceMonitor({ phaseBaselines: baselines });
  const first = monitor.scanComplianceState({ rootDir: root });
  const second = monitor.scanComplianceState({ rootDir: root });
  assert.deepEqual(second, first);
});
