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

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
  if [[ "${PHASE11_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

PHASE11_DIR="$ROOT/workflows/recovery-assurance"
STARTUP_FILE="$ROOT/security/phase11-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"

REQUIRED_FILES=(
  "$PHASE11_DIR/recovery-schema.js"
  "$PHASE11_DIR/recovery-common.js"
  "$PHASE11_DIR/checkpoint-coordinator.js"
  "$PHASE11_DIR/backup-manifest-manager.js"
  "$PHASE11_DIR/backup-integrity-verifier.js"
  "$PHASE11_DIR/restore-orchestrator.js"
  "$PHASE11_DIR/continuity-slo-engine.js"
  "$PHASE11_DIR/chaos-drill-simulator.js"
  "$PHASE11_DIR/failover-readiness-validator.js"
  "$STARTUP_FILE"
  "$ROOT/scripts/create-recovery-checkpoint.js"
  "$ROOT/scripts/verify-backup-integrity.js"
  "$ROOT/scripts/execute-restore.js"
  "$ROOT/scripts/run-recovery-drill.js"
  "$ROOT/scripts/generate-phase11-artifacts.js"
  "$ROOT/scripts/verify-phase11-policy.sh"
  "$ROOT/tests/security/phase11-recovery-schema.test.js"
  "$ROOT/tests/security/phase11-checkpoint-coordinator.test.js"
  "$ROOT/tests/security/phase11-backup-manifest-manager.test.js"
  "$ROOT/tests/security/phase11-backup-integrity-verifier.test.js"
  "$ROOT/tests/security/phase11-restore-orchestrator.test.js"
  "$ROOT/tests/security/phase11-continuity-slo-engine.test.js"
  "$ROOT/tests/security/phase11-chaos-drill-simulator.test.js"
  "$ROOT/tests/security/phase11-failover-readiness-validator.test.js"
  "$ROOT/tests/security/phase11-policy-gate.test.js"
  "$ROOT/tests/security/phase11-startup-integrity.test.js"
  "$ROOT/docs/phase11-recovery-assurance.md"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 11 file: $file"
done

SCAN_TARGETS=(
  "$PHASE11_DIR"
  "$STARTUP_FILE"
)

NETWORK_HITS="$(search_lines "fetch\(|axios|https\\.request\(|http\\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\\.launch" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 11 modules must not include autonomous network/browser automation clients"
fi

AUTONOMY_HITS="$(search_lines "\\b(autoRestore|autonomousRestore|autoFailover|autonomousFailover|submitToPlatform|browserAutomation|loginAutomation|credentialStore|storeCredentials)\\b\\s*[(:=]" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 11 modules must not include autonomous restore/failover/login logic"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\(|new Date\(|Math\\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 11 modules"
fi

RESTORE_FILE="$PHASE11_DIR/restore-orchestrator.js"
search_quiet "approvalToken" "$RESTORE_FILE" || fail "Restore orchestrator missing approval token contract"
search_quiet "confirm" "$RESTORE_FILE" || fail "Restore orchestrator missing explicit confirmation contract"
search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$RESTORE_FILE" || fail "Restore orchestrator missing token consumption enforcement"
search_quiet "governance.recovery.restore" "$RESTORE_FILE" || fail "Restore orchestrator missing governance.recovery.restore scope enforcement"
if search_quiet "setTimeout\(|setInterval\(" "$RESTORE_FILE"; then
  fail "Restore orchestrator must not auto-execute by timer"
fi

RESTORE_SCRIPT="$ROOT/scripts/execute-restore.js"
search_quiet "--approval-token" "$RESTORE_SCRIPT" || fail "Restore CLI missing approval-token requirement"
search_quiet "--restore-request" "$RESTORE_SCRIPT" || fail "Restore CLI missing restore-request requirement"
search_quiet "--confirm" "$RESTORE_SCRIPT" || fail "Restore CLI missing confirm requirement"

for file in \
  "$PHASE11_DIR/continuity-slo-engine.js" \
  "$PHASE11_DIR/chaos-drill-simulator.js" \
  "$PHASE11_DIR/failover-readiness-validator.js"; do
  search_quiet "advisory_only" "$file" || fail "Phase 11 advisory-only marker missing in $file"
  search_quiet "auto_remediation_blocked" "$file" || fail "Phase 11 auto-remediation block marker missing in $file"
  if search_quiet "withGovernanceTransaction\(" "$file"; then
    fail "Advisory/read-only Phase 11 module must not mutate governance state: $file"
  fi
  if search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$file"; then
    fail "Advisory/read-only Phase 11 module must not consume approval tokens directly: $file"
  fi
  if search_quiet "executeRestore|initiateFailover|triggerFailover" "$file"; then
    fail "Advisory/read-only Phase 11 module must not trigger restore/failover: $file"
  fi
done

search_quiet "verifyPhase11StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase11 startup integrity hook"

echo "Phase 11 policy verification passed"
