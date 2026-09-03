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

# --- project dependencies (cwd is the repository root) ---
uv sync --all-groups
npm ci
