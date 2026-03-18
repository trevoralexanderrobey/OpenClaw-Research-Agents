"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const { buildMonetizationRuntime } = require(path.join(root, "scripts", "_monetization-runtime.js"));
const { copyMonetizationConfigs, writeJson, writeTaskOutput } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

async function createApprovedOfferFixture() {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase28-manager-"));
  await copyMonetizationConfigs(fixtureRoot);

  const missionId = "mission-phase28-manager-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-phase28-manager-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Phase28 manager fixture"
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

test("phase28 derives ready_for_manual_delivery from export history without synthetic evidence event", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });
  const manager = runtime.deliveryEvidenceManager;

  await manager.recordExportEvent({
    offer_id: fixture.offerId,
    operator_id: "operator-1",
    export_format: "zip",
    exported_delivery_targets: [fixture.deliveryTarget],
    export_artifact_refs: [
      {
        path: `workspace/releases/${fixture.offerId}-export.zip`,
        file_type: ".zip",
        byte_size: 100,
        sha256: "a".repeat(64)
      }
    ]
  });

  const snapshotPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    "delivery-evidence",
    fixture.deliveryTarget,
    "delivery-evidence.json"
  );
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.current_state, "ready_for_manual_delivery");
  assert.equal(snapshot.evidence_event_count, 0);

  const ledgerPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    "delivery-evidence",
    "ledger.json"
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(Array.isArray(ledger.events) ? ledger.events.length : 0, 0);
});

test("phase28 blocks evidence recording when delivery target lacks export coverage", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });

  await assert.rejects(() => runtime.deliveryEvidenceManager.recordDeliveryOutcome({
    offer_id: fixture.offerId,
    delivery_target: fixture.deliveryTarget,
    operator_id: "operator-1",
    outcome_state: "delivery_in_progress",
    idempotency_key: "idem-no-export",
    notes: "attempt without export event"
  }), (error) => {
    assert.equal(error.code, "PHASE28_EXPORT_ELIGIBILITY_REQUIRED");
    return true;
  });
});

test("phase28 enforces idempotency replay and conflict behavior", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });
  const manager = runtime.deliveryEvidenceManager;

  await manager.recordExportEvent({
    offer_id: fixture.offerId,
    operator_id: "operator-1",
    export_format: "folder",
    exported_delivery_targets: [fixture.deliveryTarget],
    export_artifact_refs: [
      {
        path: `workspace/releases/${fixture.offerId}-export`,
        file_type: "folder",
        byte_size: 0,
        sha256: "b".repeat(64)
      }
    ]
  });

  const first = await manager.recordDeliveryOutcome({
    offer_id: fixture.offerId,
    delivery_target: fixture.deliveryTarget,
    operator_id: "operator-1",
    outcome_state: "delivery_in_progress",
    idempotency_key: "idem-1",
    notes: "first delivery handoff"
  });
  assert.equal(first.idempotent, false);

  const replay = await manager.recordDeliveryOutcome({
    offer_id: fixture.offerId,
    delivery_target: fixture.deliveryTarget,
    operator_id: "operator-1",
    outcome_state: "delivery_in_progress",
    idempotency_key: "idem-1",
    notes: "first delivery handoff"
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.event.event_hash, first.event.event_hash);

  await assert.rejects(() => manager.recordDeliveryOutcome({
    offer_id: fixture.offerId,
    delivery_target: fixture.deliveryTarget,
    operator_id: "operator-1",
    outcome_state: "delivery_in_progress",
    idempotency_key: "idem-1",
    notes: "different payload"
  }), (error) => {
    assert.equal(error.code, "PHASE28_IDEMPOTENCY_CONFLICT");
    return true;
  });
});
