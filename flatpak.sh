#!/usr/bin/env bash
#
# Penguin Citizen — single Flatpak command.
#
# One entry point for the entire Flatpak workflow: dev iteration, source
# regeneration, full release pipeline, and Flathub submission. Subcommands
# map onto helpers under flatpak/, so this script stays small and the
# heavy logic remains in one place per concern.
#
# Usage:
#   ./flatpak.sh [command] [args...]
#
# Commands:
#   dev [--clean]              Build, install --user, and run. Default if
#                              no command is given.
#   build [--clean]            Build only (no install, no run).
#   install [--clean]          Build and install --user (no run).
#   regen                      Regenerate cargo-sources.json and node-sources.json
#                              (only needed after Cargo.lock or package-lock.json
#                              change).
#   release VERSION [flags]    Full release pipeline. Bumps versions, refreshes
#                              lockfiles, regenerates sources, pins manifest tag,
#                              builds, optionally bundles/installs/publishes,
#                              git-tags, pushes origin.
#                              Flags: --install --bundle --publish-flathub
#                                     --no-build --no-tag --no-deps-bump
#                                     --clean --skip-tree-check --dry-run
#   flathub-init               First-time submission to github.com/flathub/flathub.
#                              Forks if needed, copies all submission files,
#                              opens the PR. Requires the gh CLI authenticated.
#   flathub-update VERSION     Push update to your already-merged Flathub repo.
#                              Same as: release VERSION --publish-flathub
#   help                       Show this help.
#
# Examples:
#   ./flatpak.sh                                    # dev test cycle
#   ./flatpak.sh dev --clean                        # wipe build cache first
#   ./flatpak.sh release 0.5.5                      # cut a release
#   ./flatpak.sh release 0.5.5 --install --bundle   # release + .flatpak file
#   ./flatpak.sh flathub-init                       # one-time submission
#   ./flatpak.sh flathub-update 0.5.6               # subsequent updates

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

usage() { sed -n '3,42p' "$0"; }

cmd="${1:-dev}"
shift || true

case "$cmd" in
  dev|test)
    exec ./flatpak/build-local.sh --run "$@"
    ;;
  build)
    exec ./flatpak/build-local.sh "$@"
    ;;
  install)
    exec ./flatpak/build-local.sh --install "$@"
    ;;
  regen|regenerate|sources)
    exec ./flatpak/regenerate-sources.sh "$@"
    ;;
  release)
    exec ./flatpak/release.sh "$@"
    ;;
  flathub-init|flathub-submit)
    exec ./flatpak/flathub-init.sh "$@"
    ;;
  flathub-update)
    exec ./flatpak/release.sh --publish-flathub "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "unknown command: $cmd" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
