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
  if [[ "${PHASE17_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
  "$ROOT/openclaw-bridge/execution/tool-image-catalog.js"
  "$ROOT/openclaw-bridge/execution/container-runtime.js"
  "$ROOT/openclaw-bridge/state/persistent-store.js"
  "$ROOT/openclaw-bridge/state/state-hydrator.js"
  "$ROOT/openclaw-bridge/state/open-loop-manager.js"
  "$ROOT/openclaw-bridge/core/restart-resume-orchestrator.js"
  "$ROOT/state/runtime/state.sample.json"
  "$ROOT/scripts/verify-phase17-policy.sh"
  "$ROOT/tests/security/phase17-policy-gate.test.js"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 17 file: $file"
done

search_quiet 'BUILTIN_TOOL_IMAGES' "$ROOT/openclaw-bridge/execution/tool-image-catalog.js" || fail "tool-image-catalog missing allowlist marker"
search_quiet 'validateToolImagePolicy' "$ROOT/openclaw-bridge/execution/tool-image-catalog.js" || fail "tool-image-catalog missing validation contract"
search_quiet 'runToolInContainer' "$ROOT/openclaw-bridge/execution/container-runtime.js" || fail "container-runtime missing runToolInContainer contract"
search_quiet 'getRuntimePolicy' "$ROOT/openclaw-bridge/execution/container-runtime.js" || fail "container-runtime missing getRuntimePolicy contract"
search_quiet 'assertContainerSecurityConfig' "$ROOT/openclaw-bridge/execution/container-runtime.js" || fail "container-runtime missing runtime isolation marker"
search_quiet 'PHASE17_RUNTIME_STATE_VERSION' "$ROOT/openclaw-bridge/state/persistent-store.js" || fail "persistent-store missing phase17 schema marker"
search_quiet 'registerOpenLoop' "$ROOT/openclaw-bridge/state/persistent-store.js" || fail "persistent-store missing open loop registration marker"
search_quiet 'resolveOpenLoop' "$ROOT/openclaw-bridge/state/persistent-store.js" || fail "persistent-store missing open loop resolve marker"
search_quiet 'resumePendingWork' "$ROOT/openclaw-bridge/core/restart-resume-orchestrator.js" || fail "restart-resume-orchestrator missing resume contract"

UNSAFE_HITS="$(search_lines 'child_process\\.exec|child_process\\.spawn|docker run' "$ROOT/openclaw-bridge/execution/container-runtime.js")"
if [[ -n "$UNSAFE_HITS" ]]; then
  echo "$UNSAFE_HITS" >&2
  fail "Phase 17 runtime must not include direct unsafe container shell execution paths"
fi

echo "Phase 17 policy verification passed"
