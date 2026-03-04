#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE7_DIR="$ROOT/workflows/experiment-governance"
EXPLAIN_DIR="$ROOT/analytics/experiment-explainability"
STARTUP_FILE="$ROOT/security/phase7-startup-integrity.js"
MCP_SERVICE_FILE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
SERVER_FILE="$ROOT/openclaw-bridge/bridge/server.ts"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

for path in \
  "$PHASE7_DIR/experiment-schema.js" \
  "$PHASE7_DIR/experiment-validator.js" \
  "$PHASE7_DIR/experiment-manager.js" \
  "$PHASE7_DIR/deterministic-assignment-engine.js" \
  "$PHASE7_DIR/experiment-analysis-engine.js" \
  "$PHASE7_DIR/rollout-governor.js" \
  "$PHASE7_DIR/decision-ledger.js" \
  "$PHASE7_DIR/pre-registration-lock.js" \
  "$EXPLAIN_DIR/recommendation-rationale.js" \
  "$EXPLAIN_DIR/decision-explainer.js" \
  "$STARTUP_FILE"; do
  [[ -f "$path" ]] || fail "Missing Phase 7 module: $path"
done

SCAN_TARGETS=("$PHASE7_DIR" "$EXPLAIN_DIR" "$STARTUP_FILE")

NETWORK_HITS="$(rg -n --glob '*.js' "fetch\(|axios|https\.request\(|http\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\.launch" "${SCAN_TARGETS[@]}" || true)"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 7 modules must not include network/browser automation clients"
fi

AUTONOMY_HITS="$(rg -n --pcre2 --glob '*.js' "\b(autoSubmit|autonomousSubmit|submitToPlatform|browserAutomation|loginAutomation|credentialStore|storeCredentials)\b\s*[(:=]" "${SCAN_TARGETS[@]}" || true)"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 7 modules must not include submission/login automation logic"
fi

RESTRICTED_GLOBALS="$(rg -n "Date\.now\(|new Date\(|Math\.random\(|randomUUID\(" "${SCAN_TARGETS[@]}" || true)"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 7 modules"
fi

for file in \
  "$PHASE7_DIR/experiment-manager.js" \
  "$PHASE7_DIR/deterministic-assignment-engine.js" \
  "$PHASE7_DIR/experiment-analysis-engine.js" \
  "$PHASE7_DIR/rollout-governor.js"; do
  rg -q "approvalToken" "$file" || fail "Missing approvalToken contract in $file"
  rg -q "consumeScopedApprovalToken|consumeApprovalToken" "$file" || fail "Missing approval token consumption in $file"
  rg -q "assertOperatorRole" "$file" || fail "Missing operator role enforcement in $file"
  rg -q "assertKillSwitchOpen" "$file" || fail "Missing kill-switch enforcement in $file"
  rg -q "withGovernanceTransaction\(" "$file" || fail "Missing governance transaction wrapper in $file"
done

rg -q "verifyPreRegistrationLock|assertPreRegistrationLock" "$PHASE7_DIR/rollout-governor.js" || fail "Rollout governor missing pre-registration lock verification"
rg -q "verifyPreRegistrationLock|assertPreRegistrationLock" "$PHASE7_DIR/deterministic-assignment-engine.js" || fail "Assignment engine missing pre-registration lock verification"
rg -q "verifyPreRegistrationLock|assertPreRegistrationLock" "$PHASE7_DIR/experiment-analysis-engine.js" || fail "Analysis engine missing pre-registration lock verification"

rg -q "verifyPhase7StartupIntegrity" "$MCP_SERVICE_FILE" || fail "mcp-service missing phase7 startup integrity hook"
rg -q "initialize\(" "$MCP_SERVICE_FILE" || fail "mcp-service missing initialize() contract"
rg -q "await mcpService\.initialize\(" "$SERVER_FILE" || fail "bridge server missing mandatory mcpService.initialize() bootstrap call"

rg -q "verifyRolloutDecisionIntegrity" "$STARTUP_FILE" || fail "startup integrity module missing decision ledger verification"

node - "$EGRESS_FILE" <<'NODE'
const policy = require(process.argv[2]);
const allowed = new Set(["api.semanticscholar.org", "export.arxiv.org", "api.beehiiv.com", "api.notion.com"]);
const seen = new Set();
for (const [slug, value] of Object.entries(policy.TOOL_EGRESS_POLICIES || {})) {
  if (!value || typeof value !== "object") continue;
  const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : [];
  for (const host of hosts) {
    const normalized = String(host || "").trim().toLowerCase();
    if (!normalized) continue;
    seen.add(normalized);
    if (!allowed.has(normalized)) {
      process.stderr.write(`Unexpected egress domain detected (${slug}): ${normalized}\n`);
      process.exit(1);
    }
  }
}
if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
  process.stderr.write(`Egress allowlist set mismatch. seen=${JSON.stringify([...seen].sort())}\n`);
  process.exit(1);
}
NODE

echo "Phase 7 policy verification passed"
