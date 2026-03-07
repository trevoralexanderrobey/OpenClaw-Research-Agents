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
  ".github/workflows/ci-enforcement.yml"
  "security/mutation-control.js"
  "security/operator-authorization.js"
  "openclaw-bridge/src/core/execution-router.ts"
  "openclaw-bridge/mcp/mcp-service.js"
  "scripts/build-verify.sh"
  "package.json"
)

for rel in "${REQUIRED_FILES[@]}"; do
  [[ -f "$ROOT/$rel" ]] || fail "required file missing: $rel"
done

DOC_FILE="$ROOT/docs/supervisor-architecture.md"
README_FILE="$ROOT/README.md"
ATTACK_FILE="$ROOT/docs/attack-surface.md"
FAILURE_FILE="$ROOT/docs/failure-modes.md"
RULES_FILE="$ROOT/.clinerules"
EXTENSIONS_FILE="$ROOT/.vscode/extensions.json"
EXTENSION_SETTINGS_FILE="$ROOT/.vscode/settings.json"
ALLOWLIST_FILE="$ROOT/security/cline-extension-allowlist.json"
WORKFLOW_FILE="$ROOT/.github/workflows/ci-enforcement.yml"

contains_fixed "Cline (Plan/Act) is a recommended outer operator workflow for this repository." "$DOC_FILE" || fail "supervisor architecture missing outer Cline workflow declaration"
contains_fixed "The canonical runtime supervisor/governance authority remains in-repo." "$DOC_FILE" || fail "supervisor architecture missing in-repo runtime authority clause"
contains_fixed "No runtime dependency on Cline is required." "$DOC_FILE" || fail "supervisor architecture missing tool-agnostic dependency clause"
contains_fixed "GitHub Actions is the primary enforcement path for policy/test gates; local git hooks are optional convenience only." "$DOC_FILE" || fail "supervisor architecture missing CI-first enforcement clause"
contains_fixed "Supervisor is orchestration/approval-facing only and is not a privileged mutation executor" "$DOC_FILE" || fail "supervisor architecture missing orchestration-only boundary"
contains_fixed "Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state" "$DOC_FILE" || fail "supervisor architecture missing protected mutation contract"
contains_fixed "External submission, platform login, attestation, and final submission actions are manual-only" "$DOC_FILE" || fail "supervisor architecture missing manual-only boundary"
contains_fixed "CI policy gates are release-blocking" "$DOC_FILE" || fail "supervisor architecture missing CI blocking gate clause"

contains_fixed "## Outer Operator Workflow (Cline-compatible)" "$README_FILE" || fail "README missing Outer Operator Workflow section"
contains_fixed "Use Plan mode first for repo assessment and architecture decisions, then switch to Act mode after review/approval." "$README_FILE" || fail "README missing Plan->Act operating guidance"
contains_fixed "Use conservative Auto Approve settings for internal read/edit/safe local command work only." "$README_FILE" || fail "README missing conservative Auto Approve guidance"
contains_fixed 'Repo runtime authority remains in-repo through `supervisor-authority` plus governance pathways.' "$README_FILE" || fail "README missing in-repo authority wording"
contains_fixed "Do not use YOLO mode for governed workflows in this repository." "$README_FILE" || fail "README missing YOLO prohibition wording"
contains_fixed "manual-only" "$README_FILE" || fail "README missing manual-only boundary wording"
contains_fixed "GitHub Actions is the primary enforcement path for this public repository, using standard GitHub-hosted runners." "$README_FILE" || fail "README missing CI-first enforcement wording"
contains_fixed '`OpenClaw-Research-Agents-CI / policy-and-tests`' "$README_FILE" || fail "README missing required status check name: policy-and-tests"
contains_fixed '`OpenClaw-Research-Agents-CI / deterministic-build-verify`' "$README_FILE" || fail "README missing required status check name: deterministic-build-verify"
contains_fixed "Local hooks are optional developer convenience only and are not the canonical enforcement boundary." "$README_FILE" || fail "README missing optional local-hook wording"
if search_quiet "validation stays local-only|repository-managed pre-push gate|GitHub cloud workflows are removed" "$README_FILE"; then
  fail "README contains outdated local-hook-primary or workflow-removed wording"
fi

contains_fixed "Outer Cline workflow boundary" "$ATTACK_FILE" || fail "attack-surface doc missing outer Cline boundary statement"
contains_fixed "The canonical runtime supervisor/governance authority remains in-repo and fail-closed." "$ATTACK_FILE" || fail "attack-surface doc missing in-repo authority statement"
contains_fixed "No new egress domains or dynamic endpoint expansion" "$ATTACK_FILE" || fail "attack-surface doc missing non-expansion boundary statement"
contains_fixed "GitHub Actions is the primary shared enforcement path; local git hooks are optional developer convenience only." "$ATTACK_FILE" || fail "attack-surface doc missing CI-first enforcement wording"

contains_fixed "name: OpenClaw-Research-Agents-CI" "$WORKFLOW_FILE" || fail "workflow missing expected name OpenClaw-Research-Agents-CI"
contains_fixed "policy-and-tests:" "$WORKFLOW_FILE" || fail "workflow missing policy-and-tests job"
contains_fixed "deterministic-build-verify:" "$WORKFLOW_FILE" || fail "workflow missing deterministic-build-verify job"
contains_fixed "runs-on: ubuntu-latest" "$WORKFLOW_FILE" || fail "workflow must use github-hosted ubuntu-latest runners"
contains_fixed "npm run phase2:gates" "$WORKFLOW_FILE" || fail "workflow missing phase2:gates command"
contains_fixed "npm run build:verify" "$WORKFLOW_FILE" || fail "workflow missing build:verify command"
contains_fixed "pull_request:" "$WORKFLOW_FILE" || fail "workflow missing pull_request trigger"
contains_fixed "push:" "$WORKFLOW_FILE" || fail "workflow missing push trigger"
contains_fixed "workflow_dispatch:" "$WORKFLOW_FILE" || fail "workflow missing workflow_dispatch trigger"

contains_fixed "Cline supervisor policy gate failure" "$FAILURE_FILE" || fail "failure-modes doc missing Cline policy gate failure mode"
contains_fixed "runbook" "$FAILURE_FILE" || fail "failure-modes doc missing policy gate runbook guidance"

if [[ -f "$RULES_FILE" ]]; then
  contains_fixed "No autonomous external submission" "$RULES_FILE" || fail ".clinerules missing autonomous submission prohibition"
  contains_fixed "No automated login, browser automation" "$RULES_FILE" || fail ".clinerules missing login/browser automation prohibition"
  contains_fixed "Policy gates are blocking" "$RULES_FILE" || fail ".clinerules missing blocking gate rule"
fi

if search_quiet "autonomous external submission is enabled|supervisor may execute protected mutations|supervisor bypasses operator approval|automated login is enabled" "$DOC_FILE"; then
  fail "supervisor architecture contains contradictory boundary language"
fi
if search_quiet "Cline \(VSCode Insiders extension\) is the supervisor interface for this repository" "$DOC_FILE"; then
  fail "supervisor architecture contains outdated embedded-supervisor wording"
fi

if [[ -f "$EXTENSIONS_FILE" ]]; then
  [[ -f "$ALLOWLIST_FILE" ]] || fail "Cline allowlist is required when .vscode/extensions.json is present"
  node - "$ALLOWLIST_FILE" "$EXTENSIONS_FILE" <<'NODE'
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
fi

if [[ -f "$EXTENSION_SETTINGS_FILE" && ! -f "$EXTENSIONS_FILE" ]]; then
  fail ".vscode/settings.json exists without .vscode/extensions.json; expected Cline extension recommendations when settings are present"
fi

contains_fixed "verify-cline-supervisor-policy.sh" "$ROOT/scripts/build-verify.sh" || fail "build-verify missing cline supervisor policy gate"
contains_fixed "verify:cline-supervisor" "$ROOT/package.json" || fail "package.json missing verify:cline-supervisor script"
contains_fixed "verify-cline-supervisor-policy.sh" "$ROOT/package.json" || fail "package.json script chain missing cline supervisor policy invocation"

contains_fixed "canExecuteTools: false" "$ROOT/openclaw-bridge/src/core/execution-router.ts" || fail "execution router missing supervisor non-execution boundary"
contains_fixed "assertOperatorRole" "$ROOT/openclaw-bridge/mcp/mcp-service.js" || fail "mcp service missing operator-only mutation assertion"
contains_fixed "consumeApprovalToken" "$ROOT/security/operator-authorization.js" || fail "operator authorization missing approval token consumption"
contains_fixed "requireKillSwitchOpen" "$ROOT/security/mutation-control.js" || fail "mutation-control missing kill-switch enforcement"

echo "Cline supervisor policy verification passed"
