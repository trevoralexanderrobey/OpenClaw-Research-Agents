"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createOfferBuilder } = require(path.join(root, "openclaw-bridge", "monetization", "offer-builder.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const {
  createDatasetBuildInput,
  writeJson,
  writeTaskOutput
} = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

test("phase19 offer builder creates deterministic mission-backed offers", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-offer-builder-"));
  const missionId = "mission-offer-builder-demo";
  const outputPath = writeTaskOutput(tmp, "task-offer-builder-1", "sample-research-output.md");
  const missionRoot = path.join(tmp, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Research pack mission"
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

  const builder = createOfferBuilder({
    rootDir: tmp,
    monetizationMap: readJson("config/monetization-map.json"),
    platformTargets: readJson("config/platform-targets.json"),
    datasetOutputManager: createDatasetOutputManager({ rootDir: tmp })
  });

  const first = builder.buildOffer({
    source: missionId,
    product_line: "research_packs",
    tier: "standard",
    targets: ["gumroad"]
  });
  const second = builder.buildOffer({
    source: missionId,
    product_line: "research_packs",
    tier: "standard",
    targets: ["gumroad"]
  });

  assert.equal(first.offer.offer_id, second.offer.offer_id);
  assert.equal(first.offer.source_kind, "mission");
  assert.equal(first.source_context.source_id, missionId);
});

test("phase19 offer builder resolves dataset offers from the latest commercialization-ready build in the index", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-offer-builder-dataset-"));
  const outputManager = createDatasetOutputManager({ rootDir: tmp });
  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-builder-demo",
    build_id: "build-0001",
    build_completed_at: "2026-03-06T00:00:00.000Z",
    build_started_at: "2026-03-06T00:00:00.000Z"
  }));
  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-builder-demo",
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
  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-builder-demo",
    build_id: "build-0003",
    build_report: {
      ok: false
    },
    build_completed_at: "2026-03-06T02:00:00.000Z",
    build_started_at: "2026-03-06T02:00:00.000Z",
    commercialization_ready: false,
    license_report: {
      build_summary: {
        license_state: "blocked"
      }
    },
    license_state: "blocked",
    quality_report: {
      build_summary: {
        build_score: 40,
        quality_status: "failed"
      }
    },
    quality_status: "failed"
  }));

  const builder = createOfferBuilder({
    rootDir: tmp,
    monetizationMap: readJson("config/monetization-map.json"),
    platformTargets: readJson("config/platform-targets.json"),
    datasetOutputManager: outputManager
  });

  const result = builder.buildOffer({
    source: "dataset-offer-builder-demo",
    product_line: "dataset_packs",
    tier: "standard",
    targets: ["kaggle"]
  });

  assert.equal(result.offer.source_kind, "dataset");
  assert.equal(result.offer.build_id, "build-0001");
  assert.equal(result.source_context.build_id, "build-0001");
  assert.equal(result.offer.commercialization_ready, true);
  assert.equal(result.offer.license_state, "allowed");
});
