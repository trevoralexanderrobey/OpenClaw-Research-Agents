"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");
const { createApiGovernance } = require("../../security/api-governance.js");
const { createMcpService } = require("../../openclaw-bridge/mcp/mcp-service.js");
const { TOOL_EGRESS_POLICIES } = require("../../openclaw-bridge/execution/egress-policy.js");
const { SemanticScholarMcp } = require("../../openclaw-bridge/mcp/semantic-scholar-mcp.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase3-normalization-"));
}

function buildRecord(sequence) {
  const base = {
    source: "semantic-scholar",
    paper_id: `paper-${sequence}`,
    title: `Title ${sequence}`,
    abstract: "Abstract",
    authors: ["Author"],
    citation_velocity: sequence,
    published_at: "2024-01-01T00:00:00.000Z",
    retrieved_at: "2026-03-03T00:00:00.000Z"
  };
  return {
    ...base,
    hash: BaseMcp.computeRecordHash(base),
    sequence
  };
}

test("tampered payload hash mismatch is rejected on replay verification", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  const researchPath = path.join(dir, "research.ndjson");

  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: researchPath
  });

  await governance.withGovernanceTransaction(async (tx) => {
    tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
    const seq = tx.allocateSequence();
    tx.appendResearchRecord(buildRecord(seq));
  });

  const tampered = buildRecord(2);
  tampered.title = "Tampered Title";
  fs.appendFileSync(researchPath, `${JSON.stringify(tampered)}\n`, "utf8");

  const service = createMcpService({ apiGovernance: governance });
  await assert.rejects(() => service.verifyStoredReplay(), (error) => error && error.code === "MCP_HASH_MISMATCH");
});

test("oversized abstract is rejected", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  const mcp = new SemanticScholarMcp({
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    maxAbstractChars: 10,
    resolver: {
      async resolve4() {
        return ["34.120.0.1"];
      },
      async resolve6() {
        return [];
      }
    },
    httpGet: async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: [
          {
            paperId: "abc123",
            title: "Long Abstract",
            abstract: "This abstract is intentionally too long",
            authors: [{ name: "Alice" }],
            citationCount: 1,
            publicationDate: "2024-01-01T00:00:00.000Z"
          }
        ]
      })
    })
  });

  await assert.rejects(
    () =>
      mcp.run(
        {
          action: "search",
          query: "long abstract",
          limit: 1
        },
        { correlationId: "abcdabcdabcdabcd" }
      ),
    (error) => error && error.code === "MCP_OUTPUT_SCHEMA_INVALID"
  );
});
