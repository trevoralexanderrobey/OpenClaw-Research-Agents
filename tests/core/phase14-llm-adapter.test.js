"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createLLMAdapter } = require("../../openclaw-bridge/core/llm-adapter.js");
const { createInteractionLog } = require("../../openclaw-bridge/core/interaction-log.js");
const { makeTmpDir, createMutableTimeProvider } = require("./_phase14-helpers.js");

test("phase14 mock provider returns deterministic response", async () => {
  const dir = await makeTmpDir();
  const timeProvider = createMutableTimeProvider();
  const interactionLog = createInteractionLog({
    timeProvider,
    storePath: path.join(dir, "interaction.json")
  });

  const adapter = createLLMAdapter({
    provider: "mock",
    config: { model: "mock-v1" },
    interactionLog,
    timeProvider
  });

  const prompt = "Summarize the following deterministic input.";
  const a = await adapter.complete(prompt, { taskId: "task-a" });
  const b = await adapter.complete(prompt, { taskId: "task-a" });

  assert.equal(a.text, b.text);
  assert.equal(a.provider, "mock");
  assert.equal(interactionLog.getInteractionCount(), 2);
});

test("phase14 provider switching info reflects selected provider", () => {
  const adapter = createLLMAdapter({ provider: "mock", config: { model: "mock-v1" } });
  const info = adapter.getProviderInfo();
  assert.equal(info.provider, "mock");
  assert.equal(info.model, "mock-v1");
});
