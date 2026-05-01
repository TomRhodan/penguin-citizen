#!/usr/bin/env bash
#
# Regenerate cargo-sources.json and node-sources.json for the Flatpak build.
#
# These two files are committed to the repo and consumed by flatpak-builder
# during the offline source phase. They must be regenerated whenever
#   - src-tauri/Cargo.lock changes (cargo update, dependency added/removed)
#   - package-lock.json changes
# Otherwise flatpak-builder will fail with checksum mismatches or missing
# crates/packages.
#
# This script is idempotent: it caches the venv and the cargo generator
# under ~/.cache/penguin-citizen/flatpak-tools, so subsequent runs only
# regenerate the JSON outputs.
#
# Usage:  ./flatpak/regenerate-sources.sh
# Run from the project root or the flatpak/ directory.

set -euo pipefail

# --- Resolve project root regardless of where the script is invoked from ---
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
FLATPAK_DIR="$PROJECT_ROOT/flatpak"

CARGO_LOCK="$PROJECT_ROOT/src-tauri/Cargo.lock"
NODE_LOCK="$PROJECT_ROOT/package-lock.json"
CARGO_OUT="$FLATPAK_DIR/cargo-sources.json"
NODE_OUT="$FLATPAK_DIR/node-sources.json"

# --- Persistent tool cache (outside the repo) ---
TOOL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/penguin-citizen/flatpak-tools"
VENV_DIR="$TOOL_CACHE/venv"
CARGO_GEN="$TOOL_CACHE/flatpak-cargo-generator.py"
CARGO_GEN_URL="https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py"

mkdir -p "$TOOL_CACHE"

# --- Step 1: venv with the required Python packages ---
if [[ ! -d "$VENV_DIR" ]]; then
  echo "==> Creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# Always make sure the deps are present (cheap if already installed).
# flatpak-node-generator is pulled from git, not PyPI: PyPI ships an old
# release (0.1.1) that drops several packages from the lockfile output;
# the master branch fixes this.
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet \
  tomlkit aiohttp pyyaml \
  "flatpak-node-generator @ git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"

# --- Step 2: download flatpak-cargo-generator if missing ---
if [[ ! -f "$CARGO_GEN" ]]; then
  echo "==> Downloading flatpak-cargo-generator.py"
  curl -fsSL -o "$CARGO_GEN" "$CARGO_GEN_URL"
fi

# --- Step 3: regenerate cargo-sources.json ---
echo "==> Regenerating $CARGO_OUT from $CARGO_LOCK"
"$VENV_DIR/bin/python" "$CARGO_GEN" "$CARGO_LOCK" -o "$CARGO_OUT"

# --- Step 4: regenerate node-sources.json ---
echo "==> Regenerating $NODE_OUT from $NODE_LOCK"
(cd "$PROJECT_ROOT" && \
  "$VENV_DIR/bin/flatpak-node-generator" npm package-lock.json \
    -o "$NODE_OUT")

# --- Summary ---
cargo_count=$(python3 -c "import json,sys;print(len(json.load(open('$CARGO_OUT'))))")
node_count=$(python3 -c "import json,sys;print(len(json.load(open('$NODE_OUT'))))")
cargo_size=$(du -h "$CARGO_OUT" | cut -f1)
node_size=$(du -h "$NODE_OUT" | cut -f1)

echo
echo "Done."
echo "  cargo-sources.json: $cargo_count entries ($cargo_size)"
echo "  node-sources.json:  $node_count entries ($node_size)"
