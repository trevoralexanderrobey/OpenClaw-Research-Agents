"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { createPhase14Harness, makeTmpDir } = require("./_phase14-helpers.js");
const { createTaskDefinition } = require("../../openclaw-bridge/core/task-definition-schema.js");
const { createAgentEngine } = require("../../openclaw-bridge/core/agent-engine.js");
const { createResearchOutputManager } = require("../../openclaw-bridge/core/research-output-manager.js");

test("phase14 agent engine blocks direct execution without supervisor context", async () => {
  const harness = await createPhase14Harness();
  const task = createTaskDefinition({
    type: "freeform",
    description: "test",
    inputs: [],
    outputFormat: "markdown",
    createdAt: "2026-03-05T00:00:00.000Z"
  });

  await assert.rejects(async () => harness.engine.executeTask(task, {}), (error) => error && error.code === "SUPERVISOR_APPROVAL_REQUIRED");
});

test("phase14 supervisor denial path does not call llm adapter", async () => {
  const harness = await createPhase14Harness();
  const outputDir = await makeTmpDir("openclaw-phase14-output-");
  let llmCalls = 0;

  const engine = createAgentEngine({
    timeProvider: harness.timeProvider,
    config: { maxTokensPerRequest: 512 },
    governanceBridge: {
      requestTaskApproval: async () => ({ approved: true }),
      recordTaskExecution: async () => ({ ok: true }),
      generateRLHFEntry: async () => ({ ok: true, local_mirror_path: "" })
    },
    llmAdapter: {
      complete: async () => {
        llmCalls += 1;
        return { text: "never-called", provider: "mock", model: "mock-v1", tokenCount: 1, durationMs: 1 };
      },
      getProviderInfo: () => ({ provider: "mock", model: "mock-v1" })
    },
    outputManager: createResearchOutputManager({
      timeProvider: harness.timeProvider,
      outputDir
    })
  });

  const task = createTaskDefinition({
    type: "freeform",
    description: "Supervisor denied task",
    inputs: [],
    outputFormat: "markdown",
    createdAt: "2026-03-05T00:00:00.000Z"
  });

  await assert.rejects(
    async () => engine.executeTask(task, { supervisorDecision: { approved: false, decision_id: "sup-deny", reason: "denied" } }),
    (error) => error && error.code === "SUPERVISOR_APPROVAL_REQUIRED"
  );
  assert.equal(llmCalls, 0);
});

test("phase14 end-to-end mock execution pipeline works", async () => {
  const harness = await createPhase14Harness();
  const inputDir = await makeTmpDir("openclaw-phase14-input-");
  await fsp.writeFile(path.join(inputDir, "a.txt"), "sample input", "utf8");

  const task = createTaskDefinition({
    type: "summarize",
    description: "Summarize test input",
    inputs: [{ path: inputDir, type: "path" }],
    outputFormat: "markdown",
    createdAt: "2026-03-05T00:00:00.000Z"
  });

  const supervisorDecision = await harness.governanceBridge.requestSupervisorApproval(task, {
    confirm: true,
    operatorId: "operator-test"
  });

  const result = await harness.supervisorAuthority.runApprovedTask(task, {
    confirm: true,
    supervisorDecision,
    operatorId: "operator-test"
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.ok(result.output_path.includes(task.task_id));
  assert.equal(harness.interactionLog.getInteractionCount(), 1);
});
