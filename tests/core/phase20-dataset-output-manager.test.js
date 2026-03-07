"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const { createDatasetBuildInput } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

test("phase20 dataset output manager persists Phase 20 reports and commercialization-ready index pointers", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-dataset-output-"));
  const manager = createDatasetOutputManager({ rootDir: tmp });

  manager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-output-phase20-demo",
    build_id: "build-0001",
    build_completed_at: "2026-03-06T00:00:00.000Z",
    build_started_at: "2026-03-06T00:00:00.000Z"
  }));
  manager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-output-phase20-demo",
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
  manager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-output-phase20-demo",
    build_id: "build-0003",
    build_completed_at: "2026-03-06T02:00:00.000Z",
    build_started_at: "2026-03-06T02:00:00.000Z",
    commercialization_ready: false,
    quality_report: {
      build_summary: {
        build_score: 42,
        quality_status: "failed"
      }
    },
    quality_status: "failed",
    status: "failed",
    validation_report: {
      build_summary: {
        validation_status: "failed"
      }
    },
    validation_status: "failed"
  }));

  const index = manager.loadIndex();
  assert.equal(index.schema_version, "phase20-datasets-index-v1");
  assert.equal(index.datasets[0].latest_build_id, "build-0003");
  assert.equal(index.datasets[0].latest_successful_build_id, "build-0002");
  assert.equal(index.datasets[0].latest_validated_build_id, "build-0002");
  assert.equal(index.datasets[0].latest_review_required_build_id, "build-0002");
  assert.equal(index.datasets[0].latest_commercialization_ready_build_id, "build-0001");

  const readyBuild = manager.resolveLatestCommercializationReadyBuild("dataset-output-phase20-demo");
  assert.equal(readyBuild.build_id, "build-0001");
  assert.equal(readyBuild.metadata.commercialization_ready, true);

  const build = manager.getBuild("dataset-output-phase20-demo", "build-0001");
  assert.equal(build.metadata.validation_status, "passed");
  assert.equal(build.metadata.quality_status, "passed");
  assert.equal(build.metadata.license_state, "allowed");
  assert.ok(fs.existsSync(path.join(manager.baseDir, build.validation_report_path)));
  assert.ok(fs.existsSync(path.join(manager.baseDir, build.dedupe_report_path)));
  assert.ok(fs.existsSync(path.join(manager.baseDir, build.provenance_path)));
  assert.ok(fs.existsSync(path.join(manager.baseDir, build.quality_report_path)));
  assert.ok(fs.existsSync(path.join(manager.baseDir, build.license_report_path)));
});
