"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  safeString,
  sha256
} = require("../governance-automation/common.js");

const DEFAULT_ISO_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value, prefix = "sha256") {
  const normalizedPrefix = safeString(prefix) || "sha256";
  return `${normalizedPrefix}:${sha256(canonicalStringify(value))}`;
}

function normalizeIso(value, fallback = DEFAULT_ISO_TIMESTAMP) {
  const candidate = safeString(value) || safeString(fallback) || DEFAULT_ISO_TIMESTAMP;
  if (!Number.isFinite(Date.parse(candidate))) {
    return DEFAULT_ISO_TIMESTAMP;
  }
  return candidate;
}

function stableComponentKey(component = {}) {
  const source = component && typeof component === "object" ? component : {};
  const name = safeString(source.name);
  const version = safeString(source.version);
  return `${name}@${version}`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(absPath) {
  const resolved = path.resolve(safeString(absPath));
  const data = fs.readFileSync(resolved);
  return sha256Buffer(data);
}

function stripHashPrefix(value) {
  return safeString(value).replace(/^sha256:/i, "").toLowerCase();
}

function normalizePackagePath(lockPackagePath) {
  const raw = safeString(lockPackagePath);
  if (!raw) {
    return "";
  }
  return raw.split(path.sep).join("/");
}

function dependencyDepthFromPath(lockPackagePath) {
  const normalized = normalizePackagePath(lockPackagePath);
  if (!normalized) {
    return 0;
  }
  const matches = normalized.match(/(^|\/)node_modules\//g);
  return Array.isArray(matches) ? matches.length : 0;
}

function packageDescriptorHash(name, entry = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const seed = [
    safeString(name),
    safeString(source.version),
    safeString(source.resolved),
    safeString(source.integrity)
  ].join("|");
  return sha256(seed);
}

module.exports = {
  DEFAULT_ISO_TIMESTAMP,
  canonicalStringify,
  canonicalHash,
  normalizeIso,
  stableComponentKey,
  sha256Buffer,
  sha256File,
  stripHashPrefix,
  normalizePackagePath,
  dependencyDepthFromPath,
  packageDescriptorHash
};
