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
  if [[ "${PHASE16_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

REQUIRED_FILES=(
  "$ROOT/integrations/mcp/mcp-client.js"
  "$ROOT/integrations/mcp/arxiv-client.js"
  "$ROOT/integrations/mcp/semantic-scholar-client.js"
  "$ROOT/workflows/research-ingestion/ingestion-pipeline.js"
  "$ROOT/workflows/research-ingestion/normalizer.js"
  "$ROOT/workflows/research-ingestion/citation-metrics.js"
  "$ROOT/workflows/research-ingestion/source-ledger.js"
  "$ROOT/scripts/verify-phase16-policy.sh"
  "$ROOT/tests/security/phase16-policy-gate.test.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 16 file: $file"
done

SCAN_TARGETS=(
  "$ROOT/openclaw-bridge/core"
  "$ROOT/integrations/mcp"
  "$ROOT/workflows/research-ingestion"
  "$ROOT/openclaw-bridge/state"
)

NETWORK_HITS="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket' "${SCAN_TARGETS[@]}")"
if [[ -n "$NETWORK_HITS" ]]; then
  DISALLOWED="$(printf '%s\n' "$NETWORK_HITS" | grep -vE 'openclaw-bridge/core/llm-adapter\.js|integrations/mcp/' || true)"
  if [[ -n "$DISALLOWED" ]]; then
    echo "$DISALLOWED" >&2
    fail "Phase 16 network isolation violation: only integrations/mcp/* and openclaw-bridge/core/llm-adapter.js may perform network calls"
  fi
fi

AUTONOMY_HITS="$(search_lines '\\bpublish\\b|submitToPlatform|autonomousPublish|browser\\.launch|\\blogin\\b' "$ROOT/workflows/research-ingestion")"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 16 ingestion modules must not include autonomous publish/login paths"
fi

echo "Phase 16 policy verification passed"
