"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSupplyChainPolicyEngine } = require("../../workflows/supply-chain/supply-chain-policy-engine.js");

test("phase12 supply-chain policy engine fails on disallowed license and critical vulnerabilities", () => {
  const engine = createSupplyChainPolicyEngine({});

  const result = engine.evaluatePolicy({
    sbom: {
      components: [{
        name: "pkg-a",
        version: "1.0.0",
        license: "GPL-3.0",
        package_hash_sha256: "abc",
        direct_dependency: true
      }]
    },
    dependency_manifest: {
      generated_at: "2026-01-01T00:00:00.000Z"
    },
    vulnerability_report: {
      critical_count: 1
    },
    current_time: "2026-03-05T00:00:00.000Z"
  });

  assert.equal(result.compliant, false);
  assert.ok(result.violations.some((entry) => entry.code === "license_not_allowed"));
  assert.ok(result.violations.some((entry) => entry.code === "critical_vulnerability_threshold_exceeded"));
});

test("phase12 supply-chain policy engine output is deterministic", () => {
  const engine = createSupplyChainPolicyEngine({});
  const input = {
    sbom: {
      components: [{
        name: "pkg-a",
        version: "1.0.0",
        license: "MIT",
        package_hash_sha256: "abc",
        direct_dependency: true
      }]
    },
    dependency_manifest: {
      generated_at: "2026-03-05T00:00:00.000Z"
    },
    vulnerability_report: {
      critical_count: 0
    },
    current_time: "2026-03-05T00:00:00.000Z"
  };

  const first = engine.evaluatePolicy(input);
  const second = engine.evaluatePolicy(input);
  assert.deepEqual(second, first);
});
