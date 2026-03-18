"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { nowIso } = require("../core/time-provider.js");

const EXPORT_MANIFEST_SCHEMA = "phase27-sider-export-manifest-v1";
const REENTRY_MANIFEST_SCHEMA = "phase27-sider-reentry-manifest-v1";
const DATA_POLICY = "redacted_only";

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 27 Sider handoff error"));
  error.code = String(code || "PHASE27_SIDER_HANDOFF_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!value || typeof value !== "object") {
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

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
}

function normalizeExchangeId(value) {
  const text = normalizeString(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/.test(text)) {
    throw makeError("PHASE27_INVALID_EXCHANGE_ID", "exchange_id is required and must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/");
  }
  return text;
}

function normalizeOperatorId(value) {
  const text = normalizeString(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/.test(text)) {
    throw makeError("PHASE27_INVALID_OPERATOR_ID", "operator_id is required and must be a stable identifier");
  }
  return text;
}

function normalizeSourceTaskIds(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || "")
      .split(",")
      .map((entry) => normalizeString(entry));
  const deduped = new Set(values.map((entry) => normalizeString(entry)).filter(Boolean));
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function redactSensitiveContent(text) {
  const source = String(text || "");
  let out = source;

  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  out = out.replace(/\b(sk|pk|rk|tok|api)_[A-Za-z0-9._-]{12,}\b/g, "[REDACTED_TOKEN]");
  out = out.replace(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*([^\s]+)/gi, "$1=[REDACTED]");
  out = out.replace(/security\/token-store\.json/gi, "[REDACTED_PATH]");
  out = out.replace(/security\/session-store\.json/gi, "[REDACTED_PATH]");
  out = out.replace(/workspace\/runtime\/state\.json/gi, "[REDACTED_PATH]");
  out = out.replace(/workspace\/releases\/[^/\s]+\/submission-evidence\/[^\s]*/gi, "[REDACTED_PATH]");
  out = out.replace(/workspace\/releases\/[^/\s]+\/delivery-evidence\/[^\s]*/gi, "[REDACTED_PATH]");

  return out;
}

function assertRedacted(text) {
  const source = String(text || "");
  const blockers = [
    /Bearer\s+[A-Za-z0-9._~+/-]+/i,
    /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*(?!\[REDACTED(?:_TOKEN)?\])[^\s]+/i,
    /security\/token-store\.json/i,
    /security\/session-store\.json/i,
    /workspace\/runtime\/state\.json/i
  ];
  for (const pattern of blockers) {
    if (pattern.test(source)) {
      throw makeError("PHASE27_REDACTION_REQUIRED", "content still contains sensitive token/path patterns");
    }
  }
}

async function writeUtf8(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(text || ""), "utf8");
}

async function writeCanonicalJson(filePath, value) {
  await writeUtf8(filePath, canonicalJson(value));
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createSiderHandoffManager(options = {}) {
  const rootDir = path.resolve(normalizeString(options.rootDir) || process.cwd());
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const briefsRoot = path.join(rootDir, "workspace", "operator-briefs", "sider");

  async function exportBrief(input = {}) {
    const exchangeId = normalizeExchangeId(input.exchange_id || input.exchangeId);
    const operatorId = normalizeOperatorId(input.operator_id || input.operatorId);
    const sourceTaskIds = normalizeSourceTaskIds(input.source_task_ids || input.sourceTaskIds);
    const briefText = normalizeString(input.brief_markdown || input.briefMarkdown || input.brief_text || input.briefText);
    if (!briefText) {
      throw makeError("PHASE27_BRIEF_REQUIRED", "brief markdown/text is required");
    }

    const redacted = redactSensitiveContent(briefText);
    assertRedacted(redacted);
    const exportedAt = normalizeString(timeProvider.nowIso());

    const exchangeRoot = path.join(briefsRoot, exchangeId);
    const exportDir = path.join(exchangeRoot, "export");
    const briefPath = path.join(exportDir, "brief.md");
    const briefHash = sha256(redacted);

    await writeUtf8(briefPath, redacted.endsWith("\n") ? redacted : `${redacted}\n`);

    const exportManifest = {
      schema_version: EXPORT_MANIFEST_SCHEMA,
      exchange_id: exchangeId,
      operator_id: operatorId,
      exported_at: exportedAt,
      data_policy: DATA_POLICY,
      source_task_ids: sourceTaskIds,
      brief_sha256: briefHash,
      files: [
        {
          file: "brief.md",
          sha256: briefHash
        }
      ]
    };
    const manifestPath = path.join(exportDir, "export-manifest.json");
    await writeCanonicalJson(manifestPath, exportManifest);

    return canonicalize({
      exchange_id: exchangeId,
      export_dir: exportDir,
      brief_path: briefPath,
      manifest_path: manifestPath,
      brief_sha256: briefHash,
      data_policy: DATA_POLICY
    });
  }

  async function importApprovedResponse(input = {}) {
    const exchangeId = normalizeExchangeId(input.exchange_id || input.exchangeId);
    const operatorId = normalizeOperatorId(input.operator_id || input.operatorId);
    const taskReferenceId = normalizeString(input.task_reference_id || input.taskReferenceId);
    if (!taskReferenceId) {
      throw makeError("PHASE27_TASK_REFERENCE_REQUIRED", "task_reference_id is required");
    }
    const responseText = normalizeString(
      input.approved_response_markdown
      || input.approvedResponseMarkdown
      || input.response_markdown
      || input.responseMarkdown
      || input.response_text
      || input.responseText
    );
    if (!responseText) {
      throw makeError("PHASE27_APPROVED_RESPONSE_REQUIRED", "approved response markdown/text is required");
    }

    const exchangeRoot = path.join(briefsRoot, exchangeId);
    const exportManifestPath = path.join(exchangeRoot, "export", "export-manifest.json");
    const exportManifest = await readJsonIfExists(exportManifestPath);
    if (!exportManifest || normalizeString(exportManifest.schema_version) !== EXPORT_MANIFEST_SCHEMA) {
      throw makeError("PHASE27_EXPORT_MANIFEST_MISSING", "export-manifest.json must exist before re-entry");
    }
    const exportHash = normalizeString(exportManifest.brief_sha256);
    if (!exportHash) {
      throw makeError("PHASE27_EXPORT_HASH_MISSING", "export manifest brief_sha256 is missing");
    }

    const inputSourceHash = normalizeString(input.source_export_hash || input.sourceExportHash);
    if (inputSourceHash && inputSourceHash !== exportHash) {
      throw makeError("PHASE27_SOURCE_EXPORT_HASH_MISMATCH", "source_export_hash does not match export-manifest brief_sha256");
    }

    const importedAt = normalizeString(timeProvider.nowIso());
    const redactedResponse = redactSensitiveContent(responseText);
    assertRedacted(redactedResponse);
    const responseHash = sha256(redactedResponse);

    const reentryDir = path.join(exchangeRoot, "reentry");
    const responsePath = path.join(reentryDir, "approved-response.md");
    await writeUtf8(responsePath, redactedResponse.endsWith("\n") ? redactedResponse : `${redactedResponse}\n`);

    const reentryManifest = {
      schema_version: REENTRY_MANIFEST_SCHEMA,
      exchange_id: exchangeId,
      operator_id: operatorId,
      imported_at: importedAt,
      source_export_hash: exportHash,
      task_reference_id: taskReferenceId,
      response_sha256: responseHash,
      files: [
        {
          file: "approved-response.md",
          sha256: responseHash
        }
      ]
    };
    const reentryManifestPath = path.join(reentryDir, "reentry-manifest.json");
    await writeCanonicalJson(reentryManifestPath, reentryManifest);

    return canonicalize({
      exchange_id: exchangeId,
      reentry_dir: reentryDir,
      response_path: responsePath,
      manifest_path: reentryManifestPath,
      source_export_hash: exportHash,
      response_sha256: responseHash
    });
  }

  return Object.freeze({
    rootDir,
    briefsRoot,
    exportBrief,
    importApprovedResponse,
    redactSensitiveContent
  });
}

module.exports = {
  EXPORT_MANIFEST_SCHEMA,
  REENTRY_MANIFEST_SCHEMA,
  DATA_POLICY,
  createSiderHandoffManager
};
