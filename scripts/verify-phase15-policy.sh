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
  if [[ "${PHASE15_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/config/agent-topology.json"
  "$ROOT/config/autonomy-ladder.json"
  "$ROOT/openclaw-bridge/core/agent-registry.js"
  "$ROOT/openclaw-bridge/core/role-router.js"
  "$ROOT/openclaw-bridge/core/lane-queue.js"
  "$ROOT/openclaw-bridge/core/comms-bus.js"
  "$ROOT/openclaw-bridge/core/autonomy-ladder.js"
  "$ROOT/openclaw-bridge/core/heartbeat-state.js"
  "$ROOT/scripts/verify-phase15-policy.sh"
  "$ROOT/tests/security/phase15-policy-gate.test.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 15 file: $file"
done

for dir in "$ROOT/workspace/comms/inbox" "$ROOT/workspace/comms/outbox" "$ROOT/workspace/comms/blackboard" "$ROOT/workspace/comms/events"; do
  [[ -d "$dir" ]] || fail "Missing Phase 15 comms directory: $dir"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/core/agent-registry.js"
  "$ROOT/openclaw-bridge/core/role-router.js"
  "$ROOT/openclaw-bridge/core/lane-queue.js"
  "$ROOT/openclaw-bridge/core/comms-bus.js"
  "$ROOT/openclaw-bridge/core/autonomy-ladder.js"
  "$ROOT/openclaw-bridge/core/heartbeat-state.js"
)

NETWORK_HITS="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|\bnet\b|node:net|\btls\b|node:tls|WebSocket' "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 15 modules must remain network-free"
fi

search_quiet 'context\.supervisorDecision' "$ROOT/openclaw-bridge/core/role-router.js" || fail "role-router missing supervisor mediation marker"
search_quiet 'SUPERVISOR_APPROVAL_REQUIRED' "$ROOT/openclaw-bridge/core/role-router.js" || fail "role-router missing fail-closed supervisor denial marker"
search_quiet 'queue_sequence' "$ROOT/openclaw-bridge/core/lane-queue.js" || fail "lane-queue missing deterministic sequence marker"
search_quiet 'sort\(' "$ROOT/openclaw-bridge/core/lane-queue.js" || fail "lane-queue missing deterministic ordering marker"
search_quiet 'writeAtomic' "$ROOT/openclaw-bridge/core/comms-bus.js" || fail "comms-bus missing atomic write marker"

echo "Phase 15 policy verification passed"
