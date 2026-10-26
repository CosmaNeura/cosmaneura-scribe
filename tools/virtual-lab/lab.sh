#!/bin/bash
set -euo pipefail
LAB_SOURCE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$LAB_SOURCE/../.." && pwd)"
: "${SCRIBE_LAB_ROOT:?Set SCRIBE_LAB_ROOT to an owned absolute output directory}"
case "$SCRIBE_LAB_ROOT" in /*) ;; *) echo 'Lab root must be absolute' >&2; exit 2;; esac
export SCRIBE_LAB_ROOT
export PATH="$SCRIBE_LAB_ROOT/runtime/node_modules/.bin:${SCRIBE_LAB_NODE_BIN:-/opt/homebrew/opt/node@24/bin}:$PATH"
export APPIUM_HOME="$SCRIBE_LAB_ROOT/appium"
export PROMPTFOO_CONFIG_DIR="$SCRIBE_LAB_ROOT/promptfoo"
export PROMPTFOO_DISABLE_TELEMETRY=1
export PROMPTFOO_DISABLE_UPDATE=1
export npm_config_cache="$SCRIBE_LAB_ROOT/npm-cache"
export UV_CACHE_DIR="$SCRIBE_LAB_ROOT/uv-cache"
export UV_PROJECT_ENVIRONMENT="$SCRIBE_LAB_ROOT/api-python"
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$SCRIBE_LAB_ROOT"
export SCRIBE_LAB_PROJECT="$(node -e 'const fs=require("fs"),crypto=require("crypto"),p=process.env.SCRIBE_LAB_ROOT+"/owner.json";const root=fs.realpathSync(process.env.SCRIBE_LAB_ROOT);if(!fs.existsSync(p))fs.writeFileSync(p,JSON.stringify({root,project:"scribe-lab-"+crypto.createHash("sha256").update(root).digest("hex").slice(0,12)}),{flag:"wx",mode:384});const o=JSON.parse(fs.readFileSync(p));if(o.root!==root||!/^scribe-(lab-[a-f0-9]{12}|virtual-lab)$/.test(o.project))process.exit(2);process.stdout.write(o.project)')"
if command -v docker-compose >/dev/null; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
COMPOSE+=(-f "$LAB_SOURCE/compose.yaml")
case "${1:-help}" in
  setup)
    node -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)'
    mkdir -p "$SCRIBE_LAB_ROOT/runtime"
    if [ -f "$SCRIBE_LAB_ROOT/runtime/package-lock.json" ]; then
      cmp "$LAB_SOURCE/package.json" "$SCRIBE_LAB_ROOT/runtime/package.json"
      npm ci --prefix "$SCRIBE_LAB_ROOT/runtime" --no-audit --no-fund
    else
      cp "$LAB_SOURCE/package.json" "$SCRIBE_LAB_ROOT/runtime/package.json"
      npm install --prefix "$SCRIBE_LAB_ROOT/runtime" --no-audit --no-fund
    fi
    hash -r
    if [ ! -x "$SCRIBE_LAB_ROOT/python/bin/python" ]; then uv venv --python 3.13 "$SCRIBE_LAB_ROOT/python"; fi
    uv pip install --python "$SCRIBE_LAB_ROOT/python/bin/python" jiwer==4.0.0
    (cd "$REPO" && npm ci --no-audit --no-fund && uv sync --frozen --all-groups)
    (cd "$REPO/apps/capture/e2e" && npm ci --no-audit --no-fund)
    playwright install chromium
    appium driver list --installed --json > "$SCRIBE_LAB_ROOT/appium-drivers.json"
    for pair in mac2:appium-mac2-driver xcuitest:appium-xcuitest-driver; do
      if ! node -e 'if(!JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])process.exit(1)' "$SCRIBE_LAB_ROOT/appium-drivers.json" "${pair%%:*}"; then
        appium driver install --source=local "$SCRIBE_LAB_ROOT/runtime/node_modules/${pair#*:}"
      fi
    done
    ;;
  up) "${COMPOSE[@]}" up -d --wait postgres toxiproxy echo ;;
  network)
    for service in postgres toxiproxy echo; do
      [ -n "$("${COMPOSE[@]}" ps --status running -q "$service")" ] || { echo 'Start this owned lab first' >&2; exit 2; }
    done
    python3 "$LAB_SOURCE/network/check.py" | tee "$SCRIBE_LAB_ROOT/network.json"
    "${COMPOSE[@]}" run --rm k6 ;;
  native-relay)
    node "$LAB_SOURCE/network/relay-cli.mjs" "${2:?Supply a reviewed private relay config}" "$SCRIBE_LAB_ROOT" "${3:?Supply a new private relay output directory}"
    ;;
  browser)
    (cd "$REPO" && node apps/capture/e2e/node_modules/@playwright/test/cli.js test --config apps/capture/e2e/playwright.config.mjs)
    ;;
  api-browser)
    # Fresh database per run, within the owned ephemeral PostgreSQL container only.
    db="scribe_lab_$(date +%s)_${RANDOM}_test"
    "${COMPOSE[@]}" exec -T postgres createdb -U scribe_lab "$db"
    export COSMANEURA_SCRIBE_E2E_DATABASE_URL="postgresql+asyncpg://scribe_lab:synthetic-local-only@127.0.0.1:55439/$db"
    (cd "$REPO" && node apps/capture/e2e/node_modules/@playwright/test/cli.js test --config apps/capture/e2e/playwright.full-stack.config.mjs)
    ;;
  browser-auth) node "$LAB_SOURCE/browser-auth.mjs" ;;
  auth-normal) node "$LAB_SOURCE/coordinator/normal-auth.mjs" "${2:?Supply a new private evidence directory}" "${3:-example.com}" ;;
  doctor|run|resume|cleanup|matrix|matrix-resume|zoom-doctor|zoom-run|zoom-resume)
    mode="$1"; shift
    node "$LAB_SOURCE/coordinator/cli.mjs" "$mode" "$@"
    ;;
  coordinator-test) node --test "$LAB_SOURCE"/coordinator/*.test.mjs "$LAB_SOURCE"/native/*observer.test.mjs "$LAB_SOURCE"/native/note-observation.test.mjs ;;
  auth-public) python3 "$LAB_SOURCE/native-auth/run.py" --output "$SCRIBE_LAB_ROOT/native-auth" --mode public ;;
  auth-bootstrap) python3 "$LAB_SOURCE/native-auth/run.py" --output "$SCRIBE_LAB_ROOT/native-auth" --mode email --bootstrap ;;
  evaluation) "$SCRIBE_LAB_ROOT/python/bin/python" "$LAB_SOURCE/evaluation/evaluate.py" self-check ;;
  appium) appium --address 127.0.0.1 --port 4729 --log-level warn --allow-insecure='*:session_discovery' ;;
  down) "${COMPOSE[@]}" stop ;;
  *) echo 'Commands: setup | up | network | native-relay | browser | api-browser | auth-public | auth-bootstrap | browser-auth | auth-normal | doctor | run | resume | cleanup | matrix | matrix-resume | zoom-doctor | zoom-run | zoom-resume | coordinator-test | evaluation | appium | down' ;;
esac
