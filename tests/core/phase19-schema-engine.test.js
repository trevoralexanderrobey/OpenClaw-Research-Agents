"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));

test("phase19 schema engine exposes expected dataset types", () => {
  const engine = createSchemaEngine({ rootDir: root });
  assert.deepEqual(engine.listDatasetTypes(), [
    "benchmark_eval",
    "classification",
    "instruction_qa",
    "knowledge_graph",
    "retrieval_qa"
  ]);
});

test("phase19 schema engine detects duplicate deterministic row hashes", () => {
  const engine = createSchemaEngine({ rootDir: root });
  const result = engine.validateRows("instruction_qa", [
    { instruction: "Explain X", context: "Context", answer: "Answer" },
    { instruction: "Explain X", context: "Context", answer: "Answer" }
  ]);

  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.violations), /DUPLICATE_KEY/);
});

test("phase19 schema engine rejects unknown dataset types", () => {
  const engine = createSchemaEngine({ rootDir: root });
  assert.throws(() => engine.getDatasetSchema("does_not_exist"), /Unknown dataset type/);
});

