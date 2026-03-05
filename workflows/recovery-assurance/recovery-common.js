"use strict";

const path = require("node:path");

const {
  canonicalize,
  canonicalJson,
  hashFile,
  safeString,
  sha256,
  stableSortStrings
} = require("../governance-automation/common.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value, prefix = "sha256") {
  const hash = sha256(canonicalStringify(value));
  return `${safeString(prefix) || "sha256"}:${hash}`;
}

function normalizeDayKey(isoValue) {
  const text = safeString(isoValue);
  const datePart = (text.split("T")[0] || "1970-01-01").replace(/[^0-9-]/g, "");
  const parts = datePart.split("-").filter(Boolean);
  if (parts.length === 3 && parts[0].length === 4 && parts[1].length === 2 && parts[2].length === 2) {
    return `${parts[0]}${parts[1]}${parts[2]}`;
  }
  return "19700101";
}

function deriveDeterministicId(prefix, isoValue, hashValue, size = 12) {
  const normalizedPrefix = safeString(prefix).toUpperCase() || "REC";
  const dayKey = normalizeDayKey(isoValue);
  const hash = safeString(hashValue).replace(/^sha256:/, "").toLowerCase();
  const tail = hash ? hash.slice(0, Math.max(4, Number(size) || 12)) : "000000000000";
  return `${normalizedPrefix}-${dayKey}-${tail}`;
}

function stripHashPrefix(hashValue) {
  return safeString(hashValue).replace(/^sha256:/, "").toLowerCase();
}

function computeChainHash(previousHash, currentHash) {
  return `sha256:${sha256(`${stripHashPrefix(previousHash)}|${stripHashPrefix(currentHash)}`)}`;
}

function toRelativePath(rootDir, filePath) {
  const root = path.resolve(safeString(rootDir) || process.cwd());
  const abs = path.resolve(safeString(filePath));
  return path.relative(root, abs).split(path.sep).join("/");
}

function normalizeArtifacts(artifacts, rootDir = process.cwd()) {
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts
    .map((entry) => {
      const source = isPlainObject(entry) ? entry : {};
      const file = safeString(source.file);
      const normalizedFile = file ? file.split(path.sep).join("/") : "";
      const rel = normalizedFile && !normalizedFile.startsWith("/")
        ? normalizedFile
        : (normalizedFile ? toRelativePath(rootDir, normalizedFile) : "");
      return canonicalize({
        file: rel,
        sha256: stripHashPrefix(source.sha256),
        size_bytes: Math.max(0, Number.parseInt(String(source.size_bytes || 0), 10) || 0)
      });
    })
    .filter((entry) => entry.file)
    .sort((left, right) => {
      if (left.file !== right.file) {
        return left.file.localeCompare(right.file);
      }
      return left.sha256.localeCompare(right.sha256);
    });
}

function summarizeArtifacts(artifacts) {
  const normalized = normalizeArtifacts(artifacts);
  const files = normalized.map((entry) => entry.file);
  const totalBytes = normalized.reduce((sum, entry) => sum + Number(entry.size_bytes || 0), 0);
  return canonicalize({
    count: normalized.length,
    files: stableSortStrings(files),
    total_bytes: totalBytes
  });
}

function readArtifactDescriptor(rootDir, relFile) {
  const file = safeString(relFile);
  const root = path.resolve(safeString(rootDir) || process.cwd());
  const abs = path.resolve(root, file);
  const digest = hashFile(abs);
  const exists = Boolean(digest);
  return canonicalize({
    file: file.split(path.sep).join("/"),
    sha256: digest,
    exists
  });
}

module.exports = {
  canonicalize,
  canonicalJson,
  canonicalHash,
  canonicalStringify,
  computeChainHash,
  deriveDeterministicId,
  isPlainObject,
  normalizeArtifacts,
  normalizeDayKey,
  readArtifactDescriptor,
  stripHashPrefix,
  summarizeArtifacts,
  toRelativePath
};
