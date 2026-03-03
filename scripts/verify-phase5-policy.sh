#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW_DIR="$ROOT/workflows"
GEN_DIR="$ROOT/workflows/rlhf-generator"
REVIEW_FILE="$ROOT/workflows/rlhf-review.js"
STYLE_FILE="$ROOT/STYLE.md"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

[[ -d "$WORKFLOW_DIR" ]] || fail "Missing workflows directory"
[[ -d "$GEN_DIR" ]] || fail "Missing workflows/rlhf-generator directory"
[[ -f "$REVIEW_FILE" ]] || fail "Missing workflows/rlhf-review.js"
[[ -f "$STYLE_FILE" ]] || fail "Missing STYLE.md"

for f in \
  "$GEN_DIR/pipeline-runner.js" \
  "$GEN_DIR/candidate-selector.js" \
  "$GEN_DIR/complexity-analyzer.js" \
  "$GEN_DIR/rlhf-generator.js" \
  "$GEN_DIR/rubric-builder.js" \
  "$GEN_DIR/formatting-engine.js" \
  "$GEN_DIR/compliance-linter.js" \
  "$GEN_DIR/manual-package-builder.js" \
  "$GEN_DIR/rlhf-schema.js"; do
  [[ -f "$f" ]] || fail "Missing Phase 5 workflow module: $f"
done

NETWORK_HITS="$(rg -n --glob '*.js' "fetch\(|axios|https\.request\(|http\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\.launch" "$WORKFLOW_DIR" || true)"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 5 workflows must not include network/browser automation clients"
fi

HTTPS_LITERAL_HITS="$(rg -n --glob '*.js' "https?://" "$WORKFLOW_DIR" || true)"
if [[ -n "$HTTPS_LITERAL_HITS" ]]; then
  echo "$HTTPS_LITERAL_HITS" >&2
  fail "Phase 5 workflows must not contain hardcoded external endpoints"
fi

AUTONOMY_HITS="$(rg -n --pcre2 --glob '*.js' "\\b(autoSubmit|autonomousSubmit|submitToPlatform|loginAutomation|browserAutomation|credentialStore|storeCredentials|platformApiToken)\\b\\s*[(:=]" "$WORKFLOW_DIR" || true)"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 5 workflows must not include auto-submission or login automation logic"
fi

if ! rg -q "role === \"supervisor\"" "$REVIEW_FILE"; then
  fail "rlhf-review.js missing explicit supervisor boundary check"
fi
if ! rg -q "RLHF_REVIEW_ROLE_DENIED" "$REVIEW_FILE"; then
  fail "rlhf-review.js missing deny code for unauthorized status mutation"
fi

RESTRICTED_GLOBALS="$(rg -n "Date\.now\(|new Date\(|Math\.random\(|randomUUID\(" "$WORKFLOW_DIR" || true)"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 5 workflows"
fi

for marker in \
  "AI-assistance disclosure" \
  "human-review-required" \
  "Structured reasoning" \
  "LaTeX-compatible" \
  "forbid concealment" \
  "forbid impersonation" \
  "forbid detection evasion" \
  "forbid masking synthetic origin"; do
  if ! rg -qi "$marker" "$STYLE_FILE"; then
    fail "STYLE.md missing required policy marker: $marker"
  fi
done

node - "$EGRESS_FILE" <<'NODE'
const policy = require(process.argv[2]);
const allowed = new Set(["api.semanticscholar.org", "export.arxiv.org", "api.beehiiv.com", "api.notion.com"]);
const seen = new Set();
for (const value of Object.values(policy.TOOL_EGRESS_POLICIES || {})) {
  if (!value || typeof value !== "object") continue;
  for (const host of Array.isArray(value.allowedHosts) ? value.allowedHosts : []) {
    const normalized = String(host || "").trim().toLowerCase();
    if (!normalized) continue;
    seen.add(normalized);
    if (!allowed.has(normalized)) {
      process.stderr.write(`Unexpected egress domain detected: ${normalized}\n`);
      process.exit(1);
    }
  }
}
if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
  process.stderr.write(`Egress allowlist set mismatch. seen=${JSON.stringify([...seen].sort())}\n`);
  process.exit(1);
}
NODE

echo "Phase 5 policy verification passed"
