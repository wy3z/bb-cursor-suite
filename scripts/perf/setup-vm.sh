#!/usr/bin/env bash
set -euo pipefail

SHA="${1:?usage: setup-vm.sh <suite-sha> [repo-url]}"
REPO_URL="${2:-https://github.com/wy3z/bb-cursor-suite.git}"
ROOT="${PERF_ROOT:-$HOME/perf}"
SUITE="$ROOT/suite"
BB_HOME="$ROOT/bb"
TOOLS="$ROOT/tools"

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
test -x "${CHROME_BIN:-/usr/bin/google-chrome}" || { echo "google-chrome is required" >&2; exit 1; }

mkdir -p "$ROOT" "$BB_HOME" "$TOOLS"

if [ ! -f "$BB_HOME/package.json" ]; then
  (cd "$BB_HOME" && npm init -y >/dev/null)
fi
if [ ! -x "$BB_HOME/node_modules/.bin/bb-app" ]; then
  (cd "$BB_HOME" && npm install bb-app@0.49.0 --no-audit --no-fund)
fi

if [ ! -d "$SUITE/.git" ]; then
  git clone "$REPO_URL" "$SUITE"
fi
git -C "$SUITE" fetch --quiet origin
git -C "$SUITE" checkout --quiet "$SHA"

(cd "$SUITE" && npm ci --no-audit --no-fund)
(cd "$SUITE" && env -u BB_CLI PATH="$BB_HOME/node_modules/.bin:$PATH" npm run suite -- build --all)

if [ ! -f "$TOOLS/node_modules/playwright-core/index.mjs" ]; then
  mkdir -p "$TOOLS"
  if [ ! -f "$TOOLS/package.json" ]; then
    (cd "$TOOLS" && npm init -y >/dev/null)
  fi
  (cd "$TOOLS" && npm install playwright-core@1.65.0 --no-audit --no-fund)
fi

node "$SUITE/scripts/perf/seed-fixture.mjs" --app "$BB_HOME/node_modules/.bin/bb-app" --cli "$BB_HOME/node_modules/.bin/bb" --snapshot "$ROOT/fixture/snapshot"

cat <<EOF
setup complete
suite:    $SUITE
bb-app:   $BB_HOME/node_modules/.bin/bb-app
snapshot: $ROOT/fixture/snapshot

run an arm pair:
  cd $SUITE
  node scripts/perf/drive.mjs --runs 3 --arms stock,suite
EOF
