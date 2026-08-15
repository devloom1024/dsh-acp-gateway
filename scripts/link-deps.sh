#!/usr/bin/env bash
# Recreate the @deepseek-ai symlink farm after `npm install` wipes it.
set -euo pipefail
cd "$(dirname "$0")/.."

DSH_PKG="${DSH_PKG:-}"
if [ -z "$DSH_PKG" ]; then
  NODE_MAJOR=$(node -p "process.version.split('.')[0].slice(1)")
  CANDIDATES=(
    "/usr/local/lib/node_modules/@deepseek-ai/dsh"
    "$HOME/.nvm/versions/node/v${NODE_MAJOR}.*/lib/node_modules/@deepseek-ai/dsh"
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh"
    "$(npm root -g)/@deepseek-ai/dsh"
  )
  for c in "${CANDIDATES[@]}"; do
    for p in $c; do
      if [ -f "$p/package.json" ]; then DSH_PKG="$p"; break 2; fi
    done
  done
fi
[ -n "$DSH_PKG" ] || { echo "link-deps: cannot locate @deepseek-ai/dsh; set DSH_PKG=<dsh-dir>" >&2; exit 1; }
DSH_NODE_MODULES="$DSH_PKG/node_modules/@deepseek-ai"
[ -d "$DSH_NODE_MODULES" ] || { echo "link-deps: $DSH_NODE_MODULES not found" >&2; exit 1; }

rm -rf node_modules/@deepseek-ai
mkdir -p node_modules/@deepseek-ai
for pkg in "$DSH_NODE_MODULES"/*; do
  [ -d "$pkg" ] || continue
  ln -s "$pkg" "node_modules/@deepseek-ai/$(basename "$pkg")"
done
ln -sfn "$DSH_PKG" node_modules/@deepseek-ai/dsh
echo "link-deps: linked $(ls node_modules/@deepseek-ai | wc -l | tr -d ' ') packages from $DSH_PKG"
