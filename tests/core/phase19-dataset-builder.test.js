"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const { createDatasetBuilder } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-builder.js"));
const {
  copyDatasetConfigs,
  writeTaskOutput
} = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

test("phase19 dataset builder produces deterministic dataset_id and build_id from task outputs", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-dataset-builder-"));
  await copyDatasetConfigs(tmp);
  writeTaskOutput(tmp, "task-dataset-builder-1", "sample-research-output.md", {
    rights: {
      commercial_use_allowed: true,
      redistribution_allowed: true
    },
    source_domain: "approved.example"
  });

  const schemaEngine = createSchemaEngine({ rootDir: tmp });
  const outputManager = createDatasetOutputManager({ rootDir: tmp });
  const builder = createDatasetBuilder({
    rootDir: tmp,
    schemaEngine,
    outputManager,
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const first = builder.buildDatasetFromSources({
    task_ids: ["task-dataset-builder-1"],
    dataset_type: "instruction_qa"
  });
  const second = builder.buildDatasetFromSources({
    task_ids: ["task-dataset-builder-1"],
    dataset_type: "instruction_qa"
  });

  assert.equal(first.dataset_id, second.dataset_id);
  assert.equal(first.build_id, second.build_id);
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  assert.equal(metadata.dataset_id, first.dataset_id);
  assert.equal(metadata.build_id, first.build_id);
  assert.equal(metadata.validation_status, "passed");
  assert.equal(metadata.quality_status, "passed");
  assert.equal(metadata.license_state, "allowed");
  assert.equal(metadata.commercialization_ready, true);
  assert.ok(fs.existsSync(first.validation_report_path));
  assert.ok(fs.existsSync(first.dedupe_report_path));
  assert.ok(fs.existsSync(first.provenance_path));
  assert.ok(fs.existsSync(first.quality_report_path));
  assert.ok(fs.existsSync(first.license_report_path));
});
