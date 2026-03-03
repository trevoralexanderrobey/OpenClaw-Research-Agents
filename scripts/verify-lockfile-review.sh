#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_DOC="$ROOT/security/dependency-review.md"

cd "$ROOT"

changed_files=""
if [[ -n "${GITHUB_BASE_REF:-}" ]] && git show-ref --verify --quiet "refs/remotes/origin/${GITHUB_BASE_REF}"; then
  changed_files="$(git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD")"
elif git rev-parse --verify --quiet HEAD >/dev/null; then
  changed_files="$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)"
fi

lock_changed=false
cache_lock_changed=false

if [[ "$changed_files" == *"package-lock.json"* ]]; then
  lock_changed=true
fi
if [[ "$changed_files" == *"security/npm-cache.lock.json"* ]]; then
  cache_lock_changed=true
fi

if [[ "${FORCE_LOCK_CHANGED:-0}" == "1" ]]; then
  lock_changed=true
fi
if [[ "${FORCE_CACHE_LOCK_CHANGED:-0}" == "1" ]]; then
  cache_lock_changed=true
fi

if [[ "$lock_changed" == false && "$cache_lock_changed" == false ]]; then
  echo "No lockfile/cache lock changes detected"
  exit 0
fi

if [[ ! -f "$REVIEW_DOC" ]]; then
  echo "Missing dependency review document: $REVIEW_DOC" >&2
  exit 1
fi

if ! rg -n '^Lockfile-Review:[[:space:]]+approved$' "$REVIEW_DOC" >/dev/null; then
  echo "dependency-review.md must include 'Lockfile-Review: approved'" >&2
  exit 1
fi

if ! rg -n '^Reviewer:[[:space:]]+.+$' "$REVIEW_DOC" >/dev/null; then
  echo "dependency-review.md must include a Reviewer" >&2
  exit 1
fi

if [[ "$cache_lock_changed" == true ]]; then
  if ! rg -n '^Cache-Rebuild-Reason:[[:space:]]+.+$' "$REVIEW_DOC" >/dev/null; then
    echo "dependency-review.md must include Cache-Rebuild-Reason when npm-cache lock changes" >&2
    exit 1
  fi
fi

echo "Lockfile/cache review policy passed"
