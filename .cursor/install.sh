#!/usr/bin/env bash
set -euo pipefail

# Self-contained, idempotent bootstrap for the Cosmaneura Scribe dev environment.
# Works from the default Cloud Agent base image (no personal snapshot): it
# installs uv and Node 24.5.0 / npm 11.5.2 itself, then refreshes project
# dependencies. Safe to re-run against cached or partially prepared state.

# --- uv (Python toolchain manager; auto-downloads Python 3.12) ---
if [ ! -x "$HOME/.local/bin/uv" ] && ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# --- nvm + Node 24.5.0 + npm 11.5.2 ---
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24.5.0
# Make 24.5.0 the login-shell default so `bash -lc` resolves Node 24 ahead of
# the /exec-daemon node (v22) that is injected early in PATH.
nvm alias default 24.5.0
nvm use 24.5.0
npm install -g npm@11.5.2

# --- Force pinned Node 24 ahead of the /exec-daemon node (v22) in future shells ---
# The Cloud Agent runtime injects /exec-daemon (Node 22) early in PATH, ahead of
# the nvm bin, and merely sourcing nvm does not re-select the default. Sourcing
# nvm's `use default` is therefore unreliable at boot, so login and interactive
# shells get an explicit, guarded prepend of the pinned Node 24 bin instead.
node24_bin="$HOME/.nvm/versions/node/v24.5.0/bin"
marker="# cosmaneura-scribe: prefer pinned Node 24 over /exec-daemon node"
for profile in "$HOME/.bashrc" "$HOME/.profile"; do
  touch "$profile"
  if ! grep -Fq "$marker" "$profile"; then
    {
      printf '\n%s\n' "$marker"
      printf 'case ":$PATH:" in\n'
      printf '  ":%s:"*) ;;\n' "$node24_bin"
      printf '  *) [ -d "%s" ] && export PATH="%s:$PATH" ;;\n' "$node24_bin" "$node24_bin"
      printf 'esac\n'
    } >> "$profile"
  fi
done

# --- project dependencies (cwd is the repository root) ---
uv sync --all-groups
npm ci
