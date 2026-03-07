"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetBuilder } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-builder.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const {
  copyDatasetConfigs,
  writeTaskText
} = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

function createBuilder(rootDir, overrides = {}) {
  return createDatasetBuilder({
    rootDir,
    schemaEngine: createSchemaEngine({ rootDir }),
    outputManager: createDatasetOutputManager({ rootDir }),
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" },
    ...overrides
  });
}

test("phase20 integration marks low-quality rows non-commercializable and fails validation thresholds", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-low-quality-"));
  await copyDatasetConfigs(tmp);
  writeTaskText(tmp, "task-low-quality", "Tiny", {
    rights: {
      commercial_use_allowed: true,
      redistribution_allowed: true
    }
  });

  const builder = createBuilder(tmp);
  const result = builder.buildDatasetFromSources({
    task_ids: ["task-low-quality"],
    dataset_type: "instruction_qa"
  });

  assert.equal(result.ok, false);
  assert.equal(result.commercialization_ready, false);
  assert.equal(result.validation_status, "failed");
  assert.equal(result.quality_status, "failed");
  assert.equal(result.row_count, 0);

  const validationReport = JSON.parse(fs.readFileSync(result.validation_report_path, "utf8"));
  assert.equal(validationReport.build_summary.invalid_row_count, 1);
  assert.match(JSON.stringify(validationReport.row_results[0].reason_codes), /PHASE20_MIN_LENGTH/);
});

test("phase20 integration removes exact duplicates before persisting a commercializable dataset build", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-dedupe-build-"));
  await copyDatasetConfigs(tmp);
  writeTaskText(tmp, "task-duplicate-rows", [
    "Enterprise buyers prioritize integration depth and auditability.",
    "",
    "Enterprise buyers prioritize integration depth and auditability."
  ].join("\n"), {
    rights: {
      commercial_use_allowed: true,
      redistribution_allowed: true
    },
    source_domain: "approved.example"
  });

  const builder = createBuilder(tmp);
  const result = builder.buildDatasetFromSources({
    task_ids: ["task-duplicate-rows"],
    dataset_type: "instruction_qa"
  });

  assert.equal(result.ok, true);
  assert.equal(result.commercialization_ready, true);
  assert.equal(result.row_count, 1);

  const dedupeReport = JSON.parse(fs.readFileSync(result.dedupe_report_path, "utf8"));
  assert.equal(dedupeReport.build_summary.exact_duplicate_count, 1);
  assert.equal(dedupeReport.build_summary.kept_row_count, 1);
});

test("phase20 integration fails closed when provenance tracking breaks for produced rows", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-provenance-broken-"));
  await copyDatasetConfigs(tmp);
  writeTaskText(tmp, "task-provenance-broken", "Enterprise buyers prioritize integration depth and auditability.", {
    rights: {
      commercial_use_allowed: true,
      redistribution_allowed: true
    },
    source_domain: "approved.example"
  });

  const brokenProvenanceTracker = {
    getConfigSnapshotHash() {
      return "broken-provenance-config";
    },
    trackBuild(input = {}) {
      const firstRow = Array.isArray(input.dedupe_result && input.dedupe_result.rows) ? input.dedupe_result.rows[0] : {};
      const rowHash = firstRow && firstRow.row_hash ? firstRow.row_hash : "row-hash-broken";
      const rowRecord = {
        ok: false,
        reason_codes: ["PHASE20_PROVENANCE_ARTIFACT_REQUIRED"],
        row_hash: rowHash,
        row_number: 1,
        source_artifacts: [],
        source_task_ids: ["task-provenance-broken"]
      };
      return {
        invalid_rows: [rowRecord],
        ok: false,
        provenance: {
          build_summary: {
            invalid_row_count: 1,
            row_count: 1
          },
          row_records: [rowRecord]
        },
        row_records: [rowRecord]
      };
    }
  };

  const builder = createBuilder(tmp, {
    provenanceTracker: brokenProvenanceTracker
  });
  const result = builder.buildDatasetFromSources({
    task_ids: ["task-provenance-broken"],
    dataset_type: "instruction_qa"
  });

  assert.equal(result.ok, false);
  assert.equal(result.commercialization_ready, false);

  const buildReport = JSON.parse(fs.readFileSync(result.build_report_path, "utf8"));
  assert.match(JSON.stringify(buildReport.reason_codes), /PHASE20_PROVENANCE_ARTIFACT_REQUIRED/);
});
