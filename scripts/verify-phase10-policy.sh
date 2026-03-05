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
  if [[ "${PHASE10_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

PHASE10_OBS_DIR="$ROOT/workflows/observability"
PHASE10_RUNBOOK_DIR="$ROOT/workflows/runbook-automation"
PHASE10_INCIDENT_DIR="$ROOT/workflows/incident-management"
PHASE10_ATTEST_DIR="$ROOT/workflows/attestation"
STARTUP_FILE="$ROOT/security/phase10-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
RUNTIME_POLICY_FILE="$ROOT/security/runtime-policy.js"

REQUIRED_FILES=(
  "$PHASE10_OBS_DIR/metrics-schema.js"
  "$PHASE10_OBS_DIR/telemetry-emitter.js"
  "$PHASE10_OBS_DIR/slo-alert-engine.js"
  "$PHASE10_OBS_DIR/alert-router.js"
  "$PHASE10_OBS_DIR/operational-decision-ledger.js"
  "$PHASE10_RUNBOOK_DIR/runbook-orchestrator.js"
  "$PHASE10_INCIDENT_DIR/incident-artifact-creator.js"
  "$PHASE10_INCIDENT_DIR/escalation-orchestrator.js"
  "$PHASE10_ATTEST_DIR/external-attestation-anchor.js"
  "$STARTUP_FILE"
  "$ROOT/security/phase10-attestation-egress-allowlist.json"
  "$ROOT/scripts/runbook-orchestrator.js"
  "$ROOT/scripts/incident-trigger.sh"
  "$ROOT/scripts/external-attestation-anchor.js"
  "$ROOT/scripts/generate-phase10-artifacts.js"
  "$ROOT/scripts/verify-phase10-policy.sh"
  "$ROOT/tests/security/phase10-metrics-schema.test.js"
  "$ROOT/tests/security/phase10-telemetry-emitter.test.js"
  "$ROOT/tests/security/phase10-slo-alert-engine.test.js"
  "$ROOT/tests/security/phase10-runbook-orchestrator.test.js"
  "$ROOT/tests/security/phase10-alert-router.test.js"
  "$ROOT/tests/security/phase10-incident-artifact-creator.test.js"
  "$ROOT/tests/security/phase10-escalation-orchestrator.test.js"
  "$ROOT/tests/security/phase10-external-attestation-anchor.test.js"
  "$ROOT/tests/security/phase10-policy-gate.test.js"
  "$ROOT/tests/security/phase10-startup-integrity.test.js"
  "$ROOT/docs/phase10-operational-runbook.md"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 10 file: $file"
done

SCAN_TARGETS=(
  "$PHASE10_OBS_DIR"
  "$PHASE10_RUNBOOK_DIR"
  "$PHASE10_INCIDENT_DIR"
  "$PHASE10_ATTEST_DIR"
  "$STARTUP_FILE"
)

NETWORK_HITS="$(search_lines "fetch\(|axios|https\\.request\(|http\\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\\.launch" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 10 workflow modules must not include autonomous network/browser automation clients"
fi

AUTONOMY_HITS="$(search_lines "\\b(autoSubmit|autonomousSubmit|submitToPlatform|browserAutomation|loginAutomation|credentialStore|storeCredentials)\\b\\s*[(:=]" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 10 modules must not include autonomous submission/login logic"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\(|new Date\(|Math\\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 10 modules"
fi

RUNBOOK_FILE="$PHASE10_RUNBOOK_DIR/runbook-orchestrator.js"
search_quiet "approvalToken" "$RUNBOOK_FILE" || fail "Runbook orchestrator missing approval token contract"
search_quiet "confirm" "$RUNBOOK_FILE" || fail "Runbook orchestrator missing explicit confirmation contract"
search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$RUNBOOK_FILE" || fail "Runbook orchestrator missing token consumption enforcement"
if search_quiet "setTimeout\(|setInterval\(" "$RUNBOOK_FILE"; then
  fail "Runbook orchestrator must not auto-execute by timer"
fi

ATT_SCRIPT="$ROOT/scripts/external-attestation-anchor.js"
search_quiet "--approval-token" "$ATT_SCRIPT" || fail "External attestation CLI missing approval-token requirement"
search_quiet "--external-service" "$ATT_SCRIPT" || fail "External attestation CLI missing explicit external-service requirement"
search_quiet "--confirm" "$ATT_SCRIPT" || fail "External attestation CLI missing confirm requirement"

ATT_WORKFLOW="$PHASE10_ATTEST_DIR/external-attestation-anchor.js"
search_quiet "governance.attestation.anchor" "$ATT_WORKFLOW" || fail "External attestation workflow missing required scope enforcement"
search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$ATT_WORKFLOW" || fail "External attestation workflow missing approval-token consumption"
search_quiet "resolveAllowedHosts|allowed_hosts" "$ATT_WORKFLOW" || fail "External attestation workflow missing static allowlist gating"
search_quiet "extractHostFromUrl" "$ATT_WORKFLOW" || fail "External attestation workflow missing explicit URL host validation"

ALERT_ROUTER_FILE="$PHASE10_OBS_DIR/alert-router.js"
ESCALATION_FILE="$PHASE10_INCIDENT_DIR/escalation-orchestrator.js"
INCIDENT_FILE="$PHASE10_INCIDENT_DIR/incident-artifact-creator.js"

for file in "$ALERT_ROUTER_FILE" "$ESCALATION_FILE" "$INCIDENT_FILE"; do
  search_quiet "advisory_only" "$file" || fail "Phase 10 advisory-only marker missing in $file"
  search_quiet "auto_remediation_blocked" "$file" || fail "Phase 10 auto-remediation block marker missing in $file"
  if search_quiet "apply-remediation-delta|executeRunbookAction|commitPublication|preparePublication" "$file"; then
    fail "Advisory module must not trigger remediation/mutation flows: $file"
  fi
  if search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$file"; then
    fail "Advisory module must not consume operator approval tokens directly: $file"
  fi
done

for file in "$PHASE10_OBS_DIR/metrics-schema.js" "$PHASE10_OBS_DIR/slo-alert-engine.js"; do
  if search_quiet "withGovernanceTransaction\(" "$file"; then
    fail "Read-only observability module must not mutate governance state: $file"
  fi
  if search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$file"; then
    fail "Read-only observability module must not consume approval tokens: $file"
  fi
done

search_quiet "verifyPhase10StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase10 startup integrity hook"

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

echo "Phase 10 policy verification passed"
