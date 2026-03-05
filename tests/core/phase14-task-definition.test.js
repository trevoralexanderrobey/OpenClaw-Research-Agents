"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTaskDefinition, validateTaskDefinition } = require("../../openclaw-bridge/core/task-definition-schema.js");

test("phase14 task definition determinism: same input -> same task id", () => {
  const input = {
    type: "freeform",
    description: "Draft a summary",
    inputs: [{ path: "workspace/research-input/sample/doc-1.txt", type: "path" }],
    outputFormat: "markdown",
    createdAt: "2026-03-05T00:00:00.000Z"
  };

  const a = createTaskDefinition(input);
  const b = createTaskDefinition(input);
  assert.equal(a.task_id, b.task_id);
});

test("phase14 task definition rejects invalid type", () => {
  assert.throws(() => validateTaskDefinition({ type: "unknown", description: "bad" }), /Unsupported task type/);
});
