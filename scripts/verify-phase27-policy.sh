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
  if [[ "${PHASE27_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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
    rg -n --glob '*.js' --glob '*.md' --glob '*.json' --glob '*.sh' -- "$pattern" "$@" || true
    return
  fi
  grep -R -nE --include='*.js' --include='*.md' --include='*.json' --include='*.sh' -- "$pattern" "$@" || true
}

REQUIRED_FILES=(
  "$ROOT/README.md"
  "$ROOT/docs/attack-surface.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/docs/phase27-sider-hatchify-integration.md"
  "$ROOT/openclaw-bridge/bridge/sider-handoff-manager.js"
  "$ROOT/scripts/export-sider-brief.js"
  "$ROOT/scripts/import-sider-response.js"
  "$ROOT/security/rbac-policy.json"
  "$ROOT/security/scope-registry.json"
  "$ROOT/scripts/verify-phase27-policy.sh"
  "$ROOT/tests/core/phase27-sider-handoff-manager.test.js"
  "$ROOT/tests/security/phase27-policy-gate.test.js"
  "$ROOT/package.json"
  "$ROOT/scripts/build-verify.sh"
  "$ROOT/.github/workflows/ci-enforcement.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 27 file: $file"
done

search_quiet 'integration_hatchify' "$ROOT/security/rbac-policy.json" || fail "RBAC policy must include integration_hatchify role"
search_quiet 'integration\.hatchify\.readonly' "$ROOT/security/scope-registry.json" || fail "Scope registry must include integration.hatchify.readonly"
search_quiet 'phase27-sider-export-manifest-v1' "$ROOT/openclaw-bridge/bridge/sider-handoff-manager.js" || fail "Sider handoff manager must define export manifest schema"
search_quiet 'phase27-sider-reentry-manifest-v1' "$ROOT/openclaw-bridge/bridge/sider-handoff-manager.js" || fail "Sider handoff manager must define reentry manifest schema"
search_quiet 'redacted_only' "$ROOT/openclaw-bridge/bridge/sider-handoff-manager.js" || fail "Sider handoff manager must enforce redacted_only policy"

UNSAFE_PHASE27="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|WebSocket|playwright|puppeteer|selenium|browser\.launch|login automation|background sync|bidirectional' \
  "$ROOT/openclaw-bridge/bridge/sider-handoff-manager.js" \
  "$ROOT/scripts/export-sider-brief.js" \
  "$ROOT/scripts/import-sider-response.js")"
if [[ -n "$UNSAFE_PHASE27" ]]; then
  echo "$UNSAFE_PHASE27" >&2
  fail "Phase 27 modules must remain manual-only and free of browser/login/network automation"
fi

search_quiet 'phase27:verify' "$ROOT/package.json" || fail "package.json must define phase27:verify"
search_quiet 'verify-phase27-policy\.sh' "$ROOT/package.json" || fail "package scripts must invoke verify-phase27-policy.sh"
search_quiet 'verify-phase27-policy\.sh' "$ROOT/scripts/build-verify.sh" || fail "build-verify.sh must include verify-phase27-policy.sh"
search_quiet 'npm run phase27:verify' "$ROOT/.github/workflows/ci-enforcement.yml" || fail "CI must run npm run phase27:verify"

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

if (!packageJson.scripts || !packageJson.scripts["phase27:verify"]) {
  fail("phase27:verify script is missing");
}
for (const name of ["phase2:gates"]) {
  const body = String(packageJson.scripts[name] || "");
  if (!body.includes("verify-phase27-policy.sh")) {
    fail(`${name} must include verify-phase27-policy.sh`);
  }
}
if (!String(packageJson.scripts["phase27:verify"] || "").includes("verify-phase27-policy.sh")) {
  fail("phase27:verify must execute verify-phase27-policy.sh");
}
if (!buildVerify.includes("verify-phase27-policy.sh")) {
  fail("scripts/build-verify.sh must include verify-phase27-policy.sh");
}
NODE

echo "Phase 27 Sider/Hatchify policy verification passed"
