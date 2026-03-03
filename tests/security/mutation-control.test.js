"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createMutationControl } = require("../../security/mutation-control.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase4-mutation-"));
}

function createHarness(options = {}) {
  const logger = { info() {}, warn() {}, error() {} };
  const apiGovernance = createApiGovernance({
    logger,
    statePath: options.statePath,
    researchNdjsonPath: options.researchPath,
    mutationPublishesPerHour: 50,
    mutationPublishesPerDay: 100,
    mutationWriteTokensPerDay: 500000,
    timeProvider: options.timeProvider
  });
  const operatorAuthorization = createOperatorAuthorization({
    logger,
    tokenTtlMs: 60_000
  });
  const mutationControl = createMutationControl({
    logger,
    apiGovernance,
    operatorAuthorization,
    mutationLogPath: options.mutationLogPath,
    timeProvider: options.timeProvider,
    executeOutboundRequest: options.executeOutboundRequest
  });
  return { apiGovernance, operatorAuthorization, mutationControl };
}

test("prepare fails when mutation enabled flag is false", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => ({
      externalId: "ext-1",
      latencyMs: 10,
      domain: "api.beehiiv.com",
      method: "POST"
    })
  });

  const token = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  await assert.rejects(
    () =>
      harness.mutationControl.preparePublication({
        provider: "newsletter",
        method: "POST",
        url: "https://api.beehiiv.com/v2/publications/pub/posts",
        payload: { title: "t", html: "<p>x</p>" },
        approvalToken: token
      }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_DISABLED"
  );
});

test("prepare fails without operator approval token", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => ({
      externalId: "ext-1",
      latencyMs: 10,
      domain: "api.beehiiv.com",
      method: "POST"
    })
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  await assert.rejects(
    () =>
      harness.mutationControl.preparePublication({
        provider: "newsletter",
        method: "POST",
        url: "https://api.beehiiv.com/v2/publications/pub/posts",
        payload: { title: "t", html: "<p>x</p>" }
      }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("mutation prepare+commit succeeds and dedupes identical payload", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => ({
      externalId: "beehiiv-post-123",
      latencyMs: 12,
      domain: "api.beehiiv.com",
      method: "POST"
    })
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  const commitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  const committed = await harness.mutationControl.commitPublication({
    sequence: prepared.sequence,
    approvalToken: commitToken
  }, { correlationId: "abcdabcdabcdabcd" });

  assert.equal(committed.ok, true);
  assert.equal(committed.committed.sequence, prepared.sequence);

  const duplicatePrepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  await assert.rejects(
    () => harness.mutationControl.preparePublication({
      provider: "newsletter",
      method: "POST",
      url: "https://api.beehiiv.com/v2/publications/pub/posts",
      payload: { title: "hello", html: "<p>world</p>" },
      approvalToken: duplicatePrepareToken
    }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_ALREADY_COMMITTED"
  );
});

test("uncertain retry preserves sequence and idempotency key", async () => {
  const dir = await makeTmpDir();
  let attempts = 0;
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async (attempt) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("upstream timeout");
        error.code = "MUTATION_OUTBOUND_TIMEOUT";
        throw error;
      }
      return {
        externalId: "notion-page-1",
        latencyMs: 20,
        domain: "api.notion.com",
        method: "POST"
      };
    }
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.notion.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "notion",
    method: "POST",
    url: "https://api.notion.com/v1/pages",
    payload: { parent: { database_id: "db_openclaw_publications" }, properties: { Name: { title: [] } } },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  const firstCommitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: firstCommitToken }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_OUTBOUND_TIMEOUT"
  );

  const stateAfterFailure = await harness.apiGovernance.readState();
  const pending = stateAfterFailure.outboundMutation.pendingPublications.find((item) => Number(item.sequence) === prepared.sequence);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.dispatchState, "uncertain");

  const retryToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  const retried = await harness.mutationControl.retryPublication({ sequence: prepared.sequence, approvalToken: retryToken }, { correlationId: "abcdabcdabcdabcd" });
  assert.equal(retried.ok, true);
  assert.equal(retried.committed.sequence, prepared.sequence);
  assert.equal(retried.committed.idempotencyKey, prepared.idempotencyKey);
});

test("commit fails when mutation disabled after prepare", async () => {
  const dir = await makeTmpDir();
  let currentMs = 1_000;
  const timeProvider = {
    nowMs: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString()
  };
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    timeProvider,
    executeOutboundRequest: async () => ({
      externalId: "beehiiv-post-321",
      latencyMs: 11,
      domain: "api.beehiiv.com",
      method: "POST"
    })
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  currentMs += 61_000;
  const disableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: false, approvalToken: disableToken }, { correlationId: "abcdabcdabcdabcd" });

  const commitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: commitToken }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_DISABLED"
  );
});

test("commit fails immediately when kill switch is enabled", async () => {
  const dir = await makeTmpDir();
  let currentMs = 1_000;
  const timeProvider = {
    nowMs: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString()
  };
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    timeProvider,
    executeOutboundRequest: async () => ({
      externalId: "beehiiv-post-999",
      latencyMs: 7,
      domain: "api.beehiiv.com",
      method: "POST"
    })
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  currentMs += 61_000;
  const killToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.killSwitch" }).token;
  await harness.mutationControl.setKillSwitch({ killSwitch: true, approvalToken: killToken }, { correlationId: "abcdabcdabcdabcd" });

  const commitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: commitToken }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_KILL_SWITCH_ACTIVE"
  );
});

test("startup hydration abandons pending entries not prepared while enabled", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => ({ externalId: "x", latencyMs: 1, domain: "api.beehiiv.com", method: "POST" })
  });

  await harness.apiGovernance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.pendingPublications.push({
      sequence: 42,
      provider: "newsletter",
      payloadHash: "abc",
      idempotencyKey: "def",
      dispatchState: "prepared",
      preparedWhenEnabled: false,
      allowRetry: true,
      retryCount: 0,
      maxRetryAttempts: 3,
      firstUncertainAt: null,
      uncertainDeadlineAt: null,
      lastAttemptAt: null,
      preparedAt: "2026-01-01T00:00:00.000Z",
      request: {
        method: "POST",
        url: "https://api.beehiiv.com/v2/publications/pub/posts",
        bodyCanonical: "{\"title\":\"x\"}",
        bodyBytes: 13
      }
    });
  }, { correlationId: "abcdabcdabcdabcd" });

  await harness.mutationControl.hydrateReplayProtection();
  const state = await harness.apiGovernance.readState();
  const pending = state.outboundMutation.pendingPublications.find((entry) => Number(entry.sequence) === 42);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.dispatchState, "abandoned");
  assert.equal(pending.allowRetry, false);
});

test("retry is blocked after maximum retry attempts", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => {
      const error = new Error("upstream timeout");
      error.code = "MUTATION_OUTBOUND_TIMEOUT";
      throw error;
    }
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  const commitToken1 = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: commitToken1 }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_OUTBOUND_TIMEOUT"
  );
  const commitToken2 = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.retryPublication({ sequence: prepared.sequence, approvalToken: commitToken2 }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_OUTBOUND_TIMEOUT"
  );
  const commitToken3 = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.retryPublication({ sequence: prepared.sequence, approvalToken: commitToken3 }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_OUTBOUND_TIMEOUT"
  );
  const commitToken4 = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.retryPublication({ sequence: prepared.sequence, approvalToken: commitToken4 }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && (error.code === "MUTATION_RETRY_DISALLOWED" || error.code === "MUTATION_RETRY_LIMIT_REACHED")
  );
});

test("uncertain entries older than max age require reconcile before retry", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => {
      const error = new Error("upstream timeout");
      error.code = "MUTATION_OUTBOUND_TIMEOUT";
      throw error;
    }
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const prepared = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  const commitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: commitToken }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_OUTBOUND_TIMEOUT"
  );

  await harness.apiGovernance.withGovernanceTransaction(async (tx) => {
    const pending = tx.state.outboundMutation.pendingPublications.find((entry) => Number(entry.sequence) === prepared.sequence);
    pending.uncertainDeadlineAt = "2000-01-01T00:00:00.000Z";
    pending.allowRetry = true;
  }, { correlationId: "abcdabcdabcdabcd" });

  const retryToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
  await assert.rejects(
    () => harness.mutationControl.retryPublication({ sequence: prepared.sequence, approvalToken: retryToken }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_UNCERTAIN_RECONCILE_REQUIRED"
  );
});

test("mutation sequence remains strictly monotonic across prepares", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    executeOutboundRequest: async () => ({ externalId: "x", latencyMs: 1, domain: "api.beehiiv.com", method: "POST" })
  });

  const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareTokenA = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const first = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "one", html: "<p>one</p>" },
    approvalToken: prepareTokenA
  }, { correlationId: "abcdabcdabcdabcd" });

  const prepareTokenB = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  const second = await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "two", html: "<p>two</p>" },
    approvalToken: prepareTokenB
  }, { correlationId: "abcdabcdabcdabcd" });

  assert.equal(second.sequence, first.sequence + 1);
});

test("mutation blocks commit when NODE_TLS_REJECT_UNAUTHORIZED is disabled", async () => {
  const dir = await makeTmpDir();
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson")
  });

  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const enableToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
    await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: enableToken }, { correlationId: "abcdabcdabcdabcd" });

    const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
    const prepared = await harness.mutationControl.preparePublication({
      provider: "newsletter",
      method: "POST",
      url: "https://api.beehiiv.com/v2/publications/pub/posts",
      payload: { title: "hello", html: "<p>world</p>" },
      approvalToken: prepareToken
    }, { correlationId: "abcdabcdabcdabcd" });

    const commitToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.commit" }).token;
    await assert.rejects(
      () => harness.mutationControl.commitPublication({ sequence: prepared.sequence, approvalToken: commitToken }, { correlationId: "abcdabcdabcdabcd" }),
      (error) => error && error.code === "MUTATION_TLS_ENV_OVERRIDE_FORBIDDEN"
    );
  } finally {
    if (typeof prev === "undefined") {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
});

test("toggle cooldown is enforced", async () => {
  const dir = await makeTmpDir();
  let currentMs = 1_000;
  const timeProvider = {
    nowMs: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString()
  };
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: path.join(dir, "mutation.ndjson"),
    timeProvider,
    executeOutboundRequest: async () => ({ externalId: "x", latencyMs: 1, domain: "api.beehiiv.com", method: "POST" })
  });

  const tokenA = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: tokenA }, { correlationId: "abcdabcdabcdabcd" });

  const tokenB = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await assert.rejects(
    () => harness.mutationControl.setMutationEnabled({ enabled: false, approvalToken: tokenB }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MUTATION_CONTROL_TOGGLE_COOLDOWN"
  );

  currentMs += 61_000;
  const tokenC = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  const toggled = await harness.mutationControl.setMutationEnabled({ enabled: false, approvalToken: tokenC }, { correlationId: "abcdabcdabcdabcd" });
  assert.equal(toggled.enabled, false);
});

test("mutation log tamper is detected on startup verification", async () => {
  const dir = await makeTmpDir();
  const logPath = path.join(dir, "mutation.ndjson");
  const harness = createHarness({
    statePath: path.join(dir, "state.json"),
    researchPath: path.join(dir, "research.ndjson"),
    mutationLogPath: logPath,
    executeOutboundRequest: async () => ({ externalId: "x", latencyMs: 1, domain: "api.beehiiv.com", method: "POST" })
  });

  const toggleToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.control.toggle" }).token;
  await harness.mutationControl.setMutationEnabled({ enabled: true, approvalToken: toggleToken }, { correlationId: "abcdabcdabcdabcd" });

  const prepareToken = harness.operatorAuthorization.issueApprovalToken({ scope: "mutation.newsletter.prepare" }).token;
  await harness.mutationControl.preparePublication({
    provider: "newsletter",
    method: "POST",
    url: "https://api.beehiiv.com/v2/publications/pub/posts",
    payload: { title: "hello", html: "<p>world</p>" },
    approvalToken: prepareToken
  }, { correlationId: "abcdabcdabcdabcd" });

  await fsp.appendFile(logPath, '{"tampered":true}\n', "utf8");

  const secondControl = createMutationControl({
    logger: { info() {}, warn() {}, error() {} },
    apiGovernance: harness.apiGovernance,
    operatorAuthorization: harness.operatorAuthorization,
    mutationLogPath: logPath,
    executeOutboundRequest: async () => ({ externalId: "x", latencyMs: 1, domain: "api.beehiiv.com", method: "POST" })
  });

  await assert.rejects(() => secondControl.ensureLogIntegrity(), (error) => error && error.code === "MUTATION_LOG_CHAIN_INVALID");
});
