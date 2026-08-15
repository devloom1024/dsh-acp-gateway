#!/usr/bin/env bash
# Build the offline distribution archive: a self-contained tarball that works
# without npm, without an installed @deepseek-ai/dsh app, and without network.
#
# Contents:
#   node_modules/            the full DSH runtime dependency closure (real
#                            files, dereferenced from the symlink farm)
#   dist/ examples/          the gateway build
#   config/agent-presets/    the shipped presets (standard/code/minimal/cordis)
#   vendor/dsh-app/          the portable anchor the server falls back to
#   bin/node                 an embedded Node runtime (copied from the build
#                            machine), so only the archive is required
#   dsh-acp                  launcher: execs the embedded node
#
# Usage:
#   bash scripts/package-offline.sh [output-dir]
#
# Prerequisites: `npm run build` done, and the repo's node_modules symlink
# farm (or a real install) present — the full closure is resolved through the
# farm's dsh-app-boot link.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist-offline}"
NAME="dsh-acp-gateway-$(node -p "require('$ROOT/package.json').version")"
STAGE="$(mktemp -d -t dsh-acp-offline)"
trap 'rm -rf "$STAGE"' EXIT

echo "== assembling $NAME"

# 1. Full dependency closure. The repo's node_modules is a symlink farm into
#    the dsh app install; resolve the app's node_modules through it and copy
#    real files (follow every symlink) so the archive is self-contained.
FARM="$ROOT/node_modules/@deepseek-ai/dsh-app-boot"
if [ -L "$FARM" ]; then
  APP_NM="$(dirname "$(dirname "$(readlink "$FARM")")")"
else
  APP_NM="$ROOT/node_modules"
fi
if [ ! -d "$APP_NM/@deepseek-ai" ]; then
  echo "error: cannot locate the DSH closure (looked in $APP_NM)" >&2
  exit 1
fi
echo "closure: $APP_NM"
cp -RL "$APP_NM" "$STAGE/node_modules"
# The closure lacks the dsh app package itself; carry it over from the farm so
# the anchor lookup inside the archive resolves exactly like an npm install.
if [ -L "$ROOT/node_modules/@deepseek-ai/dsh" ]; then
  mkdir -p "$STAGE/node_modules/@deepseek-ai"
  cp -RL "$ROOT/node_modules/@deepseek-ai/dsh" "$STAGE/node_modules/@deepseek-ai/dsh"
  echo "carried @deepseek-ai/dsh into the bundle"
fi

# 2. Build outputs + examples + shipped presets.
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/examples" "$STAGE/examples"
mkdir -p "$STAGE/config"
cp -R "$ROOT/config/agent-presets" "$STAGE/config/agent-presets"

# 3. Vendor anchor generated from the staged closure.
DSH_VENDOR_MODULES="$STAGE/node_modules" node "$ROOT/scripts/gen-vendor-anchor.mjs"
cp -R "$ROOT/vendor" "$STAGE/vendor"

# 4. Embedded Node runtime, when available.
if NODE_BIN="$(command -v node || true)" && [ -n "$NODE_BIN" ]; then
  NODE_REAL="$(node -e "process.stdout.write(require('node:fs').realpathSync(process.argv[1]))" "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
  mkdir -p "$STAGE/bin"
  cp "$NODE_REAL" "$STAGE/bin/node"
  chmod +x "$STAGE/bin/node"
  echo "embedded node: $("$STAGE/bin/node" --version 2>/dev/null || echo unavailable)"
else
  echo "warning: no node binary found; the archive will require a system node >= 20" >&2
fi

# 5. Launcher: prefer the embedded node, fall back to a system node.
cat > "$STAGE/dsh-acp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/bin/node"
if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi
exec "$NODE" "$DIR/dist/src/bin/dsh-acp-server.js" "$@"
EOF
chmod +x "$STAGE/dsh-acp"

# 6. Archive.
mkdir -p "$OUT_DIR"
tar -C "$STAGE" -czf "$OUT_DIR/$NAME.tar.gz" .
echo "== archive: $OUT_DIR/$NAME.tar.gz"
du -sh "$OUT_DIR/$NAME.tar.gz"
