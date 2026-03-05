"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createCheckpointCoordinator } = require("../../workflows/recovery-assurance/checkpoint-coordinator.js");
const { setupPhase11Harness } = require("./_phase11-helpers.js");

const root = path.resolve(__dirname, "../..");

test("phase11 checkpoint coordinator creates deterministic checkpoint artifacts", async () => {
  const harness = await setupPhase11Harness();
  const coordinator = createCheckpointCoordinator({
    apiGovernance: harness.governance,
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const first = await coordinator.createCheckpoint({
    rootDir: root,
    timestamp: "2026-03-05T00:00:00.000Z",
    runtime_state: await harness.governance.readState()
  });
  const second = await coordinator.createCheckpoint({
    rootDir: root,
    timestamp: "2026-03-05T00:00:00.000Z",
    runtime_state: await harness.governance.readState()
  });

  assert.deepEqual(second, first);
  assert.ok(first.checkpoint_id.startsWith("CHK-20260305-"));
  assert.ok(first.checkpoint_hash.startsWith("sha256:"));
  assert.ok(first.manifest_ref.includes(first.checkpoint_id));
  assert.equal(Array.isArray(first.checkpoint.artifacts), true);
});

test("phase11 checkpoint coordinator keeps governance state read-only", async () => {
  const harness = await setupPhase11Harness();
  const coordinator = createCheckpointCoordinator({
    apiGovernance: harness.governance,
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const before = JSON.stringify(await harness.governance.readState());
  await coordinator.createCheckpoint({
    rootDir: root,
    timestamp: "2026-03-05T00:00:00.000Z"
  });
  const after = JSON.stringify(await harness.governance.readState());
  assert.equal(after, before);
});

test("phase11 checkpoint coordinator reads existing phase evidence files when present", async () => {
  const harness = await setupPhase11Harness();
  const evidenceDir = path.join(harness.dir, "audit", "evidence", "observability");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "hash-manifest.json"), "{}\n", "utf8");

  const coordinator = createCheckpointCoordinator({
    apiGovernance: harness.governance,
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const result = await coordinator.createCheckpoint({
    rootDir: harness.dir,
    evidence_files: ["audit/evidence/observability/hash-manifest.json"],
    timestamp: "2026-03-05T00:00:00.000Z"
  });

  assert.equal(result.checkpoint.artifacts.length, 1);
  assert.equal(result.checkpoint.artifacts[0].file, "audit/evidence/observability/hash-manifest.json");
});
