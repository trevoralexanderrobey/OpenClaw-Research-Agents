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
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase22-integration-"));
  await copyMonetizationConfigs(fixtureRoot);

  const missionId = "mission-phase22-integration-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-phase22-integration-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Phase22 integration fixture"
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
    "--product-line", "research_packs",
    "--tier", "standard",
    "--targets", "gumroad",
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
    offerId: generatedBody.offer_id
  };
}

test("phase22 integration flow: generate -> approve -> export -> record -> verify", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "zip",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const evidenceInputPath = path.join(fixture.fixtureRoot, "proof.txt");
  fs.writeFileSync(evidenceInputPath, "manual submission confirmation\n", "utf8");

  const recorded = runNode("scripts/record-submission-outcome.js", [
    "--offer-id", fixture.offerId,
    "--platform-target", "gumroad",
    "--operator-id", "operator-integration",
    "--outcome-state", "submitted_pending_review",
    "--idempotency-key", "phase22-flow-1",
    "--evidence-file", evidenceInputPath,
    "--notes", "submitted through manual portal",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const verified = runNode("scripts/verify-submission-evidence.js", [
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
    "submission-evidence",
    "export-events.json"
  );
  const exportEvents = JSON.parse(fs.readFileSync(exportEventsPath, "utf8"));
  assert.equal(exportEvents.events.length, 1);
  assert.deepEqual(exportEvents.events[0].exported_platform_targets, ["gumroad"]);
});

test("phase22 integration negative: invalid transition and empty payload fail closed", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "folder",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const first = runNode("scripts/record-submission-outcome.js", [
    "--offer-id", fixture.offerId,
    "--platform-target", "gumroad",
    "--operator-id", "operator-integration",
    "--outcome-state", "submitted_pending_review",
    "--idempotency-key", "phase22-negative-1",
    "--notes", "initial submit",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const invalidTransition = runNode("scripts/record-submission-outcome.js", [
    "--offer-id", fixture.offerId,
    "--platform-target", "gumroad",
    "--operator-id", "operator-integration",
    "--outcome-state", "ready_for_manual_submission",
    "--idempotency-key", "phase22-negative-2",
    "--notes", "invalid transition",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.notEqual(invalidTransition.status, 0);
  assert.match(invalidTransition.stderr, /PHASE22_STATE_TRANSITION_INVALID|Invalid state transition/i);

  const emptyPayload = runNode("scripts/record-submission-outcome.js", [
    "--offer-id", fixture.offerId,
    "--platform-target", "gumroad",
    "--operator-id", "operator-integration",
    "--outcome-state", "withdrawn",
    "--idempotency-key", "phase22-negative-3",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.notEqual(emptyPayload.status, 0);
  assert.match(emptyPayload.stderr, /PHASE22_EVIDENCE_PAYLOAD_EMPTY|at least one payload/i);
});

test("phase22 integration negative: tampered attachment fails verification", async () => {
  const fixture = await createFixture();

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", fixture.offerId,
    "--format", "zip",
    "--operator-id", "operator-integration",
    "--confirm"
  ], fixture.fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);

  const evidenceInputPath = path.join(fixture.fixtureRoot, "proof-tamper.txt");
  fs.writeFileSync(evidenceInputPath, "phase22 attachment integrity\n", "utf8");

  const recorded = runNode("scripts/record-submission-outcome.js", [
    "--offer-id", fixture.offerId,
    "--platform-target", "gumroad",
    "--operator-id", "operator-integration",
    "--outcome-state", "submitted_pending_review",
    "--idempotency-key", "phase22-tamper-1",
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
    "submission-evidence",
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

  const verified = runNode("scripts/verify-submission-evidence.js", [
    "--offer-id", fixture.offerId,
    "--mode", "full"
  ], fixture.fixtureRoot);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /PHASE22_EVIDENCE_REF_HASH_MISMATCH|digest mismatch/i);
});
