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
  echo "ERROR: $1" >&2
  exit 1
}

has_rg() {
  if [[ "${CLINE_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
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

contains_fixed() {
  local text="$1"
  local file_path="$2"
  if has_rg; then
    rg -q --fixed-strings -- "$text" "$file_path"
    return
  fi
  grep -Fq -- "$text" "$file_path"
}

REQUIRED_FILES=(
  "README.md"
  "docs/attack-surface.md"
  "docs/failure-modes.md"
  "docs/supervisor-architecture.md"
  ".vscode/extensions.json"
  ".vscode/settings.json"
  ".clinerules"
  "security/cline-extension-allowlist.json"
  "security/mutation-control.js"
  "security/operator-authorization.js"
  "openclaw-bridge/src/core/execution-router.ts"
  "openclaw-bridge/mcp/mcp-service.js"
  "scripts/build-verify.sh"
  "package.json"
  ".github/workflows/phase2-security.yml"
)

for rel in "${REQUIRED_FILES[@]}"; do
  [[ -f "$ROOT/$rel" ]] || fail "required file missing: $rel"
done

DOC_FILE="$ROOT/docs/supervisor-architecture.md"
README_FILE="$ROOT/README.md"
ATTACK_FILE="$ROOT/docs/attack-surface.md"
FAILURE_FILE="$ROOT/docs/failure-modes.md"
RULES_FILE="$ROOT/.clinerules"

contains_fixed "Cline (VSCode Insiders extension) is the supervisor interface" "$DOC_FILE" || fail "supervisor architecture missing explicit Cline supervisor declaration"
contains_fixed "Supervisor is orchestration/approval-facing only and is not a privileged mutation executor" "$DOC_FILE" || fail "supervisor architecture missing orchestration-only boundary"
contains_fixed "Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state" "$DOC_FILE" || fail "supervisor architecture missing protected mutation contract"
contains_fixed "External submission, platform login, attestation, and final submission actions are manual-only" "$DOC_FILE" || fail "supervisor architecture missing manual-only boundary"
contains_fixed "CI policy gates are release-blocking" "$DOC_FILE" || fail "supervisor architecture missing CI blocking gate clause"

contains_fixed "## Supervisor Model (Cline)" "$README_FILE" || fail "README missing Supervisor Model (Cline) section"
contains_fixed "manual-only" "$README_FILE" || fail "README missing manual-only boundary wording"

contains_fixed "Cline supervisor boundary" "$ATTACK_FILE" || fail "attack-surface doc missing Cline supervisor boundary statement"
contains_fixed "No new egress domains or dynamic endpoint expansion" "$ATTACK_FILE" || fail "attack-surface doc missing non-expansion boundary statement"

contains_fixed "Cline supervisor policy gate failure" "$FAILURE_FILE" || fail "failure-modes doc missing Cline policy gate failure mode"
contains_fixed "runbook" "$FAILURE_FILE" || fail "failure-modes doc missing policy gate runbook guidance"

contains_fixed "No autonomous external submission" "$RULES_FILE" || fail ".clinerules missing autonomous submission prohibition"
contains_fixed "No automated login, browser automation" "$RULES_FILE" || fail ".clinerules missing login/browser automation prohibition"
contains_fixed "Policy gates are blocking" "$RULES_FILE" || fail ".clinerules missing blocking gate rule"

if search_quiet "autonomous external submission is enabled|supervisor may execute protected mutations|supervisor bypasses operator approval|automated login is enabled" "$DOC_FILE"; then
  fail "supervisor architecture contains contradictory boundary language"
fi

node - "$ROOT/security/cline-extension-allowlist.json" "$ROOT/.vscode/extensions.json" <<'NODE'
const fs = require("node:fs");

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

const allowlistPath = process.argv[2];
const extensionsPath = process.argv[3];
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
const extensions = JSON.parse(fs.readFileSync(extensionsPath, "utf8"));

if (Number(allowlist.schemaVersion) !== 1) {
  fail("cline extension allowlist schemaVersion must be 1");
}

const officialIds = Array.isArray(allowlist.officialIds) ? allowlist.officialIds : null;
const approvedAliasIds = Array.isArray(allowlist.approvedAliasIds) ? allowlist.approvedAliasIds : null;
const allowedIds = Array.isArray(allowlist.allowedIds) ? allowlist.allowedIds : null;

if (!officialIds || officialIds.length === 0) {
  fail("officialIds must be a non-empty array");
}
if (!approvedAliasIds) {
  fail("approvedAliasIds must be an array");
}
if (!allowedIds || allowedIds.length === 0) {
  fail("allowedIds must be a non-empty array");
}

const normalizedOfficial = officialIds.map((id) => String(id || "").trim()).filter(Boolean);
const normalizedAlias = approvedAliasIds.map((id) => String(id || "").trim()).filter(Boolean);
const normalizedAllowed = allowedIds.map((id) => String(id || "").trim()).filter(Boolean);

if (normalizedOfficial.length !== officialIds.length || normalizedAlias.length !== approvedAliasIds.length || normalizedAllowed.length !== allowedIds.length) {
  fail("allowlist IDs must be non-empty strings");
}

const expectedAllowed = [...new Set([...normalizedOfficial, ...normalizedAlias])].sort();
const actualAllowed = [...new Set(normalizedAllowed)].sort();
if (JSON.stringify(expectedAllowed) !== JSON.stringify(actualAllowed)) {
  fail(`allowedIds must equal deterministic union of officialIds and approvedAliasIds. expected=${JSON.stringify(expectedAllowed)} actual=${JSON.stringify(actualAllowed)}`);
}

const recommendations = extensions && Array.isArray(extensions.recommendations)
  ? extensions.recommendations.map((id) => String(id || "").trim()).filter(Boolean)
  : null;

if (!recommendations || recommendations.length === 0) {
  fail(".vscode/extensions.json must include a non-empty recommendations array");
}

const allowedSet = new Set(actualAllowed);
if (!recommendations.some((id) => allowedSet.has(id))) {
  fail(".vscode/extensions.json must recommend at least one allowlisted Cline extension ID");
}

for (const id of recommendations) {
  if (/(cline|claude-dev)/i.test(id) && !allowedSet.has(id)) {
    fail(`Cline-related extension recommendation is not allowlisted: ${id}`);
  }
}
NODE

contains_fixed "verify-cline-supervisor-policy.sh" "$ROOT/scripts/build-verify.sh" || fail "build-verify missing cline supervisor policy gate"
contains_fixed "verify:cline-supervisor" "$ROOT/package.json" || fail "package.json missing verify:cline-supervisor script"
contains_fixed "verify-cline-supervisor-policy.sh" "$ROOT/package.json" || fail "package.json script chain missing cline supervisor policy invocation"

WF="$ROOT/.github/workflows/phase2-security.yml"
contains_fixed "Verify required policy scripts exist" "$WF" || fail "workflow missing required policy script pre-check step"
contains_fixed "ERROR: required script missing:" "$WF" || fail "workflow missing clear hard error for missing scripts"
contains_fixed "bash scripts/verify-cline-supervisor-policy.sh" "$WF" || fail "workflow missing cline supervisor policy verification step"
if contains_fixed "if [[ -f scripts/verify-phase7-policy.sh ]]; then" "$WF"; then
  fail "workflow contains forbidden conditional skip for phase7 policy script"
fi

contains_fixed "canExecuteTools: false" "$ROOT/openclaw-bridge/src/core/execution-router.ts" || fail "execution router missing supervisor non-execution boundary"
contains_fixed "assertOperatorRole" "$ROOT/openclaw-bridge/mcp/mcp-service.js" || fail "mcp service missing operator-only mutation assertion"
contains_fixed "consumeApprovalToken" "$ROOT/security/operator-authorization.js" || fail "operator authorization missing approval token consumption"
contains_fixed "requireKillSwitchOpen" "$ROOT/security/mutation-control.js" || fail "mutation-control missing kill-switch enforcement"

echo "Cline supervisor policy verification passed"
