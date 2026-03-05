"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  safeString
} = require("../compliance-governance/compliance-validator.js");
const {
  canonicalJson,
  canonicalize
} = require("../governance-automation/common.js");
const { canonicalHash, normalizeIso } = require("./supply-chain-common.js");
const { validateSupplyChainPayload, SUPPLY_CHAIN_SCHEMA_VERSION } = require("./supply-chain-schema.js");
const { createOperatorOverrideLedger } = require("../governance-automation/operator-override-ledger.js");
const { createOperationalDecisionLedger } = require("../observability/operational-decision-ledger.js");

const SUPPLY_CHAIN_UPDATE_SCOPE = "governance.supply_chain.update";

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 12 dependency update governor error"));
  error.code = String(code || "PHASE12_DEPENDENCY_UPDATE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeUpdate(entry = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const packageName = safeString(source.package_name || source.name);
  const currentVersion = safeString(source.current_version || source.from_version || source.version);
  const targetVersion = safeString(source.target_version || source.to_version || source.version);

  return canonicalize({
    package_name: packageName,
    current_version: currentVersion,
    target_version: targetVersion,
    purl: safeString(source.purl),
    license_before: safeString(source.license_before),
    license_after: safeString(source.license_after || source.license),
    package_hash_sha256: safeString(source.package_hash_sha256).replace(/^sha256:/i, "").toLowerCase(),
    dependency_depth: Number.parseInt(String(source.dependency_depth || 1), 10) || 1,
    direct_dependency: source.direct_dependency === true,
    breaking_change: source.breaking_change === true,
    risk_level: safeString(source.risk_level)
  });
}

function normalizeUpdateRequest(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const updates = Array.isArray(source.updates)
    ? source.updates.map((entry) => normalizeUpdate(entry)).filter((entry) => entry.package_name && entry.target_version)
    : [];

  const normalized = canonicalize({
    schema_version: safeString(source.schema_version) || SUPPLY_CHAIN_SCHEMA_VERSION,
    request_id: safeString(source.request_id) || "",
    requested_by: safeString(source.requested_by) || "operator",
    reason: safeString(source.reason) || "dependency_update_review",
    updates: updates.sort((left, right) => {
      if (left.package_name !== right.package_name) {
        return left.package_name.localeCompare(right.package_name);
      }
      return left.target_version.localeCompare(right.target_version);
    }),
    proposed_manifest: source.proposed_manifest && typeof source.proposed_manifest === "object"
      ? canonicalize(source.proposed_manifest)
      : null
  });

  const validation = validateSupplyChainPayload("dependency_update_request", normalized);
  if (!validation.valid) {
    throw makeError("PHASE12_UPDATE_REQUEST_INVALID", "Dependency update request failed schema validation", {
      violations: validation.violations
    });
  }

  return normalized;
}

function summarizeRisk(request) {
  const updates = Array.isArray(request.updates) ? request.updates : [];
  const breaking = updates.filter((entry) => entry.breaking_change).length;
  const licenseChanges = updates.filter((entry) => entry.license_before && entry.license_after && entry.license_before !== entry.license_after).length;

  const level = breaking > 0
    ? "high"
    : (licenseChanges > 0 || updates.length > 5 ? "medium" : "low");

  return canonicalize({
    level,
    update_count: updates.length,
    breaking_change_count: breaking,
    license_change_count: licenseChanges,
    advisory_only_until_confirm: true,
    auto_update_blocked: true
  });
}

function mergeManifestFromUpdates(existingManifest, request, generatedAt) {
  const existing = existingManifest && typeof existingManifest === "object"
    ? existingManifest
    : { schema_version: SUPPLY_CHAIN_SCHEMA_VERSION, components: [] };

  const currentComponents = Array.isArray(existing.components) ? existing.components : [];
  const componentMap = new Map();

  for (const component of currentComponents) {
    const source = component && typeof component === "object" ? component : {};
    const key = `${safeString(source.name)}@${safeString(source.version)}`;
    if (safeString(source.name) && safeString(source.version)) {
      componentMap.set(key, canonicalize(source));
    }
  }

  for (const update of request.updates) {
    const oldKey = `${update.package_name}@${update.current_version}`;
    const newKey = `${update.package_name}@${update.target_version}`;
    if (update.current_version && componentMap.has(oldKey)) {
      componentMap.delete(oldKey);
    }
    componentMap.set(newKey, canonicalize({
      name: update.package_name,
      version: update.target_version,
      purl: update.purl,
      license: update.license_after || update.license_before || "UNKNOWN",
      package_hash_sha256: update.package_hash_sha256,
      dependency_depth: update.dependency_depth,
      direct_dependency: update.direct_dependency
    }));
  }

  const mergedComponents = [...componentMap.values()].sort((left, right) => {
    const leftName = safeString(left.name);
    const rightName = safeString(right.name);
    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }
    return safeString(left.version).localeCompare(safeString(right.version));
  });

  return canonicalize({
    schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
    generated_at: generatedAt,
    source_update_request_id: request.request_id,
    components: mergedComponents
  });
}

function applyKnownGoodManifest(knownGoodPath, request, generatedAt) {
  fs.mkdirSync(path.dirname(knownGoodPath), { recursive: true });

  const nextManifest = request.proposed_manifest
    ? canonicalize({
      ...request.proposed_manifest,
      schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
      generated_at: generatedAt,
      source_update_request_id: request.request_id
    })
    : mergeManifestFromUpdates(
      fs.existsSync(knownGoodPath) ? JSON.parse(fs.readFileSync(knownGoodPath, "utf8")) : null,
      request,
      generatedAt
    );

  fs.writeFileSync(knownGoodPath, canonicalJson(nextManifest), "utf8");
  return nextManifest;
}

function createDependencyUpdateGovernor(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const knownGoodPath = path.resolve(safeString(options.knownGoodPath) || path.join(process.cwd(), "security", "known-good-dependencies.json"));

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE12_UPDATE_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function" || typeof operatorAuthorization.issueApprovalToken !== "function") {
    throw makeError("PHASE12_UPDATE_CONFIG_INVALID", "operatorAuthorization consume/issue APIs are required");
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

  function presentUpdatePlan(input = {}) {
    const request = normalizeUpdateRequest(input.updateRequest || input.update_request || input);
    const risk = summarizeRisk(request);

    return canonicalize({
      plan: {
        title: "Phase 12 Dependency Update Plan",
        request_id: request.request_id,
        requested_by: request.requested_by,
        reason: request.reason,
        updates: request.updates,
        governance_transaction_wrapper_required: true,
        operator_approval_token_required: true,
        explicit_confirm_required: true,
        no_autonomous_update: true,
        known_good_manifest_path: knownGoodPath
      },
      risk,
      acceptance_criteria: canonicalize([
        "Operator role is asserted",
        `Scoped approval token ${SUPPLY_CHAIN_UPDATE_SCOPE} is consumed`,
        "Explicit confirm flag is true",
        "Known-good manifest is updated inside governance transaction wrapper",
        "Override and operational decision ledgers receive immutable entries"
      ])
    });
  }

  async function recordOverrideDecision(operatorId, reason, phaseImpact, overridePolicy, correlationId) {
    const overrideToken = operatorAuthorization.issueApprovalToken({
      operatorId,
      scope: "governance.override.apply",
      correlationId
    }).token;

    return overrideLedger.recordOverride({
      approvalToken: overrideToken,
      approval_scope: "governance.override.apply",
      scope: "phase12.supply-chain.update",
      reason,
      phase_impact: phaseImpact,
      override_policy: overridePolicy
    }, {
      role: "operator",
      requester: operatorId,
      correlationId
    });
  }

  async function recordDecision(operatorId, correlationId, result, details) {
    return decisionLedger.recordDecision({
      timestamp: normalizeIso(timeProvider.nowIso()),
      event_type: "supply-chain.dependency-update.decision",
      actor: operatorId,
      action: "approve_update",
      result,
      scope: "phase12.supply-chain.update",
      details: canonicalize(details)
    }, {
      role: "operator",
      requester: operatorId,
      requireOperatorRole: true,
      correlationId
    });
  }

  async function approveUpdate(input = {}, context = {}) {
    assertOperatorRole(context);

    const operatorId = safeString(context.requester) || "operator";
    const correlationId = safeString(context.correlationId) || `phase12-update-${operatorId}`;
    const approvalToken = safeString(context.approvalToken || input.approvalToken || input.approval_token);
    const confirm = context.confirm === true || input.confirm === true;

    const request = normalizeUpdateRequest(input.updateRequest || input.update_request || input);
    const presentation = presentUpdatePlan({ updateRequest: request });

    if (!confirm) {
      const overrideEntry = await recordOverrideDecision(
        operatorId,
        "Dependency update rejected because confirmation flag was not provided",
        "No known-good manifest changes were applied",
        "phase12-update-confirmation-required",
        correlationId
      );
      const ledgerEntry = await recordDecision(operatorId, correlationId, "rejected", {
        reason: "missing_confirm",
        request_id: request.request_id,
        override_id: safeString(overrideEntry.override_id)
      });

      return canonicalize({
        result: {
          schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
          request_id: request.request_id,
          result: "rejected",
          approved: false,
          approval_scope: SUPPLY_CHAIN_UPDATE_SCOPE,
          reason: "missing_confirm",
          advisory_only: true,
          auto_update_blocked: true
        },
        ledger_entry: ledgerEntry,
        presentation
      });
    }

    if (!approvalToken) {
      const overrideEntry = await recordOverrideDecision(
        operatorId,
        "Dependency update rejected because approval token was not provided",
        "No known-good manifest changes were applied",
        "phase12-update-token-required",
        correlationId
      );
      const ledgerEntry = await recordDecision(operatorId, correlationId, "rejected", {
        reason: "missing_approval_token",
        request_id: request.request_id,
        override_id: safeString(overrideEntry.override_id)
      });

      return canonicalize({
        result: {
          schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
          request_id: request.request_id,
          result: "rejected",
          approved: false,
          approval_scope: SUPPLY_CHAIN_UPDATE_SCOPE,
          reason: "missing_approval_token",
          advisory_only: true,
          auto_update_blocked: true
        },
        ledger_entry: ledgerEntry,
        presentation
      });
    }

    consumeScopedApprovalToken(operatorAuthorization, approvalToken, SUPPLY_CHAIN_UPDATE_SCOPE, { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    let appliedManifest = null;
    await apiGovernance.withGovernanceTransaction(async (tx) => {
      assertKillSwitchOpen(tx.state);
      const generatedAt = normalizeIso(timeProvider.nowIso());
      appliedManifest = applyKnownGoodManifest(knownGoodPath, request, generatedAt);
      return { ok: true };
    }, { correlationId });

    const manifestHash = canonicalHash(appliedManifest);

    const overrideEntry = await recordOverrideDecision(
      operatorId,
      "Dependency update approved and known-good manifest updated",
      "Known-good dependency manifest updated under operator control",
      "phase12-update-human-gated",
      correlationId
    );

    const ledgerEntry = await recordDecision(operatorId, correlationId, "approved", {
      request_id: request.request_id,
      known_good_path: knownGoodPath,
      manifest_hash: manifestHash,
      override_id: safeString(overrideEntry.override_id)
    });

    const result = canonicalize({
      schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
      request_id: request.request_id,
      result: "approved",
      approved: true,
      approval_scope: SUPPLY_CHAIN_UPDATE_SCOPE,
      known_good_path: knownGoodPath,
      manifest_hash: manifestHash,
      advisory_only: false,
      auto_update_blocked: true
    });

    const validation = validateSupplyChainPayload("dependency_update_result", result);
    if (!validation.valid) {
      throw makeError("PHASE12_UPDATE_RESULT_INVALID", "Dependency update result failed schema validation", {
        violations: validation.violations
      });
    }

    logger.info({
      event: "phase12_dependency_update_approved",
      request_id: request.request_id,
      manifest_hash: manifestHash
    });

    return canonicalize({
      result,
      ledger_entry: ledgerEntry,
      presentation
    });
  }

  return Object.freeze({
    presentUpdatePlan,
    approveUpdate
  });
}

module.exports = {
  SUPPLY_CHAIN_UPDATE_SCOPE,
  createDependencyUpdateGovernor,
  normalizeUpdateRequest,
  summarizeRisk,
  mergeManifestFromUpdates
};
