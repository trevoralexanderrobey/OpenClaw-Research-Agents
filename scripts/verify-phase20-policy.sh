#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SELF_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "ERROR: --root requires a path argument" >&2; exit 1; }
      ROOT="$(cd "$2" && pwd)"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
  if [[ "${PHASE20_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
    return 1
  fi
  command -v rg >/dev/null 2>&1
}

search_quiet() {
  local pattern="$1"
  local file_path="$2"
  if has_rg; then
    rg -q -- "$pattern" "$file_path"
    return
  fi
  grep -Eq -- "$pattern" "$file_path"
}

search_lines() {
  local pattern="$1"
  shift
  if has_rg; then
    rg -n --glob '*.js' --glob '*.sh' -- "$pattern" "$@" || true
    return
  fi
  grep -R -nE --include='*.js' --include='*.sh' -- "$pattern" "$@" || true
}

REQUIRED_FILES=(
  "$ROOT/.npmrc"
  "$ROOT/.nvmrc"
  "$ROOT/.node-version"
  "$ROOT/.github/workflows/ci-enforcement.yml"
  "$ROOT/config/dataset-schemas.json"
  "$ROOT/config/dataset-quality-rules.json"
  "$ROOT/config/dataset-license-rules.json"
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/openclaw-bridge/dataset/dataset-builder.js"
  "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js"
  "$ROOT/openclaw-bridge/dataset/dataset-validator.js"
  "$ROOT/openclaw-bridge/dataset/dataset-deduper.js"
  "$ROOT/openclaw-bridge/dataset/dataset-scorer.js"
  "$ROOT/openclaw-bridge/dataset/license-review.js"
  "$ROOT/openclaw-bridge/dataset/provenance-tracker.js"
  "$ROOT/openclaw-bridge/monetization/offer-builder.js"
  "$ROOT/openclaw-bridge/monetization/deliverable-packager.js"
  "$ROOT/openclaw-bridge/monetization/release-approval-manager.js"
  "$ROOT/scripts/build-verify.sh"
  "$ROOT/scripts/generate-offer.js"
  "$ROOT/scripts/approve-release.js"
  "$ROOT/scripts/export-release.js"
  "$ROOT/scripts/verify-node-runtime.js"
  "$ROOT/scripts/verify-phase20-policy.sh"
  "$ROOT/package.json"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 20 file: $file"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/dataset"
  "$ROOT/openclaw-bridge/monetization"
  "$ROOT/scripts/generate-offer.js"
  "$ROOT/scripts/approve-release.js"
  "$ROOT/scripts/export-release.js"
)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium' "${SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 20 modules must remain free of direct network or browser automation paths"
fi

TIMESTAMP_SCAN="$(search_lines 'mtime|birthtime|ctime|statSync|lstatSync' "$ROOT/openclaw-bridge/dataset" "$ROOT/openclaw-bridge/monetization/offer-builder.js")"
if [[ -n "$TIMESTAMP_SCAN" ]]; then
  echo "$TIMESTAMP_SCAN" >&2
  fail "Phase 20 latest-build resolution must remain index-based and must not drift into filesystem timestamp scanning"
fi

search_quiet 'resolveLatestCommercializationReadyBuild' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must provide resolveLatestCommercializationReadyBuild"
search_quiet 'latest_commercialization_ready_build_id' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset index must track latest_commercialization_ready_build_id"
search_quiet 'latest_validated_build_id' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset index must track latest_validated_build_id"
search_quiet 'commercialization_ready' "$ROOT/openclaw-bridge/dataset/dataset-builder.js" || fail "Dataset builder must compute commercialization_ready"
search_quiet 'resolveLatestCommercializationReadyBuild' "$ROOT/openclaw-bridge/monetization/offer-builder.js" || fail "Dataset-backed offers must resolve the latest commercialization-ready build from the dataset index"
search_quiet 'validateDatasetPhase20State' "$ROOT/openclaw-bridge/monetization/release-approval-manager.js" || fail "Release approval must enforce Phase 20 dataset state"
search_quiet 'validation-report\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must persist validation-report.json"
search_quiet 'dedupe-report\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must persist dedupe-report.json"
search_quiet 'provenance\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must persist provenance.json"
search_quiet 'quality-report\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must persist quality-report.json"
search_quiet 'license-report\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must persist license-report.json"
search_quiet 'manual-only' "$ROOT/README.md" || fail "README must preserve the manual-only external action boundary"
search_quiet 'allowed' "$ROOT/README.md" || fail "README must document allowed/review_required/blocked dataset states"
search_quiet 'review_required' "$ROOT/README.md" || fail "README must document allowed/review_required/blocked dataset states"
search_quiet 'blocked' "$ROOT/README.md" || fail "README must document allowed/review_required/blocked dataset states"
search_quiet 'commercialization-ready' "$ROOT/README.md" || fail "README must document commercialization-ready dataset gating"
search_quiet 'Phase 20 commercialization gate surface' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must cover the Phase 20 commercialization gate surface"
search_quiet 'Phase 20 dataset commercialization gates are fail-closed' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture must describe fail-closed Phase 20 dataset commercialization gates"
search_quiet 'verify-phase20-policy\.sh' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must include verify-phase20-policy.sh"
search_quiet 'verify-node-runtime\.js' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must enforce the declared Node runtime"
search_quiet '^engine-strict=true$' "$ROOT/.npmrc" || fail ".npmrc must enable engine-strict=true"
search_quiet '^22\.13\.1$' "$ROOT/.nvmrc" || fail ".nvmrc must pin Node 22.13.1 exactly"
search_quiet '^22\.13\.1$' "$ROOT/.node-version" || fail ".node-version must pin Node 22.13.1 exactly"
search_quiet 'actions/setup-node@v6' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must use actions/setup-node@v6"
search_quiet 'node-version-file:\s*\.nvmrc|node-version:\s*22\.13\.1' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must pin Node 22.13.1 explicitly"
search_quiet 'npm ci' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm ci"
search_quiet 'npm run phase20:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run phase20:verify"
search_quiet 'npm run monetization:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run monetization:verify"
search_quiet 'npm run build:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run build:verify"

ROOT_DIR="$ROOT" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.ROOT_DIR;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const datasetSchemas = readJson("config/dataset-schemas.json");
const qualityRules = readJson("config/dataset-quality-rules.json");
const licenseRules = readJson("config/dataset-license-rules.json");
const packageJson = readJson("package.json");
const workflowSource = readText(".github/workflows/ci-enforcement.yml");
const builderSource = readText("openclaw-bridge/dataset/dataset-builder.js");
const outputManagerSource = readText("openclaw-bridge/dataset/dataset-output-manager.js");
const offerBuilderSource = readText("openclaw-bridge/monetization/offer-builder.js");
const releaseApprovalSource = readText("openclaw-bridge/monetization/release-approval-manager.js");
const runtimeVerifierSource = readText("scripts/verify-node-runtime.js");

if (datasetSchemas.schema_version !== "phase20-dataset-schemas-v1") {
  fail("dataset-schemas.json must declare phase20-dataset-schemas-v1");
}
if (qualityRules.schema_version !== "phase20-dataset-quality-rules-v1") {
  fail("dataset-quality-rules.json must declare phase20-dataset-quality-rules-v1");
}
if (licenseRules.schema_version !== "phase20-dataset-license-rules-v1") {
  fail("dataset-license-rules.json must declare phase20-dataset-license-rules-v1");
}
if (licenseRules.default_unknown_state !== "blocked") {
  fail("dataset-license-rules.json must fail closed with default_unknown_state=blocked");
}

const requiredDatasetTypes = [
  "instruction_qa",
  "retrieval_qa",
  "benchmark_eval",
  "classification",
  "knowledge_graph"
];
for (const datasetType of requiredDatasetTypes) {
  const schema = datasetSchemas.dataset_types && datasetSchemas.dataset_types[datasetType];
  const rules = qualityRules.dataset_types && qualityRules.dataset_types[datasetType];
  if (!schema || !schema.fields || Object.keys(schema.fields).length === 0) {
    fail(`Phase 20 schema config is missing field definitions for '${datasetType}'`);
  }
  if (!rules || !Array.isArray(rules.completeness_required_fields) || rules.completeness_required_fields.length === 0) {
    fail(`Phase 20 quality rules must define completeness_required_fields for '${datasetType}'`);
  }
  if (!rules.dedupe || typeof rules.dedupe.semantic_threshold !== "number") {
    fail(`Phase 20 quality rules must define deterministic dedupe thresholds for '${datasetType}'`);
  }
  if (!rules.scoring || !rules.scoring.row_weights || !rules.scoring.build_weights) {
    fail(`Phase 20 quality rules must define deterministic scoring weights for '${datasetType}'`);
  }
}

for (const scriptName of ["phase20:verify", "monetization:verify", "build:verify", "phase2:gates"]) {
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    fail(`package.json is missing script '${scriptName}'`);
  }
}
if (!packageJson.devEngines || !packageJson.devEngines.runtime || packageJson.devEngines.runtime.name !== "node" || packageJson.devEngines.runtime.version !== "22.13.1" || packageJson.devEngines.runtime.onFail !== "error") {
  fail("package.json must enforce the declared Node runtime through devEngines.runtime");
}
if (!packageJson.devEngines || !packageJson.devEngines.packageManager || packageJson.devEngines.packageManager.name !== "npm" || packageJson.devEngines.packageManager.onFail !== "error") {
  fail("package.json must enforce npm as the contributor package manager through devEngines.packageManager");
}
if (!String(packageJson.scripts["phase20:verify"]).includes("verify-phase20-policy.sh")) {
  fail("phase20:verify must execute verify-phase20-policy.sh");
}
if (!String(packageJson.scripts["monetization:verify"]).includes("verify-phase20-policy.sh")) {
  fail("monetization:verify must include verify-phase20-policy.sh");
}
if (!String(packageJson.scripts["phase2:gates"]).includes("verify-phase20-policy.sh")) {
  fail("phase2:gates must include verify-phase20-policy.sh");
}
for (const scriptName of ["test", "phase20:verify", "monetization:verify", "phase19:verify", "build:verify", "phase2:gates"]) {
  if (!String(packageJson.scripts[scriptName] || "").includes("verify-node-runtime.js")) {
    fail(`package.json script '${scriptName}' must verify the declared Node runtime`);
  }
}
if (!runtimeVerifierSource.includes("packageJson.engines") || !runtimeVerifierSource.includes("process.versions.node")) {
  fail("verify-node-runtime.js must compare the declared Node engine against the active runtime");
}
for (const requiredFragment of ["npm ci", "npm run phase20:verify", "npm run monetization:verify", "npm run build:verify"]) {
  if (!workflowSource.includes(requiredFragment)) {
    fail(`ci-enforcement.yml must include '${requiredFragment}'`);
  }
}

const requiredCommercializationChecks = [
  'validationStatus === "passed"',
  'qualityStatus === "passed"',
  'licenseState === "allowed"'
];
for (const fragment of requiredCommercializationChecks) {
  if (!builderSource.includes(fragment)) {
    fail(`dataset-builder.js must gate commercialization_ready on ${fragment}`);
  }
}

const requiredOutputManagerFragments = [
  "latest_commercialization_ready_build_id",
  "latest_review_required_build_id",
  "latest_validated_build_id",
  "resolveLatestCommercializationReadyBuild"
];
for (const fragment of requiredOutputManagerFragments) {
  if (!outputManagerSource.includes(fragment)) {
    fail(`dataset-output-manager.js must include '${fragment}'`);
  }
}

if (!offerBuilderSource.includes("review_required") || !offerBuilderSource.includes("explicit_build_selected")) {
  fail("offer-builder.js must preserve explicit review_required build handling");
}

const requiredApprovalFragments = [
  "PHASE20_RELEASE_DATASET_VALIDATION_FAILED",
  "PHASE20_RELEASE_DATASET_QUALITY_FAILED",
  "PHASE20_RELEASE_DATASET_LICENSE_BLOCKED",
  "PHASE20_RELEASE_DATASET_REVIEW_REQUIRED_EXPLICIT",
  "PHASE20_RELEASE_DATASET_NOT_COMMERCIALIZATION_READY"
];
for (const fragment of requiredApprovalFragments) {
  if (!releaseApprovalSource.includes(fragment)) {
    fail(`release-approval-manager.js must include '${fragment}'`);
  }
}
NODE

echo "Phase 20 dataset commercialization policy verification passed"
