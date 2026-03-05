"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createGovernanceBridge } = require("../../openclaw-bridge/core/governance-bridge.js");
const { makeTmpDir } = require("./_phase14-helpers.js");

test("phase14 governance bridge calls supervisor and supports fallback mode", async () => {
  const decisions = [];
  const bridge = createGovernanceBridge({
    supervisorAuthority: {
      requestApproval: async () => ({ approved: true, reason: "ok", decision_id: "sup-1", task_id: "task-x", timestamp: "2026-03-05T00:00:00.000Z" })
    },
    operationalDecisionLedger: {
      recordDecision: async (entry) => {
        decisions.push(entry);
        return { ok: true };
      }
    }
  });

  const supervisor = await bridge.requestSupervisorApproval({ task_id: "task-x" }, { confirm: true, operatorId: "operator-1" });
  assert.equal(supervisor.approved, true);
  assert.equal(decisions.length, 1);

  const approval = await bridge.requestTaskApproval({ task_id: "task-x" }, { supervisorDecision: supervisor });
  assert.equal(approval.approved, true);
});

test("phase14 governance bridge dual-write generates local mirror", async () => {
  const dir = await makeTmpDir();
  const writes = [];
  const bridge = createGovernanceBridge({
    apiGovernance: {
      withGovernanceTransaction: async (handler) => handler({ state: { rlhfWorkflows: { drafts: [], reviewQueue: [], nextDraftSequence: 0, nextQueueSequence: 0 } } })
    }
  });

  const taskDir = path.join(dir, "task-1");
  fs.mkdirSync(taskDir, { recursive: true });

  const result = await bridge.generateRLHFEntry("task-1", {
    prompt: "prompt",
    response: "response",
    provider: "mock",
    model: "mock-v1"
  }, {
    taskOutputDir: taskDir
  });

  writes.push(result);
  assert.equal(writes.length, 1);
  assert.equal(fs.existsSync(path.join(taskDir, "rlhf-entry.json")), true);
});
