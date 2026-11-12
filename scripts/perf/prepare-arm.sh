#!/usr/bin/env bash
set -euo pipefail

REF="${1:?usage: prepare-arm.sh <git-ref> <dir>}"
DIR="${2:?usage: prepare-arm.sh <git-ref> <dir>}"
ROOT="${PERF_ROOT:-$HOME/perf}"
SUITE="$ROOT/suite"
BB_HOME="$ROOT/bb"

git -C "$SUITE" fetch origin
if [ -d "$DIR" ]; then
  git -C "$DIR" checkout --detach "$REF"
else
  git -C "$SUITE" worktree add --detach "$DIR" "$REF"
fi

(cd "$DIR" && npm ci --no-audit --no-fund)
(cd "$DIR" && env -u BB_CLI PATH="$BB_HOME/node_modules/.bin:$PATH" npm run suite -- build --all)

git -C "$DIR" rev-parse HEAD
