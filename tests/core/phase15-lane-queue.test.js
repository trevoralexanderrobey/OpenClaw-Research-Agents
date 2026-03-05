"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { createLaneQueue } = require("../../openclaw-bridge/core/lane-queue.js");
const { createRoleRouter } = require("../../openclaw-bridge/core/role-router.js");
const { createAgentRegistry } = require("../../openclaw-bridge/core/agent-registry.js");
const { createCommsBus } = require("../../openclaw-bridge/core/comms-bus.js");

async function makeTmpPath() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase15-"));
  return path.join(dir, "lane-queue.json");
}

test("phase15 lane queue preserves deterministic FIFO order under concurrent enqueue", async () => {
  const queue = createLaneQueue({ persistencePath: await makeTmpPath(), timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" } });

  await Promise.all([
    Promise.resolve().then(() => queue.enqueue("session-1", { item: "a" })),
    Promise.resolve().then(() => queue.enqueue("session-1", { item: "b" })),
    Promise.resolve().then(() => queue.enqueue("session-1", { item: "c" }))
  ]);

  const first = queue.dequeue("session-1");
  const second = queue.dequeue("session-1");
  const third = queue.dequeue("session-1");

  assert.ok(first.queue_sequence < second.queue_sequence);
  assert.ok(second.queue_sequence < third.queue_sequence);
  assert.equal(queue.getQueueState("session-1").queue_length, 0);
});

test("phase15 role router requires supervisor approval", async () => {
  const registry = createAgentRegistry();
  registry.registerRole("scout", async () => ({ ok: true }));

  const router = createRoleRouter({
    registry,
    autonomyLadder: {
      canRolePerform: () => true,
      requireHumanApproval: () => false
    }
  });

  await assert.rejects(async () => router.dispatch({ role: "scout", actionType: "execute_task" }, {}), (error) => error && error.code === "SUPERVISOR_APPROVAL_REQUIRED");
});

test("phase15 role router enforces autonomy ladder boundaries", async () => {
  const registry = createAgentRegistry();
  registry.registerRole("scout", async () => ({ ok: true }));

  const router = createRoleRouter({
    registry,
    autonomyLadder: {
      canRolePerform: () => false,
      requireHumanApproval: () => false
    }
  });

  await assert.rejects(
    async () => router.dispatch(
      { role: "scout", actionType: "execute_task" },
      { supervisorDecision: { approved: true, decision_id: "sup-1" }, operatorApproved: true }
    ),
    (error) => error && error.code === "PHASE15_ROLE_ACTION_DENIED"
  );
});

test("phase15 comms bus detects tampered envelopes", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase15-comms-"));
  const bus = createCommsBus({
    basePath: path.join(dir, "comms"),
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const inbox = bus.writeInboxMessage("scout", { task: "collect", payload: "safe" });
  bus.appendBlackboard({ note: "baseline" });

  const tampered = JSON.parse(fs.readFileSync(inbox.path, "utf8"));
  tampered.envelope.payload = "tampered";
  fs.writeFileSync(inbox.path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  const result = bus.detectTamper({ scope: "inbox", role: "scout" });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((entry) => entry.type === "envelope_hash_mismatch"));
});
