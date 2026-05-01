#!/usr/bin/env bash
#
# Penguin Citizen — Flatpak release pipeline.
#
# Single command to bump the version, regenerate offline sources, build the
# Flatpak, and (optionally) install it, produce a .flatpak bundle, or open a
# Flathub update PR. Defaults to a quick build-and-install loop; flags layer
# in the heavier deploy steps as needed.
#
# Usage:
#   ./flatpak/release.sh [flags] <version>
#
# Examples:
#   ./flatpak/release.sh 0.5.5                       # bump, build, tag, push
#   ./flatpak/release.sh --install 0.5.5             # also install --user
#   ./flatpak/release.sh --bundle 0.5.5              # produce .flatpak bundle
#   ./flatpak/release.sh --publish-flathub 0.5.5     # also open Flathub PR
#   ./flatpak/release.sh --dry-run 0.5.5             # plan only, change nothing
#
# Flags:
#   --install            Install the built Flatpak as --user
#   --bundle             Produce flatpak/dist/penguin-citizen-<v>.flatpak
#   --publish-flathub    Push the manifest update to the Flathub fork (see notes)
#   --no-build           Skip the build step (e.g. just bump + tag)
#   --no-tag             Skip git tag + push (default: tag and push origin)
#   --no-deps-bump       Skip cargo update / npm install --package-lock-only
#   --clean              Wipe flatpak/.build before building
#   --skip-tree-check    Allow dirty working tree (other-than-bumped files)
#   --dry-run            Print the plan, don't change anything
#
# Notes on --publish-flathub:
#   The Flathub fork must already exist locally. Set FLATHUB_REPO=/path/to/fork
#   in the environment, or it falls back to ../flathub-de.penguincitizen.penguincitizen.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
APP_ID="de.penguincitizen.penguincitizen"
SRC_MANIFEST="$SCRIPT_DIR/$APP_ID.yml"
DIST_DIR="$SCRIPT_DIR/dist"
BUILD_ROOT="$SCRIPT_DIR/.build"
RELEASE_REPO="$BUILD_ROOT/release-repo"
RELEASE_BUILD="$BUILD_ROOT/release-build"
STATE_DIR="$BUILD_ROOT/state"
VENV_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/penguin-citizen/flatpak-tools/venv"

INSTALL=0
BUNDLE=0
PUBLISH=0
DO_BUILD=1
DO_TAG=1
DO_DEPS_BUMP=1
CLEAN=0
SKIP_TREE_CHECK=0
DRY_RUN=0
VERSION=""

usage() { sed -n '3,30p' "$0"; }

for arg in "$@"; do
  case "$arg" in
    --install)          INSTALL=1 ;;
    --bundle)           BUNDLE=1 ;;
    --publish-flathub)  PUBLISH=1 ;;
    --no-build)         DO_BUILD=0 ;;
    --no-tag)           DO_TAG=0 ;;
    --no-deps-bump)     DO_DEPS_BUMP=0 ;;
    --clean)            CLEAN=1 ;;
    --skip-tree-check)  SKIP_TREE_CHECK=1 ;;
    --dry-run)          DRY_RUN=1 ;;
    -h|--help)          usage; exit 0 ;;
    -*)                 echo "unknown flag: $arg" >&2; usage; exit 2 ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "version specified twice: '$VERSION' and '$arg'" >&2
        exit 2
      fi
      VERSION="$arg"
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "ERROR: version argument required (e.g. 0.5.5)" >&2
  usage
  exit 2
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "ERROR: '$VERSION' is not a valid SemVer (X.Y.Z[-tag])" >&2
  exit 2
fi
TAG="v$VERSION"

# ----- helpers -----------------------------------------------------------

step() { printf '\n==> %s\n' "$*"; }
run()  {
  if (( DRY_RUN )); then printf '   [dry-run] %s\n' "$*"
  else "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null || { echo "ERROR: $1 not installed" >&2; exit 1; }
}

# Edit a file in-place via Python for safe JSON/TOML/YAML handling.
py_edit() {
  if (( DRY_RUN )); then
    printf '   [dry-run] py_edit on %s\n' "$1"
    return 0
  fi
  local file="$1"; shift
  local script="$1"; shift
  FILE="$file" "$VENV_DIR/bin/python" -c "$script"
}

# ----- pre-flight -------------------------------------------------------

require_cmd git
require_cmd flatpak-builder
[[ -d "$VENV_DIR" ]] || {
  echo "ERROR: venv missing — run ./flatpak/regenerate-sources.sh once first" >&2
  exit 1
}

cd "$PROJECT_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: not inside a git working tree at $PROJECT_ROOT" >&2
  exit 1
}

# Files this script is expected to modify — anything else dirty means the
# user has uncommitted work that should be settled before a release.
EXPECTED_DIRTY=(
  "package.json"
  "package-lock.json"
  "src-tauri/Cargo.toml"
  "src-tauri/Cargo.lock"
  "src-tauri/tauri.conf.json"
  "flatpak/${APP_ID}.yml"
  "flatpak/cargo-sources.json"
  "flatpak/node-sources.json"
  "CHANGELOG.md"
  "README.md"
)

if (( ! SKIP_TREE_CHECK )); then
  unexpected=$(git status --porcelain | awk '{print $2}' | while read -r f; do
    keep=1
    for ok in "${EXPECTED_DIRTY[@]}"; do
      [[ "$f" == "$ok" ]] && keep=0
    done
    (( keep )) && echo "$f"
  done)
  if [[ -n "$unexpected" ]]; then
    echo "ERROR: working tree has uncommitted changes outside the bump set:" >&2
    echo "$unexpected" >&2
    echo "Commit or stash them first, or pass --skip-tree-check." >&2
    exit 1
  fi
fi

# Refuse to overwrite an existing tag.
if (( DO_TAG )) && git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "ERROR: git tag '$TAG' already exists. Bump to a different version." >&2
  exit 1
fi

# ----- plan summary -----------------------------------------------------

step "Release plan"
cat <<EOF
   version:        $VERSION  (tag: $TAG)
   project:        $PROJECT_ROOT
   build:          $([[ $DO_BUILD -eq 1 ]] && echo "yes" || echo "skip")
   install (--user): $([[ $INSTALL -eq 1 ]] && echo "yes" || echo "skip")
   bundle:         $([[ $BUNDLE -eq 1 ]] && echo "yes -> $DIST_DIR" || echo "skip")
   tag + push:     $([[ $DO_TAG -eq 1 ]] && echo "yes (origin)" || echo "skip")
   deps refresh:   $([[ $DO_DEPS_BUMP -eq 1 ]] && echo "cargo update + npm i" || echo "skip")
   publish flathub: $([[ $PUBLISH -eq 1 ]] && echo "yes" || echo "skip")
   dry run:        $([[ $DRY_RUN -eq 1 ]] && echo "yes — nothing will change" || echo "no")
EOF

# ----- 1. Bump versions in source files --------------------------------

step "Bumping version to $VERSION"

run py_edit "package.json" '
import json, os
p = os.environ["FILE"]
d = json.load(open(p))
d["version"] = "'"$VERSION"'"
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
'
run py_edit "package-lock.json" '
import json, os
p = os.environ["FILE"]
d = json.load(open(p))
d["version"] = "'"$VERSION"'"
if "packages" in d and "" in d["packages"]:
    d["packages"][""]["version"] = "'"$VERSION"'"
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
'
run py_edit "src-tauri/tauri.conf.json" '
import json, os
p = os.environ["FILE"]
d = json.load(open(p))
d["version"] = "'"$VERSION"'"
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
'

# Cargo.toml: only the [package] version line (other crates may have version specs).
if (( ! DRY_RUN )); then
  awk -v v="$VERSION" '
    BEGIN { in_pkg = 0; done = 0 }
    /^\[package\]/   { in_pkg = 1; print; next }
    /^\[/             { in_pkg = 0; print; next }
    in_pkg && !done && /^version[[:space:]]*=/ {
      print "version = \"" v "\""; done = 1; next
    }
    { print }
  ' src-tauri/Cargo.toml > src-tauri/Cargo.toml.new
  mv src-tauri/Cargo.toml.new src-tauri/Cargo.toml
fi

# README has a version line — best-effort sed, no fail if not present.
if (( ! DRY_RUN )) && grep -q '^Version: ' README.md 2>/dev/null; then
  sed -i "s/^Version: .*/Version: $VERSION/" README.md
fi

# ----- 2. Refresh lockfiles (optional) ---------------------------------

if (( DO_DEPS_BUMP )); then
  step "Refreshing lockfiles (cargo + npm)"
  # cargo: only the workspace member's own entry, leave dependencies pinned.
  run cargo update --manifest-path src-tauri/Cargo.toml -p penguin-citizen --offline 2>/dev/null \
    || run cargo update --manifest-path src-tauri/Cargo.toml -p penguin-citizen
  run npm install --package-lock-only --no-audit --no-fund --silent
else
  step "Skipping lockfile refresh (--no-deps-bump)"
fi

# ----- 3. Regenerate Flatpak source manifests --------------------------

step "Regenerating cargo-sources.json + node-sources.json"
run "$SCRIPT_DIR/regenerate-sources.sh"

# ----- 4. Pin the Flatpak manifest to the new tag ---------------------

step "Updating Flatpak manifest tag to $TAG"
run py_edit "$SRC_MANIFEST" '
import yaml, os
p = os.environ["FILE"]
with open(p) as f:
    raw = f.read()
m = yaml.safe_load(raw)
for module in m["modules"]:
    if isinstance(module, dict) and module.get("name") == "penguin-citizen":
        for s in module.get("sources", []):
            if isinstance(s, dict) and s.get("type") == "git":
                s["tag"] = "'"$TAG"'"
                s.pop("commit", None)  # commit gets pinned post-tag
        break
with open(p, "w") as f:
    yaml.safe_dump(m, f, sort_keys=False, default_flow_style=False)
'

# ----- 5. Local build (optional) ---------------------------------------

if (( DO_BUILD )); then
  step "Building Flatpak (release-mode, repo: $RELEASE_REPO)"
  if (( CLEAN )); then run rm -rf "$BUILD_ROOT"; fi
  run mkdir -p "$BUILD_ROOT"

  # The committed manifest references a tag that does not exist yet (we are
  # about to create it). Patch a temp manifest to point at the working tree.
  DEV_MANIFEST="$BUILD_ROOT/${APP_ID}.release.yml"
  run py_edit "$SRC_MANIFEST" '
import yaml, os
src = os.environ["FILE"]
dst = "'"$DEV_MANIFEST"'"
project_root = "'"$PROJECT_ROOT"'"
with open(src) as f:
    m = yaml.safe_load(f)
for module in m["modules"]:
    if isinstance(module, dict) and module.get("name") == "penguin-citizen":
        new_sources = []
        for s in module.get("sources", []):
            if isinstance(s, dict) and s.get("type") == "git":
                new_sources.append({
                    "type": "dir",
                    "path": project_root,
                    "skip": ["node_modules", "dist", "src-tauri/target",
                             "flatpak/.build", "flatpak/dist", "Packages", ".vite"],
                })
            else:
                new_sources.append(s)
        module["sources"] = new_sources
with open(dst, "w") as f:
    yaml.safe_dump(m, f, sort_keys=False, default_flow_style=False)
'
  # Move the dev manifest next to the source so relative paths resolve.
  RELEASE_MANIFEST="$SCRIPT_DIR/${APP_ID}.release.yml"
  run mv "$DEV_MANIFEST" "$RELEASE_MANIFEST"

  builder_args=( --user --force-clean --ccache
    --state-dir "$STATE_DIR"
    --repo "$RELEASE_REPO"
    --default-branch "stable"
  )
  if (( INSTALL )); then builder_args+=( --install ); fi

  ( cd "$SCRIPT_DIR" && \
    run flatpak-builder "${builder_args[@]}" "$RELEASE_BUILD" \
        "$(basename "$RELEASE_MANIFEST")" )

  run rm -f "$RELEASE_MANIFEST"
fi

# ----- 6. .flatpak bundle (optional) -----------------------------------

if (( BUNDLE )); then
  step "Producing .flatpak bundle"
  if (( ! DO_BUILD )); then
    echo "ERROR: --bundle requires --build (cannot bundle from an empty repo)" >&2
    exit 1
  fi
  run mkdir -p "$DIST_DIR"
  bundle_path="$DIST_DIR/penguin-citizen-$VERSION.flatpak"
  run flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
    "$RELEASE_REPO" "$bundle_path" "$APP_ID" stable
  echo "  -> $bundle_path"
fi

# ----- 7. Git tag + push (optional) ------------------------------------

if (( DO_TAG )); then
  step "Committing release artifacts and tagging $TAG"
  files_to_add=(
    "package.json" "package-lock.json"
    "src-tauri/Cargo.toml" "src-tauri/Cargo.lock"
    "src-tauri/tauri.conf.json"
    "flatpak/${APP_ID}.yml"
    "flatpak/cargo-sources.json" "flatpak/node-sources.json"
  )
  [[ -f README.md ]] && files_to_add+=("README.md")
  [[ -f CHANGELOG.md ]] && files_to_add+=("CHANGELOG.md")

  run git add "${files_to_add[@]}"
  if git diff --cached --quiet; then
    echo "  (nothing changed; not creating an empty commit)"
  else
    run git commit -m "Release $VERSION" -m "Bumps version, refreshes Flatpak source manifests, pins manifest tag to $TAG."
  fi
  run git tag -a "$TAG" -m "Penguin Citizen $VERSION"
  step "Pushing $TAG and current branch to origin"
  run git push origin HEAD
  run git push origin "$TAG"
else
  step "Skipping git tag + push (--no-tag)"
fi

# ----- 8. Flathub update PR (optional) --------------------------------

if (( PUBLISH )); then
  step "Publishing Flathub manifest update"
  FLATHUB_REPO="${FLATHUB_REPO:-$PROJECT_ROOT/../flathub-${APP_ID}}"
  if [[ ! -d "$FLATHUB_REPO/.git" ]]; then
    cat >&2 <<EOF
ERROR: FLATHUB_REPO is not a git repo: $FLATHUB_REPO

To use --publish-flathub:
  1. Fork  https://github.com/flathub/${APP_ID}  on GitHub.
  2. Clone it next to the project:
       git clone git@github.com:<you>/${APP_ID}.git ../flathub-${APP_ID}
  3. Re-run with --publish-flathub.

(Or set FLATHUB_REPO=/path/to/clone explicitly.)
EOF
    exit 1
  fi
  # Pin the commit SHA from the freshly pushed tag, if available.
  TAG_SHA=$(git rev-parse "$TAG^{commit}" 2>/dev/null || echo "")

  run cp "$SRC_MANIFEST"                 "$FLATHUB_REPO/${APP_ID}.yml"
  run cp "$SCRIPT_DIR/${APP_ID}.metainfo.xml" "$FLATHUB_REPO/${APP_ID}.metainfo.xml"
  run cp "$SCRIPT_DIR/${APP_ID}.desktop"  "$FLATHUB_REPO/${APP_ID}.desktop"
  run cp "$SCRIPT_DIR/cargo-sources.json" "$FLATHUB_REPO/cargo-sources.json"
  run cp "$SCRIPT_DIR/node-sources.json"  "$FLATHUB_REPO/node-sources.json"
  run cp -r "$SCRIPT_DIR/icons"           "$FLATHUB_REPO/icons"

  if [[ -n "$TAG_SHA" ]]; then
    run py_edit "$FLATHUB_REPO/${APP_ID}.yml" '
import yaml, os
p = os.environ["FILE"]
with open(p) as f: m = yaml.safe_load(f)
for module in m["modules"]:
    if isinstance(module, dict) and module.get("name") == "penguin-citizen":
        for s in module.get("sources", []):
            if isinstance(s, dict) and s.get("type") == "git":
                s["commit"] = "'"$TAG_SHA"'"
with open(p, "w") as f:
    yaml.safe_dump(m, f, sort_keys=False, default_flow_style=False)
'
  fi
  ( cd "$FLATHUB_REPO" && \
    run git checkout -B "release-$VERSION" && \
    run git add -A && \
    run git commit -m "Update to $VERSION" && \
    run git push --set-upstream origin "release-$VERSION" )
  cat <<EOF

Pushed branch 'release-$VERSION' to your Flathub fork. Open a PR against
https://github.com/flathub/${APP_ID} from there. Reviewers will rebuild and
merge once happy. The first time you do this you must add 'origin' to point
at your fork yourself.
EOF
fi

step "Done."
