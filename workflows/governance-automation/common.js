"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
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

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableSortStrings(values) {
  return asArray(values)
    .map((value) => safeString(value))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function readJsonIfExists(filePath, fallback = null) {
  const text = readTextIfExists(filePath);
  if (!text) {
    return fallback;
  }
  return JSON.parse(text);
}

function writeCanonicalJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function hashFile(filePath) {
  const content = readTextIfExists(filePath);
  if (!content) {
    return "";
  }
  return sha256(content);
}

function findLineNumber(text, needle) {
  const target = safeString(needle);
  if (!target) {
    return 1;
  }
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(target)) {
      return index + 1;
    }
  }
  return 1;
}

function pushViolation(violations, entry) {
  const source = isPlainObject(entry) ? entry : {};
  violations.push(canonicalize({
    id: safeString(source.id),
    severity: safeString(source.severity) || "high",
    file: safeString(source.file),
    line: Number.isFinite(Number(source.line)) ? Number(source.line) : 1,
    clause: safeString(source.clause),
    message: safeString(source.message),
    recommended_fix: safeString(source.recommended_fix)
  }));
}

function sortViolations(violations) {
  return asArray(violations)
    .slice()
    .sort((left, right) => {
      const leftSeverity = safeString(left.severity);
      const rightSeverity = safeString(right.severity);
      if (leftSeverity !== rightSeverity) {
        return leftSeverity.localeCompare(rightSeverity);
      }
      const leftFile = safeString(left.file);
      const rightFile = safeString(right.file);
      if (leftFile !== rightFile) {
        return leftFile.localeCompare(rightFile);
      }
      const leftLine = Number(left.line || 0);
      const rightLine = Number(right.line || 0);
      if (leftLine !== rightLine) {
        return leftLine - rightLine;
      }
      return safeString(left.id).localeCompare(safeString(right.id));
    });
}

module.exports = {
  isPlainObject,
  canonicalize,
  canonicalJson,
  sha256,
  safeString,
  asArray,
  stableSortStrings,
  readTextIfExists,
  readJsonIfExists,
  writeCanonicalJson,
  hashFile,
  findLineNumber,
  pushViolation,
  sortViolations
};
