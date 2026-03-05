"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createInteractionLog } = require("../../openclaw-bridge/core/interaction-log.js");
const { makeTmpDir, createMutableTimeProvider } = require("./_phase14-helpers.js");

test("phase14 interaction log appends with valid chain integrity", async () => {
  const dir = await makeTmpDir();
  const log = createInteractionLog({
    timeProvider: createMutableTimeProvider(),
    storePath: path.join(dir, "interaction-log.json")
  });

  await log.recordInteraction({ taskId: "task-1", prompt: "hello", response: "world", provider: "mock", model: "mock-v1" });
  await log.recordInteraction({ taskId: "task-1", prompt: "hello2", response: "world2", provider: "mock", model: "mock-v1" });

  const integrity = log.verifyChainIntegrity();
  assert.equal(integrity.valid, true);
  assert.equal(log.getInteractionCount(), 2);
  assert.equal(log.getInteractions({ taskId: "task-1" }).length, 2);
});
