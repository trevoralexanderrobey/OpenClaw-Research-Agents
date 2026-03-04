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

FIRST_HASH="$(hash_file package-lock.json)"
npm ci --offline --ignore-scripts --cache ./.ci/npm-cache
SECOND_HASH="$(hash_file package-lock.json)"

if [[ "$FIRST_HASH" != "$SECOND_HASH" ]]; then
  echo "Lockfile drift detected during reproducibility verification" >&2
  exit 1
fi

echo "Deterministic build verification passed"
