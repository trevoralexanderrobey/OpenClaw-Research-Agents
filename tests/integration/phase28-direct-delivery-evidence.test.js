"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const { copyMonetizationConfigs, writeJson, writeTaskOutput } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

async function createFixture() {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase28-integration-"));
  await copyMonetizationConfigs(fixtureRoot);

  const missionId = "mission-phase28-integration-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-phase28-integration-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Phase28 integration fixture"
  });
  writeJson(path.join(missionRoot, "status.json"), {
    mission_id: missionId,
    status: "completed"
  });
  writeJson(path.join(missionRoot, "artifacts", "mission-summary.json"), {
    mission_id: missionId,
    subtask_results: [
      {
        subtask_id: "step-1",
        output_path: outputPath,
        status: "completed"
      }
    ]
  });

  const generated = runNode("scripts/generate-offer.js", [
    "--source", missionId,
    "--product-line", "enterprise_private_delivery",
    "--tier", "premium",
    "--targets", "aws_data_exchange",
    "--delivery-targets", "manual_secure_transfer",
    "--confirm"
  ], fixtureRoot);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedBody = JSON.parse(generated.stdout);

  const approved = runNode("scripts/approve-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--confirm"
  ], fixtureRoot);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);

  return {
    fixtureRoot,
    offerId: generatedBody.offer_id,
    deliveryTarget: "manual_secure_transfer"
  };
}

test("phase28 integration flow: generate -> approve -> export -> record -> verify", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "zip",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const evidenceInputPath = path.join(fixture.fixtureRoot, "delivery-proof.txt");
  fs.writeFileSync(evidenceInputPath, "manual delivery confirmation\n", "utf8");

  const recorded = runNode("scripts/record-delivery-outcome.js", [
    "--offer-id", fixture.offerId,
    "--delivery-target", fixture.deliveryTarget,
    "--operator-id", "operator-integration",
    "--outcome-state", "delivery_in_progress",
    "--idempotency-key", "phase28-flow-1",
    "--evidence-file", evidenceInputPath,
    "--notes", "manual delivery handoff started",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const verified = runNode("scripts/verify-delivery-evidence.js", [
    "--offer-id", fixture.offerId,
    "--mode", "full"
  ], fixture.fixtureRoot);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);

  const verifyBody = JSON.parse(verified.stdout);
  assert.equal(verifyBody.result.ok, true);

  const exportEventsPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    "delivery-evidence",
    "export-events.json"
  );
  const exportEvents = JSON.parse(fs.readFileSync(exportEventsPath, "utf8"));
  assert.equal(exportEvents.events.length, 1);
  assert.deepEqual(exportEvents.events[0].exported_delivery_targets, [fixture.deliveryTarget]);
});

test("phase28 integration negative: invalid transition and empty payload fail closed", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "folder",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const first = runNode("scripts/record-delivery-outcome.js", [
    "--offer-id", fixture.offerId,
    "--delivery-target", fixture.deliveryTarget,
    "--operator-id", "operator-integration",
    "--outcome-state", "delivery_in_progress",
    "--idempotency-key", "phase28-negative-1",
    "--notes", "initial handoff",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const invalidTransition = runNode("scripts/record-delivery-outcome.js", [
    "--offer-id", fixture.offerId,
    "--delivery-target", fixture.deliveryTarget,
    "--operator-id", "operator-integration",
    "--outcome-state", "ready_for_manual_delivery",
    "--idempotency-key", "phase28-negative-2",
    "--notes", "invalid transition",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.notEqual(invalidTransition.status, 0);
  assert.match(invalidTransition.stderr, /PHASE28_STATE_TRANSITION_INVALID|Invalid state transition/i);

  const emptyPayload = runNode("scripts/record-delivery-outcome.js", [
    "--offer-id", fixture.offerId,
    "--delivery-target", fixture.deliveryTarget,
    "--operator-id", "operator-integration",
    "--outcome-state", "withdrawn",
    "--idempotency-key", "phase28-negative-3",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.notEqual(emptyPayload.status, 0);
  assert.match(emptyPayload.stderr, /PHASE28_EVIDENCE_PAYLOAD_EMPTY|at least one payload/i);
});

test("phase28 integration negative: tampered attachment fails verification", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "zip",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const evidenceInputPath = path.join(fixture.fixtureRoot, "delivery-proof-tamper.txt");
  fs.writeFileSync(evidenceInputPath, "phase28 attachment integrity\n", "utf8");

  const recorded = runNode("scripts/record-delivery-outcome.js", [
    "--offer-id", fixture.offerId,
    "--delivery-target", fixture.deliveryTarget,
    "--operator-id", "operator-integration",
    "--outcome-state", "delivery_in_progress",
    "--idempotency-key", "phase28-tamper-1",
    "--evidence-file", evidenceInputPath,
    "--notes", "tamper test",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const ledgerPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    "delivery-evidence",
    "ledger.json"
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const ref = ledger.events[0].evidence_refs[0];
  const storedPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    ref.stored_path.split("/").join(path.sep)
  );
  fs.appendFileSync(storedPath, "tampered\n", "utf8");

  const verified = runNode("scripts/verify-delivery-evidence.js", [
    "--offer-id", fixture.offerId,
    "--mode", "full"
  ], fixture.fixtureRoot);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /PHASE28_EVIDENCE_REF_HASH_MISMATCH|digest mismatch/i);
});
