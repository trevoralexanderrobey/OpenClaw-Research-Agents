"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createTimeProvider } = require("../../openclaw-bridge/core/time-provider.js");
const {
  asArray,
  canonicalize,
  canonicalJson,
  safeString,
  sha256,
  stableSortStrings
} = require("../governance-automation/common.js");

const DEFAULT_ISO_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const ACCESS_CONTROL_SCHEMA_VERSION = "phase13-access-control-v1";

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value, prefix = "sha256") {
  return `${safeString(prefix) || "sha256"}:${sha256(canonicalStringify(value))}`;
}

function normalizeIso(value, fallback = DEFAULT_ISO_TIMESTAMP) {
  const candidate = safeString(value) || safeString(fallback) || DEFAULT_ISO_TIMESTAMP;
  if (!Number.isFinite(Date.parse(candidate))) {
    return DEFAULT_ISO_TIMESTAMP;
  }
  return candidate;
}

function toIsoFromMs(valueMs) {
  const parsed = Number.parseInt(String(valueMs), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ISO_TIMESTAMP;
  }
  return createTimeProvider({ fixedNowMs: parsed }).nowIso();
}

function addHoursToIso(iso, hours) {
  const baseMs = Number.parseInt(String(Date.parse(normalizeIso(iso))), 10);
  const normalizedHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  const boundedHours = Math.max(1, Math.min(24 * 365, normalizedHours));
  const nextMs = baseMs + (boundedHours * 60 * 60 * 1000);
  return toIsoFromMs(nextMs);
}

function parseHours(value, fallback = 24) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function deriveDeterministicId(prefix, seed, size = 24) {
  const normalizedPrefix = safeString(prefix).toLowerCase() || "id";
  const hash = sha256(canonicalStringify(seed));
  const length = Number.isFinite(Number(size)) ? Math.max(8, Math.min(64, Number(size))) : 24;
  return `${normalizedPrefix}-${hash.slice(0, length)}`;
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonFileIfExists(filePath, fallback) {
  try {
    const text = fs.readFileSync(path.resolve(filePath), "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function writeCanonicalJsonFile(filePath, value) {
  ensureDirectory(filePath);
  fs.writeFileSync(path.resolve(filePath), canonicalJson(value), "utf8");
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return stableSortStrings(value);
  }
  if (typeof value === "string") {
    return stableSortStrings(String(value).split(","));
  }
  return [];
}

function roleAlias(inputRole) {
  const normalized = safeString(inputRole).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "operator") {
    return "operator_admin";
  }
  return normalized;
}

function isRoleAllowedForScope(scopeEntry, roleId) {
  const role = roleAlias(roleId);
  if (!role) {
    return false;
  }
  if (role === "operator_admin") {
    return true;
  }
  const required = roleAlias(scopeEntry && scopeEntry.required_role);
  const allowedRoles = stableSortStrings(asArray(scopeEntry && scopeEntry.allowed_roles).map((entry) => roleAlias(entry)));
  if (required && role === required) {
    return true;
  }
  return allowedRoles.includes(role);
}

module.exports = {
  ACCESS_CONTROL_SCHEMA_VERSION,
  DEFAULT_ISO_TIMESTAMP,
  canonicalStringify,
  canonicalHash,
  normalizeIso,
  toIsoFromMs,
  addHoursToIso,
  parseHours,
  deriveDeterministicId,
  ensureDirectory,
  readJsonFileIfExists,
  writeCanonicalJsonFile,
  normalizeScopes,
  roleAlias,
  isRoleAllowedForScope
};
