"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  safeString
} = require("../compliance-governance/compliance-validator.js");
const { createOperatorOverrideLedger } = require("../governance-automation/operator-override-ledger.js");
const {
  canonicalJson,
  canonicalize,
  readJsonIfExists,
  sha256
} = require("../governance-automation/common.js");
const { createOperationalDecisionLedger } = require("../observability/operational-decision-ledger.js");

const DEFAULT_ALLOWLIST_PATH = path.resolve(process.cwd(), "security", "phase10-attestation-egress-allowlist.json");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 10 external attestation error"));
  error.code = String(code || "PHASE10_ATTESTATION_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeAllowedHosts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const host = safeString(item).toLowerCase();
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    out.push(host);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function loadAllowedHosts(allowlistPath) {
  const payload = readJsonIfExists(allowlistPath, { allowed_hosts: [] }) || { allowed_hosts: [] };
  return normalizeAllowedHosts(payload.allowed_hosts);
}

function extractHostFromUrl(urlValue) {
  const text = safeString(urlValue);
  if (!text) {
    throw makeError("PHASE10_ATTESTATION_EXTERNAL_SERVICE_REQUIRED", "external service URL is required");
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw makeError("PHASE10_ATTESTATION_EXTERNAL_SERVICE_INVALID", "external service URL is invalid", { externalService: text });
  }
  if (safeString(parsed.protocol).toLowerCase() !== "https:") {
    throw makeError("PHASE10_ATTESTATION_EXTERNAL_SERVICE_INVALID", "external service URL must use https");
  }
  const host = safeString(parsed.hostname).toLowerCase();
  if (!host) {
    throw makeError("PHASE10_ATTESTATION_EXTERNAL_SERVICE_INVALID", "external service URL host is required");
  }
  return host;
}

function normalizeIsoToDayKey(isoValue) {
  const datePart = safeString(isoValue).split("T")[0] || "1970-01-01";
  return datePart.replace(/-/g, "");
}

function nextAnchorSequenceForDay(artifactDir, dayKey) {
  if (!fs.existsSync(artifactDir)) {
    return 1;
  }
  const entries = fs.readdirSync(artifactDir, { withFileTypes: true });
  const pattern = new RegExp(`^ATT-${dayKey}-(\\d{3})\\.json$`);
  let maxSequence = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(pattern);
    if (!match) {
      continue;
    }
    const sequence = Number.parseInt(String(match[1]), 10);
    if (Number.isFinite(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  }
  return maxSequence + 1;
}

function canonicalHash(value) {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

function normalizeEvidenceBundle(input) {
  if (typeof input === "string" && safeString(input)) {
    const resolved = path.resolve(safeString(input));
    const loaded = readJsonIfExists(resolved, null);
    if (!loaded || typeof loaded !== "object") {
      throw makeError("PHASE10_ATTESTATION_EVIDENCE_INVALID", "evidence bundle file must contain a JSON object", {
        path: resolved
      });
    }
    return canonicalize(loaded);
  }

  if (!input || typeof input !== "object") {
    throw makeError("PHASE10_ATTESTATION_EVIDENCE_INVALID", "evidence bundle object is required");
  }

  return canonicalize(input);
}

function createExternalAttestationAnchor(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const allowlistPath = safeString(options.allowlistPath) || DEFAULT_ALLOWLIST_PATH;
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts) || [];
  const artifactPath = safeString(options.artifactPath)
    ? path.resolve(options.artifactPath)
    : path.resolve(process.cwd(), "audit", "evidence", "observability", "attestation");

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_ATTESTATION_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function" || typeof operatorAuthorization.issueApprovalToken !== "function") {
    throw makeError("PHASE10_ATTESTATION_CONFIG_INVALID", "operatorAuthorization consume/issue APIs are required");
  }

  const overrideLedger = options.overrideLedger || createOperatorOverrideLedger({
    apiGovernance,
    operatorAuthorization,
    logger,
    timeProvider
  });

  const decisionLedger = options.decisionLedger || createOperationalDecisionLedger({
    apiGovernance,
    logger,
    timeProvider
  });

  function resolveAllowedHosts() {
    if (allowedHosts.length > 0) {
      return allowedHosts;
    }
    return loadAllowedHosts(allowlistPath);
  }

  async function initiateAttestationAnchor(evidenceBundleInput, externalService, context = {}) {
    assertOperatorRole(context);

    const confirm = context.confirm === true;
    if (!confirm) {
      throw makeError("PHASE10_ATTESTATION_CONFIRM_REQUIRED", "--confirm is required for external attestation anchoring");
    }

    const scope = safeString(context.scope) || "governance.attestation.anchor";
    if (scope !== "governance.attestation.anchor") {
      throw makeError("PHASE10_ATTESTATION_SCOPE_INVALID", "scope must be governance.attestation.anchor", { scope });
    }

    consumeScopedApprovalToken(operatorAuthorization, context.approvalToken, scope, {
      correlationId: safeString(context.correlationId)
    });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    const allowed = resolveAllowedHosts();
    const host = extractHostFromUrl(externalService);
    if (!allowed.includes(host)) {
      throw makeError("PHASE10_ATTESTATION_EXTERNAL_SERVICE_DENIED", "external service host is not allowlisted", {
        host,
        allowed_hosts: allowed
      });
    }

    const evidenceBundle = normalizeEvidenceBundle(evidenceBundleInput);
    const evidenceBundleHash = canonicalHash(evidenceBundle);
    const timestamp = String(timeProvider.nowIso());
    const dayKey = normalizeIsoToDayKey(timestamp);

    fs.mkdirSync(artifactPath, { recursive: true });
    const nextSequence = nextAnchorSequenceForDay(artifactPath, dayKey);
    const anchorId = `ATT-${dayKey}-${String(nextSequence).padStart(3, "0")}`;

    const anchorProof = `proof:${sha256(`phase10-attestation-anchor-v1|${anchorId}|${evidenceBundleHash}|${safeString(externalService)}|${scope}`)}`;

    const overrideToken = operatorAuthorization.issueApprovalToken({
      operatorId: safeString(context.requester) || "operator",
      scope: "governance.override.apply",
      correlationId: safeString(context.correlationId)
    }).token;

    const overrideEntry = await overrideLedger.recordOverride({
      approvalToken: overrideToken,
      approval_scope: "governance.override.apply",
      scope: "phase10.attestation",
      reason: "Operator-approved external attestation anchor execution",
      phase_impact: "Evidence anchoring metadata added",
      override_policy: "phase10-attestation-opt-in"
    }, {
      role: "operator",
      requester: safeString(context.requester) || "operator",
      correlationId: safeString(context.correlationId)
    });

    const ledgerEntry = await decisionLedger.recordDecision({
      timestamp,
      event_type: "attestation.anchor.success",
      actor: safeString(context.requester) || "operator",
      action: "initiate_attestation_anchor",
      result: "anchored",
      scope: "phase10.attestation",
      details: {
        anchor_id: anchorId,
        external_service: safeString(externalService),
        host,
        evidence_bundle_hash: evidenceBundleHash,
        override_id: safeString(overrideEntry.override_id)
      }
    }, {
      role: "operator",
      requester: safeString(context.requester) || "operator",
      requireOperatorRole: true,
      correlationId: safeString(context.correlationId)
    });

    const artifact = canonicalize({
      anchor_id: anchorId,
      timestamp,
      evidence_bundle_hash: evidenceBundleHash,
      external_service: safeString(externalService),
      anchor_proof: anchorProof,
      operator_approval_token_scope: scope,
      ledger_entry_id: safeString(ledgerEntry.decision_id),
      override_entry_id: safeString(overrideEntry.override_id),
      advisory_only: true,
      auto_remediation_blocked: true
    });

    const artifactPathname = path.join(artifactPath, `${anchorId}.json`);
    fs.writeFileSync(artifactPathname, canonicalJson(artifact), "utf8");

    logger.info({
      event: "phase10_attestation_anchor_created",
      anchor_id: anchorId,
      external_service: safeString(externalService)
    });

    return canonicalize({
      anchor_id: anchorId,
      anchor_proof: anchorProof,
      artifact_path: artifactPathname
    });
  }

  function verifyAttestationAnchor(anchorId) {
    const normalizedAnchorId = safeString(anchorId);
    if (!normalizedAnchorId) {
      return { valid: false, external_reference: "" };
    }

    const artifactFilePath = path.join(artifactPath, `${normalizedAnchorId}.json`);
    const payload = readJsonIfExists(artifactFilePath, null);
    if (!payload || typeof payload !== "object") {
      return { valid: false, external_reference: "" };
    }

    const expectedProof = `proof:${sha256(`phase10-attestation-anchor-v1|${safeString(payload.anchor_id)}|${safeString(payload.evidence_bundle_hash)}|${safeString(payload.external_service)}|${safeString(payload.operator_approval_token_scope)}`)}`;
    const valid = safeString(payload.anchor_proof) === expectedProof;

    return canonicalize({
      valid,
      external_reference: valid ? `${safeString(payload.external_service)}#${safeString(payload.anchor_id)}` : ""
    });
  }

  return Object.freeze({
    initiateAttestationAnchor,
    verifyAttestationAnchor,
    resolveAllowedHosts
  });
}

module.exports = {
  createExternalAttestationAnchor,
  normalizeAllowedHosts,
  extractHostFromUrl,
  normalizeEvidenceBundle,
  DEFAULT_ALLOWLIST_PATH
};
