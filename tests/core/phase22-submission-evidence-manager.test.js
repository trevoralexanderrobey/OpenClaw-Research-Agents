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
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase22-manager-"));
  await copyMonetizationConfigs(fixtureRoot);

  const missionId = "mission-phase22-manager-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-phase22-manager-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Phase22 manager fixture"
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
    offerId: generatedBody.offer_id,
    bundleDir: generatedBody.bundle_dir
  };
}

test("phase22 derives ready_for_manual_submission from export history without synthetic evidence event", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });
  const manager = runtime.submissionEvidenceManager;

  await manager.recordExportEvent({
    offer_id: fixture.offerId,
    operator_id: "operator-1",
    export_format: "zip",
    exported_platform_targets: ["gumroad"],
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
    "submission-evidence",
    "gumroad",
    "submission-evidence.json"
  );
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.current_state, "ready_for_manual_submission");
  assert.equal(snapshot.evidence_event_count, 0);

  const ledgerPath = path.join(
    fixture.fixtureRoot,
    "workspace",
    "releases",
    fixture.offerId,
    "submission-evidence",
    "ledger.json"
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(Array.isArray(ledger.events) ? ledger.events.length : 0, 0);
});

test("phase22 blocks evidence recording when target lacks export coverage", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });

  await assert.rejects(() => runtime.submissionEvidenceManager.recordSubmissionOutcome({
    offer_id: fixture.offerId,
    platform_target: "gumroad",
    operator_id: "operator-1",
    outcome_state: "submitted_pending_review",
    idempotency_key: "idem-no-export",
    notes: "attempt without export event"
  }), (error) => {
    assert.equal(error.code, "PHASE22_EXPORT_ELIGIBILITY_REQUIRED");
    return true;
  });
});

test("phase22 enforces idempotency replay and conflict behavior", async () => {
  const fixture = await createApprovedOfferFixture();
  const runtime = buildMonetizationRuntime({ rootDir: fixture.fixtureRoot });
  const manager = runtime.submissionEvidenceManager;

  await manager.recordExportEvent({
    offer_id: fixture.offerId,
    operator_id: "operator-1",
    export_format: "folder",
    exported_platform_targets: ["gumroad"],
    export_artifact_refs: [
      {
        path: `workspace/releases/${fixture.offerId}-export`,
        file_type: "folder",
        byte_size: 0,
        sha256: "b".repeat(64)
      }
    ]
  });

  const first = await manager.recordSubmissionOutcome({
    offer_id: fixture.offerId,
    platform_target: "gumroad",
    operator_id: "operator-1",
    outcome_state: "submitted_pending_review",
    idempotency_key: "idem-1",
    notes: "first submit"
  });
  assert.equal(first.idempotent, false);

  const replay = await manager.recordSubmissionOutcome({
    offer_id: fixture.offerId,
    platform_target: "gumroad",
    operator_id: "operator-1",
    outcome_state: "submitted_pending_review",
    idempotency_key: "idem-1",
    notes: "first submit"
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.event.event_hash, first.event.event_hash);

  await assert.rejects(() => manager.recordSubmissionOutcome({
    offer_id: fixture.offerId,
    platform_target: "gumroad",
    operator_id: "operator-1",
    outcome_state: "submitted_pending_review",
    idempotency_key: "idem-1",
    notes: "different payload"
  }), (error) => {
    assert.equal(error.code, "PHASE22_IDEMPOTENCY_CONFLICT");
    return true;
  });
});
