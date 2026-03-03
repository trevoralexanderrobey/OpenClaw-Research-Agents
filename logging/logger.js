"use strict";

const { nowIso } = require("../openclaw-bridge/core/time-provider.js");

const SENSITIVE_KEY_PATTERN = /(secret|token|password|api[_-]?key|authorization|bearer|credential)/i;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const CORRELATION_ID_PATTERN = /^[a-f0-9-]{16,64}$/;

function sanitizeString(value) {
  return String(value).replace(CONTROL_CHAR_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function maskSensitiveValue(value) {
  const source = String(value || "");
  if (source.length <= 6) {
    return "***";
  }
  return `${source.slice(0, 2)}***${source.slice(-2)}`;
}

function sanitizeValue(value, keyHint = "") {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (typeof value === "string") {
    const cleaned = sanitizeString(value);
    if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
      return maskSensitiveValue(cleaned);
    }
    return cleaned;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyHint));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = sanitizeValue(child, key);
    }
    return out;
  }

  return sanitizeString(String(value));
}

function validateCorrelationId(rawId) {
  const value = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  if (!value || !CORRELATION_ID_PATTERN.test(value)) {
    return "00000000-0000-0000-0000-000000000000";
  }
  return value;
}

function serializeBounded(payload, maxBytes) {
  let json = `${JSON.stringify(payload)}\n`;
  let bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) {
    return json;
  }

  const truncated = {
    ...payload,
    message: sanitizeString(String(payload.message || "")).slice(0, 256),
    log_truncated: true,
  };
  json = `${JSON.stringify(truncated)}\n`;
  bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) {
    return json;
  }

  return `${JSON.stringify({
    timestamp: payload.timestamp,
    severity: payload.severity,
    component: payload.component,
    correlationId: payload.correlationId,
    message: "log payload exceeded size limit",
    log_truncated: true,
  })}\n`;
}

function createLogger(component, options = {}) {
  const name = sanitizeString(component || "openclaw");
  const stream = options.stream && typeof options.stream.write === "function" ? options.stream : process.stdout;
  const maxPayloadBytes = Number.isFinite(Number(options.maxPayloadBytes))
    ? Math.max(1024, Number(options.maxPayloadBytes))
    : DEFAULT_MAX_PAYLOAD_BYTES;

  function emit(severity, input) {
    const payloadInput = input && typeof input === "object" ? input : { message: input };
    const correlationId = validateCorrelationId(payloadInput.correlationId);
    const sanitized = sanitizeValue(payloadInput);
    delete sanitized.correlationId;

    const payload = {
      timestamp: nowIso(),
      severity,
      component: name,
      correlationId,
      ...sanitized,
    };

    const line = serializeBounded(payload, maxPayloadBytes);
    stream.write(line);
  }

  return Object.freeze({
    info(input) {
      emit("info", input);
    },
    warn(input) {
      emit("warn", input);
    },
    error(input) {
      emit("error", input);
    },
  });
}

module.exports = {
  createLogger,
  sanitizeValue,
  validateCorrelationId,
};
