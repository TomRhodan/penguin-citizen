#!/usr/bin/env bash
#
# First-time submission of Penguin Citizen to Flathub.
#
# This is the one-shot procedure that goes against github.com/flathub/flathub
# (the submission queue), not against an app-specific Flathub repo (which
# only exists after approval). After approval, use ./flatpak.sh flathub-update
# instead.
#
# Steps:
#   1. Validate environment (gh CLI, manifest pinned to a real tag).
#   2. Fork github.com/flathub/flathub if needed.
#   3. Clone the fork to FLATHUB_SUBMISSION_FORK (defaults to ~/flathub-fork).
#   4. Branch off `new-pr`, copy all submission files, commit, push.
#   5. Open a pull request with the standard justification body.
#
# Usage:
#   ./flatpak.sh flathub-init [--reuse-branch]
#
# Environment:
#   FLATHUB_SUBMISSION_FORK   Where to clone the fork (default: ~/flathub-fork)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
APP_ID="de.penguincitizen.penguincitizen"
SRC_MANIFEST="$SCRIPT_DIR/$APP_ID.yml"
FORK_DIR="${FLATHUB_SUBMISSION_FORK:-$HOME/flathub-fork}"
APP_DIR="$FORK_DIR/$APP_ID"
BRANCH="$APP_ID"

REUSE_BRANCH=0
for arg in "$@"; do
  case "$arg" in
    --reuse-branch) REUSE_BRANCH=1 ;;
    -h|--help) sed -n '3,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# ----- pre-flight ------------------------------------------------------

step "Pre-flight checks"
command -v gh >/dev/null || {
  cat >&2 <<EOF
ERROR: gh (GitHub CLI) is not installed.
  Arch:  sudo pacman -S github-cli
  Then:  gh auth login
EOF
  exit 1
}
gh auth status >/dev/null 2>&1 || {
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
}

# Confirm the manifest references a real upstream tag (not v0.5.5 placeholder).
manifest_tag=$(grep -E '^\s*tag:' "$SRC_MANIFEST" | head -1 | awk '{print $2}' | tr -d "'\"")
if [[ -z "$manifest_tag" ]]; then
  echo "ERROR: cannot find tag: line in $SRC_MANIFEST" >&2
  exit 1
fi
( cd "$PROJECT_ROOT" && git rev-parse --verify "$manifest_tag" >/dev/null 2>&1 ) || {
  cat >&2 <<EOF
ERROR: manifest pins tag '$manifest_tag' but it does not exist locally.
Run a release first to create and push the tag:
    ./flatpak.sh release ${manifest_tag#v}
EOF
  exit 1
}
( cd "$PROJECT_ROOT" && git ls-remote --tags origin "$manifest_tag" | grep -q "$manifest_tag" ) || {
  echo "ERROR: tag '$manifest_tag' is not pushed to origin yet (Flathub clones from origin)." >&2
  exit 1
}

# Pin the commit too, so Flathub gets a fully reproducible build.
manifest_commit=$( cd "$PROJECT_ROOT" && git rev-parse "$manifest_tag^{commit}" )
echo "  manifest tag:    $manifest_tag"
echo "  manifest commit: $manifest_commit"

# ----- fork + clone ---------------------------------------------------

step "Fork + clone flathub/flathub into $FORK_DIR"
gh_user=$(gh api user --jq .login)
fork_repo="$gh_user/flathub"

if ! gh repo view "$fork_repo" >/dev/null 2>&1; then
  echo "  forking flathub/flathub to $fork_repo"
  gh repo fork flathub/flathub --clone=false --remote=false
else
  echo "  fork $fork_repo already exists"
fi

if [[ ! -d "$FORK_DIR/.git" ]]; then
  git clone --branch=new-pr "git@github.com:$fork_repo.git" "$FORK_DIR"
else
  echo "  clone $FORK_DIR already exists, pulling latest new-pr"
  ( cd "$FORK_DIR" && git fetch origin new-pr && git checkout new-pr && git reset --hard origin/new-pr )
fi

# ----- branch + copy files -------------------------------------------

step "Preparing branch $BRANCH"
cd "$FORK_DIR"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  if (( REUSE_BRANCH )); then
    git checkout "$BRANCH"
    git reset --hard new-pr
  else
    cat >&2 <<EOF
ERROR: branch $BRANCH already exists in the fork.
  Use --reuse-branch to overwrite, or delete it first:
    cd $FORK_DIR && git branch -D $BRANCH
EOF
    exit 1
  fi
else
  git checkout -b "$BRANCH" new-pr
fi

step "Copying submission files into $APP_DIR"
mkdir -p "$APP_DIR"
cp "$SRC_MANIFEST"                            "$APP_DIR/$APP_ID.yml"
cp "$SCRIPT_DIR/$APP_ID.metainfo.xml"         "$APP_DIR/$APP_ID.metainfo.xml"
cp "$SCRIPT_DIR/$APP_ID.desktop"              "$APP_DIR/$APP_ID.desktop"
cp "$SCRIPT_DIR/cargo-sources.json"           "$APP_DIR/cargo-sources.json"
cp "$SCRIPT_DIR/node-sources.json"            "$APP_DIR/node-sources.json"
cp -r "$SCRIPT_DIR/icons"                     "$APP_DIR/icons"

# Pin the commit SHA in the copied manifest (for reproducibility — required
# by Flathub).
"${XDG_CACHE_HOME:-$HOME/.cache}/penguin-citizen/flatpak-tools/venv/bin/python" - <<PY
import yaml
p = "$APP_DIR/$APP_ID.yml"
with open(p) as f: m = yaml.safe_load(f)
for module in m["modules"]:
    if isinstance(module, dict) and module.get("name") == "penguin-citizen":
        for s in module.get("sources", []):
            if isinstance(s, dict) and s.get("type") == "git":
                s["commit"] = "$manifest_commit"
with open(p, "w") as f:
    yaml.safe_dump(m, f, sort_keys=False, default_flow_style=False)
PY

# ----- commit + push -------------------------------------------------

step "Committing + pushing to fork"
git add "$APP_ID"
git commit -m "Add $APP_ID"
git push --set-upstream origin "$BRANCH"

# ----- open PR -------------------------------------------------------

step "Opening pull request against flathub/flathub"
pr_body=$(cat <<EOF
Submission for Penguin Citizen — a Tauri 2 launcher for Star Citizen on Linux.
It manages Wine/Proton runners, Wine prefixes, and Star-Citizen config files
(USER.cfg, actionmaps.xml, attributes.xml). Same use case as Heroic Games
Launcher and Lutris.

Manifest pinned to:
- tag: \`$manifest_tag\`
- commit: \`$manifest_commit\`

### Permission justifications

- \`--filesystem=home\`: user-chosen Wine prefix and game install paths,
  same pattern as Heroic / Lutris / Bottles.
- \`--filesystem=/run/media\`, \`/mnt\`, \`/media\`: external drives where
  game files commonly live.
- \`--device=all\`: Star Citizen and many Wine games need direct access to
  joystick/gamepad devices under /dev/input/event*.
- \`--socket=x11\`: XWayland required for Wine and the Electron-based RSI
  Launcher even on Wayland sessions.
- \`--system-talk-name=org.freedesktop.UDisks2\`: Wine enumerates host disks
  via UDisks2 to expose NTFS mounts as drive letters (D:, E:, ...).
- \`--allow=multiarch\`: Star-Citizen Wine setup pulls in 32-bit components.
- \`--allow=devel\`: Wine's thread tracking + Electron's multi-process
  renderer need ptrace.
- \`--allow=bluetooth\`: Wine queries Bluetooth for controller discovery.
- \`--share=network\`: required for downloading Wine/Proton runners,
  DXVK builds, RSI news feed, and GitHub-released metadata.

### Sandboxed-aware behavior

The pkexec-based system tweaks (vm.max_map_count, file-max) are gated behind
a sandbox check and presented as copy-paste sudo commands instead of
attempting to elevate from inside the sandbox.

### Build

Offline sources are generated with flatpak-cargo-generator and
flatpak-node-generator (committed alongside the manifest).
EOF
)

if gh pr create \
    --repo flathub/flathub \
    --base new-pr \
    --head "$gh_user:$BRANCH" \
    --title "Add $APP_ID" \
    --body "$pr_body"; then
  echo
  echo "Done. The PR is open. Reviewers will respond in 2–4 weeks."
  echo "Trigger a CI rebuild any time with the comment: @flathubbot build"
else
  cat <<EOF

Push succeeded but \`gh pr create\` failed (perhaps a PR already exists,
or you don't have permission to mention the upstream). Open it manually:
  https://github.com/flathub/flathub/compare/new-pr...$gh_user:$BRANCH?expand=1
EOF
fi
