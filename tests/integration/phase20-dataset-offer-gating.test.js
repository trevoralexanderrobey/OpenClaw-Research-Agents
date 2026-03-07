"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const {
  copyMonetizationConfigs,
  createDatasetBuildInput
} = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

async function createRepoFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-dataset-offer-gating-"));
  await copyMonetizationConfigs(tmp);
  return tmp;
}

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

test("phase20 integration resolves dataset offers from the latest commercialization-ready build by default", async () => {
  const fixtureRoot = await createRepoFixture();
  const outputManager = createDatasetOutputManager({ rootDir: fixtureRoot });

  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-gating-demo",
    build_id: "build-0001",
    build_completed_at: "2026-03-06T00:00:00.000Z",
    build_started_at: "2026-03-06T00:00:00.000Z"
  }));
  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-gating-demo",
    build_id: "build-0002",
    build_completed_at: "2026-03-06T01:00:00.000Z",
    build_started_at: "2026-03-06T01:00:00.000Z",
    commercialization_ready: false,
    license_report: {
      build_summary: {
        license_state: "review_required"
      }
    },
    license_state: "review_required"
  }));

  const generated = runNode("scripts/generate-offer.js", [
    "--source", "dataset-offer-gating-demo",
    "--product-line", "dataset_packs",
    "--tier", "standard",
    "--targets", "kaggle",
    "--confirm"
  ], fixtureRoot);

  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const body = JSON.parse(generated.stdout);
  const offer = JSON.parse(fs.readFileSync(path.join(body.bundle_dir, "offer.json"), "utf8"));
  assert.equal(offer.build_id, "build-0001");
  assert.equal(body.source_status.commercialization_ready, true);
  assert.equal(offer.license_state, "allowed");
});

test("phase20 integration allows explicit review_required build packaging with warnings and preserves approval/export flow", async () => {
  const fixtureRoot = await createRepoFixture();
  const outputManager = createDatasetOutputManager({ rootDir: fixtureRoot });

  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-gating-review-demo",
    build_id: "build-0002",
    build_completed_at: "2026-03-06T01:00:00.000Z",
    build_started_at: "2026-03-06T01:00:00.000Z",
    commercialization_ready: false,
    license_report: {
      build_summary: {
        license_state: "review_required"
      }
    },
    license_state: "review_required"
  }));

  const generated = runNode("scripts/generate-offer.js", [
    "--source", "dataset-offer-gating-review-demo",
    "--build-id", "build-0002",
    "--product-line", "dataset_packs",
    "--tier", "standard",
    "--targets", "kaggle",
    "--confirm"
  ], fixtureRoot);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedBody = JSON.parse(generated.stdout);
  const offer = JSON.parse(fs.readFileSync(path.join(generatedBody.bundle_dir, "offer.json"), "utf8"));
  assert.equal(offer.build_id, "build-0002");
  assert.equal(offer.explicit_build_selected, true);
  assert.equal(offer.license_state, "review_required");
  assert.ok(Array.isArray(offer.warnings));
  assert.equal(offer.warnings.length, 1);

  const approved = runNode("scripts/approve-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--confirm"
  ], fixtureRoot);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--format", "folder",
    "--confirm"
  ], fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);
  const exportBody = JSON.parse(exported.stdout);
  assert.equal(exportBody.dataset_phase20_status.license_state, "review_required");
  assert.equal(exportBody.dataset_phase20_status.commercialization_ready, false);
});

test("phase20 integration rejects blocked dataset builds from monetization packaging", async () => {
  const fixtureRoot = await createRepoFixture();
  const outputManager = createDatasetOutputManager({ rootDir: fixtureRoot });

  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-gating-blocked-demo",
    build_id: "build-0003",
    build_completed_at: "2026-03-06T02:00:00.000Z",
    build_started_at: "2026-03-06T02:00:00.000Z",
    commercialization_ready: false,
    license_report: {
      build_summary: {
        license_state: "blocked"
      }
    },
    license_state: "blocked"
  }));

  const generated = runNode("scripts/generate-offer.js", [
    "--source", "dataset-offer-gating-blocked-demo",
    "--build-id", "build-0003",
    "--product-line", "dataset_packs",
    "--tier", "standard",
    "--targets", "kaggle",
    "--confirm"
  ], fixtureRoot);

  assert.notEqual(generated.status, 0);
  assert.match(generated.stderr, /blocked by license review/i);
});
