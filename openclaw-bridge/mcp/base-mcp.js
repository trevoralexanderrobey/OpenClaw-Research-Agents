"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const tls = require("node:tls");

const { z } = require("zod");

const { nowIso, nowMs } = require("../core/time-provider.js");
const { createPromptSanitizer } = require("../../security/prompt-sanitizer.js");
const { createApiGovernance } = require("../../security/api-governance.js");
const { createCircuitBreaker } = require("../supervisor/circuit-breaker.js");
const {
  validateEgressPolicy,
  preparePinnedEgressTarget,
  logOutboundAttempt
} = require("../execution/egress-policy.js");

const MCP_ERROR_CODES = Object.freeze({
  INPUT_SCHEMA_INVALID: "MCP_INPUT_SCHEMA_INVALID",
  OUTPUT_SCHEMA_INVALID: "MCP_OUTPUT_SCHEMA_INVALID",
  QUERY_TOO_LARGE: "MCP_QUERY_TOO_LARGE",
  OUTBOUND_POLICY_MISSING: "MCP_OUTBOUND_POLICY_MISSING",
  OUTBOUND_REQUEST_FAILED: "MCP_OUTBOUND_REQUEST_FAILED",
  OUTBOUND_TIMEOUT: "MCP_OUTBOUND_TIMEOUT",
  CIRCUIT_OPEN: "MCP_CIRCUIT_OPEN",
  HASH_MISMATCH: "MCP_HASH_MISMATCH",
  TLS_OVERRIDE_FORBIDDEN: "MCP_TLS_OVERRIDE_FORBIDDEN",
  NOT_IMPLEMENTED: "MCP_NOT_IMPLEMENTED"
});

const TLS_OVERRIDE_FIELDS = Object.freeze([
  "rejectUnauthorized",
  "ca",
  "cert",
  "key",
  "agent",
  "checkServerIdentity",
  "servername",
  "insecureSkipTlsVerify",
  "tlsOptions",
  "tls"
]);

const CanonicalResearchRecordSchema = z
  .object({
    source: z.string().min(1).max(64),
    paper_id: z.string().min(1).max(256),
    title: z.string().min(1).max(2000),
    abstract: z.string().max(20000),
    authors: z.array(z.string().min(1).max(256)).max(200),
    citation_velocity: z.number().int().min(0).max(10_000_000),
    published_at: z.string().min(1).max(64),
    retrieved_at: z.string().min(1).max(64),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().min(1)
  })
  .strict();

const CanonicalResearchRecordWithoutHashSchema = CanonicalResearchRecordSchema.omit({ hash: true, sequence: true });

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value, maxLen) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (typeof maxLen === "number" && maxLen > 0 && text.length > maxLen) {
    return text.slice(0, maxLen);
  }
  return text;
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors)) {
    return [];
  }
  return authors
    .map((item) => {
      if (typeof item === "string") {
        return normalizeText(item, 256);
      }
      if (isPlainObject(item) && typeof item.name === "string") {
        return normalizeText(item.name, 256);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 200);
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

function createMcpError(code, message, details) {
  const error = new Error(String(message || "MCP error"));
  error.code = String(code || "MCP_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function computeResearchRecordHash(recordWithoutHash) {
  const parsed = CanonicalResearchRecordWithoutHashSchema.parse(recordWithoutHash);
  const canonicalPayload = canonicalStringify(parsed);
  const seed = `research-record-v1|${parsed.source}|${canonicalPayload}`;
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function verifyResearchRecordHash(record) {
  const parsed = CanonicalResearchRecordSchema.parse(record);
  const expected = computeResearchRecordHash({
    source: parsed.source,
    paper_id: parsed.paper_id,
    title: parsed.title,
    abstract: parsed.abstract,
    authors: parsed.authors,
    citation_velocity: parsed.citation_velocity,
    published_at: parsed.published_at,
    retrieved_at: parsed.retrieved_at
  });
  if (expected !== parsed.hash) {
    const error = createMcpError(MCP_ERROR_CODES.HASH_MISMATCH, "Research record hash mismatch", {
      expected,
      actual: parsed.hash,
      paper_id: parsed.paper_id
    });
    throw error;
  }
  return true;
}

function parseDateOrFallback(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "1970-01-01T00:00:00.000Z";
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function assertNoTlsOverrides(target, code) {
  if (!isPlainObject(target)) {
    return;
  }
  for (const key of TLS_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw createMcpError(code, `TLS option override is forbidden: '${key}'`);
    }
  }
}

class BaseMcp {
  constructor(options = {}) {
    this.mcpSlug = typeof options.mcpSlug === "string" ? options.mcpSlug.trim().toLowerCase() : "";
    this.source = typeof options.source === "string" ? options.source.trim().toLowerCase() : this.mcpSlug;
    this.inputSchema = options.inputSchema;
    this.maxInputChars = parsePositiveInt(options.maxInputChars, 512);
    this.retryMax = Math.min(2, parsePositiveInt(options.retryMax, 2));
    this.timeoutMs = Math.min(12_000, parsePositiveInt(options.timeoutMs, 8_000));
    this.maxAbstractChars = parsePositiveInt(options.maxAbstractChars, 20_000);
    this.logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();
    this.promptSanitizer = options.promptSanitizer || createPromptSanitizer({ logger: this.logger, maxChars: this.maxInputChars });
    this.apiGovernance = options.apiGovernance || createApiGovernance({ logger: this.logger });
    this.egressPolicies = options.egressPolicies;
    this.resolver = options.resolver;
    this.timeProvider = options.timeProvider && typeof options.timeProvider === "object" ? options.timeProvider : { nowIso, nowMs };
    this.circuitBreaker = options.circuitBreaker || createCircuitBreaker({
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      timeout: 60_000
    });
    this.httpGet = typeof options.httpGet === "function" ? options.httpGet : this.#httpsGet.bind(this);

    if (!this.mcpSlug) {
      throw createMcpError("MCP_CONFIG_INVALID", "mcpSlug is required");
    }
    if (!this.inputSchema || typeof this.inputSchema.safeParse !== "function") {
      throw createMcpError("MCP_CONFIG_INVALID", "inputSchema (zod) is required");
    }
  }

  async run(input, context = {}) {
    const correlationId = typeof context.correlationId === "string" ? context.correlationId : "";

    const parsedInput = this.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw createMcpError(MCP_ERROR_CODES.INPUT_SCHEMA_INVALID, "MCP input schema validation failed", {
        issues: parsedInput.error.issues
      });
    }

    const inputSize = Buffer.byteLength(canonicalStringify(parsedInput.data));
    if (inputSize > this.maxInputChars) {
      throw createMcpError(MCP_ERROR_CODES.QUERY_TOO_LARGE, `Input exceeds max size (${this.maxInputChars})`, {
        inputSize,
        maxInputChars: this.maxInputChars
      });
    }

    const sanitizedInput = await this.#sanitizeInput(parsedInput.data, { correlationId });
    const rawRecords = await this.#executeWithRetry(sanitizedInput, { ...context, correlationId });

    if (!Array.isArray(rawRecords)) {
      throw createMcpError(MCP_ERROR_CODES.OUTPUT_SCHEMA_INVALID, "MCP execution must return an array");
    }

    const normalizedWithoutSequence = rawRecords.map((record) => this.normalizeRecord(record, { ...context, correlationId }));
    const finalRecords = await this.apiGovernance.withGovernanceTransaction(async (tx) => {
      tx.applyUsage({
        mcp: this.mcpSlug,
        tokens: this.estimateTokens(sanitizedInput),
        correlationId
      });

      const committed = [];
      for (const normalized of normalizedWithoutSequence) {
        const sequence = tx.allocateSequence();
        const withSequence = {
          ...normalized,
          sequence
        };
        const parsedRecord = CanonicalResearchRecordSchema.parse(withSequence);
        verifyResearchRecordHash(parsedRecord);
        tx.appendResearchRecord(parsedRecord);
        committed.push(parsedRecord);
      }
      return committed;
    }, { correlationId });

    return {
      ok: true,
      records: finalRecords
    };
  }

  estimateTokens(input) {
    const source = canonicalStringify(input);
    return Math.max(1, Math.ceil(Buffer.byteLength(source) / 4));
  }

  async #sanitizeInput(parsedInput, context) {
    const out = { ...parsedInput };
    if (typeof out.query === "string") {
      const sanitized = this.promptSanitizer.sanitizeQuery(out.query, context);
      out.query = sanitized.query;
    }
    if (typeof out.paper_id === "string") {
      out.paper_id = normalizeText(out.paper_id, 256);
    }
    return out;
  }

  async #executeWithRetry(parsedInput, context) {
    const gate = this.circuitBreaker.checkBeforeRequest(this.mcpSlug);
    if (!gate.allowed) {
      throw createMcpError(MCP_ERROR_CODES.CIRCUIT_OPEN, "MCP circuit breaker is open", {
        mcp: this.mcpSlug
      });
    }

    let attempt = 0;
    let lastError = null;
    while (attempt <= this.retryMax) {
      attempt += 1;
      try {
        const records = await this.execute(parsedInput, context);
        this.circuitBreaker.recordSuccess(this.mcpSlug);
        return records;
      } catch (error) {
        lastError = error;
        this.circuitBreaker.recordFailure(this.mcpSlug);
        if (attempt > this.retryMax) {
          break;
        }
      }
    }

    throw createMcpError(
      MCP_ERROR_CODES.OUTBOUND_REQUEST_FAILED,
      lastError && lastError.message ? lastError.message : "MCP execution failed",
      {
        attemptCount: attempt,
        code: lastError && lastError.code ? lastError.code : "UNKNOWN"
      }
    );
  }

  async policyValidatedGet(url, context = {}) {
    assertNoTlsOverrides(context, MCP_ERROR_CODES.TLS_OVERRIDE_FORBIDDEN);

    const policyCheck = validateEgressPolicy(this.mcpSlug, this.egressPolicies, { allowDefault: false });
    if (!policyCheck.valid) {
      throw createMcpError(MCP_ERROR_CODES.OUTBOUND_POLICY_MISSING, policyCheck.errors.join("; "));
    }

    const started = this.timeProvider.nowMs();
    const correlationId = typeof context.correlationId === "string" ? context.correlationId : "";
    let domain = "";

    try {
      const pinned = await preparePinnedEgressTarget(url, policyCheck.policy, {
        resolver: this.resolver
      });
      domain = pinned.hostname;
      const result = await this.httpGet(pinned, {
        timeoutMs: this.timeoutMs,
        maxBodyBytes: parsePositiveInt(context.maxBodyBytes, 1024 * 1024)
      });
      logOutboundAttempt(this.logger, {
        domain,
        status: "success",
        latencyMs: this.timeProvider.nowMs() - started,
        correlationId,
        code: "OK"
      });
      return result;
    } catch (error) {
      logOutboundAttempt(this.logger, {
        domain,
        status: "blocked",
        latencyMs: this.timeProvider.nowMs() - started,
        correlationId,
        code: error && error.code ? error.code : "EGRESS_ERROR"
      });
      throw error;
    }
  }

  async policyValidatedGetJson(url, context = {}) {
    const response = await this.policyValidatedGet(url, context);
    try {
      return JSON.parse(response.body);
    } catch {
      throw createMcpError(MCP_ERROR_CODES.OUTBOUND_REQUEST_FAILED, "Expected JSON response body");
    }
  }

  async policyValidatedGetText(url, context = {}) {
    const response = await this.policyValidatedGet(url, context);
    return String(response.body || "");
  }

  async #httpsGet(pinnedTarget, options = {}) {
    assertNoTlsOverrides(options, MCP_ERROR_CODES.TLS_OVERRIDE_FORBIDDEN);

    const timeoutMs = parsePositiveInt(options.timeoutMs, 8000);
    const maxBodyBytes = parsePositiveInt(options.maxBodyBytes, 1024 * 1024);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: "https:",
          hostname: pinnedTarget.hostname,
          port: pinnedTarget.url.port ? Number(pinnedTarget.url.port) : 443,
          method: "GET",
          path: `${pinnedTarget.url.pathname}${pinnedTarget.url.search}`,
          lookup: pinnedTarget.lookup,
          servername: pinnedTarget.hostname,
          rejectUnauthorized: true,
          checkServerIdentity(_serverName, cert) {
            return tls.checkServerIdentity(pinnedTarget.hostname, cert);
          },
          agent: false,
          headers: {
            Accept: "application/json, text/plain, application/atom+xml"
          }
        },
        (res) => {
          const chunks = [];
          let seen = 0;

          res.on("data", (chunk) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            seen += part.length;
            if (seen > maxBodyBytes) {
              req.destroy(createMcpError(MCP_ERROR_CODES.OUTBOUND_REQUEST_FAILED, "Outbound response too large", {
                maxBodyBytes
              }));
              return;
            }
            chunks.push(part);
          });

          res.on("end", () => {
            const statusCode = Number(res.statusCode || 0);
            const body = Buffer.concat(chunks).toString("utf8");
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                createMcpError(MCP_ERROR_CODES.OUTBOUND_REQUEST_FAILED, `Outbound request failed with status ${statusCode}`, {
                  statusCode,
                  bodyPreview: body.slice(0, 200)
                })
              );
              return;
            }
            resolve({
              statusCode,
              headers: res.headers,
              body
            });
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(createMcpError(MCP_ERROR_CODES.OUTBOUND_TIMEOUT, `Outbound request timed out (${timeoutMs}ms)`));
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.end();
    });
  }

  // eslint-disable-next-line class-methods-use-this
  execute() {
    throw createMcpError(MCP_ERROR_CODES.NOT_IMPLEMENTED, "execute() must be implemented by subclass");
  }

  normalizeRecord(rawRecord) {
    const source = this.source;
    const paperId = normalizeText(rawRecord && rawRecord.paper_id, 256) || normalizeText(rawRecord && rawRecord.paperId, 256);
    const title = normalizeText(rawRecord && rawRecord.title, 2000);
    const abstractStripped = stripHtml(rawRecord && rawRecord.abstract);
    if (abstractStripped.length > this.maxAbstractChars) {
      throw createMcpError(MCP_ERROR_CODES.OUTPUT_SCHEMA_INVALID, `abstract exceeds max length (${this.maxAbstractChars})`, {
        paper_id: paperId,
        length: abstractStripped.length
      });
    }
    const abstract = abstractStripped;
    const authors = normalizeAuthors(rawRecord && rawRecord.authors);
    const citationVelocity = Number.isFinite(Number(rawRecord && rawRecord.citation_velocity))
      ? Math.max(0, Math.floor(Number(rawRecord.citation_velocity)))
      : 0;
    const publishedAt = parseDateOrFallback(rawRecord && rawRecord.published_at);
    const retrievedAt = this.timeProvider.nowIso();

    const payloadWithoutHash = {
      source,
      paper_id: paperId,
      title,
      abstract,
      authors,
      citation_velocity: citationVelocity,
      published_at: publishedAt,
      retrieved_at: retrievedAt
    };

    const hash = computeResearchRecordHash(payloadWithoutHash);
    return {
      ...payloadWithoutHash,
      hash
    };
  }

  static verifyRecordHash(record) {
    return verifyResearchRecordHash(record);
  }

  static computeRecordHash(recordWithoutHash) {
    return computeResearchRecordHash(recordWithoutHash);
  }

  static canonicalStringify(value) {
    return canonicalStringify(value);
  }
}

module.exports = {
  BaseMcp,
  MCP_ERROR_CODES,
  CanonicalResearchRecordSchema,
  CanonicalResearchRecordWithoutHashSchema,
  normalizeAuthors,
  normalizeText,
  stripHtml,
  verifyResearchRecordHash,
  computeResearchRecordHash
};
