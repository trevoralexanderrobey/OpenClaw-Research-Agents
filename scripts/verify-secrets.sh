#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PATTERN='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|BEGIN[[:space:]]+PRIVATE[[:space:]]+KEY|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|api[_-]?key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_\-]{16,}|secret[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_\-]{16,})'

if rg -n -S "$PATTERN" "$ROOT" \
  --glob '!**/.git/**' \
  --glob '!**/.ci/npm-cache/**' \
  --glob '!**/audit/evidence/**'; then
  echo "Potential secrets detected in repository" >&2
  exit 1
fi

echo "Secret scan passed"
