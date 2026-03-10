#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SELF_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "ERROR: --root requires a path argument" >&2; exit 1; }
      ROOT="$(cd "$2" && pwd)"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

PATTERN='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|BEGIN[[:space:]]+PRIVATE[[:space:]]+KEY|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|api[_-]?key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_\-]{16,}|secret[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_\-]{16,})'
GG_CONFIG="$ROOT/.gitguardian.yaml"

has_rg() {
  command -v rg >/dev/null 2>&1
}

has_ggshield() {
  command -v ggshield >/dev/null 2>&1
}

has_ggshield_auth() {
  if [[ -n "${GITGUARDIAN_API_KEY:-}" ]]; then
    return 0
  fi
  if ! has_ggshield; then
    return 1
  fi
  ggshield api-status >/dev/null 2>&1
}

run_regex_scan() {
  if has_rg; then
    if rg -n -S "$PATTERN" "$ROOT" \
      --glob '!**/.git/**' \
      --glob '!**/.ci/npm-cache/**' \
      --glob '!**/audit/evidence/**' \
      --glob '!**/node_modules/**'; then
      echo "Potential secrets detected in repository" >&2
      return 1
    fi
    return 0
  fi

  local matched=0
  while IFS= read -r -d '' file_path; do
    if grep -nE -- "$PATTERN" "$file_path"; then
      matched=1
    fi
  done < <(
    find "$ROOT" \
      \( -path "$ROOT/.git" -o -path "$ROOT/.ci/npm-cache" -o -path "$ROOT/audit/evidence" -o -path "$ROOT/node_modules" \) -prune \
      -o -type f -print0
  )

  if [[ "$matched" == "1" ]]; then
    echo "Potential secrets detected in repository" >&2
    return 1
  fi
}

run_ggshield_scan() {
  [[ -f "$GG_CONFIG" ]] || { echo "Missing ggshield configuration file: $GG_CONFIG" >&2; return 1; }
  GITGUARDIAN_DONT_LOAD_ENV="${GITGUARDIAN_DONT_LOAD_ENV:-1}" \
    ggshield --config-path "$GG_CONFIG" --no-check-for-updates secret scan path -r -y --use-gitignore "$ROOT"
}

if has_ggshield && has_ggshield_auth; then
  if run_ggshield_scan; then
    echo "Secret scan passed via ggshield"
    exit 0
  fi
  exit 1
fi

if [[ "${VERIFY_SECRETS_REQUIRE_GGSHIELD:-0}" == "1" ]]; then
  echo "ggshield is required but is unavailable or unauthenticated. Export GITGUARDIAN_API_KEY or run 'ggshield auth login'." >&2
  exit 1
fi

echo "WARNING: ggshield unavailable or unauthenticated; using regex fallback" >&2
if run_regex_scan; then
  echo "Secret scan passed via regex fallback"
  exit 0
fi

exit 1
