#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { createInteractionLog } = require("../openclaw-bridge/core/interaction-log.js");
const { createLLMAdapter, resolveProviderConfig } = require("../openclaw-bridge/core/llm-adapter.js");
const { canonicalize, safeString, sha256 } = require("../workflows/governance-automation/common.js");
const {
  createMemoryLogger,
  normalizeError,
  parseCsvOption,
  redactSecrets,
  withTimeout,
  writeEvidenceSet
} = require("./_live-verification-common.js");

const DEFAULT_PROVIDERS = Object.freeze(["local", "openai", "anthropic", "openrouter"]);
const DEFAULT_PROMPT = [
  "Live provider verification probe.",
  "Return a concise acknowledgement that includes the provider model name.",
  "Do not use markdown formatting."
].join(" ");

function parseArgs(argv) {
  const out = {
    maxAttempts: 2,
    outputDir: path.join(process.cwd(), "audit", "evidence", "live-llm"),
    providers: DEFAULT_PROVIDERS.slice(),
    prompt: DEFAULT_PROMPT,
    timeoutMs: 30000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--providers") { out.providers = parseCsvOption(argv[index + 1], DEFAULT_PROVIDERS); index += 1; continue; }
    if (token === "--output-dir") { out.outputDir = path.resolve(String(argv[index + 1] || "").trim() || out.outputDir); index += 1; continue; }
    if (token === "--timeout-ms") { out.timeoutMs = Math.max(1, Number.parseInt(String(argv[index + 1] || "").trim(), 10) || out.timeoutMs); index += 1; continue; }
    if (token === "--max-attempts") { out.maxAttempts = Math.max(1, Number.parseInt(String(argv[index + 1] || "").trim(), 10) || out.maxAttempts); index += 1; continue; }
    if (token === "--prompt") { out.prompt = String(argv[index + 1] || "").trim() || out.prompt; index += 1; continue; }
  }

  return out;
}

function resolveApiKey(provider, config) {
  if (!["openai", "anthropic", "openrouter"].includes(provider)) {
    return "";
  }
  const envName = safeString(config.apiKeyEnv)
    || (provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY");
  return safeString(config.apiKey) || safeString(process.env[envName]);
}

function isRetryableLlmError(error) {
  const normalized = normalizeError(error);
  const code = safeString(normalized.code).toUpperCase();
  const message = safeString(normalized.message).toLowerCase();
  if (code === "PHASE14_LLM_MISSING_API_KEY") {
    return false;
  }
  if (code === "HARNESS_TIMEOUT") {
    return true;
  }
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  if (/_HTTP_ERROR$/.test(code)) {
    return true;
  }
  if (message.includes("fetch failed") || message.includes("timed out") || message.includes("socket hang up")) {
    return true;
  }
  return false;
}

async function makeInteractionLog(provider) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `openclaw-live-llm-${provider}-`));
  return createInteractionLog({
    storePath: path.join(dir, "interaction-log.json"),
    timeProvider: { nowIso: () => new Date().toISOString() }
  });
}

async function probeProvider(provider, options = {}) {
  const startedAt = new Date().toISOString();
  const runtime = createMemoryLogger();
  const providerConfig = resolveProviderConfig({}, provider);
  const redactedConfig = redactSecrets(providerConfig);
  const apiKey = resolveApiKey(provider, providerConfig);
  const attempts = [];

  if (["openai", "anthropic", "openrouter"].includes(provider) && !apiKey) {
    return canonicalize({
      provider,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status: "blocked",
      blocker: {
        code: "PHASE14_LLM_MISSING_API_KEY",
        message: `${provider} credential is not configured`,
        missing_prerequisite: safeString(providerConfig.apiKeyEnv)
          || (provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY")
      },
      attempts,
      retry_strategy: {
        source: "harness",
        max_attempts: Number(options.maxAttempts || 2),
        adapter_retry_support: "none_observed"
      },
      provider_config: redactedConfig,
      runtime_logs: runtime.getEvents()
    });
  }

  const interactionLog = await makeInteractionLog(provider);
  const adapter = createLLMAdapter({
    provider,
    config: providerConfig,
    interactionLog,
    logger: runtime.logger,
    timeProvider: { nowMs: () => Date.now() }
  });

  const providerInfo = adapter.getProviderInfo();
  let finalResponse = null;
  let finalError = null;

  for (let attempt = 1; attempt <= Number(options.maxAttempts || 2); attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await withTimeout(() => adapter.complete(options.prompt || DEFAULT_PROMPT, {
        model: safeString(options.model) || safeString(providerInfo.model),
        taskId: `live-llm-${provider}`
      }), Number(options.timeoutMs || 30000));

      finalResponse = response;
      attempts.push(canonicalize({
        attempt,
        duration_ms: Date.now() - attemptStartedAt,
        retryable_on_failure: false,
        status: "success",
        token_count: Number(response.tokenCount || 0)
      }));
      break;
    } catch (error) {
      finalError = normalizeError(error);
      const retryable = isRetryableLlmError(error);
      attempts.push(canonicalize({
        attempt,
        duration_ms: Date.now() - attemptStartedAt,
        error: finalError,
        retryable_on_failure: retryable,
        status: "failed"
      }));
      if (!retryable || attempt >= Number(options.maxAttempts || 2)) {
        break;
      }
    }
  }

  return canonicalize({
    provider,
    provider_config: redactedConfig,
    provider_info: redactSecrets(providerInfo),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    status: finalResponse ? "success" : "failed",
    blocker: null,
    attempts,
    response: finalResponse ? canonicalize({
      model: safeString(finalResponse.model),
      provider: safeString(finalResponse.provider),
      duration_ms: Number(finalResponse.durationMs || 0),
      token_count: Number(finalResponse.tokenCount || 0),
      text_hash: sha256(safeString(finalResponse.text)),
      text_preview: safeString(finalResponse.text).slice(0, 200)
    }) : null,
    final_error: finalResponse ? null : finalError,
    retry_strategy: {
      source: "harness",
      max_attempts: Number(options.maxAttempts || 2),
      adapter_retry_support: "none_observed"
    },
    interaction_count: interactionLog.getInteractionCount(),
    runtime_logs: runtime.getEvents()
  });
}

function classifyOverallStatus(results) {
  const items = Array.isArray(results) ? results : [];
  const successCount = items.filter((item) => item.status === "success").length;
  if (successCount === items.length && items.length > 0) {
    return "verified";
  }
  if (successCount > 0) {
    return "partially_verified";
  }
  return "needs_verification";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const providers = args.providers.length > 0 ? args.providers : DEFAULT_PROVIDERS.slice();
  const results = [];

  for (const provider of providers) {
    results.push(await probeProvider(provider, args));
  }

  const summary = canonicalize({
    completed_at: new Date().toISOString(),
    overall_status: classifyOverallStatus(results),
    providers,
    results,
    started_at: results[0] ? results[0].started_at : new Date().toISOString()
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
  DEFAULT_PROMPT,
  DEFAULT_PROVIDERS,
  classifyOverallStatus,
  isRetryableLlmError,
  parseArgs,
  probeProvider,
  resolveApiKey
};
