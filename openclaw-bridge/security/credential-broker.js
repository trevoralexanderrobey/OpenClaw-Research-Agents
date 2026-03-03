"use strict";

const { randomUuid } = require("../core/entropy-provider.js");
const { nowMs } = require("../core/time-provider.js");

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createCredentialBroker(options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(1000, Number(options.ttlMs)) : 5 * 60 * 1000;
  const currentTimeMs = typeof options.nowMs === "function" ? options.nowMs : nowMs;
  const credentialsByHandle = new Map();

  function purgeExpired() {
    const current = currentTimeMs();
    for (const [handle, entry] of credentialsByHandle.entries()) {
      if (current >= entry.expiresAt) {
        credentialsByHandle.delete(handle);
      }
    }
  }

  function issueHandle(secretValue, metadata = {}) {
    purgeExpired();
    const secret = normalizeString(secretValue);
    if (!secret) {
      const error = new Error("Secret value is required");
      error.code = "BROKER_SECRET_REQUIRED";
      throw error;
    }

    const handle = `cred_${randomUuid()}`;
    credentialsByHandle.set(handle, {
      value: secret,
      metadata: {
        principal: normalizeString(metadata.principal) || "unknown",
        purpose: normalizeString(metadata.purpose) || "runtime",
      },
      createdAt: currentTimeMs(),
      expiresAt: currentTimeMs() + ttlMs,
    });
    return handle;
  }

  function resolveHandle(handle) {
    purgeExpired();
    const key = normalizeString(handle);
    if (!key || !credentialsByHandle.has(key)) {
      const error = new Error("Credential handle not found or expired");
      error.code = "BROKER_HANDLE_NOT_FOUND";
      throw error;
    }
    const entry = credentialsByHandle.get(key);
    return {
      value: entry.value,
      metadata: { ...entry.metadata },
      expiresAt: entry.expiresAt,
    };
  }

  function revokeHandle(handle) {
    const key = normalizeString(handle);
    if (!key) {
      return false;
    }
    return credentialsByHandle.delete(key);
  }

  return {
    issueHandle,
    resolveHandle,
    revokeHandle,
    purgeExpired,
    getActiveHandleCount() {
      purgeExpired();
      return credentialsByHandle.size;
    }
  };
}

module.exports = {
  createCredentialBroker
};
