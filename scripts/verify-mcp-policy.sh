#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="$ROOT/openclaw-bridge/mcp"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
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

search_fixed_js_tree() {
  local signature="$1"
  local root_dir="$2"
  if has_rg; then
    rg -n --fixed-strings --glob '*.js' --glob '!base-mcp.js' -- "$signature" "$root_dir" || true
    return
  fi

  local out=""
  while IFS= read -r file_path; do
    local hits
    hits="$(grep -nF -- "$signature" "$file_path" || true)"
    if [[ -n "$hits" ]]; then
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        out+="${file_path}:${line}"$'\n'
      done <<<"$hits"
    fi
  done < <(find "$root_dir" -type f -name '*.js' ! -name 'base-mcp.js' | sort)

  if [[ -n "$out" ]]; then
    printf "%s" "$out"
  fi
}

if [[ ! -d "$MCP_DIR" ]]; then
  fail "MCP directory not found: $MCP_DIR"
fi

for f in "$MCP_DIR"/*.js; do
  [[ -f "$f" ]] || continue
  base_name="$(basename "$f")"
  if [[ "$base_name" == "base-mcp.js" || "$base_name" == "mcp-service.js" ]]; then
    continue
  fi

  if ! search_quiet "extends\\s+BaseMcp" "$f"; then
    fail "MCP file does not extend BaseMcp: $f"
  fi
done

bad_network=""
for signature in "fetch(" "https.request(" "http.request("; do
  hits="$(search_fixed_js_tree "$signature" "$MCP_DIR")"
  if [[ -n "$hits" ]]; then
    bad_network+="$hits"$'\n'
  fi
done

if [[ -n "$bad_network" ]]; then
  echo "$bad_network" >&2
  fail "Direct network call found outside base-mcp wrapper"
fi

if ! search_quiet "allowedHosts:\\s*\\[\\s*\"api\\.semanticscholar\\.org\"\\s*\\]" "$EGRESS_FILE"; then
  fail "semantic-scholar egress allowlist missing"
fi
if ! search_quiet "allowedHosts:\\s*\\[\\s*\"export\\.arxiv\\.org\"\\s*\\]" "$EGRESS_FILE"; then
  fail "arxiv egress allowlist missing"
fi

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
      process.stderr.write(`Unregistered egress domain in ${slug}: ${normalized}\n`);
      process.exit(1);
    }
  }
}
if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
  process.stderr.write(`Egress domain set mismatch. seen=${JSON.stringify([...seen].sort())}\n`);
  process.exit(1);
}
NODE

if ! search_quiet "withGovernanceTransaction\\(" "$MCP_DIR/base-mcp.js"; then
  fail "Governance transaction wrapper missing in base MCP"
fi
if ! search_quiet "tx\\.applyUsage\\(" "$MCP_DIR/base-mcp.js"; then
  fail "API governance usage limiter call missing in base MCP"
fi

for f in "$MCP_DIR"/*.js; do
  [[ -f "$f" ]] || continue
  base_name="$(basename "$f")"
  if [[ "$base_name" == *".stub.js" || "$base_name" == "base-mcp.js" || "$base_name" == "mcp-service.js" ]]; then
    continue
  fi
  if ! search_quiet "inputSchema" "$f"; then
    fail "Schema validation missing in MCP module: $f"
  fi
done

echo "MCP policy verification passed"
