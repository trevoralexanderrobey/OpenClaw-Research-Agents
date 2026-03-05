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
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase8-state-"));
}

function writeV7State(statePath) {
  const v7 = {
    schemaVersion: 7,
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
    },
    rlhfOutcomes: {
      records: [],
      nextOutcomeSequence: 0,
      calibration: {
        version: "v1",
        lastCalibratedAt: "",
        weights: {
          complexity: 0.35,
          monetization: 0.35,
          qualitySignal: 0.30
        }
      },
      portfolioSnapshots: [],
      nextSnapshotSequence: 0,
      chainHeadHash: "0000000000000000000000000000000000000000000000000000000000000000",
      chainHeadSequence: 0
    },
    experimentGovernance: {
      policyVersion: "v1",
      experiments: [],
      assignments: [],
      analysisSnapshots: [],
      rolloutDecisions: [],
      activeRolloutProfile: {
        version: "v1",
        updatedAt: "",
        updatedBy: "",
        weights: {
          complexity: 0.35,
          monetization: 0.35,
          qualitySignal: 0.30
        },
        templateBias: {}
      },
      decisionLedger: { records: [], nextSequence: 0, chainHead: "" },
      nextExperimentSequence: 0,
      nextAssignmentSequence: 0,
      nextAnalysisSequence: 0,
      nextRolloutDecisionSequence: 0
    }
  };
  fs.writeFileSync(statePath, `${JSON.stringify(v7, null, 2)}\n`, "utf8");
}

test("v7->v8 migration succeeds and is deterministic", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV7State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v7-to-v8.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const migrated = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(migrated.schemaVersion, 8);
  assert.equal(Array.isArray(migrated.complianceGovernance.attestationSnapshots), true);
  assert.equal(migrated.complianceGovernance.nextReleaseGateSequence, 0);

  const firstHash = sha256File(statePath);
  const migrateAgain = spawnSync("node", ["scripts/migrate-state-v7-to-v8.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrateAgain.status, 0, migrateAgain.stderr || migrateAgain.stdout);
  const secondHash = sha256File(statePath);
  assert.equal(firstHash, secondHash, "migration output changed on second run");
});

test("v8 downgrade path is rejected by v6->v7 migrator", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV7State(statePath);

  const migrate = spawnSync("node", ["scripts/migrate-state-v7-to-v8.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const downgrade = spawnSync("node", ["scripts/migrate-state-v6-to-v7.js", statePath], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8"
  });
  assert.notEqual(downgrade.status, 0, "v8 should not be accepted by v6->v7 migrator");
});

test("api governance rejects unsupported runtime state schema versions in Phase 8", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  writeV7State(statePath);

  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await assert.rejects(async () => governance.snapshot(), (error) => error && error.code === "RUNTIME_STATE_SCHEMA_UNSUPPORTED");
});
