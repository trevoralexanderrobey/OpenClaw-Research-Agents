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
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-state-"));
}

function writeV5State(statePath) {
  const v5 = {
    schemaVersion: 5,
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
    },
    rlhfWorkflows: {
      drafts: [],
      candidateQueue: [],
      reviewQueue: [],
      nextDraftSequence: 0,
      nextQueueSequence: 0,
      lastAutomationRunAt: "",
      generatorVersion: "v1"
    }
  };
  fs.writeFileSync(statePath, `${JSON.stringify(v5, null, 2)}\n`, "utf8");
}

test("v5->v6 migration succeeds and is deterministic", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV5State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v5-to-v6.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const migrated = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(Array.isArray(migrated.rlhfOutcomes.records), true);
  assert.equal(migrated.rlhfOutcomes.nextOutcomeSequence, 0);

  const firstHash = sha256File(statePath);
  const migrateAgain = spawnSync("node", ["scripts/migrate-state-v5-to-v6.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrateAgain.status, 0, migrateAgain.stderr || migrateAgain.stdout);
  const secondHash = sha256File(statePath);
  assert.equal(firstHash, secondHash, "migration output changed on second run");
});

test("v6 downgrade path is rejected by v4->v5 migrator", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV5State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v5-to-v6.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const downgrade = spawnSync("node", ["scripts/migrate-state-v4-to-v5.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.notEqual(downgrade.status, 0, "v6 should not be accepted by v4->v5 migrator");
});

test("api governance rejects unsupported runtime state schema versions in Phase 6", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV5State(statePath);

  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await assert.rejects(async () => governance.snapshot(), (error) => error && error.code === "RUNTIME_STATE_SCHEMA_UNSUPPORTED");
});
