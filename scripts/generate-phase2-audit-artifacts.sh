#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/audit/evidence/phase2"
mkdir -p "$OUT_DIR"

bash "$ROOT/scripts/cleanroom-purge-validate.sh" > "$OUT_DIR/purge-validation.txt"
bash "$ROOT/scripts/verify-secrets.sh" > "$OUT_DIR/secret-scan.txt"
bash "$ROOT/scripts/verify-no-lifecycle-hooks.sh" > "$OUT_DIR/lifecycle-hook-check.txt"
bash "$ROOT/scripts/verify-npm-cache-checksum.sh" > "$OUT_DIR/npm-cache-checksum.txt"
node "$ROOT/scripts/validate-runtime-policy.js" > "$OUT_DIR/runtime-policy-validation.txt"
bash "$ROOT/scripts/verify-tool-registry-checksum.sh" > "$OUT_DIR/tool-registry-checksum.txt"
bash "$ROOT/scripts/verify-container-digest.sh" > "$OUT_DIR/container-digest-check.txt"
bash "$ROOT/scripts/lint-restricted-globals.sh" > "$OUT_DIR/restricted-globals-lint.txt"
node "$ROOT/scripts/generate-sbom.js" > "$OUT_DIR/sbom-generation.txt"

echo "Phase 2 audit artifacts generated at $OUT_DIR"
