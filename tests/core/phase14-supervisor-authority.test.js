"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSupervisorAuthority } = require("../../openclaw-bridge/core/supervisor-authority.js");
const { createMutableTimeProvider } = require("./_phase14-helpers.js");

function createTask(taskId, description = "task") {
  return {
    task_id: taskId,
    description,
    type: "freeform"
  };
}

test("phase14 supervisor denial path: missing confirm is denied", async () => {
  const supervisor = createSupervisorAuthority({
    timeProvider: createMutableTimeProvider(),
    approvalPolicy: { requireConfirm: true },
    executeHandler: async () => ({ ok: true })
  });
  await supervisor.initialize();

  const decision = await supervisor.requestApproval(createTask("task-deny", "deny"), { confirm: false, operatorId: "op" });
  assert.equal(decision.approved, false);
  assert.equal(decision.reason, "missing_confirm");
});

test("phase14 supervisor queue ordering is deterministic for approved tasks", async () => {
  const executed = [];
  const supervisor = createSupervisorAuthority({
    timeProvider: createMutableTimeProvider(),
    executeHandler: async (taskEnvelope) => {
      executed.push(taskEnvelope.task_id);
      return { ok: true, task_id: taskEnvelope.task_id };
    }
  });
  await supervisor.initialize();

  const tasks = [createTask("task-1", "one"), createTask("task-2", "two"), createTask("task-3", "three")];
  for (const task of tasks) {
    const decision = await supervisor.requestApproval(task, { confirm: true, operatorId: "op" });
    supervisor.enqueueApprovedTask(task, { supervisorDecision: decision });
  }

  await supervisor.drainOne();
  await supervisor.drainOne();
  await supervisor.drainOne();

  assert.deepEqual(executed, ["task-1", "task-2", "task-3"]);
});

test("phase14 circuit breaker opens deterministically after repeated failures", async () => {
  const timeProvider = createMutableTimeProvider();
  const supervisor = createSupervisorAuthority({
    timeProvider,
    supervisorConfig: {
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 60000
    },
    executeHandler: async () => {
      const error = new Error("forced failure");
      error.code = "FORCED_FAILURE";
      throw error;
    }
  });
  await supervisor.initialize();

  const task = createTask("task-breaker", "breaker");
  const decision = await supervisor.requestApproval(task, { confirm: true, operatorId: "op" });

  await assert.rejects(async () => supervisor.runApprovedTask(task, { supervisorDecision: decision, confirm: true }), (error) => error && error.code === "FORCED_FAILURE");
  await assert.rejects(async () => supervisor.runApprovedTask(task, { supervisorDecision: decision, confirm: true }), (error) => error && error.code === "FORCED_FAILURE");

  await assert.rejects(async () => supervisor.runApprovedTask(task, { supervisorDecision: decision, confirm: true }), (error) => error && error.code === "PHASE14_SUPERVISOR_BREAKER_OPEN");
});
