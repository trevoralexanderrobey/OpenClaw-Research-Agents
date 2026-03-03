#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MUTATION_CTRL="$ROOT/security/mutation-control.js"
MCP_SERVICE="$ROOT/openclaw-bridge/mcp/mcp-service.js"
NEWSLETTER_MCP="$ROOT/openclaw-bridge/mcp/newsletter-mcp.js"
NOTION_MCP="$ROOT/openclaw-bridge/mcp/notion-mcp.js"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

[[ -f "$MUTATION_CTRL" ]] || fail "Missing mutation control module"
[[ -f "$MCP_SERVICE" ]] || fail "Missing mcp-service module"
[[ -f "$NEWSLETTER_MCP" ]] || fail "Missing newsletter mutation MCP"
[[ -f "$NOTION_MCP" ]] || fail "Missing notion mutation MCP"

rg -q "preparePublication" "$MUTATION_CTRL" || fail "mutation-control missing preparePublication"
rg -q "commitPublication" "$MUTATION_CTRL" || fail "mutation-control missing commitPublication"
rg -q "requireKillSwitchOpen" "$MUTATION_CTRL" || fail "mutation-control missing kill-switch enforcement"
rg -q "requireMutationEnabled" "$MUTATION_CTRL" || fail "mutation-control missing enabled-state enforcement"
rg -q "consumeApprovalToken" "$MUTATION_CTRL" || fail "mutation-control missing operator token consumption"
rg -q "applyMutationAccounting" "$MUTATION_CTRL" || fail "mutation-control missing mutation governance accounting"
rg -q "verifyMutationLogChain" "$MUTATION_CTRL" || fail "mutation-control missing mutation log chain verification"

rg -q "assertOperatorRole" "$MCP_SERVICE" || fail "mcp-service missing operator role boundary"
rg -q "mutation.preparePublication" "$MCP_SERVICE" || fail "mcp-service missing mutation.preparePublication method"
rg -q "mutation.commitPublication" "$MCP_SERVICE" || fail "mcp-service missing mutation.commitPublication method"
rg -q "mutation.retryPublication" "$MCP_SERVICE" || fail "mcp-service missing mutation.retryPublication method"
rg -q "mutation.reconcilePublication" "$MCP_SERVICE" || fail "mcp-service missing mutation.reconcilePublication method"

rg -q "extends\\s+BaseMcp" "$NEWSLETTER_MCP" || fail "newsletter-mcp does not extend BaseMcp"
rg -q "extends\\s+BaseMcp" "$NOTION_MCP" || fail "notion-mcp does not extend BaseMcp"
rg -q "mutationControl\\.preparePublication" "$NEWSLETTER_MCP" || fail "newsletter-mcp missing preparePublication flow"
rg -q "mutationControl\\.preparePublication" "$NOTION_MCP" || fail "notion-mcp missing preparePublication flow"

if rg -n --glob '!tests/**' "rejectUnauthorized\\s*:\\s*false" "$ROOT/security" "$ROOT/openclaw-bridge" >/dev/null; then
  fail "Found rejectUnauthorized:false in runtime source"
fi

node - "$EGRESS_FILE" <<'NODE'
const policy = require(process.argv[2]);
const map = policy.TOOL_EGRESS_POLICIES || {};
const checks = [
  ["newsletter-publisher-mcp", "api.beehiiv.com", ["POST", "PATCH"]],
  ["notion-sync-mcp", "api.notion.com", ["POST", "PATCH"]]
];
for (const [slug, host, methods] of checks) {
  const entry = map[slug];
  if (!entry) {
    process.stderr.write(`Missing egress policy for ${slug}\n`);
    process.exit(1);
  }
  const hosts = Array.isArray(entry.allowedHosts) ? entry.allowedHosts : [];
  if (!hosts.includes(host)) {
    process.stderr.write(`Missing host ${host} in ${slug} egress policy\n`);
    process.exit(1);
  }
  const byHost = entry.allowedMethodsByHost && typeof entry.allowedMethodsByHost === "object" ? entry.allowedMethodsByHost : {};
  const got = Array.isArray(byHost[host]) ? byHost[host].slice().sort() : [];
  const expected = methods.slice().sort();
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    process.stderr.write(`Method allowlist mismatch for ${slug}/${host}: got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}\n`);
    process.exit(1);
  }
}
NODE

echo "Mutation policy verification passed"
