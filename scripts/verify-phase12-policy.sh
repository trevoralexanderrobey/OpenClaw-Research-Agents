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
  if [[ "${PHASE12_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

PHASE12_DIR="$ROOT/workflows/supply-chain"
STARTUP_FILE="$ROOT/security/phase12-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"

REQUIRED_FILES=(
  "$PHASE12_DIR/supply-chain-schema.js"
  "$PHASE12_DIR/supply-chain-common.js"
  "$PHASE12_DIR/sbom-generator.js"
  "$PHASE12_DIR/dependency-integrity-verifier.js"
  "$PHASE12_DIR/build-provenance-attestor.js"
  "$PHASE12_DIR/dependency-update-governor.js"
  "$PHASE12_DIR/vulnerability-reporter.js"
  "$PHASE12_DIR/supply-chain-policy-engine.js"
  "$PHASE12_DIR/artifact-signing-manager.js"
  "$STARTUP_FILE"
  "$ROOT/scripts/generate-sbom.js"
  "$ROOT/scripts/verify-dependency-integrity.js"
  "$ROOT/scripts/generate-build-provenance.js"
  "$ROOT/scripts/approve-dependency-update.js"
  "$ROOT/scripts/scan-vulnerabilities.js"
  "$ROOT/scripts/sign-artifact.js"
  "$ROOT/scripts/verify-artifact-signature.js"
  "$ROOT/scripts/generate-phase12-artifacts.js"
  "$ROOT/scripts/verify-phase12-policy.sh"
  "$ROOT/security/known-good-dependencies.json"
  "$ROOT/security/vulnerability-advisories.json"
  "$ROOT/security/artifact-signing-key.sample.json"
  "$ROOT/security/supply-chain-policy.json"
  "$ROOT/tests/security/phase12-supply-chain-schema.test.js"
  "$ROOT/tests/security/phase12-sbom-generator.test.js"
  "$ROOT/tests/security/phase12-dependency-integrity-verifier.test.js"
  "$ROOT/tests/security/phase12-build-provenance-attestor.test.js"
  "$ROOT/tests/security/phase12-dependency-update-governor.test.js"
  "$ROOT/tests/security/phase12-vulnerability-reporter.test.js"
  "$ROOT/tests/security/phase12-supply-chain-policy-engine.test.js"
  "$ROOT/tests/security/phase12-artifact-signing-manager.test.js"
  "$ROOT/tests/security/phase12-policy-gate.test.js"
  "$ROOT/tests/security/phase12-startup-integrity.test.js"
  "$ROOT/docs/phase12-supply-chain-security.md"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 12 file: $file"
done

SCAN_TARGETS=(
  "$PHASE12_DIR"
  "$STARTUP_FILE"
)

NETWORK_HITS="$(search_lines "fetch\(|axios|https\\.request\(|http\\.request\(|node:https|node:http|registry\\.npmjs|child_process\\.exec\\(|child_process\\.spawn\\(|playwright|puppeteer|selenium|webdriver|browser\\.launch" "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 12 modules must not include network, registry, or browser automation clients"
fi

AUTONOMY_HITS="$(search_lines "\\b(autoUpdate|autonomousUpdate|autoPatch|autonomousPatch|npm install|pnpm add|yarn add|autoInstall|autoRemediate|selfHealDependency)\\b" "${SCAN_TARGETS[@]}")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 12 modules must not include autonomous dependency update/patch/install logic"
fi

RESTRICTED_GLOBALS="$(search_lines "Date\\.now\(|new Date\(|Math\\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}")"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 12 modules"
fi

UPDATE_FILE="$PHASE12_DIR/dependency-update-governor.js"
search_quiet "approvalToken" "$UPDATE_FILE" || fail "Dependency update governor missing approval token contract"
search_quiet "confirm" "$UPDATE_FILE" || fail "Dependency update governor missing explicit confirmation contract"
search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$UPDATE_FILE" || fail "Dependency update governor missing token consumption enforcement"
search_quiet "governance.supply_chain.update" "$UPDATE_FILE" || fail "Dependency update governor missing governance.supply_chain.update scope enforcement"
if search_quiet "setTimeout\(|setInterval\(" "$UPDATE_FILE"; then
  fail "Dependency update governor must not auto-execute by timer"
fi

APPROVE_SCRIPT="$ROOT/scripts/approve-dependency-update.js"
search_quiet "--approval-token" "$APPROVE_SCRIPT" || fail "approve-dependency-update CLI missing --approval-token requirement"
search_quiet "--update-request" "$APPROVE_SCRIPT" || fail "approve-dependency-update CLI missing --update-request requirement"
search_quiet "--confirm" "$APPROVE_SCRIPT" || fail "approve-dependency-update CLI missing --confirm requirement"

VULN_FILE="$PHASE12_DIR/vulnerability-reporter.js"
search_quiet "advisory_only" "$VULN_FILE" || fail "Vulnerability reporter missing advisory_only marker"
search_quiet "auto_patch_blocked" "$VULN_FILE" || fail "Vulnerability reporter missing auto_patch_blocked marker"
if search_quiet "npm install|autoPatch|applyPatch|patchDependency" "$VULN_FILE"; then
  fail "Vulnerability reporter must remain advisory-only and must not patch dependencies"
fi

for file in \
  "$PHASE12_DIR/sbom-generator.js" \
  "$PHASE12_DIR/build-provenance-attestor.js" \
  "$PHASE12_DIR/artifact-signing-manager.js"; do
  if search_quiet "withGovernanceTransaction\(" "$file"; then
    fail "Read-only supply chain module must not mutate governance state: $file"
  fi
  if search_quiet "consumeScopedApprovalToken|consumeApprovalToken" "$file"; then
    fail "Read-only supply chain module must not consume approval tokens: $file"
  fi
  if search_quiet "npm install|pnpm add|yarn add" "$file"; then
    fail "Read-only supply chain module must not install or update dependencies: $file"
  fi
done

search_quiet "verifyPhase12StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase12 startup integrity hook"

echo "Phase 12 policy verification passed"
