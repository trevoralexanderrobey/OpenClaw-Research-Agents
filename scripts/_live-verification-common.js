"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  canonicalJson,
  hashFile,
  safeString,
  sha256
} = require("../workflows/governance-automation/common.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeIso(value) {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function isoFileStamp(iso) {
  return normalizeIso(iso).replace(/[:.]/g, "-");
}

function writeCanonicalJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
  return filePath;
}

function redactSecrets(value, keyName = "") {
  const key = safeString(keyName).toLowerCase();
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value)) {
      out[childKey] = redactSecrets(value[childKey], childKey);
    }
    return canonicalize(out);
  }
  if (typeof value !== "string") {
    return value;
  }
  if (!/(api[_-]?key|secret|token|authorization|credential)/i.test(key)) {
    return value;
  }
  return value ? "[REDACTED]" : "";
}

function normalizeError(error) {
  const source = error && typeof error === "object" ? error : {};
  return canonicalize({
    code: safeString(source.code) || safeString(source.cause && source.cause.code) || "UNKNOWN_ERROR",
    name: safeString(source.name) || "Error",
    message: safeString(source.message) || String(error),
    details: redactSecrets(source.details && typeof source.details === "object" ? source.details : {})
  });
}

function createMemoryLogger() {
  const events = [];

  function push(level, payload) {
    const entry = payload && typeof payload === "object" ? payload : { message: String(payload || "") };
    events.push(canonicalize({
      level,
      payload: redactSecrets(entry),
      sequence: events.length + 1
    }));
  }

  return {
    logger: {
      info(payload) { push("info", payload); },
      warn(payload) { push("warn", payload); },
      error(payload) { push("error", payload); }
    },
    getEvents() {
      return canonicalize(events.slice());
    }
  };
}

function parseCsvOption(value, fallback = []) {
  const text = safeString(value);
  if (!text) {
    return fallback.slice();
  }
  return text
    .split(",")
    .map((entry) => safeString(entry))
    .filter(Boolean);
}

async function withTimeout(factory, timeoutMs) {
  const effectiveTimeout = Math.max(1, Number(timeoutMs || 0) || 30000);
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(`Harness timeout after ${effectiveTimeout}ms`);
          error.code = "HARNESS_TIMEOUT";
          reject(error);
        }, effectiveTimeout);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildHashManifest(outputDir) {
  ensureDir(outputDir);
  const files = fs.readdirSync(outputDir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      file: name,
      sha256: hashFile(path.join(outputDir, name))
    }));

  const manifest = canonicalize({
    schema_version: "live-verification-hash-manifest-v1",
    generated_at: new Date().toISOString(),
    files
  });

  writeCanonicalJson(path.join(outputDir, "hash-manifest.json"), manifest);
  return manifest;
}

function writeEvidenceSet(outputDir, prefix, payload) {
  ensureDir(outputDir);
  const normalized = canonicalize(payload);
  const stamp = isoFileStamp(normalized.started_at || normalized.generated_at || new Date().toISOString());
  const timestampedPath = path.join(outputDir, `${prefix}-${stamp}.json`);
  const latestPath = path.join(outputDir, `${prefix}-latest.json`);
  writeCanonicalJson(timestampedPath, normalized);
  writeCanonicalJson(latestPath, normalized);
  const manifest = buildHashManifest(outputDir);
  return {
    latest_path: latestPath,
    timestamped_path: timestampedPath,
    manifest_path: path.join(outputDir, "hash-manifest.json"),
    manifest
  };
}

function createStableId(prefix, seed) {
  return `${prefix}-${sha256(seed).slice(0, 16)}`;
}

module.exports = {
  buildHashManifest,
  createMemoryLogger,
  createStableId,
  ensureDir,
  normalizeError,
  normalizeIso,
  parseCsvOption,
  redactSecrets,
  withTimeout,
  writeCanonicalJson,
  writeEvidenceSet
};
