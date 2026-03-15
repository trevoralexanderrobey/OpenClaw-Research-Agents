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
  if [[ "${PHASE26_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
    rg -n --glob '*.js' --glob '*.ts' --glob '*.sh' -- "$pattern" "$@" || true
    return
  fi
  grep -R -nE --include='*.js' --include='*.ts' --include='*.sh' -- "$pattern" "$@" || true
}

REQUIRED_FILES=(
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/docs/phase26-bridge-runtime-and-execution-routing.md"
  "$ROOT/openclaw-bridge/bridge/bridge-routing.js"
  "$ROOT/openclaw-bridge/bridge/bridge-auth.js"
  "$ROOT/openclaw-bridge/bridge/server.ts"
  "$ROOT/tests/security/phase26-bridge-routing.test.js"
  "$ROOT/tests/security/phase26-bridge-auth.test.js"
  "$ROOT/tests/security/phase26-policy-gate.test.js"
  "$ROOT/scripts/verify-phase26-policy.sh"
  "$ROOT/scripts/build-verify.sh"
  "$ROOT/package.json"
  "$ROOT/.github/workflows/ci-enforcement.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 26A file: $file"
done

search_quiet 'Phase 26A' "$ROOT/docs/phase26-bridge-runtime-and-execution-routing.md" || fail "Phase 26A doc must define minimal-slice scope"
search_quiet '/mcp' "$ROOT/openclaw-bridge/bridge/server.ts" || fail "bridge server must expose /mcp streamable endpoint"
search_quiet 'createBridgePrincipalResolver' "$ROOT/openclaw-bridge/bridge/server.ts" || fail "bridge server must use shared principal resolver"
search_quiet 'integration_hatchify' "$ROOT/openclaw-bridge/bridge/bridge-auth.js" || fail "bridge auth must include integration_hatchify lane separation"
search_quiet '/mcp/events' "$ROOT/openclaw-bridge/bridge/bridge-routing.js" || fail "legacy /mcp/events route alias must remain mapped"
search_quiet '/operator/mcp/messages' "$ROOT/openclaw-bridge/bridge/bridge-routing.js" || fail "operator MCP route must remain explicit"

UNSAFE_PHASE26="$(search_lines 'workspace/operator-briefs/sider|approved-response|reentry-manifest' \
  "$ROOT/openclaw-bridge/bridge/bridge-auth.js" \
  "$ROOT/openclaw-bridge/bridge/bridge-routing.js" \
  "$ROOT/openclaw-bridge/bridge/server.ts")"
if [[ -n "$UNSAFE_PHASE26" ]]; then
  echo "$UNSAFE_PHASE26" >&2
  fail "Phase 26A must not implement Sider export/re-entry or browser/login automation features"
fi

search_quiet 'verify-phase26-policy\.sh' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must include verify-phase26-policy.sh"
search_quiet 'phase26:verify' "$ROOT/package.json" || fail "package.json must define phase26:verify"
search_quiet 'verify-phase26-policy\.sh' "$ROOT/package.json" || fail "package scripts must invoke verify-phase26-policy.sh"
search_quiet 'npm run phase26:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run phase26:verify"

ROOT_DIR="$ROOT" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const root = process.env.ROOT_DIR;
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const buildVerify = fs.readFileSync(path.join(root, "scripts", "build-verify.sh"), "utf8");

if (!packageJson.scripts || !packageJson.scripts["phase26:verify"]) {
  fail("phase26:verify script is missing");
}
for (const name of ["phase2:gates"]) {
  const body = String(packageJson.scripts[name] || "");
  if (!body.includes("verify-phase26-policy.sh")) {
    fail(`${name} must include verify-phase26-policy.sh`);
  }
}
if (!String(packageJson.scripts["phase26:verify"] || "").includes("verify-phase26-policy.sh")) {
  fail("phase26:verify must execute verify-phase26-policy.sh");
}
if (!buildVerify.includes("verify-phase26-policy.sh")) {
  fail("scripts/build-verify.sh must include verify-phase26-policy.sh");
}
NODE

echo "Phase 26A bridge policy verification passed"
