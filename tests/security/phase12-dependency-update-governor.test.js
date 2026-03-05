"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const {
  SUPPLY_CHAIN_UPDATE_SCOPE,
  createDependencyUpdateGovernor
} = require("../../workflows/supply-chain/dependency-update-governor.js");
const { setupPhase12Harness, issueToken } = require("./_phase12-helpers.js");

function writeKnownGood(filePath) {
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: "phase12-supply-chain-v1",
    generated_at: "2026-03-05T00:00:00.000Z",
    components: [{
      name: "zod",
      version: "3.24.1",
      purl: "pkg:npm/zod@3.24.1",
      license: "MIT",
      package_hash_sha256: "oldhash",
      dependency_depth: 1,
      direct_dependency: true
    }]
  }, null, 2));
}

function makeRequest(overrides = {}) {
  return {
    schema_version: "phase12-supply-chain-v1",
    request_id: "req-1",
    requested_by: "operator",
    reason: "upgrade",
    updates: [{
      package_name: "zod",
      current_version: "3.24.1",
      target_version: "3.24.1",
      purl: "pkg:npm/zod@3.24.1",
      license_before: "MIT",
      license_after: "MIT",
      package_hash_sha256: "newhash",
      dependency_depth: 1,
      direct_dependency: true,
      breaking_change: false
    }],
    ...overrides
  };
}

test("phase12 dependency update governor rejects missing confirm and logs decision", async () => {
  const harness = await setupPhase12Harness();
  const knownGoodPath = path.join(harness.dir, "known-good.json");
  writeKnownGood(knownGoodPath);

  const governor = createDependencyUpdateGovernor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    knownGoodPath,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const result = await governor.approveUpdate({
    updateRequest: makeRequest(),
    approvalToken: issueToken(harness.authorization, SUPPLY_CHAIN_UPDATE_SCOPE)
  }, {
    role: "operator",
    requester: "op-1",
    confirm: false
  });

  assert.equal(result.result.result, "rejected");
  assert.equal(result.result.reason, "missing_confirm");

  const state = await harness.governance.readState();
  const decisions = state.complianceGovernance.operationalDecisionLedger.records;
  assert.ok(decisions.length > 0);
});

test("phase12 dependency update governor rejects missing token and logs decision", async () => {
  const harness = await setupPhase12Harness();
  const knownGoodPath = path.join(harness.dir, "known-good.json");
  writeKnownGood(knownGoodPath);

  const governor = createDependencyUpdateGovernor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    knownGoodPath,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const result = await governor.approveUpdate({
    updateRequest: makeRequest(),
    confirm: true
  }, {
    role: "operator",
    requester: "op-1",
    confirm: true
  });

  assert.equal(result.result.result, "rejected");
  assert.equal(result.result.reason, "missing_approval_token");
});

test("phase12 dependency update governor applies known-good manifest with token and confirm", async () => {
  const harness = await setupPhase12Harness();
  const knownGoodPath = path.join(harness.dir, "known-good.json");
  writeKnownGood(knownGoodPath);

  const governor = createDependencyUpdateGovernor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    knownGoodPath,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const token = issueToken(harness.authorization, SUPPLY_CHAIN_UPDATE_SCOPE);
  const result = await governor.approveUpdate({
    updateRequest: makeRequest(),
    approvalToken: token,
    confirm: true
  }, {
    role: "operator",
    requester: "op-1",
    approvalToken: token,
    confirm: true,
    correlationId: "phase12-governor-test"
  });

  assert.equal(result.result.result, "approved");
  const updated = JSON.parse(fs.readFileSync(knownGoodPath, "utf8"));
  assert.equal(updated.components[0].package_hash_sha256, "newhash");
});
