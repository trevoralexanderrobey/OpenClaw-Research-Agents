"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  PHASE8_HASH_TARGETS,
  CLINE_REQUIRED_MARKERS
} = require("./compliance-monitor.js");
const {
  DEFAULT_REQUIRED_CLAUSES
} = require("./policy-drift-detector.js");
const {
  PHASE8_REQUIRED
} = require("./phase-completeness-validator.js");
const {
  canonicalize,
  hashFile,
  readJsonIfExists,
  safeString,
  writeCanonicalJson
} = require("./common.js");

const FROZEN_BASELINE_COMMIT = "c006a0925840d24f7eac02d414a66ce254e98419";
const FROZEN_BASELINE_CI_RUN = "22698188722";
const FROZEN_HISTORICAL_RUN = "22658655231";

function collectPhase8ModuleHashes(rootDir) {
  const out = {};
  for (const rel of PHASE8_HASH_TARGETS) {
    out[rel] = hashFile(path.join(rootDir, rel));
  }
  return canonicalize(out);
}

function buildBaselineContracts(rootDir) {
  return canonicalize({
    baselineCommit: FROZEN_BASELINE_COMMIT,
    baselineCiRunId: FROZEN_BASELINE_CI_RUN,
    historicalRunId: FROZEN_HISTORICAL_RUN,
    phase8ModuleHashes: collectPhase8ModuleHashes(rootDir),
    requiredClauses: DEFAULT_REQUIRED_CLAUSES,
    clineMarkers: CLINE_REQUIRED_MARKERS,
    phase8RequiredArtifacts: PHASE8_REQUIRED
  });
}

function loadBaselineContracts(rootDir, explicitPath = "") {
  const baselinePath = safeString(explicitPath)
    ? path.resolve(explicitPath)
    : path.join(rootDir, "audit/evidence/governance-automation/phase9-baseline-contracts.json");

  const loaded = readJsonIfExists(baselinePath, null);
  if (loaded && typeof loaded === "object") {
    return canonicalize(loaded);
  }

  return buildBaselineContracts(rootDir);
}

function writeBaselineContracts(rootDir, outputPath = "") {
  const contracts = buildBaselineContracts(rootDir);
  const target = safeString(outputPath)
    ? path.resolve(outputPath)
    : path.join(rootDir, "audit/evidence/governance-automation/phase9-baseline-contracts.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeCanonicalJson(target, contracts);
  return {
    path: target,
    contracts
  };
}

module.exports = {
  FROZEN_BASELINE_COMMIT,
  FROZEN_BASELINE_CI_RUN,
  FROZEN_HISTORICAL_RUN,
  collectPhase8ModuleHashes,
  buildBaselineContracts,
  loadBaselineContracts,
  writeBaselineContracts
};
