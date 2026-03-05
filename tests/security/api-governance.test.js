"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase3-governance-"));
}

function buildRecord(sequence) {
  const base = {
    source: "semantic-scholar",
    paper_id: `paper-${sequence}`,
    title: `Title ${sequence}`,
    abstract: "Abstract",
    authors: ["Author"],
    citation_velocity: sequence,
    published_at: "2020-01-01T00:00:00.000Z",
    retrieved_at: "2026-03-03T00:00:00.000Z"
  };
  return {
    ...base,
    hash: BaseMcp.computeRecordHash(base),
    sequence
  };
}

test("api governance enforces per-minute limit", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 1,
    globalRequestsPerMinute: 10,
    dailyTokenBudget: 100,
    dailyRequestLimit: 100
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_MCP_RPM_EXCEEDED"
  );
});

test("api governance enforces daily token budget", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 10,
    globalRequestsPerMinute: 10,
    dailyTokenBudget: 10,
    dailyRequestLimit: 100
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 8, correlationId: "abcdabcdabcdabcd" });
  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 3, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_DAILY_TOKENS_EXCEEDED"
  );
});

test("api governance enforces global per-minute limit", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 10,
    globalRequestsPerMinute: 1,
    dailyTokenBudget: 100,
    dailyRequestLimit: 100
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "arxiv-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_GLOBAL_RPM_EXCEEDED"
  );
});

test("api governance enforces daily request ceiling", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 10,
    globalRequestsPerMinute: 10,
    dailyTokenBudget: 100,
    dailyRequestLimit: 1
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_DAILY_REQUESTS_EXCEEDED"
  );
});

test("api governance circuit opens after violation", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 1,
    globalRequestsPerMinute: 1,
    dailyTokenBudget: 100,
    dailyRequestLimit: 100
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_MCP_RPM_EXCEEDED"
  );

  await assert.rejects(
    () => governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "API_GOVERNANCE_CIRCUIT_OPEN"
  );
});

test("governance transaction serializes parallel sequence allocation", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 1000,
    globalRequestsPerMinute: 1000,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 100000
  });

  const count = 25;
  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      await governance.withGovernanceTransaction(async (tx) => {
        tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
        const sequence = tx.allocateSequence();
        tx.appendResearchRecord(buildRecord(sequence));
        return index;
      });
    })
  );

  const records = await governance.loadResearchRecords();
  assert.equal(records.length, count);
  for (let i = 0; i < records.length; i += 1) {
    assert.equal(records[i].sequence, i + 1, "sequence should be contiguous and ordered");
  }
});

test("governance recovers from truncated trailing NDJSON record", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  const researchPath = path.join(dir, "research.ndjson");

  const governanceA = createApiGovernance({
    statePath,
    researchNdjsonPath: researchPath,
    perMcpRequestsPerMinute: 1000,
    globalRequestsPerMinute: 1000,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 100000
  });

  await governanceA.withGovernanceTransaction(async (tx) => {
    tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
    const sequence = tx.allocateSequence();
    tx.appendResearchRecord(buildRecord(sequence));
  });

  const original = await fsp.readFile(researchPath, "utf8");
  await fsp.writeFile(researchPath, `${original}{"source":"semantic-scholar"`, "utf8");

  const governanceB = createApiGovernance({
    statePath,
    researchNdjsonPath: researchPath
  });

  const repairedRecords = await governanceB.loadResearchRecords();
  assert.equal(repairedRecords.length, 1);
  assert.equal(repairedRecords[0].sequence, 1);

  const repairedBody = await fsp.readFile(researchPath, "utf8");
  assert.equal(repairedBody.endsWith("\n"), true);
  const lines = repairedBody.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.sequence, 1);
});

test("governance daily reset uses UTC boundary from deterministic time provider", async () => {
  const dir = await makeTmpDir();
  let currentMs = Date.parse("2026-03-03T23:59:59.000Z");
  const timeProvider = {
    nowMs: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString()
  };

  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider,
    perMcpRequestsPerMinute: 1000,
    globalRequestsPerMinute: 1000,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 100000
  });

  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 2, correlationId: "abcdabcdabcdabcd" });
  const beforeMidnight = await governance.snapshot();
  assert.equal(beforeMidnight.dayKey, "2026-03-03");
  assert.equal(beforeMidnight.global.requestsToday, 1);
  assert.equal(beforeMidnight.global.tokensToday, 2);

  currentMs = Date.parse("2026-03-04T00:00:01.000Z");
  await governance.checkAndRecord({ mcp: "semantic-scholar-mcp", tokens: 3, correlationId: "abcdabcdabcdabcd" });
  const afterMidnight = await governance.snapshot();
  assert.equal(afterMidnight.dayKey, "2026-03-04");
  assert.equal(afterMidnight.global.requestsToday, 1);
  assert.equal(afterMidnight.global.tokensToday, 3);
});

test("mutation governance accounting is deduped by deterministic attempt id", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    mutationPublishesPerHour: 100,
    mutationPublishesPerDay: 100,
    mutationWriteTokensPerDay: 100000
  });

  await governance.withGovernanceTransaction(async (tx) => {
    const first = tx.applyMutationAccounting({
      kind: "publish",
      attemptId: "commit:1:1",
      tokens: 10,
      correlationId: "abcdabcdabcdabcd"
    });
    assert.equal(first.counted, true);
  });

  await governance.withGovernanceTransaction(async (tx) => {
    const second = tx.applyMutationAccounting({
      kind: "publish",
      attemptId: "commit:1:1",
      tokens: 10,
      correlationId: "abcdabcdabcdabcd"
    });
    assert.equal(second.counted, false);
  });

  const state = await governance.readState();
  assert.equal(state.apiGovernance.mutation.dayWindow.publishes, 1);
  assert.equal(state.apiGovernance.mutation.dayWindow.writeTokens, 10);
});

test("api governance initializes additive phase10 operational decision ledger state", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  const state = await governance.readState();
  assert.deepEqual(state.complianceGovernance.operationalDecisionLedger, {
    records: [],
    nextSequence: 0,
    chainHead: ""
  });
});
