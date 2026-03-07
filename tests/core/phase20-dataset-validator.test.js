"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetValidator } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-validator.js"));

test("phase20 dataset validator emits row-level violations and preserves passing builds with valid minimum completeness", () => {
  const validator = createDatasetValidator({
    schemaEngine: createSchemaEngine({ rootDir: root })
  });

  const result = validator.validateBuild({
    dataset_type: "instruction_qa",
    metadata: {
      dataset_id: "dataset-validator-demo",
      build_id: "build-0001",
      dataset_type: "instruction_qa",
      target_schema: "phase19-instruction-qa-v1"
    },
    rows: [
      {
        instruction: "Explain the buyer signal.",
        context: "Enterprise buyers prioritize integration depth and auditability.",
        answer: "Enterprise buyers prioritize integration depth and auditability."
      },
      {
        instruction: "short",
        context: "",
        answer: "tiny",
        unexpected_field: "drift"
      }
    ]
  });

  assert.equal(result.validation_status, "passed");
  assert.equal(result.rows.length, 1);
  assert.equal(result.row_results.length, 2);

  const invalidRow = result.row_results.find((entry) => entry.ok === false);
  assert.ok(invalidRow);
  assert.match(JSON.stringify(invalidRow.reason_codes), /PHASE20_ROW_SHAPE_INCONSISTENT/);
  assert.match(JSON.stringify(invalidRow.reason_codes), /PHASE20_NON_EMPTY_REQUIRED/);
  assert.match(JSON.stringify(invalidRow.reason_codes), /PHASE20_MIN_LENGTH/);
});

test("phase20 dataset validator fails closed on malformed dataset metadata", () => {
  const validator = createDatasetValidator({
    schemaEngine: createSchemaEngine({ rootDir: root })
  });

  assert.throws(() => validator.validateBuild({
    dataset_type: "instruction_qa",
    metadata: {
      dataset_id: "dataset-validator-demo",
      dataset_type: "instruction_qa",
      target_schema: "phase19-instruction-qa-v1"
    },
    rows: []
  }), (error) => error && error.code === "PHASE20_DATASET_METADATA_INVALID");
});

test("phase20 dataset validator fails closed on malformed schema or quality config", () => {
  const validator = createDatasetValidator({
    schemaEngine: {
      getDatasetSchema() {
        return {
          dataset_type: "instruction_qa",
          required_fields: ["instruction", "row_hash"],
          fields: {
            instruction: {}
          }
        };
      },
      getQualityRules() {
        return {
          completeness_required_fields: ["missing_field"],
          min_row_count: 1,
          non_empty_fields: ["instruction"]
        };
      },
      normalizeRow() {
        return {
          instruction: "Explains the buyer signal in enough detail.",
          row_hash: "row-hash-1"
        };
      }
    }
  });

  assert.throws(() => validator.validateBuild({
    dataset_type: "instruction_qa",
    metadata: {
      dataset_id: "dataset-validator-demo",
      build_id: "build-0001",
      dataset_type: "instruction_qa",
      target_schema: "phase19-instruction-qa-v1"
    },
    rows: [
      {
        instruction: "Explains the buyer signal in enough detail."
      }
    ]
  }), (error) => error && error.code === "PHASE20_SCHEMA_CONFIG_INVALID");
});
