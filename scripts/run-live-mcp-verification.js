#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../security/api-governance.js");
const { createArxivClient } = require("../integrations/mcp/arxiv-client.js");
const { createSemanticScholarClient } = require("../integrations/mcp/semantic-scholar-client.js");
const { createArxivMcp } = require("../openclaw-bridge/mcp/arxiv-mcp.js");
const { createSemanticScholarMcp } = require("../openclaw-bridge/mcp/semantic-scholar-mcp.js");
const { createMcpService } = require("../openclaw-bridge/mcp/mcp-service.js");
const { TOOL_EGRESS_POLICIES } = require("../openclaw-bridge/execution/egress-policy.js");
const { canonicalize, safeString, sha256 } = require("../workflows/governance-automation/common.js");
const {
  createMemoryLogger,
  normalizeError,
  parseCsvOption,
  withTimeout,
  writeEvidenceSet
} = require("./_live-verification-common.js");

const DEFAULT_PROVIDERS = Object.freeze(["arxiv", "semantic-scholar"]);
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "audit", "evidence", "mcp-live");
const DEFAULT_TIMEOUT_MS = 15000;
const QUERY_BY_PROVIDER = Object.freeze({
  arxiv: "transformer interpretability",
  "semantic-scholar": "foundation models"
});

function parseArgs(argv) {
  const out = {
    outputDir: DEFAULT_OUTPUT_DIR,
    providers: DEFAULT_PROVIDERS.slice(),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--providers") { out.providers = parseCsvOption(argv[index + 1], DEFAULT_PROVIDERS); index += 1; continue; }
    if (token === "--output-dir") { out.outputDir = path.resolve(String(argv[index + 1] || "").trim() || out.outputDir); index += 1; continue; }
    if (token === "--timeout-ms") { out.timeoutMs = Math.max(1, Number.parseInt(String(argv[index + 1] || "").trim(), 10) || out.timeoutMs); index += 1; continue; }
  }

  return out;
}

async function createTempGovernance(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 1000,
    globalRequestsPerMinute: 1000,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 100000
  });
}

function createDirectClient(provider) {
  if (provider === "arxiv") {
    return createArxivClient();
  }
  if (provider === "semantic-scholar") {
    return createSemanticScholarClient();
  }
  throw new Error(`Unsupported provider '${provider}'`);
}

function createMcpModule(provider, options = {}) {
  if (provider === "arxiv") {
    return createArxivMcp(options);
  }
  if (provider === "semantic-scholar") {
    return createSemanticScholarMcp(options);
  }
  throw new Error(`Unsupported provider '${provider}'`);
}

function createSuccessBody(provider) {
  if (provider === "arxiv") {
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<feed xmlns=\"http://www.w3.org/2005/Atom\">",
      "<entry>",
      "<id>http://arxiv.org/abs/1234.56789</id>",
      "<title>Deterministic Test Paper</title>",
      "<summary>Stable abstract for retry harness.</summary>",
      "<author><name>Alice Example</name></author>",
      "<published>2024-01-01T00:00:00.000Z</published>",
      "</entry>",
      "</feed>"
    ].join("");
  }

  return JSON.stringify({
    data: [
      {
        paperId: "paper-123",
        title: "Deterministic Test Paper",
        abstract: "Stable abstract for retry harness.",
        authors: [{ name: "Alice Example" }],
        citationCount: 42,
        publicationDate: "2024-01-01T00:00:00.000Z"
      }
    ]
  });
}

async function probeDirectClient(provider, timeoutMs) {
  const client = createDirectClient(provider);
  const query = QUERY_BY_PROVIDER[provider];
  const startedAt = Date.now();

  try {
    const records = await withTimeout(() => client.searchPapers(query, { limit: 1 }), timeoutMs);
    const first = Array.isArray(records) ? records[0] || null : null;
    return canonicalize({
      duration_ms: Date.now() - startedAt,
      provider,
      query,
      record_count: Array.isArray(records) ? records.length : 0,
      sample_hash: first ? sha256(JSON.stringify(first)) : "",
      status: "success"
    });
  } catch (error) {
    return canonicalize({
      duration_ms: Date.now() - startedAt,
      error: normalizeError(error),
      provider,
      query,
      status: "failed"
    });
  }
}

async function probeControlledRetry(provider) {
  const governance = await createTempGovernance(`openclaw-mcp-retry-${provider}`);
  const callTimes = [];
  const body = createSuccessBody(provider);
  const module = createMcpModule(provider, {
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    httpGet: async () => {
      callTimes.push(Date.now());
      if (callTimes.length === 1) {
        const error = new Error("Injected transient timeout");
        error.code = "MCP_OUTBOUND_TIMEOUT";
        throw error;
      }
      return {
        body,
        headers: {},
        statusCode: 200
      };
    }
  });

  const query = QUERY_BY_PROVIDER[provider];
  try {
    const result = await module.run({
      action: "search",
      limit: 1,
      query
    }, {
      correlationId: `controlled-retry-${provider}`
    });

    return canonicalize({
      attempts_observed: callTimes.length,
      backoff_behavior: callTimes.length > 1 ? Math.max(0, callTimes[1] - callTimes[0]) : 0,
      records_count: Array.isArray(result.records) ? result.records.length : 0,
      status: "success"
    });
  } catch (error) {
    return canonicalize({
      attempts_observed: callTimes.length,
      error: normalizeError(error),
      status: "failed"
    });
  }
}

async function probeControlledTimeout(provider) {
  const governance = await createTempGovernance(`openclaw-mcp-timeout-${provider}`);
  let callCount = 0;
  const module = createMcpModule(provider, {
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    httpGet: async () => {
      callCount += 1;
      const error = new Error("Injected timeout");
      error.code = "MCP_OUTBOUND_TIMEOUT";
      throw error;
    }
  });

  try {
    await module.run({
      action: "search",
      limit: 1,
      query: QUERY_BY_PROVIDER[provider]
    }, {
      correlationId: `controlled-timeout-${provider}`
    });

    return canonicalize({
      attempts_observed: callCount,
      status: "unexpected_success"
    });
  } catch (error) {
    return canonicalize({
      attempts_observed: callCount,
      error: normalizeError(error),
      status: "failed_as_expected"
    });
  }
}

async function probeMcpService(provider, timeoutMs) {
  const governance = await createTempGovernance(`openclaw-mcp-service-${provider}`);
  const logger = createMemoryLogger();
  const service = createMcpService({
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    logger: logger.logger
  });
  const startedAt = Date.now();

  try {
    const result = await withTimeout(() => service.handle("research.search", {
      limit: 1,
      provider,
      query: QUERY_BY_PROVIDER[provider]
    }, {
      correlationId: `live-mcp-${provider}`,
      requester: "live-verification",
      role: "supervisor"
    }), timeoutMs);

    const replay = await service.verifyStoredReplay();
    const records = await governance.loadResearchRecords();
    return canonicalize({
      duration_ms: Date.now() - startedAt,
      provider,
      record_count: Array.isArray(result.records) ? result.records.length : 0,
      replay_snapshot: {
        count: Number(replay.count || 0),
        ok: replay.ok === true,
        records_hash: sha256(JSON.stringify(records))
      },
      runtime_logs: logger.getEvents(),
      status: "success"
    });
  } catch (error) {
    return canonicalize({
      duration_ms: Date.now() - startedAt,
      error: normalizeError(error),
      provider,
      runtime_logs: logger.getEvents(),
      status: "failed"
    });
  }
}

async function probeProvider(provider, timeoutMs) {
  return canonicalize({
    controlled_retry: await probeControlledRetry(provider),
    controlled_timeout: await probeControlledTimeout(provider),
    direct_client_live: await probeDirectClient(provider, timeoutMs),
    mcp_service_live: await probeMcpService(provider, timeoutMs),
    provider
  });
}

function classifyProviderStatus(result) {
  const liveSuccess = result.direct_client_live && result.direct_client_live.status === "success";
  const serviceSuccess = result.mcp_service_live && result.mcp_service_live.status === "success";
  const retrySuccess = result.controlled_retry && result.controlled_retry.status === "success";
  const timeoutSuccess = result.controlled_timeout && result.controlled_timeout.status === "failed_as_expected";
  if (liveSuccess && serviceSuccess && retrySuccess && timeoutSuccess) {
    return "partially_verified";
  }
  if (liveSuccess || serviceSuccess || retrySuccess || timeoutSuccess) {
    return "partially_verified";
  }
  return "needs_verification";
}

function classifyOverallStatus(results) {
  const items = Array.isArray(results) ? results : [];
  if (items.length === 0) {
    return "needs_verification";
  }
  if (items.every((item) => classifyProviderStatus(item) === "partially_verified")) {
    return "partially_verified";
  }
  if (items.some((item) => classifyProviderStatus(item) === "partially_verified")) {
    return "partially_verified";
  }
  return "needs_verification";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];

  for (const provider of args.providers) {
    const result = await probeProvider(provider, args.timeoutMs);
    result.status = classifyProviderStatus(result);
    results.push(canonicalize(result));
  }

  const summary = canonicalize({
    backoff_evidence_note: "No explicit sleep/backoff delay is implemented in openclaw-bridge/mcp/base-mcp.js; current evidence proves bounded retries and timeout/error wrapping.",
    completed_at: new Date().toISOString(),
    overall_status: classifyOverallStatus(results),
    providers: args.providers,
    results,
    started_at: new Date().toISOString()
  });

  const output = writeEvidenceSet(args.outputDir, "summary", summary);
  for (const result of results) {
    writeEvidenceSet(args.outputDir, result.provider, result);
  }

  process.stdout.write(`${JSON.stringify(canonicalize({
    ok: true,
    output,
    overall_status: summary.overall_status
  }), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PROVIDERS,
  QUERY_BY_PROVIDER,
  classifyOverallStatus,
  classifyProviderStatus,
  createSuccessBody,
  parseArgs,
  probeControlledRetry,
  probeControlledTimeout,
  probeDirectClient,
  probeMcpService,
  probeProvider
};
