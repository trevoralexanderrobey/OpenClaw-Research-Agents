#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FORBIDDEN_PATTERN='Date\.now\(|new Date\(|Math\.random\(|randomUUID\('

MATCHES="$(rg -n -S "$FORBIDDEN_PATTERN" "$ROOT/openclaw-bridge" \
  --glob '!**/core/time-provider.js' \
  --glob '!**/core/entropy-provider.js' \
  --glob '!**/docs/**' || true)"

if [[ -n "$MATCHES" ]]; then
  echo "Restricted global usage detected outside controlled providers:" >&2
  echo "$MATCHES" >&2
  exit 1
fi

echo "Restricted globals lint passed"
