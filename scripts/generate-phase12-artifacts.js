#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { canonicalize, canonicalJson, sha256 } = require("../workflows/governance-automation/common.js");
const { getSupplyChainSchema } = require("../workflows/supply-chain/supply-chain-schema.js");
const { createSbomGenerator } = require("../workflows/supply-chain/sbom-generator.js");
const { createDependencyIntegrityVerifier } = require("../workflows/supply-chain/dependency-integrity-verifier.js");
const { createBuildProvenanceAttestor } = require("../workflows/supply-chain/build-provenance-attestor.js");
const { createDependencyUpdateGovernor, SUPPLY_CHAIN_UPDATE_SCOPE } = require("../workflows/supply-chain/dependency-update-governor.js");
const { createVulnerabilityReporter } = require("../workflows/supply-chain/vulnerability-reporter.js");
const { createSupplyChainPolicyEngine } = require("../workflows/supply-chain/supply-chain-policy-engine.js");
const { createArtifactSigningManager } = require("../workflows/supply-chain/artifact-signing-manager.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit", "evidence", "supply-chain")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outDir = path.resolve(String(argv[index + 1] || out.outDir));
      index += 1;
      continue;
    }
  }

  return out;
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function fixedTimeProvider() {
  return {
    nowIso() {
      return "2026-03-05T00:00:00.000Z";
    }
  };
}

function fixedNowMsFactory() {
  let current = 1772668800000;
  return () => {
    const value = current;
    current += 1000;
    return value;
  };
}

function makeHarness(rootDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-phase12-artifacts-"));
  const statePath = path.join(tmpDir, "state.json");
  const ndjsonPath = path.join(tmpDir, "research.ndjson");

  const apiGovernance = createApiGovernance({
    statePath,
    researchNdjsonPath: ndjsonPath,
    timeProvider: {
      nowMs: fixedNowMsFactory(),
      nowIso: fixedTimeProvider().nowIso
    }
  });
  const operatorAuthorization = createOperatorAuthorization({
    nowMs: fixedNowMsFactory()
  });

  return {
    rootDir,
    apiGovernance,
    operatorAuthorization,
    timeProvider: fixedTimeProvider(),
    tmpDir
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir;
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const harness = makeHarness(rootDir);

  const schema = getSupplyChainSchema();

  const sbomGenerator = createSbomGenerator({
    rootDir,
    timeProvider: harness.timeProvider
  });
  const sbomResult = sbomGenerator.generateSbom();

  const knownGoodPath = path.join(rootDir, "security", "known-good-dependencies.json");
  const advisoryDbPath = path.join(rootDir, "security", "vulnerability-advisories.json");
  const policyPath = path.join(rootDir, "security", "supply-chain-policy.json");
  const sampleKeyPath = path.join(rootDir, "security", "artifact-signing-key.sample.json");

  const integrityVerifier = createDependencyIntegrityVerifier({ knownGoodPath });
  const integrityResult = integrityVerifier.verifyDependencyIntegrity(sbomResult.sbom);

  const provenanceAttestor = createBuildProvenanceAttestor({
    timeProvider: harness.timeProvider
  });
  const provenanceResult = provenanceAttestor.generateProvenance({
    commit_sha: "03295ceea3e4620507fa6d88df4f6a2324c899f8",
    builder_identity: "phase12-artifact-generator",
    sbom_hash: sbomResult.sbom_hash,
    artifacts: [{ artifact_path: path.join(rootDir, "package-lock.json") }],
    policy_gates: {
      phase11: "pass",
      phase12: "pending"
    }
  });

  const updateGovernorKnownGoodPath = path.join(outDir, ".phase12-known-good-working.json");
  const baselineKnownGood = JSON.parse(fs.readFileSync(knownGoodPath, "utf8"));
  fs.writeFileSync(updateGovernorKnownGoodPath, canonicalJson(baselineKnownGood), "utf8");

  const updateGovernor = createDependencyUpdateGovernor({
    apiGovernance: harness.apiGovernance,
    operatorAuthorization: harness.operatorAuthorization,
    timeProvider: harness.timeProvider,
    knownGoodPath: updateGovernorKnownGoodPath
  });

  const firstComponent = Array.isArray(baselineKnownGood.components) && baselineKnownGood.components.length > 0
    ? baselineKnownGood.components[0]
    : {
      name: "zod",
      version: "3.24.1",
      package_hash_sha256: "",
      license: "MIT",
      purl: "pkg:npm/zod@3.24.1",
      dependency_depth: 1,
      direct_dependency: true
    };

  const updateRequest = {
    schema_version: "phase12-supply-chain-v1",
    request_id: "phase12-update-001",
    requested_by: "phase12-artifact-generator",
    reason: "sample_known_good_refresh",
    updates: [{
      package_name: firstComponent.name,
      current_version: firstComponent.version,
      target_version: firstComponent.version,
      purl: firstComponent.purl,
      license_before: firstComponent.license,
      license_after: firstComponent.license,
      package_hash_sha256: firstComponent.package_hash_sha256,
      dependency_depth: firstComponent.dependency_depth,
      direct_dependency: firstComponent.direct_dependency,
      breaking_change: false
    }],
    proposed_manifest: baselineKnownGood
  };

  const updatePlan = updateGovernor.presentUpdatePlan({ updateRequest });
  const updateToken = harness.operatorAuthorization.issueApprovalToken({
    operatorId: "phase12-artifacts-operator",
    scope: SUPPLY_CHAIN_UPDATE_SCOPE
  }).token;

  const updateApproval = await updateGovernor.approveUpdate({
    updateRequest,
    approvalToken: updateToken,
    confirm: true
  }, {
    role: "operator",
    requester: "phase12-artifacts-operator",
    correlationId: "phase12-artifacts-update",
    approvalToken: updateToken,
    confirm: true
  });

  const vulnerabilityReporter = createVulnerabilityReporter({});
  const vulnerabilityReport = vulnerabilityReporter.scanVulnerabilities(sbomResult.sbom, advisoryDbPath);

  const policyEngine = createSupplyChainPolicyEngine({ policyPath });
  const policyResult = policyEngine.evaluatePolicy({
    sbom: sbomResult.sbom,
    dependency_manifest: baselineKnownGood,
    vulnerability_report: vulnerabilityReport,
    current_time: "2026-03-05T00:00:00.000Z"
  });

  const signingManager = createArtifactSigningManager({
    keyPath: sampleKeyPath,
    timeProvider: harness.timeProvider
  });
  const signResult = signingManager.signArtifact({
    artifact_path: path.join(rootDir, "package-lock.json"),
    sbom_hash: sbomResult.sbom_hash,
    provenance_hash: provenanceResult.provenance_hash,
    keyPath: sampleKeyPath
  });
  const verifyResult = signingManager.verifySignature(signResult.signature_record, sampleKeyPath);

  const policyGateRun = spawnSync("bash", ["scripts/verify-phase12-policy.sh", "--root", rootDir], {
    cwd: rootDir,
    encoding: "utf8"
  });
  const policyGateResult = canonicalize({
    command: `bash scripts/verify-phase12-policy.sh --root ${rootDir}`,
    status: Number(policyGateRun.status),
    passed: Number(policyGateRun.status) === 0,
    stdout: String(policyGateRun.stdout || "").trim(),
    stderr: String(policyGateRun.stderr || "").trim()
  });

  const files = {
    "supply-chain-schema.json": schema,
    "sbom-sample.json": sbomResult,
    "dependency-integrity-results.json": integrityResult,
    "build-provenance-sample.json": provenanceResult,
    "dependency-update-plan-sample.json": updatePlan,
    "dependency-update-approval-sample.json": updateApproval,
    "vulnerability-report-sample.json": vulnerabilityReport,
    "supply-chain-policy-results.json": policyResult,
    "artifact-signature-sample.json": signResult,
    "artifact-verification-sample.json": verifyResult,
    "phase12-policy-gate-results.json": policyGateResult
  };

  for (const [name, value] of Object.entries(files)) {
    writeCanonical(path.join(outDir, name), value);
  }

  const orderedFiles = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const hashManifest = canonicalize({
    files: orderedFiles.map((name) => ({
      file: name,
      sha256: hashFile(path.join(outDir, name))
    }))
  });
  writeCanonical(path.join(outDir, "hash-manifest.json"), hashManifest);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out_dir: outDir,
    files: [...orderedFiles, "hash-manifest.json"]
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
