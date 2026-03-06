"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function resolveProviderConfig(config = {}, provider) {
  const root = path.resolve(process.cwd());
  const committedPath = path.join(root, "config", "llm-providers.json");
  const localPath = path.join(root, "config", "llm-providers.local.json");

  const committed = parseJsonFile(committedPath, { providers: {} });
  const local = parseJsonFile(localPath, { providers: {} });

  const merged = {
    ...(committed && committed.providers && committed.providers[provider] ? committed.providers[provider] : {}),
    ...(local && local.providers && local.providers[provider] ? local.providers[provider] : {}),
    ...(isPlainObject(config) ? config : {})
  };

  return merged;
}

function estimateTokenCount(text) {
  const normalized = safeString(text);
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).filter(Boolean).length;
}

function makeError(code, message, details) {
  const error = new Error(String(message || "LLM adapter error"));
  error.code = String(code || "PHASE14_LLM_ADAPTER_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function buildMockResponse(prompt, model) {
  const source = String(prompt || "");
  const digest = sha256(`mock-llm-v1|${source}`);
  const focusLine = source.split("\n").find((line) => line.trim().length > 0) || "";
  const preview = focusLine.slice(0, 120);
  return {
    text: [
      `Mock completion (${model})`,
      `Digest: ${digest}`,
      `Focus: ${preview}`,
      "Summary: Deterministic mock response generated from canonical prompt hash."
    ].join("\n"),
    tokenCount: Math.max(8, estimateTokenCount(source) / 2),
    raw: { digest }
  };
}

async function callLocalOllama(prompt, providerConfig) {
  const endpoint = safeString(providerConfig.endpoint) || "http://localhost:11434/api/generate";
  const model = safeString(providerConfig.model) || "llama3.1";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: String(prompt || ""),
      stream: false
    })
  });

  if (!response.ok) {
    throw makeError("PHASE14_LLM_LOCAL_HTTP_ERROR", `Local provider request failed (${response.status})`);
  }

  const payload = await response.json();
  return {
    text: safeString(payload.response),
    tokenCount: estimateTokenCount(safeString(payload.response)),
    raw: payload,
    model
  };
}

async function callOpenAi(prompt, providerConfig) {
  const endpoint = safeString(providerConfig.endpoint) || "https://api.openai.com/v1/responses";
  const model = safeString(providerConfig.model) || "gpt-4.1-mini";
  const apiKey = safeString(providerConfig.apiKey) || safeString(process.env[safeString(providerConfig.apiKeyEnv) || "OPENAI_API_KEY"]);
  if (!apiKey) {
    throw makeError("PHASE14_LLM_MISSING_API_KEY", "OpenAI API key not configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: String(prompt || "")
    })
  });

  if (!response.ok) {
    throw makeError("PHASE14_LLM_OPENAI_HTTP_ERROR", `OpenAI request failed (${response.status})`);
  }

  const payload = await response.json();
  const text = safeString(payload.output_text)
    || safeString(payload?.output?.[0]?.content?.[0]?.text)
    || safeString(payload?.choices?.[0]?.message?.content);

  return {
    text,
    tokenCount: Number(payload?.usage?.total_tokens || estimateTokenCount(text)),
    raw: payload,
    model
  };
}

async function callAnthropic(prompt, providerConfig) {
  const endpoint = safeString(providerConfig.endpoint) || "https://api.anthropic.com/v1/messages";
  const model = safeString(providerConfig.model) || "claude-3-5-sonnet-latest";
  const apiKey = safeString(providerConfig.apiKey) || safeString(process.env[safeString(providerConfig.apiKeyEnv) || "ANTHROPIC_API_KEY"]);
  if (!apiKey) {
    throw makeError("PHASE14_LLM_MISSING_API_KEY", "Anthropic API key not configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(providerConfig.maxTokens || 1024),
      messages: [{ role: "user", content: String(prompt || "") }]
    })
  });

  if (!response.ok) {
    throw makeError("PHASE14_LLM_ANTHROPIC_HTTP_ERROR", `Anthropic request failed (${response.status})`);
  }

  const payload = await response.json();
  const text = safeString(payload?.content?.[0]?.text);
  return {
    text,
    tokenCount: Number(payload?.usage?.input_tokens || 0) + Number(payload?.usage?.output_tokens || 0),
    raw: payload,
    model
  };
}

async function callOpenRouter(prompt, providerConfig) {
  const endpoint = safeString(providerConfig.endpoint) || "https://openrouter.ai/api/v1/chat/completions";
  const model = safeString(providerConfig.model) || "openai/gpt-4o-mini";
  const apiKey = safeString(providerConfig.apiKey) || safeString(process.env[safeString(providerConfig.apiKeyEnv) || "OPENROUTER_API_KEY"]);
  if (!apiKey) {
    throw makeError("PHASE14_LLM_MISSING_API_KEY", "OpenRouter API key not configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: String(prompt || "") }]
    })
  });

  if (!response.ok) {
    throw makeError("PHASE14_LLM_OPENROUTER_HTTP_ERROR", `OpenRouter request failed (${response.status})`);
  }

  const payload = await response.json();
  const text = safeString(payload?.choices?.[0]?.message?.content);
  return {
    text,
    tokenCount: Number(payload?.usage?.total_tokens || estimateTokenCount(text)),
    raw: payload,
    model
  };
}

function createLLMAdapter(options = {}) {
  const provider = safeString(options.provider || "mock") || "mock";
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowMs === "function"
    ? options.timeProvider
    : { nowMs: () => 0 };
  const interactionLog = options.interactionLog && typeof options.interactionLog.recordInteraction === "function"
    ? options.interactionLog
    : null;

  const providerConfig = resolveProviderConfig(options.config, provider);
  const defaultModel = safeString(providerConfig.model)
    || (provider === "mock" ? "mock-v1" : "unknown");

  async function complete(prompt, completionOptions = {}) {
    const promptText = String(prompt || "");
    const model = safeString(completionOptions.model) || defaultModel;
    const skillsContext = completionOptions.skillsContext && typeof completionOptions.skillsContext === "object"
      ? canonicalize(completionOptions.skillsContext)
      : { local_skills: [], hosted_skill_refs: [] };
    const startedAt = Number(timeProvider.nowMs());

    let result;
    if (provider === "mock") {
      const mock = buildMockResponse(promptText, model);
      result = { text: mock.text, tokenCount: Math.floor(mock.tokenCount), raw: mock.raw, model };
    } else if (provider === "local") {
      result = await callLocalOllama(promptText, { ...providerConfig, model });
    } else if (provider === "openai") {
      result = await callOpenAi(promptText, { ...providerConfig, model });
    } else if (provider === "anthropic") {
      result = await callAnthropic(promptText, { ...providerConfig, model });
    } else if (provider === "openrouter") {
      result = await callOpenRouter(promptText, { ...providerConfig, model });
    } else {
      throw makeError("PHASE14_LLM_PROVIDER_UNSUPPORTED", `Unsupported provider '${provider}'`);
    }

    const completedAt = Number(timeProvider.nowMs());
    const durationMs = Math.max(0, completedAt - startedAt);

    if (interactionLog) {
      await interactionLog.recordInteraction({
        taskId: safeString(completionOptions.taskId),
        prompt: promptText,
        response: safeString(result.text),
        provider,
        model,
        duration: durationMs,
        tokenCount: Math.max(0, Number.parseInt(String(result.tokenCount || 0), 10) || 0),
        metadata: {
          prompt_hash: sha256(promptText),
          response_hash: sha256(safeString(result.text)),
          phase18_skill_count: Array.isArray(skillsContext.local_skills) ? skillsContext.local_skills.length : 0,
          phase18_hosted_skill_ref_count: Array.isArray(skillsContext.hosted_skill_refs) ? skillsContext.hosted_skill_refs.length : 0
        }
      });
    }

    logger.info({ event: "phase14_llm_complete", provider, model, duration_ms: durationMs });

    return {
      text: safeString(result.text),
      provider,
      model,
      skillsContext,
      durationMs,
      tokenCount: Math.max(0, Number.parseInt(String(result.tokenCount || estimateTokenCount(result.text)), 10) || 0),
      raw: result.raw
    };
  }

  function getProviderInfo() {
    return canonicalize({
      provider,
      model: defaultModel,
      configured: Boolean(providerConfig && Object.keys(providerConfig).length > 0),
      skill_attachment_mode: "modeled_noop_until_verified"
    });
  }

  return Object.freeze({
    complete,
    getProviderInfo
  });
}

module.exports = {
  createLLMAdapter,
  estimateTokenCount,
  resolveProviderConfig
};
