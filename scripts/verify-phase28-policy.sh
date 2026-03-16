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
  if [[ "${PHASE28_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/docs/phase28-direct-delivery-governance.md"
  "$ROOT/config/direct-delivery-targets.json"
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js"
  "$ROOT/openclaw-bridge/monetization/manual-delivery-state-machine.js"
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-ledger.js"
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js"
  "$ROOT/openclaw-bridge/monetization/deliverable-packager.js"
  "$ROOT/scripts/_monetization-runtime.js"
  "$ROOT/scripts/export-release.js"
  "$ROOT/scripts/record-delivery-outcome.js"
  "$ROOT/scripts/verify-delivery-evidence.js"
  "$ROOT/scripts/build-verify.sh"
  "$ROOT/scripts/verify-phase28-policy.sh"
  "$ROOT/package.json"
  "$ROOT/.github/workflows/ci-enforcement.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 28 file: $file"
done

PHASE28_SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js"
  "$ROOT/openclaw-bridge/monetization/manual-delivery-state-machine.js"
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-ledger.js"
  "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js"
  "$ROOT/scripts/record-delivery-outcome.js"
  "$ROOT/scripts/verify-delivery-evidence.js"
)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium|login automation|credential automation' "${PHASE28_SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 28 delivery modules must remain free of network/browser/login automation logic"
fi

search_quiet 'phase28-export-events-v1' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 export events schema marker missing"
search_quiet 'phase28-export-event-v1' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 export event schema marker missing"
search_quiet 'phase28-delivery-evidence-ledger-v1' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 evidence ledger schema marker missing"
search_quiet 'phase28-delivery-evidence-event-v1' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 evidence event schema marker missing"
search_quiet 'bundle_exported' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 must restrict export event_type to bundle_exported"
search_quiet 'delivery_outcome_recorded' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 must support delivery_outcome_recorded event_type"
search_quiet 'delivery_correction_recorded' "$ROOT/openclaw-bridge/monetization/delivery-evidence-schema.js" || fail "Phase 28 must support delivery_correction_recorded event_type"
search_quiet 'ready_for_manual_delivery' "$ROOT/openclaw-bridge/monetization/manual-delivery-state-machine.js" || fail "Phase 28 initial ready_for_manual_delivery state missing"
search_quiet 'ALLOWED_TRANSITIONS' "$ROOT/openclaw-bridge/monetization/manual-delivery-state-machine.js" || fail "Phase 28 transition matrix must be explicit"
search_quiet 'withOfferLock' "$ROOT/openclaw-bridge/monetization/delivery-evidence-ledger.js" || fail "Phase 28 ledger must use per-offer lock"
search_quiet 'writeCanonicalJsonAtomic' "$ROOT/openclaw-bridge/monetization/delivery-evidence-ledger.js" || fail "Phase 28 ledger must use atomic writes"
search_quiet 'hash_of_release_bundle' "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js" || fail "Phase 28 approved_bundle_hash must be resolved from release approval"
search_quiet 'ensureExportCoverage' "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js" || fail "Phase 28 must enforce target-specific export eligibility"
search_quiet 'idempotency_key' "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js" || fail "Phase 28 manager must enforce idempotency_key"
search_quiet 'recordDeliveryOutcome' "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js" || fail "Phase 28 manager must expose delivery outcome recording"
search_quiet 'recordExportEvent' "$ROOT/openclaw-bridge/monetization/delivery-evidence-manager.js" || fail "Phase 28 manager must expose export event recording"
search_quiet 'deliveryEvidenceManager\.recordExportEvent' "$ROOT/scripts/export-release.js" || fail "export-release must append Phase 28 delivery export events"
search_quiet 'record-delivery-outcome\.js' "$ROOT/package.json" || fail "package.json must wire record-delivery-outcome.js"
search_quiet 'verify-delivery-evidence\.js' "$ROOT/package.json" || fail "package.json must wire verify-delivery-evidence.js"
search_quiet 'verify-phase28-policy\.sh' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must include verify-phase28-policy.sh"
search_quiet 'npm run phase28:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run phase28:verify"
search_quiet 'Phase 28' "$ROOT/README.md" || fail "README must document Phase 28 boundary"
search_quiet 'Phase 28' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must document Phase 28 boundary"
search_quiet 'Phase 28' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture doc must document Phase 28 boundary"

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
const buildVerify = readText("scripts/build-verify.sh");
const schemaSource = readText("openclaw-bridge/monetization/delivery-evidence-schema.js");
const managerSource = readText("openclaw-bridge/monetization/delivery-evidence-manager.js");
const config = readJson("config/direct-delivery-targets.json");

if (!packageJson.scripts || !packageJson.scripts["phase28:verify"]) {
  fail("package.json must define phase28:verify");
}
for (const scriptName of ["monetization:verify", "phase2:gates"]) {
  const body = String(packageJson.scripts[scriptName] || "");
  if (!body.includes("verify-phase28-policy.sh")) {
    fail(`${scriptName} must execute verify-phase28-policy.sh`);
  }
}
if (!String(packageJson.scripts["phase28:verify"]).includes("verify-phase28-policy.sh")) {
  fail("phase28:verify must execute verify-phase28-policy.sh");
}
if (!String(packageJson.scripts["build:verify"] || "").includes("build-verify.sh")) {
  fail("build:verify must route through scripts/build-verify.sh");
}
if (!buildVerify.includes("verify-phase28-policy.sh")) {
  fail("scripts/build-verify.sh must include verify-phase28-policy.sh");
}
if (String(config.schema_version || "") !== "phase28-direct-delivery-targets-v1") {
  fail("config/direct-delivery-targets.json schema_version mismatch");
}
for (const marker of [
  "PHASE28_EXPORT_EVENTS_SCHEMA",
  "PHASE28_EXPORT_EVENT_SCHEMA",
  "PHASE28_EVIDENCE_LEDGER_SCHEMA",
  "PHASE28_EVIDENCE_EVENT_SCHEMA",
  "PHASE28_VERIFY_STATUS_SCHEMA"
]) {
  if (!schemaSource.includes(marker)) {
    fail(`delivery-evidence-schema.js must include marker '${marker}'`);
  }
}
if (!managerSource.includes("approved_delivery_targets")) {
  fail("delivery-evidence-manager.js must resolve and use approved_delivery_targets");
}
NODE

echo "Phase 28 direct-delivery policy verification passed"
