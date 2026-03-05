"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createResearchOutputManager } = require("../../openclaw-bridge/core/research-output-manager.js");
const { makeTmpDir, createMutableTimeProvider } = require("./_phase14-helpers.js");

test("phase14 output manager saves output and manifest deterministically", async () => {
  const dir = await makeTmpDir();
  const manager = createResearchOutputManager({
    timeProvider: createMutableTimeProvider(),
    outputDir: path.join(dir, "out")
  });

  const saved = manager.saveOutput("task-abc", "hello world", {
    status: "completed",
    type: "freeform",
    output_format: "markdown",
    provider: "mock",
    model: "mock-v1",
    started_at: "2026-03-05T00:00:00.000Z",
    completed_at: "2026-03-05T00:00:01.000Z"
  });

  assert.ok(saved.output_path.endsWith("output.md"));
  assert.equal(manager.listOutputs().length, 1);

  const manifest = manager.generateOutputManifest();
  assert.ok(manifest.path.endsWith("hash-manifest.json"));
  assert.ok(manifest.files.length >= 3);
});
