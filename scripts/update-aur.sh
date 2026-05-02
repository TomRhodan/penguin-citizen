#!/usr/bin/env bash
# Updates the penguin-citizen-bin AUR package to the latest GitHub release.
# Bumps pkgver/_releasetag, refreshes sha256sums, regenerates .SRCINFO,
# and prints the diff. Does NOT commit or push — the maintainer must do that
# manually after testing with `makepkg -si`. AUR rules forbid full automation
# of pushes; this script keeps the human in the loop.
#
# Usage:
#   ./scripts/update-aur.sh                 # uses default AUR_REPO path
#   AUR_REPO=/path/to/repo ./scripts/update-aur.sh

set -euo pipefail

REPO="TomRhodan/penguin-citizen"
AUR_REPO="${AUR_REPO:-$HOME/Projekte/Privat/penguin-citizen-bin}"

err() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$AUR_REPO/PKGBUILD" ] || err "PKGBUILD not found at $AUR_REPO. Set AUR_REPO env var or clone: git clone ssh://aur@aur.archlinux.org/penguin-citizen-bin.git"

for tool in curl updpkgsums makepkg git; do
    command -v "$tool" >/dev/null || err "$tool not found (install: sudo pacman -S pacman-contrib base-devel)"
done

cd "$AUR_REPO"

# Refuse to run on dirty repo — avoids mixing manual edits with the bump
if [ -n "$(git status --porcelain)" ]; then
    err "$AUR_REPO has uncommitted changes. Commit or stash first."
fi

echo "==> Fetching latest GitHub release for $REPO..."
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+' || true)
[ -n "$TAG" ] || err "could not fetch latest release tag (rate limit or network?)"
echo "    Latest tag: $TAG"

# Parse vX.Y.Z[-N] format
if [[ "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-([0-9]+))?$ ]]; then
    NEW_PKGVER="${BASH_REMATCH[1]}"
    NEW_RELEASETAG="${BASH_REMATCH[3]:-0}"
else
    err "tag '$TAG' does not match expected vX.Y.Z[-N] format"
fi

CUR_PKGVER=$(grep -oP '^pkgver=\K\S+' PKGBUILD)
CUR_RELEASETAG=$(grep -oP '^_releasetag=\K\S+' PKGBUILD)

echo "    Current PKGBUILD: pkgver=$CUR_PKGVER, _releasetag=$CUR_RELEASETAG"
echo "    Target:           pkgver=$NEW_PKGVER, _releasetag=$NEW_RELEASETAG"

if [ "$CUR_PKGVER" = "$NEW_PKGVER" ] && [ "$CUR_RELEASETAG" = "$NEW_RELEASETAG" ]; then
    echo "==> Already up to date. Nothing to do."
    exit 0
fi

echo "==> Updating PKGBUILD (pkgrel resets to 1 on pkgver bump)..."
sed -i \
    -e "s/^pkgver=.*/pkgver=$NEW_PKGVER/" \
    -e "s/^pkgrel=.*/pkgrel=1/" \
    -e "s/^_releasetag=.*/_releasetag=$NEW_RELEASETAG/" \
    PKGBUILD

echo "==> Downloading new .deb and refreshing sha256sums..."
updpkgsums

echo "==> Regenerating .SRCINFO..."
makepkg --printsrcinfo > .SRCINFO

# Drop any downloaded artifacts that .gitignore covers but rm anyway for tidiness
rm -f -- *.deb

echo
echo "==> Diff:"
git --no-pager diff --color=always PKGBUILD .SRCINFO || true
echo

cat <<EOF
==> Done. Next steps (run MANUALLY — AUR rules require human review):

    cd $AUR_REPO
    makepkg -si                            # local install test (CRITICAL — verify app launches)
    sudo pacman -Rns penguin-citizen-bin   # optional cleanup after smoke-test
    git add PKGBUILD .SRCINFO
    git commit -m "Update to v$NEW_PKGVER-$NEW_RELEASETAG"
    git push

Then verify the package page on:
    https://aur.archlinux.org/packages/penguin-citizen-bin
EOF
