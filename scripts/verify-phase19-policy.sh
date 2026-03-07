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
  if [[ "${PHASE19_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
    rg -n --glob '*.js' -- "$pattern" "$@" || true
    return
  fi
  grep -R -nE --include='*.js' -- "$pattern" "$@" || true
}

REQUIRED_FILES=(
  "$ROOT/config/dataset-schemas.json"
  "$ROOT/config/dataset-quality-rules.json"
  "$ROOT/config/mission-templates.json"
  "$ROOT/config/autonomy-ladder.json"
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/openclaw-bridge/core/mission-envelope-schema.js"
  "$ROOT/openclaw-bridge/dataset/schema-engine.js"
  "$ROOT/openclaw-bridge/dataset/dataset-builder.js"
  "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js"
  "$ROOT/openclaw-bridge/monetization/offer-builder.js"
  "$ROOT/scripts/build-dataset-from-task.js"
  "$ROOT/scripts/run-dataset-mission.js"
  "$ROOT/scripts/verify-phase19-policy.sh"
  "$ROOT/workspace/datasets/raw/.gitkeep"
  "$ROOT/workspace/datasets/staged/.gitkeep"
  "$ROOT/workspace/datasets/index/.gitkeep"
  "$ROOT/package.json"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 19 file: $file"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/dataset"
  "$ROOT/scripts/build-dataset-from-task.js"
  "$ROOT/scripts/run-dataset-mission.js"
)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium' "${SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 19 dataset modules must remain free of direct network or browser automation paths"
fi

TIMESTAMP_SCAN="$(search_lines 'mtime|birthtime|ctime|statSync|lstatSync' "$ROOT/openclaw-bridge/dataset" "$ROOT/openclaw-bridge/monetization/offer-builder.js")"
if [[ -n "$TIMESTAMP_SCAN" ]]; then
  echo "$TIMESTAMP_SCAN" >&2
  fail "Phase 19 latest-build lookup must not rely on filesystem timestamp scanning"
fi

search_quiet 'datasets-index\.json' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset index must be stored at workspace/datasets/index/datasets-index.json"
search_quiet 'latest_successful_build_id' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset index must track latest_successful_build_id"
search_quiet 'resolveLatestSuccessfulBuild' "$ROOT/openclaw-bridge/dataset/dataset-output-manager.js" || fail "Dataset output manager must provide resolveLatestSuccessfulBuild"
search_quiet 'resolveLatest(Successful|CommercializationReady)Build' "$ROOT/openclaw-bridge/monetization/offer-builder.js" || fail "Dataset-backed offers must resolve latest builds from the dataset index"
search_quiet 'mission_type' "$ROOT/openclaw-bridge/core/mission-envelope-schema.js" || fail "Mission envelope must include mission_type"
search_quiet 'dataset_type' "$ROOT/openclaw-bridge/core/mission-envelope-schema.js" || fail "Mission envelope must include dataset_type"
search_quiet 'dataset_id' "$ROOT/openclaw-bridge/core/mission-envelope-schema.js" || fail "Mission envelope must include dataset_id"
search_quiet 'Outer Operator Workflow \(Cline-compatible\)' "$ROOT/README.md" || fail "README must document outer Cline-compatible operator workflow"
search_quiet 'Final release approval remains human-only\.' "$ROOT/README.md" || fail "README must keep final release approval human-only"
search_quiet 'packaging artifacts, not proof of publication' "$ROOT/README.md" || fail "README must keep packaging-not-publication boundary explicit"
search_quiet 'External publishing, uploads, marketplace submissions, customer delivery, login automation, and browser automation remain manual-only\.' "$ROOT/README.md" || fail "README must keep external submission/publication actions manual-only"
search_quiet 'Outer Cline workflow boundary' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must document outer Cline workflow boundary"
search_quiet 'External submission/publication remains manual-only\.' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must keep manual-only external boundary"
search_quiet 'canonical runtime supervisor/governance authority remains in-repo' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture must preserve in-repo runtime authority wording"
search_quiet 'External submission, platform login, attestation, and final submission actions are manual-only' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture must keep manual-only external boundary"

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

const datasetSchemas = readJson("config/dataset-schemas.json");
const qualityRules = readJson("config/dataset-quality-rules.json");
const missionTemplates = readJson("config/mission-templates.json");
const autonomy = readJson("config/autonomy-ladder.json");
const packageJson = readJson("package.json");

const requiredDatasetTypes = [
  "instruction_qa",
  "retrieval_qa",
  "benchmark_eval",
  "classification",
  "knowledge_graph"
];
for (const datasetType of requiredDatasetTypes) {
  if (!datasetSchemas.dataset_types || !datasetSchemas.dataset_types[datasetType]) {
    fail(`Missing dataset schema '${datasetType}'`);
  }
  if (!qualityRules.dataset_types || !qualityRules.dataset_types[datasetType]) {
    fail(`Missing dataset quality rules '${datasetType}'`);
  }
}

const requiredTemplates = ["research_pack", "dataset_sample", "subscription_refresh"];
for (const templateId of requiredTemplates) {
  const template = missionTemplates.templates && missionTemplates.templates[templateId];
  if (!template || template.enabled !== true) {
    fail(`Mission template '${templateId}' must exist and remain enabled`);
  }
}

const requiredActions = [
  "discover_sources",
  "extract_structured",
  "build_dataset_rows",
  "write_dataset_card",
  "generate_store_copy",
  "generate_submission_pack",
  "package_release"
];

const scout = autonomy.roles && autonomy.roles.scout;
const analyst = autonomy.roles && autonomy.roles.analyst;
const synthesizer = autonomy.roles && autonomy.roles.synthesizer;
const operator = autonomy.roles && autonomy.roles.operator;

if (!scout || !Array.isArray(scout.allowedActions) || !scout.allowedActions.includes("discover_sources")) {
  fail("Autonomy ladder must allow discover_sources for scout");
}
if (!analyst || !Array.isArray(analyst.allowedActions) || !analyst.allowedActions.includes("extract_structured")) {
  fail("Autonomy ladder must allow extract_structured for analyst");
}
for (const action of requiredActions.slice(2)) {
  if (!synthesizer || !Array.isArray(synthesizer.allowedActions) || !synthesizer.allowedActions.includes(action)) {
    fail(`Autonomy ladder must allow ${action} for synthesizer`);
  }
}
if (!operator || !Array.isArray(operator.allowedActions) || !operator.allowedActions.includes("approve_release")) {
  fail("Autonomy ladder must keep approve_release on operator");
}
if (!Array.isArray(operator.requireHumanApproval) || !operator.requireHumanApproval.includes("approve_release")) {
  fail("approve_release must remain human-approved");
}

for (const scriptName of ["phase19:verify", "monetization:verify", "generate:offer", "approve:release", "export:release"]) {
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    fail(`package.json is missing script '${scriptName}'`);
  }
}
NODE

echo "Phase 19 dataset policy verification passed"
