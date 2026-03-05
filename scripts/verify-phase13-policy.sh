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
  if [[ "${PHASE13_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

PHASE13_DIR="$ROOT/workflows/access-control"
STARTUP_FILE="$ROOT/security/phase13-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
TOKEN_MANAGER_FILE="$PHASE13_DIR/token-lifecycle-manager.js"
ENFORCER_FILE="$PHASE13_DIR/permission-boundary-enforcer.js"
ESCALATION_FILE="$PHASE13_DIR/privilege-escalation-detector.js"
LEDGER_FILE="$PHASE13_DIR/access-decision-ledger.js"
SESSION_FILE="$PHASE13_DIR/session-governance-manager.js"
LEGACY_BRIDGE_FILE="$PHASE13_DIR/legacy-access-bridge.js"

PHASE13_CLI_FILES=(
  "$ROOT/scripts/_phase13-access-utils.js"
  "$ROOT/scripts/issue-token.js"
  "$ROOT/scripts/rotate-token.js"
  "$ROOT/scripts/revoke-token.js"
  "$ROOT/scripts/validate-token.js"
  "$ROOT/scripts/list-active-tokens.js"
  "$ROOT/scripts/create-session.js"
  "$ROOT/scripts/validate-session.js"
  "$ROOT/scripts/check-access.js"
  "$ROOT/scripts/detect-escalation.js"
  "$ROOT/scripts/generate-phase13-artifacts.js"
)

REQUIRED_FILES=(
  "$PHASE13_DIR/access-control-schema.js"
  "$PHASE13_DIR/access-control-common.js"
  "$PHASE13_DIR/role-permission-registry.js"
  "$PHASE13_DIR/scope-registry.js"
  "$PHASE13_DIR/token-lifecycle-manager.js"
  "$PHASE13_DIR/access-decision-ledger.js"
  "$PHASE13_DIR/permission-boundary-enforcer.js"
  "$PHASE13_DIR/privilege-escalation-detector.js"
  "$PHASE13_DIR/session-governance-manager.js"
  "$PHASE13_DIR/legacy-access-bridge.js"
  "$STARTUP_FILE"
  "$ROOT/security/rbac-policy.json"
  "$ROOT/security/scope-registry.json"
  "$ROOT/security/token-store.sample.json"
  "$ROOT/scripts/verify-phase13-policy.sh"
  "$ROOT/tests/security/phase13-access-control-schema.test.js"
  "$ROOT/tests/security/phase13-role-permission-registry.test.js"
  "$ROOT/tests/security/phase13-scope-registry.test.js"
  "$ROOT/tests/security/phase13-token-lifecycle-manager.test.js"
  "$ROOT/tests/security/phase13-permission-boundary-enforcer.test.js"
  "$ROOT/tests/security/phase13-privilege-escalation-detector.test.js"
  "$ROOT/tests/security/phase13-access-decision-ledger.test.js"
  "$ROOT/tests/security/phase13-session-governance-manager.test.js"
  "$ROOT/tests/security/phase13-policy-gate.test.js"
  "$ROOT/tests/security/phase13-startup-integrity.test.js"
)

for file in "${PHASE13_CLI_FILES[@]}"; do
  REQUIRED_FILES+=("$file")
done

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 13 file: $file"
done

SCAN_TARGETS=(
  "$PHASE13_DIR"
  "$STARTUP_FILE"
  "${PHASE13_CLI_FILES[@]}"
)

NETWORK_HITS="$(search_lines "fetch\\(|axios|http\\.request\\(|https\\.request\\(|node:http|node:https|[^a-zA-Z0-9_]net[^a-zA-Z0-9_]|node:net|[^a-zA-Z0-9_]tls[^a-zA-Z0-9_]|node:tls|WebSocket" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 13 modules must not include network clients or sockets"
fi

AUTH_HITS="$(search_lines "oauth|ldap|openid|saml|idp|okta|auth0|passport" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTH_HITS" ]]; then
  echo "$AUTH_HITS" >&2
  fail "Phase 13 modules must not include external identity provider integrations"
fi

BROWSER_HITS="$(search_lines "playwright|puppeteer|selenium|webdriver|browser\\.launch|login\\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$BROWSER_HITS" ]]; then
  echo "$BROWSER_HITS" >&2
  fail "Phase 13 modules must not include browser/login automation"
fi

AUTONOMY_HITS="$(search_lines "autoIssue|autonomousIssue|autoRotate|autonomousRotate|autoRevoke|autonomousRevoke|autoCreateSession|autonomousSession" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 13 modules must not include autonomous token/session lifecycle behavior"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\\(|new Date\\(|Math\\.random\\(|randomUUID\\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 13 modules"
fi

search_quiet "withGovernanceTransaction\\(" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing governance transaction wrapper"
search_quiet "missing_confirm" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing explicit confirmation rejection"
search_quiet "ensureOperatorContext" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing operator initiation enforcement"
search_quiet "governance.token.issue" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing token issue scope marker"
search_quiet "governance.token.rotate" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing token rotate scope marker"
search_quiet "governance.token.revoke" "$TOKEN_MANAGER_FILE" || fail "Token lifecycle manager missing token revoke scope marker"

search_quiet "advisory_only" "$ESCALATION_FILE" || fail "Escalation detector missing advisory_only marker"
search_quiet "auto_revoke_blocked" "$ESCALATION_FILE" || fail "Escalation detector missing auto_revoke_blocked marker"

search_quiet "deny_unknown_role" "$ENFORCER_FILE" || fail "Permission boundary enforcer missing unknown-role fail-closed marker"
search_quiet "deny_unknown_scope" "$ENFORCER_FILE" || fail "Permission boundary enforcer missing unknown-scope fail-closed marker"
search_quiet "deny_expired_token" "$ENFORCER_FILE" || fail "Permission boundary enforcer missing expired-token fail-closed marker"
search_quiet "deny_revoked_token" "$ENFORCER_FILE" || fail "Permission boundary enforcer missing revoked-token fail-closed marker"

search_quiet "token_revoked" "$SESSION_FILE" || fail "Session manager missing token revoked fail-closed marker"
search_quiet "token_expired" "$SESSION_FILE" || fail "Session manager missing token expired fail-closed marker"
search_quiet "validateSession" "$SESSION_FILE" || fail "Session manager missing validation contract"

search_quiet "prev_chain_hash" "$LEDGER_FILE" || fail "Access decision ledger missing prev_chain_hash marker"
search_quiet "chain_hash" "$LEDGER_FILE" || fail "Access decision ledger missing chain_hash marker"
search_quiet "verifyChainIntegrity" "$LEDGER_FILE" || fail "Access decision ledger missing verifyChainIntegrity contract"

search_quiet "LEGACY_PROTECTED_CALL_PATHS" "$LEGACY_BRIDGE_FILE" || fail "Legacy bridge missing protected call path allowlist marker"
search_quiet "allow_legacy_admin_fallback" "$LEGACY_BRIDGE_FILE" || fail "Legacy bridge missing explicit legacy admin fallback marker"
search_quiet "deny_missing_approval_token" "$LEGACY_BRIDGE_FILE" || fail "Legacy bridge missing missing-token fail-closed marker"

search_quiet "verifyPhase13StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase13 startup integrity hook"

GITIGNORE_FILE="$ROOT/.gitignore"
[[ -f "$GITIGNORE_FILE" ]] || fail "Missing .gitignore"

RUNTIME_FILES=(
  "security/token-store.json"
  "security/access-decision-ledger.json"
  "security/session-store.json"
)

for rel in "${RUNTIME_FILES[@]}"; do
  search_quiet "^${rel}$" "$GITIGNORE_FILE" || fail "Runtime file must be gitignored: ${rel}"

done

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for rel in "${RUNTIME_FILES[@]}"; do
    if git -C "$ROOT" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
      fail "Runtime file must not be committed: ${rel}"
    fi
  done
fi

echo "Phase 13 policy verification passed"
