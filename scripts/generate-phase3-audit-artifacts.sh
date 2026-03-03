#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/audit/evidence/phase3"
mkdir -p "$OUT_DIR"

node "$ROOT/scripts/validate-runtime-policy.js" > "$OUT_DIR/runtime-policy-validation.txt"
bash "$ROOT/scripts/verify-mcp-policy.sh" > "$OUT_DIR/mcp-policy-verification.txt"
bash "$ROOT/scripts/verify-container-digest.sh" > "$OUT_DIR/container-digest-check.txt"
node --test "$ROOT/tests/security/egress-policy-phase3.test.js" > "$OUT_DIR/egress-policy-tests.txt"
node --test "$ROOT/tests/security/api-governance.test.js" > "$OUT_DIR/api-governance-tests.txt"
node --test "$ROOT/tests/security/mcp-normalization.test.js" > "$OUT_DIR/mcp-normalization-tests.txt"
node --test "$ROOT/tests/integration/determinism.test.js" > "$OUT_DIR/determinism-tests.txt"

node - "$ROOT" "$OUT_DIR/daily-usage-summary.json" <<'NODE'
const path = require("node:path");
const { createApiGovernance } = require(path.join(process.argv[2], "security", "api-governance.js"));

async function main() {
  const outPath = process.argv[3];
  const governance = createApiGovernance();
  await governance.writeDailySummary(outPath);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
NODE

echo "Phase 3 audit artifacts generated at $OUT_DIR"
