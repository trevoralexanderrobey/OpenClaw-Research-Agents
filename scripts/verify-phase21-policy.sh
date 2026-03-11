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
  if [[ "${PHASE21_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/config/platform-targets.json"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-contract.js"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-registry.js"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-manifest-validator.js"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-snapshot-validator.js"
  "$ROOT/openclaw-bridge/monetization/phase21-release-approval-validator.js"
  "$ROOT/openclaw-bridge/monetization/submission-pack-generator.js"
  "$ROOT/openclaw-bridge/monetization/deliverable-packager.js"
  "$ROOT/openclaw-bridge/monetization/release-approval-manager.js"
  "$ROOT/scripts/_monetization-runtime.js"
  "$ROOT/scripts/generate-offer.js"
  "$ROOT/scripts/approve-release.js"
  "$ROOT/scripts/export-release.js"
  "$ROOT/scripts/build-verify.sh"
  "$ROOT/scripts/verify-phase21-policy.sh"
  "$ROOT/package.json"
  "$ROOT/.github/workflows/ci-enforcement.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 21 file: $file"
done

ADAPTER_SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/monetization/adapters"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-contract.js"
  "$ROOT/openclaw-bridge/monetization/publisher-adapter-registry.js"
  "$ROOT/openclaw-bridge/monetization/submission-pack-generator.js"
)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium|login|credential' "${ADAPTER_SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 21 adapter paths must remain free of direct network/browser/login automation logic"
fi

search_quiet 'createDefaultPublisherAdapterRegistry' "$ROOT/scripts/_monetization-runtime.js" || fail "Monetization runtime must initialize the Phase 21 publisher adapter registry"
search_quiet 'validateRegistryCoverage' "$ROOT/scripts/_monetization-runtime.js" || fail "Monetization runtime must enforce full adapter coverage for configured platform targets"
search_quiet 'adapter-manifest\.json' "$ROOT/openclaw-bridge/monetization/submission-pack-generator.js" || fail "Submission pack generator must write adapter-manifest.json per target"
search_quiet 'generated_files_sha256' "$ROOT/openclaw-bridge/monetization/submission-pack-generator.js" || fail "Submission pack generator must capture generated_files_sha256 entries"
search_quiet 'publisher_adapter_snapshot_hash' "$ROOT/openclaw-bridge/monetization/deliverable-packager.js" || fail "Bundle metadata must persist publisher_adapter_snapshot_hash"
search_quiet 'publisher_adapter_required' "$ROOT/openclaw-bridge/monetization/deliverable-packager.js" || fail "Bundle metadata must mark publisher_adapter_required"
search_quiet 'validatePublisherAdapterManifest' "$ROOT/openclaw-bridge/monetization/release-approval-manager.js" || fail "Release approval must validate adapter manifests"
search_quiet 'validatePublisherAdapterSnapshot' "$ROOT/openclaw-bridge/monetization/release-approval-manager.js" || fail "Release approval must validate adapter snapshot contracts"
search_quiet 'validatePhase21ReleaseApproval' "$ROOT/openclaw-bridge/monetization/release-approval-manager.js" || fail "Release approval must validate the phase21 release-approval contract"
search_quiet 'publisher_adapter_status' "$ROOT/scripts/export-release.js" || fail "Export output must surface publisher_adapter_status from approval validation"
search_quiet 'verify-phase21-policy\.sh' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must include verify-phase21-policy.sh"
search_quiet 'npm run phase21:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run phase21:verify"
search_quiet 'Phase 21' "$ROOT/README.md" || fail "README must document Phase 21 adapter boundary"
search_quiet 'Phase 21' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must document Phase 21 adapter surface"
search_quiet 'Phase 21' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture doc must document Phase 21 adapter boundary"

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

const packageJson = readJson("package.json");
const platformTargets = readJson("config/platform-targets.json");

if (!packageJson.scripts || !packageJson.scripts["phase21:verify"]) {
  fail("package.json must define phase21:verify");
}
for (const scriptName of ["monetization:verify", "phase2:gates"]) {
  const body = String(packageJson.scripts[scriptName] || "");
  if (!body.includes("verify-phase21-policy.sh")) {
    fail(`${scriptName} must execute verify-phase21-policy.sh`);
  }
}
if (!String(packageJson.scripts["build:verify"] || "").includes("scripts/build-verify.sh")) {
  fail("build:verify must route through scripts/build-verify.sh");
}
const runtimeSource = readText("scripts/_monetization-runtime.js");
if (!runtimeSource.includes("PHASE21_RUNTIME_ADAPTER_REGISTRY_TARGETS_MISMATCH")) {
  fail("Monetization runtime must fail closed on adapter/config registry mismatch");
}
const releaseApprovalSource = readText("openclaw-bridge/monetization/release-approval-manager.js");
for (const fragment of [
  "PHASE21_RELEASE_ADAPTER_MANIFEST_MISSING",
  "PHASE21_RELEASE_ADAPTER_GENERATED_FILE_MISSING",
  "PHASE21_RELEASE_ADAPTER_GENERATED_FILE_HASH_MISMATCH",
  "PHASE21_RELEASE_ADAPTER_MANIFEST_HASH_MISMATCH",
  "PHASE21_RELEASE_ADAPTER_PLACEHOLDER_MISSING",
  "PHASE21_RELEASE_ADAPTER_SNAPSHOT_HASH_MISMATCH"
]) {
  if (!releaseApprovalSource.includes(fragment)) {
    fail(`release-approval-manager.js must include '${fragment}'`);
  }
}
const targetNames = Object.keys(platformTargets.platform_targets || {}).sort((a, b) => a.localeCompare(b));
for (const targetName of targetNames) {
  const rel = path.join("openclaw-bridge", "monetization", "adapters", `${targetName}-manual-adapter.js`);
  if (!fs.existsSync(path.join(root, rel))) {
    fail(`Missing per-target adapter stub '${rel}'`);
  }
}
NODE

echo "Phase 21 publisher adapter policy verification passed"
