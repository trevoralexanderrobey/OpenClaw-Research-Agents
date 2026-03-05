"use strict";

const path = require("node:path");

const {
  canonicalize,
  safeString,
  stableSortStrings
} = require("../governance-automation/common.js");
const {
  canonicalHash,
  normalizeIso,
  sha256File,
  stripHashPrefix
} = require("./supply-chain-common.js");
const {
  SUPPLY_CHAIN_SCHEMA_VERSION,
  validateSupplyChainPayload
} = require("./supply-chain-schema.js");

const DEFAULT_SLSA_LEVEL = "SLSA_BUILD_L2_LOCAL";

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 12 build provenance attestor error"));
  error.code = String(code || "PHASE12_PROVENANCE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeArtifact(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const artifactPath = safeString(source.path || source.artifact_path || source.file);
  const resolvedPath = artifactPath ? path.resolve(artifactPath) : "";
  const providedHash = stripHashPrefix(source.sha256 || source.artifact_hash || source.hash);
  const artifactHash = providedHash || (resolvedPath ? sha256File(resolvedPath) : "");
  return canonicalize({
    path: artifactPath.split(path.sep).join("/"),
    sha256: artifactHash
  });
}

function normalizeArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  return list
    .map((entry) => normalizeArtifact(entry))
    .filter((entry) => entry.path && entry.sha256)
    .sort((left, right) => {
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return left.sha256.localeCompare(right.sha256);
    });
}

function normalizePolicyGates(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        const source = entry && typeof entry === "object" ? entry : {};
        return canonicalize({
          gate: safeString(source.gate || source.name),
          status: safeString(source.status || source.result)
        });
      })
      .filter((entry) => entry.gate)
      .sort((left, right) => left.gate.localeCompare(right.gate));
  }

  if (value && typeof value === "object") {
    const names = stableSortStrings(Object.keys(value));
    return names.map((name) => canonicalize({
      gate: name,
      status: safeString(value[name])
    }));
  }

  return [];
}

function createBuildProvenanceAttestor(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  function generateProvenance(input = {}) {
    const commitSha = safeString(input.commit_sha || input.commitSha).toLowerCase();
    const builderIdentity = safeString(input.builder_identity || input.builderIdentity);
    const sbomHash = safeString(input.sbom_hash || input.sbomHash);
    const generatedAt = normalizeIso(safeString(input.generated_at) || safeString(timeProvider.nowIso()));

    if (!commitSha) {
      throw makeError("PHASE12_PROVENANCE_COMMIT_REQUIRED", "commit_sha is required");
    }
    if (!builderIdentity) {
      throw makeError("PHASE12_PROVENANCE_BUILDER_REQUIRED", "builder_identity is required");
    }
    if (!sbomHash) {
      throw makeError("PHASE12_PROVENANCE_SBOM_HASH_REQUIRED", "sbom_hash is required");
    }

    const artifacts = normalizeArtifacts(input.artifacts);
    if (artifacts.length === 0) {
      throw makeError("PHASE12_PROVENANCE_ARTIFACTS_REQUIRED", "At least one build artifact hash is required");
    }

    const policyGates = normalizePolicyGates(input.policy_gates || input.policyGates);

    const provenance = canonicalize({
      schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
      slsa_version: "v1",
      slsa_level: DEFAULT_SLSA_LEVEL,
      commit_sha: commitSha,
      builder_identity: builderIdentity,
      sbom_hash: sbomHash,
      generated_at: generatedAt,
      artifacts,
      policy_gates: policyGates,
      predicate_type: "slsa_provenance_v1"
    });

    const validation = validateSupplyChainPayload("provenance_record", provenance);
    if (!validation.valid) {
      throw makeError("PHASE12_PROVENANCE_SCHEMA_INVALID", "Provenance payload failed schema validation", {
        violations: validation.violations
      });
    }

    const provenanceHash = canonicalHash(provenance);

    const result = canonicalize({
      provenance,
      provenance_hash: provenanceHash,
      slsa_level: DEFAULT_SLSA_LEVEL
    });

    logger.info({
      event: "phase12_build_provenance_generated",
      artifact_count: artifacts.length,
      provenance_hash: provenanceHash
    });

    return result;
  }

  return Object.freeze({
    generateProvenance
  });
}

module.exports = {
  DEFAULT_SLSA_LEVEL,
  createBuildProvenanceAttestor,
  normalizeArtifacts,
  normalizePolicyGates
};
