"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { nowMs: runtimeNowMs, nowIso: runtimeNowIso } = require("../openclaw-bridge/core/time-provider.js");
const { randomHex } = require("../openclaw-bridge/core/entropy-provider.js");
const { createStateTransactionWrapper } = require("../openclaw-bridge/state/state-manager.js");
const { createCircuitBreaker } = require("../openclaw-bridge/supervisor/circuit-breaker.js");

const DEFAULT_LIMITS = Object.freeze({
  perMcpRequestsPerMinute: 20,
  globalRequestsPerMinute: 60,
  dailyTokenBudget: 250000,
  dailyRequestLimit: 2000,
  mutationPublishesPerHour: 5,
  mutationPublishesPerDay: 30,
  mutationWriteTokensPerDay: 100000,
  mutationControlTogglesPerMinute: 1,
  mutationAttemptIdTtlMs: 7 * 24 * 60 * 60 * 1000
});

const DEFAULT_STATE_PATH = path.resolve(process.cwd(), "workspace", "runtime", "state.json");
const DEFAULT_RESEARCH_NDJSON_PATH = path.resolve(process.cwd(), "workspace", "memory", "research-ingestion.ndjson");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalStringify(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildDefaultV4State() {
  return {
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
      global: {
        requestsToday: 0,
        tokensToday: 0
      },
      window: {
        minuteEpoch: 0,
        globalRequests: 0,
        perMcpRequests: {}
      },
      perMcpDaily: {},
      violations: {
        count: 0,
        lastViolationAt: null,
        lastViolationCode: null
      },
      mutation: {
        hourWindow: {
          hourEpoch: 0,
          publishes: 0
        },
        dayWindow: {
          dayKey: "1970-01-01",
          publishes: 0,
          writeTokens: 0
        },
        controlWindow: {
          minuteEpoch: 0,
          toggles: 0
        },
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
}

function normalizeRuntimeState(raw) {
  const state = isPlainObject(raw) ? raw : buildDefaultV4State();
  if (Number(state.schemaVersion) !== 4) {
    const error = new Error(`Unsupported runtime state schemaVersion: ${state.schemaVersion}`);
    error.code = "RUNTIME_STATE_SCHEMA_UNSUPPORTED";
    throw error;
  }

  if (!isPlainObject(state.apiGovernance)) {
    state.apiGovernance = buildDefaultV4State().apiGovernance;
  }
  if (!isPlainObject(state.apiGovernance.global)) {
    state.apiGovernance.global = { requestsToday: 0, tokensToday: 0 };
  }
  if (!isPlainObject(state.apiGovernance.window)) {
    state.apiGovernance.window = { minuteEpoch: 0, globalRequests: 0, perMcpRequests: {} };
  }
  if (!isPlainObject(state.apiGovernance.window.perMcpRequests)) {
    state.apiGovernance.window.perMcpRequests = {};
  }
  if (!isPlainObject(state.apiGovernance.perMcpDaily)) {
    state.apiGovernance.perMcpDaily = {};
  }
  if (!isPlainObject(state.apiGovernance.violations)) {
    state.apiGovernance.violations = { count: 0, lastViolationAt: null, lastViolationCode: null };
  }
  if (!isPlainObject(state.apiGovernance.mutation)) {
    state.apiGovernance.mutation = buildDefaultV4State().apiGovernance.mutation;
  }
  if (!isPlainObject(state.apiGovernance.mutation.hourWindow)) {
    state.apiGovernance.mutation.hourWindow = { hourEpoch: 0, publishes: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.dayWindow)) {
    state.apiGovernance.mutation.dayWindow = { dayKey: "1970-01-01", publishes: 0, writeTokens: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.controlWindow)) {
    state.apiGovernance.mutation.controlWindow = { minuteEpoch: 0, toggles: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.accountedAttemptIds)) {
    state.apiGovernance.mutation.accountedAttemptIds = {};
  }

  if (!isPlainObject(state.researchIngestion)) {
    state.researchIngestion = { nextSequence: 1, lastCommittedSequence: 0, hashVersion: "research-record-v1" };
  }
  state.researchIngestion.nextSequence = Math.max(1, parsePositiveInt(state.researchIngestion.nextSequence, 1));
  state.researchIngestion.lastCommittedSequence = Math.max(0, parsePositiveInt(state.researchIngestion.lastCommittedSequence, 0));
  state.researchIngestion.hashVersion = typeof state.researchIngestion.hashVersion === "string"
    ? state.researchIngestion.hashVersion
    : "research-record-v1";

  if (!isPlainObject(state.outboundMutation)) {
    state.outboundMutation = buildDefaultV4State().outboundMutation;
  }
  state.outboundMutation.enabled = Boolean(state.outboundMutation.enabled);
  state.outboundMutation.killSwitch = Boolean(state.outboundMutation.killSwitch);
  if (!Array.isArray(state.outboundMutation.pendingPublications)) {
    state.outboundMutation.pendingPublications = [];
  }
  if (!Array.isArray(state.outboundMutation.committedPublications)) {
    state.outboundMutation.committedPublications = [];
  }
  state.outboundMutation.lastMutationSequence = Math.max(0, parsePositiveInt(state.outboundMutation.lastMutationSequence, 0));
  state.outboundMutation.lastControlSequence = Math.max(0, parsePositiveInt(state.outboundMutation.lastControlSequence, 0));
  state.outboundMutation.lastControlToggleAt = typeof state.outboundMutation.lastControlToggleAt === "string"
    ? state.outboundMutation.lastControlToggleAt
    : null;
  state.outboundMutation.mutationLogTipHash = typeof state.outboundMutation.mutationLogTipHash === "string"
    && /^[a-f0-9]{64}$/.test(state.outboundMutation.mutationLogTipHash)
    ? state.outboundMutation.mutationLogTipHash
    : "0000000000000000000000000000000000000000000000000000000000000000";

  return state;
}

function dayKeyFromMsUtc(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function minuteEpochFromMsUtc(epochMs) {
  return Math.floor(Number(epochMs) / 60000);
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    const body = await fs.readFile(filePath, "utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function ensureDirectoryFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeAtomic(filePath, body, options = {}) {
  const nowMs = options.nowMs;
  const nowValue = typeof nowMs === "function" ? nowMs() : runtimeNowMs();
  await ensureDirectoryFor(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${nowValue}-${randomHex(8)}`;

  const tmpHandle = await fs.open(tmpPath, "w", 0o600);
  await tmpHandle.writeFile(body, "utf8");
  await tmpHandle.sync();
  await tmpHandle.close();

  await fs.rename(tmpPath, filePath);

  const fileHandle = await fs.open(filePath, "r");
  await fileHandle.sync();
  await fileHandle.close();

  const dirHandle = await fs.open(path.dirname(filePath), "r");
  await dirHandle.sync();
  await dirHandle.close();
}

function parseNdjsonLines(raw, options = {}) {
  const source = String(raw || "");
  const lines = source.split("\n");
  const records = [];
  const nonEmptyIndexes = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length > 0) {
      nonEmptyIndexes.push(i);
    }
  }

  const lastNonEmptyIndex = nonEmptyIndexes.length > 0 ? nonEmptyIndexes[nonEmptyIndexes.length - 1] : -1;
  const allowRecoverTrailingLine = Boolean(options.allowRecoverTrailingLine);
  let recoveredTrailingLine = false;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      continue;
    }

    try {
      records.push(JSON.parse(trimmed));
    } catch {
      const isTrailing = i === lastNonEmptyIndex;
      if (allowRecoverTrailingLine && isTrailing) {
        recoveredTrailingLine = true;
        break;
      }
      const error = new Error(`Invalid NDJSON record at line ${i + 1}`);
      error.code = "API_GOVERNANCE_NDJSON_CORRUPTED";
      error.details = { line: i + 1 };
      throw error;
    }
  }

  return {
    records,
    recoveredTrailingLine
  };
}

async function loadNdjsonRecords(filePath, options = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseNdjsonLines(raw, options).records;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function appendNdjsonRecordsAtomic(filePath, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }
  const existing = await loadNdjsonRecords(filePath);
  const merged = [...existing, ...records];
  const lines = merged.map((entry) => JSON.stringify(canonicalize(entry))).join("\n");
  const body = lines.length > 0 ? `${lines}\n` : "";
  await writeAtomic(filePath, body);
}

async function ensureNdjsonIntegrity(filePath, options = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseNdjsonLines(raw, { allowRecoverTrailingLine: true });
    if (!parsed.recoveredTrailingLine) {
      return { repaired: false };
    }

    const repairedBody = parsed.records.map((entry) => JSON.stringify(canonicalize(entry))).join("\n");
    const payload = repairedBody.length > 0 ? `${repairedBody}\n` : "";
    await writeAtomic(filePath, payload, { nowMs: options.nowMs });
    if (options.logger && typeof options.logger.warn === "function") {
      options.logger.warn({
        event: "api_governance_ndjson_repaired",
        reason: "truncated_trailing_record_removed"
      });
    }
    return { repaired: true };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { repaired: false };
    }
    throw error;
  }
}

function maxSequence(records) {
  let max = 0;
  for (const item of records) {
    const value = Number(item && item.sequence);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return max;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function createApiGovernance(options = {}) {
  const statePath = path.resolve(options.statePath || DEFAULT_STATE_PATH);
  const researchPath = path.resolve(options.researchNdjsonPath || DEFAULT_RESEARCH_NDJSON_PATH);
  const timeProvider =
    options.timeProvider &&
    typeof options.timeProvider === "object" &&
    typeof options.timeProvider.nowMs === "function" &&
    typeof options.timeProvider.nowIso === "function"
      ? options.timeProvider
      : { nowMs: runtimeNowMs, nowIso: runtimeNowIso };
  const limits = {
    perMcpRequestsPerMinute: parsePositiveInt(options.perMcpRequestsPerMinute, DEFAULT_LIMITS.perMcpRequestsPerMinute),
    globalRequestsPerMinute: parsePositiveInt(options.globalRequestsPerMinute, DEFAULT_LIMITS.globalRequestsPerMinute),
    dailyTokenBudget: parsePositiveInt(options.dailyTokenBudget, DEFAULT_LIMITS.dailyTokenBudget),
    dailyRequestLimit: parsePositiveInt(options.dailyRequestLimit, DEFAULT_LIMITS.dailyRequestLimit),
    mutationPublishesPerHour: parsePositiveInt(options.mutationPublishesPerHour, DEFAULT_LIMITS.mutationPublishesPerHour),
    mutationPublishesPerDay: parsePositiveInt(options.mutationPublishesPerDay, DEFAULT_LIMITS.mutationPublishesPerDay),
    mutationWriteTokensPerDay: parsePositiveInt(options.mutationWriteTokensPerDay, DEFAULT_LIMITS.mutationWriteTokensPerDay),
    mutationControlTogglesPerMinute: parsePositiveInt(options.mutationControlTogglesPerMinute, DEFAULT_LIMITS.mutationControlTogglesPerMinute),
    mutationAttemptIdTtlMs: parsePositiveInt(options.mutationAttemptIdTtlMs, DEFAULT_LIMITS.mutationAttemptIdTtlMs)
  };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {} };
  const circuitBreaker = createCircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    successThreshold: 1,
    timeout: parsePositiveInt(options.circuitTimeoutMs, 60000)
  });
  const runTransaction = createStateTransactionWrapper();

  let manualCircuitReason = "";
  let ndjsonIntegrityCheckPromise = null;

  function nowMs() {
    return Number(timeProvider.nowMs());
  }

  function nowIso() {
    return String(timeProvider.nowIso());
  }

  async function ensureNdjsonIntegrityOnce() {
    if (!ndjsonIntegrityCheckPromise) {
      ndjsonIntegrityCheckPromise = ensureNdjsonIntegrity(researchPath, {
        logger,
        nowMs
      }).catch((error) => {
        ndjsonIntegrityCheckPromise = null;
        throw error;
      });
    }
    return ndjsonIntegrityCheckPromise;
  }

  async function loadState() {
    await ensureNdjsonIntegrityOnce();

    const raw = await readJsonOrDefault(statePath, buildDefaultV4State());
    const state = normalizeRuntimeState(raw);

    // Sequence reconciliation is source-of-truth by append-only NDJSON.
    const records = await loadNdjsonRecords(researchPath);
    const observedMax = maxSequence(records);
    if (observedMax < Number(state.researchIngestion.lastCommittedSequence || 0)) {
      const error = new Error("State lastCommittedSequence is ahead of persisted NDJSON records");
      error.code = "API_GOVERNANCE_SEQUENCE_STATE_AHEAD";
      error.details = {
        lastCommittedSequence: Number(state.researchIngestion.lastCommittedSequence || 0),
        observedMax
      };
      throw error;
    }
    if (observedMax >= state.researchIngestion.nextSequence) {
      state.researchIngestion.nextSequence = observedMax + 1;
      state.researchIngestion.lastCommittedSequence = observedMax;
    }

    return state;
  }

  async function persistState(state) {
    await writeAtomic(statePath, canonicalStringify(state), { nowMs });
  }

  function recordViolation(state, code, correlationId) {
    state.apiGovernance.violations.count = parsePositiveInt(state.apiGovernance.violations.count, 0) + 1;
    state.apiGovernance.violations.lastViolationAt = nowIso();
    state.apiGovernance.violations.lastViolationCode = code;
    circuitBreaker.recordFailure("api-governance");
    logger.warn({
      correlationId,
      event: "api_governance_violation",
      code
    });
  }

  function assertLimit(state, condition, code, message, correlationId) {
    if (condition) {
      return;
    }
    recordViolation(state, code, correlationId);
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function applyUsageCounters(state, input) {
    const correlationId = typeof input.correlationId === "string" ? input.correlationId : "";
    const mcp = normalizeSlug(input.mcp);
    const tokens = parsePositiveInt(input.tokens, 0);
    if (!mcp) {
      const error = new Error("mcp is required");
      error.code = "API_GOVERNANCE_MCP_REQUIRED";
      throw error;
    }
    if (tokens < 0) {
      const error = new Error("tokens must be >= 0");
      error.code = "API_GOVERNANCE_INVALID_TOKENS";
      throw error;
    }

    if (manualCircuitReason) {
      const error = new Error("API governance circuit is manually tripped");
      error.code = "API_GOVERNANCE_CIRCUIT_OPEN";
      error.details = { reason: manualCircuitReason };
      throw error;
    }

    const gate = circuitBreaker.checkBeforeRequest("api-governance");
    if (!gate.allowed) {
      const error = new Error("API governance circuit breaker is open");
      error.code = "API_GOVERNANCE_CIRCUIT_OPEN";
      throw error;
    }

    const currentMs = nowMs();
    const currentDay = dayKeyFromMsUtc(currentMs);
    const currentMinute = minuteEpochFromMsUtc(currentMs);

    if (state.apiGovernance.dayKey !== currentDay) {
      state.apiGovernance.dayKey = currentDay;
      state.apiGovernance.global.requestsToday = 0;
      state.apiGovernance.global.tokensToday = 0;
      state.apiGovernance.perMcpDaily = {};
    }

    if (Number(state.apiGovernance.window.minuteEpoch) !== currentMinute) {
      state.apiGovernance.window.minuteEpoch = currentMinute;
      state.apiGovernance.window.globalRequests = 0;
      state.apiGovernance.window.perMcpRequests = {};
    }

    const perMcpMinuteCount = parsePositiveInt(state.apiGovernance.window.perMcpRequests[mcp], 0);
    const globalMinuteCount = parsePositiveInt(state.apiGovernance.window.globalRequests, 0);
    const currentRequestsToday = parsePositiveInt(state.apiGovernance.global.requestsToday, 0);
    const currentTokensToday = parsePositiveInt(state.apiGovernance.global.tokensToday, 0);

    assertLimit(
      state,
      perMcpMinuteCount + 1 <= limits.perMcpRequestsPerMinute,
      "API_GOVERNANCE_MCP_RPM_EXCEEDED",
      `Per-MCP RPM exceeded for ${mcp}`,
      correlationId
    );
    assertLimit(
      state,
      globalMinuteCount + 1 <= limits.globalRequestsPerMinute,
      "API_GOVERNANCE_GLOBAL_RPM_EXCEEDED",
      "Global RPM exceeded",
      correlationId
    );
    assertLimit(
      state,
      currentRequestsToday + 1 <= limits.dailyRequestLimit,
      "API_GOVERNANCE_DAILY_REQUESTS_EXCEEDED",
      "Daily request limit exceeded",
      correlationId
    );
    assertLimit(
      state,
      currentTokensToday + tokens <= limits.dailyTokenBudget,
      "API_GOVERNANCE_DAILY_TOKENS_EXCEEDED",
      "Daily token budget exceeded",
      correlationId
    );

    state.apiGovernance.window.perMcpRequests[mcp] = perMcpMinuteCount + 1;
    state.apiGovernance.window.globalRequests = globalMinuteCount + 1;
    state.apiGovernance.global.requestsToday = currentRequestsToday + 1;
    state.apiGovernance.global.tokensToday = currentTokensToday + tokens;

    const perMcpDaily = isPlainObject(state.apiGovernance.perMcpDaily[mcp]) ? state.apiGovernance.perMcpDaily[mcp] : { requests: 0, tokens: 0 };
    perMcpDaily.requests = parsePositiveInt(perMcpDaily.requests, 0) + 1;
    perMcpDaily.tokens = parsePositiveInt(perMcpDaily.tokens, 0) + tokens;
    state.apiGovernance.perMcpDaily[mcp] = perMcpDaily;

    circuitBreaker.recordSuccess("api-governance");
    return { mcp, tokens };
  }

  function pruneMutationAttemptAccounting(state, currentMs) {
    const accounted = state.apiGovernance.mutation.accountedAttemptIds;
    const ttlMs = limits.mutationAttemptIdTtlMs;
    for (const key of Object.keys(accounted)) {
      const value = Number(accounted[key]);
      if (!Number.isFinite(value) || value + ttlMs < currentMs) {
        delete accounted[key];
      }
    }
  }

  function applyMutationAccounting(state, input = {}) {
    const attemptId = typeof input.attemptId === "string" ? input.attemptId.trim() : "";
    if (!attemptId) {
      const error = new Error("mutation attemptId is required");
      error.code = "API_GOVERNANCE_MUTATION_ATTEMPT_REQUIRED";
      throw error;
    }
    const accounted = state.apiGovernance.mutation.accountedAttemptIds;
    const currentMs = nowMs();
    pruneMutationAttemptAccounting(state, currentMs);
    if (Object.prototype.hasOwnProperty.call(accounted, attemptId)) {
      return { counted: false };
    }

    const kind = typeof input.kind === "string" ? input.kind : "publish";
    const tokens = Math.max(0, parsePositiveInt(input.tokens, 0));
    const currentHour = Math.floor(currentMs / 3600000);
    const currentMinute = minuteEpochFromMsUtc(currentMs);
    const currentDay = dayKeyFromMsUtc(currentMs);

    if (kind === "publish") {
      if (Number(state.apiGovernance.mutation.hourWindow.hourEpoch) !== currentHour) {
        state.apiGovernance.mutation.hourWindow.hourEpoch = currentHour;
        state.apiGovernance.mutation.hourWindow.publishes = 0;
      }
      if (String(state.apiGovernance.mutation.dayWindow.dayKey) !== currentDay) {
        state.apiGovernance.mutation.dayWindow.dayKey = currentDay;
        state.apiGovernance.mutation.dayWindow.publishes = 0;
        state.apiGovernance.mutation.dayWindow.writeTokens = 0;
      }

      const nextHourlyPublishes = parsePositiveInt(state.apiGovernance.mutation.hourWindow.publishes, 0) + 1;
      const nextDailyPublishes = parsePositiveInt(state.apiGovernance.mutation.dayWindow.publishes, 0) + 1;
      const nextDailyWriteTokens = parsePositiveInt(state.apiGovernance.mutation.dayWindow.writeTokens, 0) + tokens;

      assertLimit(
        state,
        nextHourlyPublishes <= limits.mutationPublishesPerHour,
        "API_GOVERNANCE_MUTATION_HOURLY_PUBLISHES_EXCEEDED",
        "Mutation publishes/hour exceeded",
        input.correlationId
      );
      assertLimit(
        state,
        nextDailyPublishes <= limits.mutationPublishesPerDay,
        "API_GOVERNANCE_MUTATION_DAILY_PUBLISHES_EXCEEDED",
        "Mutation publishes/day exceeded",
        input.correlationId
      );
      assertLimit(
        state,
        nextDailyWriteTokens <= limits.mutationWriteTokensPerDay,
        "API_GOVERNANCE_MUTATION_DAILY_WRITE_TOKENS_EXCEEDED",
        "Mutation write tokens/day exceeded",
        input.correlationId
      );

      state.apiGovernance.mutation.hourWindow.publishes = nextHourlyPublishes;
      state.apiGovernance.mutation.dayWindow.publishes = nextDailyPublishes;
      state.apiGovernance.mutation.dayWindow.writeTokens = nextDailyWriteTokens;
    } else if (kind === "control_toggle") {
      if (Number(state.apiGovernance.mutation.controlWindow.minuteEpoch) !== currentMinute) {
        state.apiGovernance.mutation.controlWindow.minuteEpoch = currentMinute;
        state.apiGovernance.mutation.controlWindow.toggles = 0;
      }
      const nextToggles = parsePositiveInt(state.apiGovernance.mutation.controlWindow.toggles, 0) + 1;
      assertLimit(
        state,
        nextToggles <= limits.mutationControlTogglesPerMinute,
        "API_GOVERNANCE_MUTATION_CONTROL_TOGGLES_EXCEEDED",
        "Mutation control toggles/minute exceeded",
        input.correlationId
      );
      state.apiGovernance.mutation.controlWindow.toggles = nextToggles;
    }

    accounted[attemptId] = currentMs;
    return { counted: true };
  }

  async function withGovernanceTransaction(handler, metadata = {}) {
    return runTransaction(async () => {
      const state = await loadState();
      const pendingRecords = [];
      let highestAllocatedSequence = Number(state.researchIngestion.lastCommittedSequence || 0);

      const tx = {
        state,
        allocateSequence() {
          const next = parsePositiveInt(state.researchIngestion.nextSequence, 1);
          state.researchIngestion.nextSequence = next + 1;
          highestAllocatedSequence = Math.max(highestAllocatedSequence, next);
          return next;
        },
        appendResearchRecord(record) {
          if (!isPlainObject(record)) {
            const error = new Error("record must be an object");
            error.code = "API_GOVERNANCE_RECORD_REQUIRED";
            throw error;
          }
          pendingRecords.push(canonicalize(record));
        },
        applyUsage(input) {
          return applyUsageCounters(state, input);
        },
        applyMutationAccounting(input) {
          return applyMutationAccounting(state, input);
        }
      };

      const result = await handler(tx);

      if (pendingRecords.length > 0) {
        await appendNdjsonRecordsAtomic(researchPath, pendingRecords);
        state.researchIngestion.lastCommittedSequence = highestAllocatedSequence;
      }

      state.lastDeterministicReplayAt = nowIso();
      await persistState(state);

      logger.info({
        correlationId: typeof metadata.correlationId === "string" ? metadata.correlationId : "",
        event: "api_governance_transaction_committed",
        records: pendingRecords.length
      });

      return result;
    });
  }

  async function checkAndRecord(input = {}) {
    return withGovernanceTransaction(async (tx) => {
      const applied = tx.applyUsage(input);
      return {
        ok: true,
        mcp: applied.mcp,
        tokens: applied.tokens
      };
    }, { correlationId: input.correlationId });
  }

  async function snapshot() {
    const state = await loadState();
    const daily = {
      dayKey: state.apiGovernance.dayKey,
      global: state.apiGovernance.global,
      perMcpDaily: state.apiGovernance.perMcpDaily,
      violations: state.apiGovernance.violations,
      mutation: state.apiGovernance.mutation
    };
    return canonicalize(daily);
  }

  async function readState() {
    const state = await loadState();
    return canonicalize(state);
  }

  async function writeDailySummary(outPath) {
    const target = path.resolve(outPath || path.join(process.cwd(), "audit", "evidence", "phase4", "daily-usage-summary.json"));
    const data = await snapshot();
    const payload = {
      generatedAt: nowIso(),
      digest: sha256(JSON.stringify(data)),
      data
    };
    await writeAtomic(target, canonicalStringify(payload));
    return { ok: true, path: target };
  }

  function tripCircuit(reason) {
    manualCircuitReason = typeof reason === "string" && reason.trim() ? reason.trim() : "manual_trip";
    circuitBreaker.recordFailure("api-governance");
    return {
      ok: true,
      code: "API_GOVERNANCE_CIRCUIT_TRIPPED",
      reason: manualCircuitReason
    };
  }

  async function loadResearchRecords() {
    await ensureNdjsonIntegrityOnce();
    const records = await loadNdjsonRecords(researchPath);
    return records
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  }

  return Object.freeze({
    limits,
    statePath,
    researchPath,
    checkAndRecord,
    withGovernanceTransaction,
    tripCircuit,
    snapshot,
    readState,
    writeDailySummary,
    loadResearchRecords
  });
}

module.exports = {
  DEFAULT_LIMITS,
  createApiGovernance
};
