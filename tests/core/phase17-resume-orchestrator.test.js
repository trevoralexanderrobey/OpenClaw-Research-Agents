"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { registerOpenLoop } = require("../../openclaw-bridge/state/persistent-store.js");
const { createStateHydrator } = require("../../openclaw-bridge/state/state-hydrator.js");
const { createOpenLoopManager } = require("../../openclaw-bridge/state/open-loop-manager.js");
const { createLaneQueue } = require("../../openclaw-bridge/core/lane-queue.js");
const { createRestartResumeOrchestrator } = require("../../openclaw-bridge/core/restart-resume-orchestrator.js");
const { validateToolImagePolicy } = require("../../openclaw-bridge/execution/tool-image-catalog.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase17-"));
}

test("phase17 resume orchestrator requeues open loops deterministically", async () => {
  const dir = await makeTmpDir();
  const runtimePath = path.join(dir, "state.json");

  await registerOpenLoop({
    loopId: "loop-a",
    sessionId: "session-1",
    taskEnvelope: { taskId: "task-a" }
  }, { path: runtimePath });

  const laneQueue = createLaneQueue({ persistencePath: path.join(dir, "lane.json"), timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" } });
  const hydrator = createStateHydrator({ path: runtimePath });
  const openLoopManager = createOpenLoopManager({ path: runtimePath, laneQueue });

  const orchestrator = createRestartResumeOrchestrator({
    stateHydrator: hydrator,
    openLoopManager,
    governanceBridge: {
      recordTaskExecution: async () => ({ ok: true })
    }
  });

  const result = await orchestrator.resumePendingWork({ correlationId: "resume-test" });
  assert.equal(result.ok, true);
  assert.equal(result.requeue_result.requeued_count, 1);

  const queueState = laneQueue.getQueueState("session-1");
  assert.equal(queueState.queue_length, 1);
});

test("phase17 runtime rejects non-allowlisted tool images", () => {
  assert.throws(
    () => validateToolImagePolicy("not-allowlisted-tool"),
    (error) => error && error.code === "TOOL_IMAGE_NOT_FOUND"
  );
});

test("phase17 resume applies supervisor and governance approvals before resumed execution", async () => {
  const dir = await makeTmpDir();
  const runtimePath = path.join(dir, "state.json");
  await registerOpenLoop({
    loopId: "loop-b",
    sessionId: "session-2",
    taskEnvelope: { task_id: "task-b", description: "resume task" }
  }, { path: runtimePath });

  const laneQueue = createLaneQueue({ persistencePath: path.join(dir, "lane.json"), timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" } });
  const hydrator = createStateHydrator({ path: runtimePath });
  const openLoopManager = createOpenLoopManager({ path: runtimePath, laneQueue });

  const calls = { supervisor: 0, governance: 0, executed: 0 };
  const orchestrator = createRestartResumeOrchestrator({
    stateHydrator: hydrator,
    openLoopManager,
    supervisorAuthority: {
      requestApproval: async () => {
        calls.supervisor += 1;
        return { approved: true, decision_id: "sup-resume-1", reason: "approved" };
      }
    },
    governanceBridge: {
      requestTaskApproval: async () => {
        calls.governance += 1;
        return { approved: true, reason: "governance_approved" };
      },
      recordTaskExecution: async () => ({ ok: true })
    }
  });

  const result = await orchestrator.resumePendingWork({
    executeResumedTasks: true,
    confirm: true,
    operatorId: "operator-resume",
    executeHandler: async () => {
      calls.executed += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.supervisor, 1);
  assert.equal(calls.governance, 1);
  assert.equal(calls.executed, 1);
});
