"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { canonicalJson, canonicalize, safeString } = require("../governance-automation/common.js");
const { createOperationalDecisionLedger } = require("../observability/operational-decision-ledger.js");

function makeError(code, message) {
  const error = new Error(String(message || "Phase 10 incident artifact creator error"));
  error.code = String(code || "PHASE10_INCIDENT_ARTIFACT_ERROR");
  return error;
}

function normalizeIsoToDayKey(isoValue) {
  const text = safeString(isoValue);
  const datePart = text.split("T")[0] || "1970-01-01";
  return datePart.replace(/-/g, "");
}

function nextIncidentSequenceForDay(artifactDir, dayKey) {
  if (!fs.existsSync(artifactDir)) {
    return 1;
  }
  const entries = fs.readdirSync(artifactDir, { withFileTypes: true });
  const pattern = new RegExp(`^INC-${dayKey}-(\\d{3})\\.json$`);
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

function normalizeEscalationPath(value) {
  if (!Array.isArray(value)) {
    return ["operator-email", "cline-notification"];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = safeString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : ["operator-email", "cline-notification"];
}

function normalizeAffectedComponents(value) {
  if (!Array.isArray(value)) {
    return ["unknown-component"];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = safeString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : ["unknown-component"];
}

function createIncidentArtifactCreator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const artifactPath = safeString(options.artifactPath)
    ? path.resolve(options.artifactPath)
    : path.resolve(process.cwd(), "audit", "evidence", "observability", "incidents");
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const apiGovernance = options.apiGovernance;

  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_INCIDENT_ARTIFACT_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required");
  }

  const decisionLedger = options.decisionLedger || createOperationalDecisionLedger({
    apiGovernance,
    logger,
    timeProvider
  });

  async function createIncidentArtifact(triggerEvent, severity, metadata = {}) {
    const timestamp = safeString(metadata.timestamp) || String(timeProvider.nowIso());
    const dayKey = normalizeIsoToDayKey(timestamp);

    fs.mkdirSync(artifactPath, { recursive: true });
    const nextSequence = nextIncidentSequenceForDay(artifactPath, dayKey);
    const incidentId = `INC-${dayKey}-${String(nextSequence).padStart(3, "0")}`;

    const artifact = canonicalize({
      incident_id: incidentId,
      timestamp,
      trigger_event: safeString(triggerEvent) || "manual_incident_trigger",
      severity: safeString(severity) || "medium",
      affected_components: normalizeAffectedComponents(metadata.affected_components || metadata.components),
      recommended_action: safeString(metadata.recommended_action) || "Review incident artifact and decide next operator action",
      escalation_path: normalizeEscalationPath(metadata.escalation_path),
      ledger_entry_id: "",
      advisory_only: true,
      requires_operator_action: true,
      auto_remediation_blocked: true,
      metadata: canonicalize(metadata && typeof metadata === "object" ? metadata : {})
    });

    const ledgerEntry = await decisionLedger.recordDecision({
      timestamp,
      event_type: "incident.created",
      actor: safeString(metadata.actor) || "operator",
      action: "create_incident_artifact",
      result: "created",
      scope: "phase10.incident",
      details: {
        incident_id: incidentId,
        severity: artifact.severity,
        trigger_event: artifact.trigger_event
      }
    }, {
      requester: safeString(metadata.actor) || "operator"
    });

    artifact.ledger_entry_id = safeString(ledgerEntry.decision_id);

    const artifactFilePath = path.join(artifactPath, `${incidentId}.json`);
    fs.writeFileSync(artifactFilePath, canonicalJson(artifact), "utf8");

    logger.info({
      event: "phase10_incident_artifact_created",
      incident_id: incidentId,
      artifact_path: artifactFilePath
    });

    return canonicalize({
      incident_id: incidentId,
      artifact_path: artifactFilePath
    });
  }

  return Object.freeze({
    createIncidentArtifact
  });
}

module.exports = {
  createIncidentArtifactCreator,
  normalizeIsoToDayKey,
  nextIncidentSequenceForDay
};
