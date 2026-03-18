#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

hash_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$file_path" | awk '{print $1}'
}

node scripts/verify-node-runtime.js
npm ci --offline --ignore-scripts --cache ./.ci/npm-cache
bash scripts/verify-no-lifecycle-hooks.sh
bash scripts/verify-npm-cache-checksum.sh
node scripts/validate-runtime-policy.js
bash scripts/verify-tool-registry-checksum.sh
bash scripts/verify-container-digest.sh
bash scripts/lint-restricted-globals.sh
bash scripts/verify-mcp-policy.sh
bash scripts/verify-mutation-policy.sh
bash scripts/verify-phase5-policy.sh
bash scripts/verify-phase6-policy.sh
bash scripts/verify-phase7-policy.sh
bash scripts/verify-cline-supervisor-policy.sh
bash scripts/verify-phase8-policy.sh
bash scripts/verify-phase9-policy.sh
bash scripts/verify-phase10-policy.sh
bash scripts/verify-phase11-policy.sh
bash scripts/verify-phase12-policy.sh
bash scripts/verify-phase13-policy.sh
bash scripts/verify-phase14-policy.sh
bash scripts/verify-phase15-policy.sh
bash scripts/verify-phase16-policy.sh
bash scripts/verify-phase17-policy.sh
bash scripts/verify-phase18-policy.sh
bash scripts/verify-monetization-policy.sh
bash scripts/verify-phase19-policy.sh
bash scripts/verify-phase20-policy.sh
bash scripts/verify-phase21-policy.sh
bash scripts/verify-phase22-policy.sh
bash scripts/verify-phase26-policy.sh

FIRST_HASH="$(hash_file package-lock.json)"
npm ci --offline --ignore-scripts --cache ./.ci/npm-cache
SECOND_HASH="$(hash_file package-lock.json)"

if [[ "$FIRST_HASH" != "$SECOND_HASH" ]]; then
  echo "Lockfile drift detected during reproducibility verification" >&2
  exit 1
fi

echo "Deterministic build verification passed"
