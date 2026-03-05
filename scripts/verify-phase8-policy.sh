#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SELF_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || {
        echo "ERROR: --root requires a path argument" >&2
        exit 1
      }
      ROOT="$(cd "$2" && pwd)"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

PHASE8_DIR="$ROOT/workflows/compliance-governance"
EXPLAIN_DIR="$ROOT/analytics/compliance-explainability"
STARTUP_FILE="$ROOT/security/phase8-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
  if [[ "${PHASE8_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
    return 1
  fi
  command -v rg >/dev/null 2>&1
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

search_quiet() {
  local pattern="$1"
  local file_path="$2"
  if has_rg; then
    rg -q -- "$pattern" "$file_path"
    return
  fi
  grep -Eq -- "$pattern" "$file_path"
}

REQUIRED_FILES=(
  "$PHASE8_DIR/compliance-schema.js"
  "$PHASE8_DIR/compliance-validator.js"
  "$PHASE8_DIR/runtime-attestation-engine.js"
  "$PHASE8_DIR/evidence-bundle-builder.js"
  "$PHASE8_DIR/release-gate-governor.js"
  "$PHASE8_DIR/compliance-decision-ledger.js"
  "$EXPLAIN_DIR/gate-rationale.js"
  "$EXPLAIN_DIR/attestation-explainer.js"
  "$STARTUP_FILE"
  "$ROOT/scripts/migrate-state-v7-to-v8.js"
  "$ROOT/scripts/generate-phase8-artifacts.js"
  "$ROOT/scripts/verify-phase8-ci-health.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 8 file: $file"
done

SCAN_TARGETS=("$PHASE8_DIR" "$EXPLAIN_DIR" "$STARTUP_FILE")

NETWORK_HITS="$(search_lines "fetch\(|axios|https\\.request\(|http\\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\\.launch" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 8 modules must not include network/browser automation clients"
fi

AUTONOMY_HITS="$(search_lines "\\b(autoSubmit|autonomousSubmit|submitToPlatform|browserAutomation|loginAutomation|credentialStore|storeCredentials)\\b\\s*[(:=]" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 8 modules must not include submission/login automation logic"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\(|new Date\(|Math\\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 8 modules"
fi

for file in \
  "$PHASE8_DIR/runtime-attestation-engine.js" \
  "$PHASE8_DIR/evidence-bundle-builder.js" \
  "$PHASE8_DIR/release-gate-governor.js"; do
  search_quiet "approvalToken" "$file" || fail "Missing approvalToken contract in $file"
  search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$file" || fail "Missing approval token consumption in $file"
  search_quiet "assertOperatorRole" "$file" || fail "Missing operator role enforcement in $file"
  search_quiet "assertKillSwitchOpen" "$file" || fail "Missing kill-switch enforcement in $file"
  search_quiet "withGovernanceTransaction\(" "$file" || fail "Missing governance transaction wrapper in $file"
done

search_quiet "assertOperatorRole" "$PHASE8_DIR/release-gate-governor.js" || fail "Release gate governor missing operator role denial"
search_quiet "buildReleaseGateIdempotencyFingerprint" "$PHASE8_DIR/release-gate-governor.js" || fail "Release gate governor missing idempotency fingerprint use"
search_quiet "verifyComplianceDecisionIntegrity" "$PHASE8_DIR/release-gate-governor.js" || fail "Release gate governor missing decision ledger integrity check"
search_quiet "verifyComplianceDecisionIntegrity" "$STARTUP_FILE" || fail "Startup integrity module missing decision ledger verification"
search_quiet "verifyPhase8StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase8 startup integrity hook"

search_quiet "runtimeStateSchemaVersion: 8" "$ROOT/security/runtime-policy.js" || fail "runtime policy missing schema v8 target"

node - "$EGRESS_FILE" <<'NODE'
const policy = require(process.argv[2]);
const allowed = new Set(["api.semanticscholar.org", "export.arxiv.org", "api.beehiiv.com", "api.notion.com"]);
const seen = new Set();
for (const [slug, value] of Object.entries(policy.TOOL_EGRESS_POLICIES || {})) {
  if (!value || typeof value !== "object") continue;
  const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : [];
  for (const host of hosts) {
    const normalized = String(host || "").trim().toLowerCase();
    if (!normalized) continue;
    seen.add(normalized);
    if (!allowed.has(normalized)) {
      process.stderr.write(`Unexpected egress domain detected (${slug}): ${normalized}\n`);
      process.exit(1);
    }
  }
}
if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
  process.stderr.write(`Egress allowlist set mismatch. seen=${JSON.stringify([...seen].sort())}\n`);
  process.exit(1);
}
NODE

echo "Phase 8 policy verification passed"
