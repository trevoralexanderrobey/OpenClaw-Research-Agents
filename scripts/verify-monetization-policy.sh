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
  if [[ "${PHASE19_MONETIZATION_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/config/monetization-map.json"
  "$ROOT/config/platform-targets.json"
  "$ROOT/openclaw-bridge/monetization/offer-schema.js"
  "$ROOT/openclaw-bridge/monetization/offer-builder.js"
  "$ROOT/openclaw-bridge/monetization/deliverable-packager.js"
  "$ROOT/openclaw-bridge/monetization/submission-pack-generator.js"
  "$ROOT/openclaw-bridge/monetization/release-approval-manager.js"
  "$ROOT/scripts/_monetization-runtime.js"
  "$ROOT/scripts/generate-offer.js"
  "$ROOT/scripts/approve-release.js"
  "$ROOT/scripts/export-release.js"
  "$ROOT/scripts/verify-monetization-policy.sh"
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing monetization file: $file"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/monetization"
  "$ROOT/scripts/_monetization-runtime.js"
  "$ROOT/scripts/generate-offer.js"
  "$ROOT/scripts/approve-release.js"
  "$ROOT/scripts/export-release.js"
)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium' "${SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 19 monetization modules must remain free of direct network or browser automation paths"
fi

search_quiet 'validateApprovedRelease' "$ROOT/scripts/export-release.js" || fail "export-release must validate release approval before export"
search_quiet 'release-approval\.json' "$ROOT/openclaw-bridge/monetization/release-approval-manager.js" || fail "release approval artifact handling is required"
search_quiet 'manual-only' "$ROOT/README.md" || fail "README must state manual-only external submission boundary"
search_quiet 'packaging artifact' "$ROOT/README.md" || fail "README must state monetization bundles are packaging artifacts"
search_quiet 'manual-only' "$ROOT/docs/attack-surface.md" || fail "attack-surface doc must state manual-only monetization boundary"

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

const monetizationMap = readJson("config/monetization-map.json");
const platformTargets = readJson("config/platform-targets.json");

const requiredProductLines = [
  "research_retainers",
  "research_subscriptions",
  "research_packs",
  "dataset_samples",
  "dataset_packs",
  "dataset_subscriptions",
  "custom_dataset_services",
  "enterprise_private_delivery",
  "sponsorship_assets"
];
const requiredTiers = ["sample", "standard", "premium", "enterprise"];

for (const productLine of requiredProductLines) {
  if (!monetizationMap.product_lines || !monetizationMap.product_lines[productLine]) {
    fail(`Missing monetization product line '${productLine}'`);
  }
}
for (const tier of requiredTiers) {
  if (!monetizationMap.tiers || !monetizationMap.tiers[tier]) {
    fail(`Missing monetization tier '${tier}'`);
  }
  if (monetizationMap.tiers[tier].final_release_gate_required !== true) {
    fail(`Tier '${tier}' must require the final release gate`);
  }
}

for (const [targetName, target] of Object.entries(platformTargets.platform_targets || {})) {
  if (target.manual_only !== true) {
    fail(`Platform target '${targetName}' must remain manual_only`);
  }
  if (!Array.isArray(target.required_artifact_placeholders) || target.required_artifact_placeholders.length === 0) {
    fail(`Platform target '${targetName}' must define required_artifact_placeholders`);
  }
  if (!Array.isArray(target.supported_product_lines) || target.supported_product_lines.length === 0) {
    fail(`Platform target '${targetName}' must define supported_product_lines`);
  }
  if (!Array.isArray(target.supported_tiers) || target.supported_tiers.length === 0) {
    fail(`Platform target '${targetName}' must define supported_tiers`);
  }
}
NODE

echo "Phase 19 monetization policy verification passed"
