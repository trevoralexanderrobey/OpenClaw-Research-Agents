"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { createApiGovernance } = require("../../security/api-governance.js");

function sha256File(filePath) {
  const body = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase5-state-"));
}

function writeV4State(statePath) {
  const v4 = {
    schemaVersion: 4,
    deterministicSerialization: true,
    lastDeterministicReplayAt: null,
    activeInitiatives: [],
    openLoops: [],
    agentHealth: {},
    circuitBreakerState: {},
    dailyTokenUsage: {},
    hydrationTimestamp: "1970-01-01T00:00:00.000Z",
    apiGovernance: {
      dayKey: "1970-01-01",
      global: { requestsToday: 0, tokensToday: 0 },
      window: { minuteEpoch: 0, globalRequests: 0, perMcpRequests: {} },
      perMcpDaily: {},
      violations: { count: 0, lastViolationAt: null, lastViolationCode: null },
      mutation: {
        hourWindow: { hourEpoch: 0, publishes: 0 },
        dayWindow: { dayKey: "1970-01-01", publishes: 0, writeTokens: 0 },
        controlWindow: { minuteEpoch: 0, toggles: 0 },
        accountedAttemptIds: {}
      }
    },
    researchIngestion: {
      nextSequence: 1,
      lastCommittedSequence: 0,
      hashVersion: "research-record-v1"
    },
    outboundMutation: {
      enabled: false,
      killSwitch: false,
      pendingPublications: [],
      committedPublications: [],
      lastMutationSequence: 0,
      lastControlToggleAt: null,
      lastControlSequence: 0,
      mutationLogTipHash: "0000000000000000000000000000000000000000000000000000000000000000"
    }
  };
  fs.writeFileSync(statePath, `${JSON.stringify(v4, null, 2)}\n`, "utf8");
}

test("v4->v5 migration succeeds and is deterministic", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV4State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v4-to-v5.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const migrated = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(Array.isArray(migrated.rlhfWorkflows.drafts), true);
  assert.equal(migrated.rlhfWorkflows.nextDraftSequence, 0);

  const firstHash = sha256File(statePath);
  const migrateAgain = spawnSync("node", ["scripts/migrate-state-v4-to-v5.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrateAgain.status, 0, migrateAgain.stderr || migrateAgain.stdout);
  const secondHash = sha256File(statePath);
  assert.equal(firstHash, secondHash, "migration output changed on second run");
});

test("v5 downgrade paths are rejected by prior migrators", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV4State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v4-to-v5.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const downgradeA = spawnSync("node", ["scripts/migrate-state-v3-to-v4.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.notEqual(downgradeA.status, 0, "v5 should not be accepted by v3->v4 migrator");

  const downgradeB = spawnSync("node", ["scripts/migrate-state-v2-to-v3.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.notEqual(downgradeB.status, 0, "v5 should not be accepted by v2->v3 migrator");
});

test("api governance rejects unsupported runtime state versions in Phase 5", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV4State(statePath);

  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await assert.rejects(async () => governance.snapshot(), (error) => error && error.code === "RUNTIME_STATE_SCHEMA_UNSUPPORTED");
});
