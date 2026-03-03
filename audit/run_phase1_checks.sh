#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$ROOT/audit/evidence"
mkdir -p "$EVIDENCE_DIR"

BANNED_PATTERN='nmap|metasploit|burp|sqlmap|msfvenom|aircrack|ffuf|nikto|hackerone|payload generator|lateral movement'

# A1/A11 surface scan on active runtime code (exclude docs/audit/workspace memory artifacts)
rg -n -S "$BANNED_PATTERN" "$ROOT/openclaw-bridge" --glob '!**/docs/**' --glob '!**/security/**' > "$EVIDENCE_DIR/image-catalog-scan.txt" || true

# A2 container runtime policy indicators
{
  echo "ReadonlyRootfs / Privileged / CapDrop / NetworkMode checks:";
  rg -n "ReadonlyRootfs|Privileged|CapDrop|NetworkMode|PidMode|Binds" "$ROOT/openclaw-bridge/execution/container-runtime.js" -S || true;
} > "$EVIDENCE_DIR/runtime-policy-inspect.txt"

# A3 plaintext key scan (runtime + workspace paths only)
{
  rg -n "API_KEY|SECRET_KEY|TOKEN=|Bearer\\s+[A-Za-z0-9_-]{20,}" "$ROOT/openclaw-bridge" -S || true
  rg -n "API_KEY|SECRET_KEY|TOKEN=|Bearer\\s+[A-Za-z0-9_-]{20,}" "$ROOT/workspace" -S || true
} > "$EVIDENCE_DIR/secret-scan.txt"

# A4 workspace scope scaffold check
{
  for d in supervisor scout analyst synthesizer operator; do
    test -d "$ROOT/workspace/agents-workspaces/$d" && echo "ok:$d" || echo "missing:$d";
  done
} > "$EVIDENCE_DIR/workspace-scope-test.txt"

# A5 reinjection ordering policy presence
rg -n "Reinjection sequence|nextRetryAt|retryCount|loopId" "$ROOT/openclaw-bridge/docs/state-schema-phase1.md" -S > "$EVIDENCE_DIR/lane-reinjection-test.txt" || true

# A6 circuit breaker scaffold presence
rg -n "CIRCUIT_STATE|recordFailure|recordSuccess|OPEN|HALF_OPEN|CLOSED" "$ROOT/openclaw-bridge/supervisor/circuit-breaker.js" -S > "$EVIDENCE_DIR/circuit-breaker-test.txt" || true

# A7 supervisor boundary check
rg -n "role === \"supervisor\" && !toolName.startsWith\(\"supervisor\\.\"\)" "$ROOT/openclaw-bridge/src/core/execution-router.ts" -S > "$EVIDENCE_DIR/supervisor-boundary-test.txt" || true

# A10 freeze policy evidence
rg -n "ENABLE_OPERATOR_MUTATIONS|ENABLE_EXTERNAL_POST_PUT_DELETE|false" "$ROOT/openclaw-bridge/openclaw.json" -S > "$EVIDENCE_DIR/freeze-policy-test.txt" || true

# A11 non-coupling notice presence
rg -n "not operationally coupled" "$ROOT/audit/clean-room-derivative-notice.md" -S > "$EVIDENCE_DIR/non-coupling-test.txt" || true

echo "Phase 1 checks complete. Evidence written to: $EVIDENCE_DIR"
