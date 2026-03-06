"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { buildPhase14Runtime } = require("../../scripts/_phase14-agent-utils.js");
const { createTaskDefinition } = require("../../openclaw-bridge/core/task-definition-schema.js");

test("phase18 compatibility preserves the legacy single-task execution lifecycle", async () => {
  const inputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-compat-input-"));
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-compat-output-"));
  await fsp.writeFile(path.join(inputDir, "source.txt"), "sample input", "utf8");

  const runtime = await buildPhase14Runtime({
    config: {
      inputDir,
      outputDir,
      provider: "mock",
      model: "mock-v1"
    }
  });
  const task = createTaskDefinition({
    type: "summarize",
    description: "Legacy task path still works",
    inputs: [{ path: inputDir, type: "path" }],
    outputFormat: "markdown",
    createdAt: "2026-03-05T00:00:00.000Z"
  });

  const supervisorDecision = await runtime.governanceBridge.requestSupervisorApproval(task, {
    confirm: true,
    operatorId: "operator-test"
  });
  const result = await runtime.supervisorAuthority.runApprovedTask(task, {
    confirm: true,
    operatorId: "operator-test",
    supervisorDecision,
    provider: "mock",
    model: "mock-v1"
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.ok(result.output_path.includes(task.task_id));
});

test("phase18 mission mode stays disabled by default until live evidence is promoted", async () => {
  const runtime = await buildPhase14Runtime();
  await assert.rejects(
    async () => runtime.agentSpawner.spawnMission({
      template_id: "academic_trend_scan",
      description: "disabled mission",
      inputs: [],
      created_at: "2026-03-06T00:00:00.000Z"
    }, {
      supervisorDecision: { approved: true, decision_id: "sup-1" },
      governanceDecision: { approved: true, reason: "governance_approved" }
    }),
    (error) => error && error.code === "PHASE18_DISABLED"
  );
});
