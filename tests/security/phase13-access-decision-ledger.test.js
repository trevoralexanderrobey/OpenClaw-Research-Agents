"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createAccessDecisionLedger } = require("../../workflows/access-control/access-decision-ledger.js");
const { makeTmpDir } = require("./_phase13-helpers.js");

function fixedTimeProvider() {
  return { nowIso: () => "2026-03-05T00:00:00.000Z" };
}

test("phase13 access decision ledger verifies chain and detects tamper", async () => {
  const dir = await makeTmpDir();
  const storePath = path.join(dir, "ledger.json");
  const ledger = createAccessDecisionLedger({ storePath, timeProvider: fixedTimeProvider() });

  await ledger.recordDecision({
    decision_id: "acd-1",
    actor: "tok-a",
    role: "operator_admin",
    action: "execute",
    resource: "governance.release",
    scope: "governance.release.approve",
    result: "allow",
    reason: "allow"
  });

  await ledger.recordDecision({
    decision_id: "acd-2",
    actor: "tok-b",
    role: "operator_readonly",
    action: "write",
    resource: "governance.release",
    scope: "governance.release.approve",
    result: "deny",
    reason: "deny_permission_mismatch"
  });

  const valid = ledger.verifyChainIntegrity();
  assert.equal(valid.valid, true, JSON.stringify(valid, null, 2));

  const tamperedState = JSON.parse(fs.readFileSync(storePath, "utf8"));
  tamperedState.decisions[0].reason = "tampered";
  fs.writeFileSync(storePath, JSON.stringify(tamperedState, null, 2), "utf8");

  const broken = ledger.verifyChainIntegrity();
  assert.equal(broken.valid, false);
  assert.equal(broken.broken_at, 1);
});

test("phase13 access decision ledger detects chain-head mismatch", async () => {
  const dir = await makeTmpDir();
  const storePath = path.join(dir, "ledger.json");
  const ledger = createAccessDecisionLedger({ storePath, timeProvider: fixedTimeProvider() });

  await ledger.recordDecision({
    decision_id: "acd-1",
    actor: "tok-a",
    role: "operator_admin",
    action: "execute",
    resource: "governance.release",
    scope: "governance.release.approve",
    result: "allow",
    reason: "allow"
  });

  const state = JSON.parse(fs.readFileSync(storePath, "utf8"));
  state.chain_head = "sha256:deadbeef";
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2), "utf8");

  const broken = ledger.verifyChainIntegrity();
  assert.equal(broken.valid, false);
  assert.equal(broken.broken_at, 1);
});

async function runBurst(storePath) {
  const ledger = createAccessDecisionLedger({ storePath, timeProvider: fixedTimeProvider() });
  const burst = [];
  for (let index = 0; index < 50; index += 1) {
    burst.push(ledger.recordDecision({
      decision_id: `acd-burst-${index + 1}`,
      actor: `tok-${index + 1}`,
      role: "operator_admin",
      action: "execute",
      resource: "governance.runbook",
      scope: "governance.runbook.execute",
      result: index % 2 === 0 ? "allow" : "deny",
      reason: index % 2 === 0 ? "allow" : "deny_permission_mismatch"
    }));
  }
  await Promise.all(burst);
  return ledger;
}

test("phase13 access ledger rapid-write ordering remains contiguous and deterministic; tamper break index is stable", async () => {
  const dir = await makeTmpDir();
  const firstPath = path.join(dir, "first-ledger.json");
  const secondPath = path.join(dir, "second-ledger.json");

  const firstLedger = await runBurst(firstPath);
  const firstState = firstLedger._debug_readState();
  assert.equal(firstState.decisions.length, 50);
  for (let i = 0; i < firstState.decisions.length; i += 1) {
    assert.equal(firstState.decisions[i].sequence, i + 1);
  }
  const firstIntegrity = firstLedger.verifyChainIntegrity();
  assert.equal(firstIntegrity.valid, true);

  const secondLedger = await runBurst(secondPath);
  const secondState = secondLedger._debug_readState();
  assert.equal(secondState.chain_head, firstState.chain_head);

  const tampered = JSON.parse(fs.readFileSync(firstPath, "utf8"));
  tampered.decisions[9].reason = "tamper";
  fs.writeFileSync(firstPath, JSON.stringify(tampered, null, 2), "utf8");

  const broken = firstLedger.verifyChainIntegrity();
  assert.equal(broken.valid, false);
  assert.equal(broken.broken_at, 10);
});
