#!/usr/bin/env bash
set -euo pipefail

find_brew_path() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi

  local candidates=(
    "/opt/homebrew/bin/brew"
    "/home/linuxbrew/.linuxbrew/bin/brew"
    "/usr/local/bin/brew"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

activate_brew() {
  local brew_bin="$1"
  eval "$("$brew_bin" shellenv)"
}

BREW_BIN="$(find_brew_path || true)"
if [[ -z "$BREW_BIN" ]]; then
  case "$(uname -s)" in
    Darwin|Linux)
      ;;
    *)
      echo "Automatic Homebrew installation is only supported on macOS and Linux" >&2
      exit 1
      ;;
  esac

  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  BREW_BIN="$(find_brew_path || true)"
  if [[ -z "$BREW_BIN" ]]; then
    echo "Homebrew installation completed but 'brew' was not found in a standard location" >&2
    exit 1
  fi
fi

activate_brew "$BREW_BIN"

brew install ggshield
ggshield --version

if [[ -n "${GITGUARDIAN_API_KEY:-}" ]]; then
  ggshield api-status
else
  echo "ggshield installed. Export GITGUARDIAN_API_KEY or run 'ggshield auth login' to enable authenticated scans."
fi
