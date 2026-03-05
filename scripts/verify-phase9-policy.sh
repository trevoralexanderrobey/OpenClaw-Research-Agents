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

PHASE9_DIR="$ROOT/workflows/governance-automation"
STARTUP_FILE="$ROOT/security/phase9-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
RUNTIME_POLICY_FILE="$ROOT/security/runtime-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
  if [[ "${PHASE9_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$PHASE9_DIR/compliance-monitor.js"
  "$PHASE9_DIR/policy-drift-detector.js"
  "$PHASE9_DIR/remediation-recommender.js"
  "$PHASE9_DIR/operator-override-ledger.js"
  "$PHASE9_DIR/phase-completeness-validator.js"
  "$PHASE9_DIR/phase9-baseline-contracts.js"
  "$STARTUP_FILE"
  "$ROOT/scripts/apply-operator-override.js"
  "$ROOT/scripts/apply-remediation-delta.js"
  "$ROOT/scripts/generate-phase9-artifacts.js"
  "$ROOT/tests/security/phase9-compliance-monitor.test.js"
  "$ROOT/tests/security/phase9-drift-detector.test.js"
  "$ROOT/tests/security/phase9-remediation-recommender.test.js"
  "$ROOT/tests/security/phase9-override-ledger.test.js"
  "$ROOT/tests/security/phase9-completeness-validator.test.js"
  "$ROOT/tests/security/phase9-policy-gate.test.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 9 file: $file"
done

SCAN_TARGETS=(
  "$PHASE9_DIR"
  "$STARTUP_FILE"
)

NETWORK_HITS="$(search_lines "fetch\(|axios|https\\.request\(|http\\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\\.launch" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 9 modules must not include network/browser automation clients"
fi

AUTONOMY_HITS="$(search_lines "\\b(autoSubmit|autonomousSubmit|submitToPlatform|browserAutomation|loginAutomation|credentialStore|storeCredentials)\\b\\s*[(:=]" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 9 modules must not include submission/login automation logic"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\(|Math\\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 9 modules"
fi

for file in \
  "$PHASE9_DIR/compliance-monitor.js" \
  "$PHASE9_DIR/policy-drift-detector.js" \
  "$PHASE9_DIR/remediation-recommender.js" \
  "$PHASE9_DIR/phase-completeness-validator.js"; do
  if search_quiet "withGovernanceTransaction\(" "$file"; then
    fail "Read-only Phase 9 module must not use governance transaction wrapper: $file"
  fi
  if search_quiet "consumeApprovalToken|consumeScopedApprovalToken" "$file"; then
    fail "Read-only Phase 9 module must not consume approval tokens: $file"
  fi
done

search_quiet "assertOperatorRole" "$PHASE9_DIR/operator-override-ledger.js" || fail "override-ledger missing operator role enforcement"
search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$PHASE9_DIR/operator-override-ledger.js" || fail "override-ledger missing approval-token checks"
search_quiet "withGovernanceTransaction\(" "$PHASE9_DIR/operator-override-ledger.js" || fail "override-ledger missing governance transaction wrapper"
search_quiet "verifyPhase9StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase9 startup integrity hook"

node - "$RUNTIME_POLICY_FILE" <<'NODE'
const loaded = require(process.argv[2]);
const policy = loaded && loaded.RUNTIME_POLICY ? loaded.RUNTIME_POLICY : loaded;
const determinism = policy && policy.determinism ? policy.determinism : {};
const version = Number(determinism.runtimeStateSchemaVersion || 0);
if (!Number.isFinite(version) || version < 8) {
  process.stderr.write(`runtimeStateSchemaVersion must be >= 8 (got ${version})\n`);
  process.exit(1);
}
NODE

echo "Phase 9 policy verification passed"
