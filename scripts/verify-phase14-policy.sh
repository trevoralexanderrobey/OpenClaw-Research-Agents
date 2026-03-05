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
  if [[ "${PHASE14_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/config/agent-config.json"
  "$ROOT/config/llm-providers.json"
  "$ROOT/openclaw-bridge/core/agent-engine.js"
  "$ROOT/openclaw-bridge/core/governance-bridge.js"
  "$ROOT/openclaw-bridge/core/supervisor-authority.js"
  "$ROOT/openclaw-bridge/core/llm-adapter.js"
  "$ROOT/openclaw-bridge/core/interaction-log.js"
  "$ROOT/openclaw-bridge/core/task-definition-schema.js"
  "$ROOT/openclaw-bridge/core/research-output-manager.js"
  "$ROOT/security/phase14-startup-integrity.js"
  "$ROOT/scripts/run-research-task.js"
  "$ROOT/scripts/verify-phase14-policy.sh"
  "$ROOT/tests/security/phase14-policy-gate.test.js"
  "$ROOT/tests/security/phase14-startup-integrity.test.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 14 file: $file"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/core/agent-engine.js"
  "$ROOT/openclaw-bridge/core/governance-bridge.js"
  "$ROOT/openclaw-bridge/core/supervisor-authority.js"
  "$ROOT/openclaw-bridge/core/interaction-log.js"
  "$ROOT/openclaw-bridge/core/task-definition-schema.js"
  "$ROOT/openclaw-bridge/core/research-output-manager.js"
  "$ROOT/security/phase14-startup-integrity.js"
)

NETWORK_HITS="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|\bnet\b|node:net|\btls\b|node:tls|WebSocket' "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 14 network isolation violation: network calls are only allowed in llm-adapter.js"
fi

search_quiet 'complete\(' "$ROOT/openclaw-bridge/core/llm-adapter.js" || fail "llm-adapter missing completion contract"
search_quiet 'context\.supervisorDecision' "$ROOT/openclaw-bridge/core/agent-engine.js" || fail "agent-engine missing supervisor decision requirement marker"
search_quiet 'SUPERVISOR_APPROVAL_REQUIRED' "$ROOT/openclaw-bridge/core/agent-engine.js" || fail "agent-engine missing bypass fail-closed marker"
search_quiet 'requestSupervisorApproval' "$ROOT/openclaw-bridge/core/governance-bridge.js" || fail "governance-bridge missing supervisor approval contract"
search_quiet 'runApprovedTask\(' "$ROOT/scripts/run-research-task.js" || fail "run-research-task must route through supervisor authority"
search_quiet 'requestSupervisorApproval' "$ROOT/scripts/run-research-task.js" || fail "run-research-task missing supervisor mediation"
search_quiet 'verifyPhase14StartupIntegrity' "$ROOT/openclaw-bridge/mcp/mcp-service.js" || fail "mcp-service missing phase14 startup integrity hook"

for rel in "config/llm-providers.local.json" "security/interaction-log.json"; do
  search_quiet "^${rel}$" "$ROOT/.gitignore" || fail "Runtime file must be gitignored: ${rel}"
done

if ! search_quiet '^workspace/research-output/\*$' "$ROOT/.gitignore"; then
  fail "workspace/research-output/* must be gitignored"
fi
if ! search_quiet '^!workspace/research-output/\.gitkeep$' "$ROOT/.gitignore"; then
  fail "workspace/research-output/.gitkeep exception missing in .gitignore"
fi

echo "Phase 14 policy verification passed"
