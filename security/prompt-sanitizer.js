"use strict";

const INJECTION_PATTERNS = Object.freeze([
  /ignore\s+previous\s+instructions/i,
  /system\s+prompt/i,
  /\bexfiltrate\b/i,
  /override\s+policy/i
]);

const HTML_PATTERN = /<[^>]*>/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeForLog(input) {
  return normalizeString(input)
    .replace(HTML_PATTERN, " ")
    .replace(URL_PATTERN, "[url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function createPromptSanitizer(options = {}) {
  const maxChars = Number.isFinite(Number(options.maxChars)) ? Math.max(16, Number(options.maxChars)) : 512;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {} };
  const stats = {
    sanitized: 0,
    rejected: 0
  };

  function detectInjection(input) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(input)) {
        return pattern.source;
      }
    }
    return "";
  }

  function sanitizeQuery(input, context = {}) {
    const raw = normalizeString(input).trim();
    const correlationId = typeof context.correlationId === "string" ? context.correlationId : "";
    if (!raw) {
      const error = new Error("Query is required");
      error.code = "PROMPT_QUERY_REQUIRED";
      throw error;
    }

    if (raw.length > maxChars) {
      stats.rejected += 1;
      logger.warn({
        correlationId,
        event: "prompt_query_rejected",
        code: "PROMPT_QUERY_TOO_LARGE",
        preview: sanitizeForLog(raw)
      });
      const error = new Error(`Query exceeds maximum length (${maxChars})`);
      error.code = "PROMPT_QUERY_TOO_LARGE";
      throw error;
    }

    const cleaned = raw
      .replace(HTML_PATTERN, " ")
      .replace(MARKDOWN_LINK_PATTERN, "$1")
      .replace(URL_PATTERN, " ")
      .replace(/\s+/g, " ")
      .trim();

    const detectedPattern = detectInjection(raw) || detectInjection(cleaned);
    if (detectedPattern) {
      stats.rejected += 1;
      logger.warn({
        correlationId,
        event: "prompt_query_rejected",
        code: "PROMPT_INJECTION_DETECTED",
        pattern: detectedPattern,
        preview: sanitizeForLog(raw)
      });
      const error = new Error("Suspicious prompt content rejected");
      error.code = "PROMPT_INJECTION_DETECTED";
      throw error;
    }

    if (cleaned.length > maxChars) {
      stats.rejected += 1;
      logger.warn({
        correlationId,
        event: "prompt_query_rejected",
        code: "PROMPT_QUERY_TOO_LARGE_AFTER_SANITIZE",
        preview: sanitizeForLog(cleaned)
      });
      const error = new Error(`Sanitized query exceeds maximum length (${maxChars})`);
      error.code = "PROMPT_QUERY_TOO_LARGE";
      throw error;
    }

    const wasSanitized = cleaned !== raw;
    if (wasSanitized) {
      stats.sanitized += 1;
      logger.info({
        correlationId,
        event: "prompt_query_sanitized"
      });
    }

    return {
      ok: true,
      query: cleaned,
      wasSanitized
    };
  }

  return Object.freeze({
    sanitizeQuery,
    getStats() {
      return { ...stats };
    }
  });
}

module.exports = {
  INJECTION_PATTERNS,
  createPromptSanitizer
};
