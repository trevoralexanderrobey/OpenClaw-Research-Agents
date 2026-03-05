"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const tls = require("node:tls");

const {
  validateEgressPolicy,
  preparePinnedEgressTarget,
  assertOutboundMethodAllowed,
  logOutboundAttempt
} = require("../openclaw-bridge/execution/egress-policy.js");
const { getLegacyAccessBridge } = require("../workflows/access-control/legacy-access-bridge.js");
const { createApiGovernance } = require("./api-governance.js");
const { createOperatorAuthorization } = require("./operator-authorization.js");

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

const MUTATION_CONSTANTS = Object.freeze({
  MAX_BODY_BYTES: 65536,
  MAX_HTML_CHARS: 50000,
  MAX_EXTERNAL_LINKS: 20,
  MAX_EMBEDDED_IMAGES: 10,
  MAX_RETRY_ATTEMPTS: 3,
  UNCERTAIN_MAX_AGE_HOURS: 24,
  TOGGLE_COOLDOWN_MS: 60_000
});

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Mutation control error"));
  error.code = String(code || "MUTATION_CONTROL_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function extractExternalLinks(html) {
  const source = String(html || "");
  const matches = source.match(/https?:\/\/[^\s"'<>)]+/gi);
  return Array.isArray(matches) ? matches : [];
}

function extractEmbeddedImages(html) {
  const source = String(html || "");
  const matches = source.match(/<img\b[^>]*>/gi);
  return Array.isArray(matches) ? matches : [];
}

async function readNdjson(filePath) {
  try {
    const body = await fs.readFile(filePath, "utf8");
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw makeError("MUTATION_LOG_PARSE_FAILED", `Invalid mutation log record at line ${index + 1}`);
      }
    });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeNdjsonAtomic(filePath, records) {
  const targetPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const body = records.map((entry) => JSON.stringify(canonicalize(entry))).join("\n");
  const payload = body.length > 0 ? `${body}\n` : "";
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const tmpHandle = await fs.open(tmpPath, "w", 0o600);
  await tmpHandle.writeFile(payload, "utf8");
  await tmpHandle.sync();
  await tmpHandle.close();
  await fs.rename(tmpPath, targetPath);
}

function buildEntryHashSeed(entry) {
  const input = {
    attemptedAt: normalizeString(entry.attemptedAt),
    code: normalizeString(entry.code),
    correlationId: normalizeString(entry.correlationId),
    domain: normalizeString(entry.domain),
    latencyMs: Number(entry.latencyMs || 0),
    method: normalizeString(entry.method).toUpperCase(),
    mutationSequence: Number(entry.mutationSequence || 0),
    payloadHash: normalizeString(entry.payloadHash),
    provider: normalizeString(entry.provider),
    status: normalizeString(entry.status)
  };
  return canonicalStringify(input);
}

function appendHashedMutationLogRecord(prevChainHash, entry) {
  const prev = /^[a-f0-9]{64}$/.test(String(prevChainHash || "")) ? prevChainHash : ZERO_HASH;
  const entryHash = sha256(buildEntryHashSeed(entry));
  const chainHash = sha256(`${prev}|${entryHash}`);
  return canonicalize({
    ...entry,
    prevChainHash: prev,
    entryHash,
    chainHash
  });
}

function verifyMutationLogChain(entries, expectedTipHash) {
  let prev = ZERO_HASH;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isPlainObject(entry)) {
      throw makeError("MUTATION_LOG_CHAIN_INVALID", `Mutation log entry ${i + 1} is not an object`);
    }
    if (entry.prevChainHash !== prev) {
      throw makeError("MUTATION_LOG_CHAIN_INVALID", `Mutation log prevChainHash mismatch at entry ${i + 1}`);
    }
    const expectedEntryHash = sha256(buildEntryHashSeed(entry));
    if (entry.entryHash !== expectedEntryHash) {
      throw makeError("MUTATION_LOG_CHAIN_INVALID", `Mutation log entryHash mismatch at entry ${i + 1}`);
    }
    const expectedChainHash = sha256(`${entry.prevChainHash}|${entry.entryHash}`);
    if (entry.chainHash !== expectedChainHash) {
      throw makeError("MUTATION_LOG_CHAIN_INVALID", `Mutation log chainHash mismatch at entry ${i + 1}`);
    }
    prev = entry.chainHash;
  }
  const expectedTip = /^[a-f0-9]{64}$/.test(String(expectedTipHash || "")) ? expectedTipHash : ZERO_HASH;
  if (prev !== expectedTip) {
    throw makeError("MUTATION_LOG_CHAIN_INVALID", "Mutation log tip hash mismatch", {
      expectedTip,
      actualTip: prev
    });
  }
  return true;
}

function estimateWriteTokens(bodyCanonical) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(bodyCanonical || ""), "utf8") / 4));
}

function ensurePayloadGuardrails(payload = {}) {
  const bodyCanonical = canonicalStringify(payload);
  const bodyBytes = Buffer.byteLength(bodyCanonical, "utf8");
  if (bodyBytes > MUTATION_CONSTANTS.MAX_BODY_BYTES) {
    throw makeError("MUTATION_PAYLOAD_TOO_LARGE", `Mutation body exceeds ${MUTATION_CONSTANTS.MAX_BODY_BYTES} bytes`);
  }

  const html = normalizeString(payload.html || payload.content || payload.body || "");
  if (html.length > MUTATION_CONSTANTS.MAX_HTML_CHARS) {
    throw makeError("MUTATION_HTML_TOO_LARGE", `Mutation HTML exceeds ${MUTATION_CONSTANTS.MAX_HTML_CHARS} chars`);
  }

  const links = extractExternalLinks(html);
  if (links.length > MUTATION_CONSTANTS.MAX_EXTERNAL_LINKS) {
    throw makeError("MUTATION_EXTERNAL_LINKS_EXCEEDED", `Mutation payload has too many external links (${links.length})`);
  }

  const images = extractEmbeddedImages(html);
  if (images.length > MUTATION_CONSTANTS.MAX_EMBEDDED_IMAGES) {
    throw makeError("MUTATION_EMBEDDED_IMAGES_EXCEEDED", `Mutation payload has too many embedded images (${images.length})`);
  }

  return {
    bodyCanonical,
    bodyBytes,
    writeTokens: estimateWriteTokens(bodyCanonical)
  };
}

function providerToToolSlug(provider) {
  const normalized = normalizeString(provider).toLowerCase();
  if (normalized === "newsletter") {
    return "newsletter-publisher-mcp";
  }
  if (normalized === "notion") {
    return "notion-sync-mcp";
  }
  throw makeError("MUTATION_PROVIDER_UNSUPPORTED", `Unsupported mutation provider '${provider}'`);
}

function providerToScope(provider, action) {
  const normalized = normalizeString(provider).toLowerCase();
  return `mutation.${normalized}.${action}`;
}

function assertLegacyScopedAccess(input = {}) {
  if (!normalizeString(input.approvalToken)) {
    return;
  }
  const bridge = getLegacyAccessBridge();
  const evaluation = bridge.evaluateLegacyAccess({
    approvalToken: input.approvalToken,
    scope: input.scope,
    role: normalizeString(input.role),
    action: "legacy.execute",
    resource: normalizeString(input.resource) || normalizeString(input.scope),
    caller: normalizeString(input.caller),
    correlationId: normalizeString(input.correlationId)
  });
  if (!evaluation.allowed) {
    throw makeError("MUTATION_ACCESS_DENIED", "Phase 13 boundary denied legacy mutation access", {
      reason: evaluation.reason,
      scope: normalizeString(input.scope)
    });
  }
}

function createMutationControl(options = {}) {
  const apiGovernance = options.apiGovernance || createApiGovernance({ logger: options.logger });
  const operatorAuthorization = options.operatorAuthorization || createOperatorAuthorization({ logger: options.logger });
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const egressPolicies = options.egressPolicies;
  const resolver = options.resolver;
  const timeProvider = options.timeProvider && typeof options.timeProvider === "object"
    ? options.timeProvider
    : {
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString()
      };
  const mutationLogPath = path.resolve(options.mutationLogPath || path.join(process.cwd(), "workspace", "memory", "mutation-attempts.ndjson"));
  const executeOutboundRequest = typeof options.executeOutboundRequest === "function" ? options.executeOutboundRequest : null;

  let chainVerified = false;

  function nowMs() {
    return Number(timeProvider.nowMs());
  }

  function nowIso() {
    return String(timeProvider.nowIso());
  }

  async function ensureLogIntegrity() {
    if (chainVerified) {
      return;
    }
    const state = await apiGovernance.readState();
    const expectedTipHash = state && state.outboundMutation ? state.outboundMutation.mutationLogTipHash : ZERO_HASH;
    const entries = await readNdjson(mutationLogPath);
    verifyMutationLogChain(entries, expectedTipHash);
    chainVerified = true;
  }

  async function appendAuditLog(entryInput, correlationId) {
    await ensureLogIntegrity();
    await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      const prevHash = normalizeString(state.outboundMutation.mutationLogTipHash) || ZERO_HASH;
      const entry = appendHashedMutationLogRecord(prevHash, {
        attemptedAt: nowIso(),
        correlationId: normalizeString(correlationId),
        ...entryInput
      });
      const existing = await readNdjson(mutationLogPath);
      const next = [...existing, entry];
      await writeNdjsonAtomic(mutationLogPath, next);
      state.outboundMutation.mutationLogTipHash = entry.chainHash;
    }, { correlationId: normalizeString(correlationId) });
  }

  function requireMutationEnabled(state, phase) {
    if (!state.outboundMutation.enabled) {
      throw makeError("MUTATION_DISABLED", `Mutation is disabled during ${phase}`);
    }
  }

  function requireKillSwitchOpen(state) {
    if (state.outboundMutation.killSwitch) {
      throw makeError("MUTATION_KILL_SWITCH_ACTIVE", "Mutation kill-switch is active");
    }
  }

  function findPendingBySequence(state, sequence) {
    const seq = Number(sequence);
    return state.outboundMutation.pendingPublications.find((item) => Number(item.sequence) === seq) || null;
  }

  async function setMutationEnabled(input = {}, context = {}) {
    const correlationId = normalizeString(context.correlationId);
    assertLegacyScopedAccess({
      approvalToken: input.approvalToken,
      scope: "mutation.control.toggle",
      role: context.role,
      resource: "mutation.control",
      caller: "legacy.mutation.control.toggle",
      correlationId
    });
    operatorAuthorization.consumeApprovalToken(input.approvalToken, "mutation.control.toggle", { correlationId });

    const result = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      requireKillSwitchOpen(state);

      const currentMs = nowMs();
      const lastToggleMs = Number.parseInt(String(Date.parse(state.outboundMutation.lastControlToggleAt || "")), 10);
      if (Number.isFinite(lastToggleMs) && (currentMs - lastToggleMs) < MUTATION_CONSTANTS.TOGGLE_COOLDOWN_MS) {
        throw makeError("MUTATION_CONTROL_TOGGLE_COOLDOWN", "Mutation control toggle cooldown is active");
      }

      state.outboundMutation.lastControlSequence = Number(state.outboundMutation.lastControlSequence || 0) + 1;
      const attemptId = `toggle:${state.outboundMutation.lastControlSequence}`;
      tx.applyMutationAccounting({
        kind: "control_toggle",
        attemptId,
        correlationId
      });

      state.outboundMutation.enabled = Boolean(input.enabled);
      state.outboundMutation.lastControlToggleAt = nowIso();

      return {
        ok: true,
        enabled: state.outboundMutation.enabled,
        controlSequence: state.outboundMutation.lastControlSequence
      };
    }, { correlationId });
    await appendAuditLog({
      provider: "control",
      mutationSequence: Number(result.controlSequence || 0),
      payloadHash: "",
      domain: "",
      method: "TOGGLE_ENABLED",
      status: result.enabled ? "enabled" : "disabled",
      latencyMs: 0,
      code: "MUTATION_ENABLED_TOGGLED"
    }, correlationId);
    return result;
  }

  async function setKillSwitch(input = {}, context = {}) {
    const correlationId = normalizeString(context.correlationId);
    assertLegacyScopedAccess({
      approvalToken: input.approvalToken,
      scope: "mutation.control.killSwitch",
      role: context.role,
      resource: "mutation.control",
      caller: "legacy.mutation.control.kill_switch",
      correlationId
    });
    operatorAuthorization.consumeApprovalToken(input.approvalToken, "mutation.control.killSwitch", { correlationId });

    const result = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      state.outboundMutation.lastControlSequence = Number(state.outboundMutation.lastControlSequence || 0) + 1;
      const attemptId = `toggle:${state.outboundMutation.lastControlSequence}`;
      tx.applyMutationAccounting({
        kind: "control_toggle",
        attemptId,
        correlationId
      });

      state.outboundMutation.killSwitch = Boolean(input.killSwitch);
      state.outboundMutation.lastControlToggleAt = nowIso();

      return {
        ok: true,
        killSwitch: state.outboundMutation.killSwitch,
        controlSequence: state.outboundMutation.lastControlSequence
      };
    }, { correlationId });
    await appendAuditLog({
      provider: "control",
      mutationSequence: Number(result.controlSequence || 0),
      payloadHash: "",
      domain: "",
      method: "TOGGLE_KILL_SWITCH",
      status: result.killSwitch ? "kill_switch_on" : "kill_switch_off",
      latencyMs: 0,
      code: "MUTATION_KILL_SWITCH_TOGGLED"
    }, correlationId);
    return result;
  }

  async function preparePublication(input = {}, context = {}) {
    const correlationId = normalizeString(context.correlationId);
    const provider = normalizeString(input.provider).toLowerCase();
    const method = normalizeString(input.method || "POST").toUpperCase();
    const url = normalizeString(input.url);
    const prepareScope = providerToScope(provider, "prepare");
    assertLegacyScopedAccess({
      approvalToken: input.approvalToken,
      scope: prepareScope,
      role: context.role,
      resource: `mutation.${provider}`,
      caller: "legacy.mutation.prepare",
      correlationId
    });
    operatorAuthorization.consumeApprovalToken(input.approvalToken, prepareScope, { correlationId });

    const guardrails = ensurePayloadGuardrails(input.payload);
    const payloadHash = sha256(`payload-v1|${provider}|${guardrails.bodyCanonical}`);
    const idempotencyKey = sha256(`mutation-v1|${provider}|${guardrails.bodyCanonical}`);

    const prepared = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      requireKillSwitchOpen(state);
      requireMutationEnabled(state, "prepare");

      if (state.outboundMutation.committedPublications.some((entry) => normalizeString(entry.idempotencyKey) === idempotencyKey)) {
        throw makeError("MUTATION_ALREADY_COMMITTED", "Mutation payload already committed", { idempotencyKey });
      }
      if (state.outboundMutation.pendingPublications.some((entry) => normalizeString(entry.idempotencyKey) === idempotencyKey)) {
        throw makeError("MUTATION_ALREADY_PENDING", "Mutation payload already prepared", { idempotencyKey });
      }

      const nextSequence = Number(state.outboundMutation.lastMutationSequence || 0) + 1;
      state.outboundMutation.lastMutationSequence = nextSequence;

      const pending = canonicalize({
        sequence: nextSequence,
        provider,
        payloadHash,
        idempotencyKey,
        dispatchState: "prepared",
        preparedWhenEnabled: true,
        allowRetry: true,
        retryCount: 0,
        maxRetryAttempts: MUTATION_CONSTANTS.MAX_RETRY_ATTEMPTS,
        firstUncertainAt: null,
        uncertainDeadlineAt: null,
        lastAttemptAt: null,
        preparedAt: nowIso(),
        request: {
          method,
          url,
          bodyCanonical: guardrails.bodyCanonical,
          bodyBytes: guardrails.bodyBytes
        }
      });

      state.outboundMutation.pendingPublications.push(pending);

      return pending;
    }, { correlationId });

    await appendAuditLog({
      provider,
      mutationSequence: prepared.sequence,
      payloadHash,
      domain: (() => {
        try { return new URL(url).hostname; } catch { return ""; }
      })(),
      method,
      status: "prepared",
      latencyMs: 0,
      code: "PREPARED"
    }, correlationId);

    return {
      ok: true,
      sequence: prepared.sequence,
      idempotencyKey,
      payloadHash
    };
  }

  async function executePinnedRequest(provider, request, correlationId, idempotencyKey) {
    if (String(process.env.NODE_TLS_REJECT_UNAUTHORIZED || "") === "0") {
      throw makeError("MUTATION_TLS_ENV_OVERRIDE_FORBIDDEN", "NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden for mutations");
    }

    const toolSlug = providerToToolSlug(provider);
    const policyCheck = validateEgressPolicy(toolSlug, egressPolicies, { allowDefault: false });
    if (!policyCheck.valid) {
      throw makeError("MUTATION_EGRESS_POLICY_MISSING", policyCheck.errors.join("; "));
    }

    const startMs = nowMs();
    const pinned = await preparePinnedEgressTarget(request.url, policyCheck.policy, { resolver });
    assertOutboundMethodAllowed(pinned.hostname, request.method, policyCheck.policy);

    const payload = Buffer.from(String(request.bodyCanonical || ""), "utf8");

    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: "https:",
          hostname: pinned.hostname,
          port: pinned.url.port ? Number(pinned.url.port) : 443,
          method: String(request.method || "POST").toUpperCase(),
          path: `${pinned.url.pathname}${pinned.url.search}`,
          lookup: pinned.lookup,
          servername: pinned.hostname,
          rejectUnauthorized: true,
          checkServerIdentity(_hostname, cert) {
            return tls.checkServerIdentity(pinned.hostname, cert);
          },
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": payload.byteLength,
            "idempotency-key": idempotencyKey
          }
        },
        (res) => {
          const chunks = [];
          let seen = 0;
          res.on("data", (chunk) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            seen += part.length;
            if (seen > 1024 * 1024) {
              req.destroy(makeError("MUTATION_RESPONSE_TOO_LARGE", "Mutation response too large"));
              return;
            }
            chunks.push(part);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: Number(res.statusCode || 0),
              body,
              latencyMs: nowMs() - startMs,
              domain: pinned.hostname,
              method: String(request.method || "POST").toUpperCase()
            });
          });
        }
      );

      req.setTimeout(12_000, () => {
        req.destroy(makeError("MUTATION_OUTBOUND_TIMEOUT", "Mutation outbound timeout"));
      });
      req.on("error", (error) => reject(error));
      req.write(payload);
      req.end();
    });

    logOutboundAttempt(logger, {
      domain: response.domain,
      status: response.statusCode >= 200 && response.statusCode < 300 ? "success" : "blocked",
      latencyMs: response.latencyMs,
      correlationId,
      code: response.statusCode >= 200 && response.statusCode < 300 ? "OK" : "MUTATION_RESPONSE_STATUS"
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw makeError("MUTATION_OUTBOUND_FAILED", `Mutation outbound failed with status ${response.statusCode}`, {
        statusCode: response.statusCode,
        responseBodyPreview: response.body.slice(0, 300)
      });
    }

    let parsed = {};
    try {
      parsed = response.body ? JSON.parse(response.body) : {};
    } catch {
      parsed = {};
    }

    return {
      externalId: normalizeString(parsed.id || parsed.page_id || parsed.post_id) || `${provider}-${sha256(response.body).slice(0, 16)}`,
      latencyMs: response.latencyMs,
      domain: response.domain,
      method: response.method
    };
  }

  async function commitPublication(input = {}, context = {}) {
    const correlationId = normalizeString(context.correlationId);
    const sequence = Number(input.sequence);

    if (!Number.isFinite(sequence) || sequence <= 0) {
      throw makeError("MUTATION_SEQUENCE_REQUIRED", "Valid mutation sequence is required");
    }

    await ensureLogIntegrity();

    assertLegacyScopedAccess({
      approvalToken: input.approvalToken,
      scope: "mutation.commit",
      role: context.role,
      resource: "mutation.publish",
      caller: "legacy.mutation.commit",
      correlationId
    });
    operatorAuthorization.consumeApprovalToken(input.approvalToken, "mutation.commit", { correlationId });

    const attempt = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      requireKillSwitchOpen(state);
      requireMutationEnabled(state, "commit");

      const pending = findPendingBySequence(state, sequence);
      if (!pending) {
        throw makeError("MUTATION_PENDING_NOT_FOUND", `Pending mutation sequence '${sequence}' not found`);
      }
      if (!pending.preparedWhenEnabled) {
        pending.dispatchState = "abandoned";
        pending.allowRetry = false;
        throw makeError("MUTATION_PENDING_INVALID_PREPARE_STATE", "Pending mutation was not prepared while enabled");
      }
      if (!pending.allowRetry && pending.dispatchState === "uncertain") {
        throw makeError("MUTATION_RETRY_DISALLOWED", "Pending mutation retry is disallowed");
      }

      if (state.outboundMutation.committedPublications.some((entry) => Number(entry.sequence) === sequence)) {
        throw makeError("MUTATION_ALREADY_COMMITTED", "Mutation sequence already committed");
      }
      if (state.outboundMutation.committedPublications.some((entry) => normalizeString(entry.idempotencyKey) === normalizeString(pending.idempotencyKey))) {
        throw makeError("MUTATION_ALREADY_COMMITTED", "Mutation idempotency key already committed");
      }

      const currentRetryCount = Number(pending.retryCount || 0);
      const attemptNo = currentRetryCount + 1;
      if (attemptNo > Number(pending.maxRetryAttempts || MUTATION_CONSTANTS.MAX_RETRY_ATTEMPTS)) {
        pending.allowRetry = false;
        throw makeError("MUTATION_RETRY_LIMIT_REACHED", "Mutation retry limit reached");
      }

      if (pending.dispatchState === "uncertain" && normalizeString(pending.uncertainDeadlineAt)) {
        const deadlineMs = Date.parse(pending.uncertainDeadlineAt);
        if (Number.isFinite(deadlineMs) && nowMs() > deadlineMs) {
          pending.allowRetry = false;
          throw makeError("MUTATION_UNCERTAIN_RECONCILE_REQUIRED", "Uncertain mutation exceeded max age and requires reconciliation");
        }
      }

      const attemptId = `commit:${sequence}:${attemptNo}`;
      tx.applyMutationAccounting({
        kind: "publish",
        attemptId,
        tokens: estimateWriteTokens(pending.request.bodyCanonical),
        correlationId
      });

      pending.dispatchState = "in_flight";
      pending.lastAttemptAt = nowIso();
      pending.retryCount = attemptNo;

      return {
        sequence,
        provider: pending.provider,
        payloadHash: pending.payloadHash,
        idempotencyKey: pending.idempotencyKey,
        request: pending.request,
        attemptNo
      };
    }, { correlationId });

    try {
      const result = executeOutboundRequest
        ? await executeOutboundRequest(attempt, { correlationId })
        : await executePinnedRequest(attempt.provider, attempt.request, correlationId, attempt.idempotencyKey);
      const committed = await apiGovernance.withGovernanceTransaction(async (tx) => {
        const state = tx.state;
        const pending = findPendingBySequence(state, sequence);
        if (!pending) {
          const existing = state.outboundMutation.committedPublications.find((entry) => Number(entry.sequence) === sequence);
          if (existing) {
            return existing;
          }
          throw makeError("MUTATION_PENDING_NOT_FOUND", "Pending mutation vanished before commit finalization");
        }

        const committedRecord = canonicalize({
          sequence,
          provider: attempt.provider,
          payloadHash: attempt.payloadHash,
          idempotencyKey: attempt.idempotencyKey,
          externalId: result.externalId,
          committedAt: nowIso(),
          latencyMs: result.latencyMs,
          status: "committed",
          irreversible: true
        });

        state.outboundMutation.pendingPublications = state.outboundMutation.pendingPublications
          .filter((entry) => Number(entry.sequence) !== sequence);
        state.outboundMutation.committedPublications.push(committedRecord);
        return committedRecord;
      }, { correlationId });

      await appendAuditLog({
        provider: attempt.provider,
        mutationSequence: sequence,
        payloadHash: attempt.payloadHash,
        domain: result.domain,
        method: result.method,
        status: "committed",
        latencyMs: result.latencyMs,
        code: "COMMITTED"
      }, correlationId);

      return {
        ok: true,
        committed
      };
    } catch (error) {
      await apiGovernance.withGovernanceTransaction(async (tx) => {
        const state = tx.state;
        const pending = findPendingBySequence(state, sequence);
        if (!pending) {
          return;
        }
        pending.dispatchState = "uncertain";
        if (!pending.firstUncertainAt) {
          pending.firstUncertainAt = nowIso();
          pending.uncertainDeadlineAt = new Date(nowMs() + (MUTATION_CONSTANTS.UNCERTAIN_MAX_AGE_HOURS * 60 * 60 * 1000)).toISOString();
        }
        if (Number(pending.retryCount || 0) >= Number(pending.maxRetryAttempts || MUTATION_CONSTANTS.MAX_RETRY_ATTEMPTS)) {
          pending.allowRetry = false;
        }
      }, { correlationId });

      await appendAuditLog({
        provider: attempt.provider,
        mutationSequence: sequence,
        payloadHash: attempt.payloadHash,
        domain: "",
        method: normalizeString(attempt.request.method).toUpperCase(),
        status: "uncertain",
        latencyMs: 0,
        code: error && error.code ? error.code : "MUTATION_COMMIT_FAILED"
      }, correlationId);

      throw error;
    }
  }

  async function retryPublication(input = {}, context = {}) {
    const sequence = Number(input.sequence);
    const correlationId = normalizeString(context.correlationId);

    await apiGovernance.withGovernanceTransaction(async (tx) => {
      const pending = findPendingBySequence(tx.state, sequence);
      if (!pending) {
        throw makeError("MUTATION_PENDING_NOT_FOUND", "Pending mutation not found for retry");
      }
      if (pending.dispatchState !== "uncertain") {
        throw makeError("MUTATION_RETRY_STATE_INVALID", "Retry requires uncertain dispatch state");
      }
      if (!pending.allowRetry) {
        throw makeError("MUTATION_RETRY_DISALLOWED", "Retry is not allowed for this pending mutation");
      }
      if (Number(pending.retryCount || 0) >= Number(pending.maxRetryAttempts || MUTATION_CONSTANTS.MAX_RETRY_ATTEMPTS)) {
        pending.allowRetry = false;
        throw makeError("MUTATION_RETRY_LIMIT_REACHED", "Retry limit reached");
      }
    }, { correlationId });

    return commitPublication(input, context);
  }

  async function reconcilePublication(input = {}, context = {}) {
    const correlationId = normalizeString(context.correlationId);
    const sequence = Number(input.sequence);
    const action = normalizeString(input.action).toLowerCase();
    assertLegacyScopedAccess({
      approvalToken: input.approvalToken,
      scope: "mutation.reconcile",
      role: context.role,
      resource: "mutation.publish",
      caller: "legacy.mutation.reconcile",
      correlationId
    });
    operatorAuthorization.consumeApprovalToken(input.approvalToken, "mutation.reconcile", { correlationId });

    if (!["confirm_committed", "confirm_not_committed", "abandon"].includes(action)) {
      throw makeError("MUTATION_RECONCILE_ACTION_INVALID", "Invalid reconcile action");
    }

    const reconciled = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      const pending = findPendingBySequence(state, sequence);
      if (!pending) {
        throw makeError("MUTATION_PENDING_NOT_FOUND", "Pending mutation not found");
      }
      if (pending.dispatchState !== "uncertain") {
        throw makeError("MUTATION_RECONCILE_STATE_INVALID", "Only uncertain mutations can be reconciled");
      }

      if (action === "confirm_committed") {
        const committedRecord = canonicalize({
          sequence,
          provider: pending.provider,
          payloadHash: pending.payloadHash,
          idempotencyKey: pending.idempotencyKey,
          externalId: normalizeString(input.externalId) || `manual-${sequence}`,
          committedAt: nowIso(),
          latencyMs: 0,
          status: "committed",
          irreversible: true
        });
        state.outboundMutation.pendingPublications = state.outboundMutation.pendingPublications
          .filter((entry) => Number(entry.sequence) !== sequence);
        state.outboundMutation.committedPublications.push(committedRecord);
        return { action, sequence, committed: true };
      }

      if (action === "confirm_not_committed") {
        if (Number(pending.retryCount || 0) >= Number(pending.maxRetryAttempts || MUTATION_CONSTANTS.MAX_RETRY_ATTEMPTS)) {
          pending.allowRetry = false;
        } else {
          pending.dispatchState = "prepared";
        }
        return { action, sequence, committed: false, retryAllowed: Boolean(pending.allowRetry) };
      }

      pending.dispatchState = "abandoned";
      pending.allowRetry = false;
      return { action, sequence, committed: false, abandoned: true };
    }, { correlationId });

    await appendAuditLog({
      provider: normalizeString(input.provider).toLowerCase(),
      mutationSequence: sequence,
      payloadHash: "",
      domain: "",
      method: "RECONCILE",
      status: "reconciled",
      latencyMs: 0,
      code: `RECONCILE_${action.toUpperCase()}`
    }, correlationId);

    return {
      ok: true,
      ...reconciled
    };
  }

  async function hydrateReplayProtection() {
    await ensureLogIntegrity();
    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      const now = nowMs();
      const maxAgeMs = MUTATION_CONSTANTS.UNCERTAIN_MAX_AGE_HOURS * 60 * 60 * 1000;

      const committedKeys = new Set();
      for (const entry of state.outboundMutation.committedPublications) {
        const key = normalizeString(entry.idempotencyKey);
        if (key) {
          committedKeys.add(key);
        }
      }

      for (const pending of state.outboundMutation.pendingPublications) {
        if (!pending.preparedWhenEnabled) {
          pending.dispatchState = "abandoned";
          pending.allowRetry = false;
          continue;
        }
        if (committedKeys.has(normalizeString(pending.idempotencyKey))) {
          pending.dispatchState = "abandoned";
          pending.allowRetry = false;
          continue;
        }
        if (pending.dispatchState === "in_flight") {
          pending.dispatchState = "uncertain";
          pending.firstUncertainAt = pending.firstUncertainAt || nowIso();
          pending.uncertainDeadlineAt = pending.uncertainDeadlineAt || new Date(now + maxAgeMs).toISOString();
        }
        if (pending.dispatchState === "uncertain" && normalizeString(pending.uncertainDeadlineAt)) {
          const deadlineMs = Date.parse(pending.uncertainDeadlineAt);
          if (Number.isFinite(deadlineMs) && now > deadlineMs) {
            pending.allowRetry = false;
          }
        }
      }

      return {
        ok: true,
        committedKeyCount: committedKeys.size,
        pendingCount: state.outboundMutation.pendingPublications.length
      };
    });
  }

  return Object.freeze({
    constants: MUTATION_CONSTANTS,
    ensureLogIntegrity,
    hydrateReplayProtection,
    preparePublication,
    commitPublication,
    retryPublication,
    reconcilePublication,
    setMutationEnabled,
    setKillSwitch,
    appendAuditLog
  });
}

module.exports = {
  MUTATION_CONSTANTS,
  createMutationControl,
  appendHashedMutationLogRecord,
  verifyMutationLogChain
};
