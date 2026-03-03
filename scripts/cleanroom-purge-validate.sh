#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BANNED_PATTERN='nmap|metasploit|burp|sqlmap|msfvenom|aircrack|ffuf|nikto|hashcat|lateral movement|exploit payload|network scanning'

if rg -n -S "$BANNED_PATTERN" "$ROOT/openclaw-bridge" --glob '!**/docs/**' --glob '!**/security/**'; then
  echo "Forbidden offensive capability identifiers detected in active runtime paths" >&2
  exit 1
fi

for forbidden_path in \
  "$ROOT/openclaw-bridge/containers/nmap" \
  "$ROOT/openclaw-bridge/containers/sqlmap" \
  "$ROOT/openclaw-bridge/containers/nikto" \
  "$ROOT/openclaw-bridge/containers/aircrack" \
  "$ROOT/openclaw-bridge/containers/msfvenom" \
  "$ROOT/openclaw-bridge/containers/ffuf" \
  "$ROOT/openclaw-bridge/containers/hashcat" \
  "$ROOT/openclaw-bridge/burp-bionic-link" \
  "$ROOT/openclaw-bridge/burp-bionic-link-legacy"
do
  if [[ -e "$forbidden_path" ]]; then
    echo "Forbidden path present: $forbidden_path" >&2
    exit 1
  fi
done

echo "Clean-room purge validation passed"
