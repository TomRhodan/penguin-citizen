#!/usr/bin/env bash
#
# Local Flatpak build for development iterations.
#
# Patches the committed manifest to use the working tree as the source
# (instead of the pinned git tag) and runs flatpak-builder. Useful for
# testing manifest or code changes before tagging a release.
#
# Usage:
#   ./flatpak/build-local.sh              # build only
#   ./flatpak/build-local.sh --install    # build + install --user
#   ./flatpak/build-local.sh --run        # build + install + run
#   ./flatpak/build-local.sh --clean      # wipe build/state caches first

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
APP_ID="de.penguincitizen.penguincitizen"
SRC_MANIFEST="$SCRIPT_DIR/$APP_ID.yml"

VENV_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/penguin-citizen/flatpak-tools/venv"
BUILD_ROOT="$SCRIPT_DIR/.build"
BUILD_DIR="$BUILD_ROOT/build"
STATE_DIR="$BUILD_ROOT/state"
# Dev manifest must live next to the source manifest so relative paths
# (cargo-sources.json, node-sources.json, ../src-tauri/helper) resolve.
DEV_MANIFEST="$SCRIPT_DIR/$APP_ID.dev.yml"

INSTALL=0
RUN=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --run)     INSTALL=1; RUN=1 ;;
    --clean)   CLEAN=1 ;;
    -h|--help)
      sed -n '3,15p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- Pre-flight checks ---
command -v flatpak-builder >/dev/null || {
  echo "ERROR: flatpak-builder not installed (sudo pacman -S flatpak-builder)" >&2
  exit 1
}
[[ -f "$SRC_MANIFEST" ]] || {
  echo "ERROR: manifest not found: $SRC_MANIFEST" >&2
  exit 1
}
[[ -f "$SCRIPT_DIR/cargo-sources.json" && -f "$SCRIPT_DIR/node-sources.json" ]] || {
  echo "ERROR: source files missing — run ./flatpak/regenerate-sources.sh first" >&2
  exit 1
}
[[ -d "$VENV_DIR" ]] || {
  echo "ERROR: venv missing — run ./flatpak/regenerate-sources.sh first (it creates the venv)" >&2
  exit 1
}

if (( CLEAN )); then
  echo "==> Wiping $BUILD_ROOT"
  rm -rf "$BUILD_ROOT"
fi
mkdir -p "$BUILD_ROOT"

# --- Patch manifest: replace the git source with a dir source ---
echo "==> Generating dev manifest at $DEV_MANIFEST"
PROJECT_ROOT="$PROJECT_ROOT" SRC_MANIFEST="$SRC_MANIFEST" DEV_MANIFEST="$DEV_MANIFEST" \
  "$VENV_DIR/bin/python" - <<'PY'
import os, yaml

src = os.environ['SRC_MANIFEST']
dst = os.environ['DEV_MANIFEST']
project_root = os.environ['PROJECT_ROOT']

with open(src) as f:
    manifest = yaml.safe_load(f)

for module in manifest['modules']:
    if not isinstance(module, dict):
        continue
    if module.get('name') != 'penguin-citizen':
        continue
    new_sources = []
    git_replaced = False
    for s in module.get('sources', []):
        if isinstance(s, dict) and s.get('type') == 'git':
            new_sources.append({
                'type': 'dir',
                'path': project_root,
                # Skip large generated trees that should not enter the build sandbox.
                'skip': [
                    'node_modules',
                    'dist',
                    'src-tauri/target',
                    'flatpak/.build',
                    'Packages',
                    '.vite',
                ],
            })
            git_replaced = True
        else:
            new_sources.append(s)
    if not git_replaced:
        raise SystemExit('No git source found in penguin-citizen module — manifest layout changed?')
    module['sources'] = new_sources
    break
else:
    raise SystemExit('penguin-citizen module not found in manifest')

with open(dst, 'w') as f:
    yaml.safe_dump(manifest, f, sort_keys=False, default_flow_style=False)
PY

# --- Build ---
BUILDER_ARGS=(
  --user
  --force-clean
  --state-dir "$STATE_DIR"
  --ccache
)
if (( INSTALL )); then
  BUILDER_ARGS+=( --install )
fi

echo "==> Running flatpak-builder"
echo "    manifest: $DEV_MANIFEST"
echo "    build:    $BUILD_DIR"
( cd "$SCRIPT_DIR" && \
  flatpak-builder "${BUILDER_ARGS[@]}" "$BUILD_DIR" "$DEV_MANIFEST" )

if (( RUN )); then
  echo "==> Launching $APP_ID"
  flatpak run --user "$APP_ID"
fi

# Dev manifest is a throwaway derived from the committed manifest;
# remove it so it doesn't get mistaken for the canonical one.
rm -f "$DEV_MANIFEST"
