#!/usr/bin/env bash
# Publishes blueprint data for the installed Star Citizen build.
#
# Meant to run unattended from a systemd user timer. It does nothing at all
# while the installed build already has data, which is the normal case - only a
# game patch gives it work.
#
# What it does when a patch has landed:
#   1. waits until the install has settled and Star Citizen is not running
#   2. builds and runs bp-extract against the local installation
#   3. lets the extractor refuse implausible output (see sanity_check there)
#   4. commits and pushes the data repository
#   5. reports by mail, if mail is configured, and to the journal either way
#
# Usage:
#   ./scripts/publish-blueprints.sh            # the real thing
#   DRY_RUN=1 ./scripts/publish-blueprints.sh  # everything except commit/push
#
# Environment:
#   SC_CHANNEL    game environment to publish      (default: LIVE)
#   DATA_REPO     path to penguin-citizen-blueprints
#   INSTALL_PATH  Star Citizen install path        (default: from the app config)
#   MAILTO        additionally mail the report     (unset: no mail)
#   NO_NOTIFY     set to 1 to suppress the desktop notification
#   SETTLE_MIN    minutes build_manifest.id must be untouched (default: 15)

set -euo pipefail

SC_CHANNEL="${SC_CHANNEL:-LIVE}"
DATA_REPO="${DATA_REPO:-$HOME/Projekte/Privat/penguin-citizen-blueprints}"
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
CONFIG="$HOME/.config/penguin-citizen/config.json"
SETTLE_MIN="${SETTLE_MIN:-15}"
MAILTO="${MAILTO:-}"
NO_NOTIFY="${NO_NOTIFY:-0}"
DRY_RUN="${DRY_RUN:-0}"

log() { echo "[blueprints] $*"; }
die() { echo "[blueprints] ERROR: $*" >&2; report "failed" "$*"; exit 1; }

# Journal always, a desktop notification when there is a session, mail on top
# if it is configured. A timer that reports only failures leaves the successful
# case invisible, and a patch day is exactly when you want to know it worked.
#
# Urgency `critical` is what keeps the notification on screen until it is
# dismissed - normal ones disappear after a few seconds and a run that happens
# while you are away would go unnoticed.
report() {
    local status="$1" body="$2"
    log "$status: $body"

    if [ "$NO_NOTIFY" != "1" ] && command -v notify-send >/dev/null; then
        local urgency=normal
        [ "$status" = "failed" ] && urgency=critical
        [ "$status" = "published" ] && urgency=critical
        notify-send --urgency="$urgency" --app-name="Penguin Citizen" \
            --icon=penguin-citizen \
            "Blueprints: $status ($SC_CHANNEL)" "$body" 2>/dev/null \
            || log "notify-send failed - no session bus?"
    fi

    if [ -n "$MAILTO" ]; then
        if command -v mail >/dev/null; then
            printf '%s\n' "$body" | mail -s "Penguin Citizen blueprints: $status ($SC_CHANNEL)" "$MAILTO" \
                || log "sending mail to $MAILTO failed"
        else
            log "MAILTO is set but no mail command exists"
        fi
    fi
}

# ── where is the game ───────────────────────────────────────────────────────

if [ -z "${INSTALL_PATH:-}" ]; then
    [ -f "$CONFIG" ] || die "no install path given and $CONFIG does not exist"
    INSTALL_PATH=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('install_path',''))" "$CONFIG")
    [ -n "$INSTALL_PATH" ] || die "config.json has no install_path"
fi

MANIFEST="$INSTALL_PATH/drive_c/Program Files/Roberts Space Industries/StarCitizen/$SC_CHANNEL/build_manifest.id"
[ -f "$MANIFEST" ] || die "no build_manifest.id at $MANIFEST"

BUILD=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['Data']['Version'])" "$MANIFEST") \
    || die "could not read the build id from $MANIFEST"

# ── is there anything to do ─────────────────────────────────────────────────

INDEX="$DATA_REPO/index.json"
if [ -f "$INDEX" ] && python3 - "$INDEX" "$SC_CHANNEL" "$BUILD" <<'PY'
import json, sys
index, channel, build = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(index))
builds = {b["build"] for b in data.get("channels", {}).get(channel, {}).get("builds", [])}
sys.exit(0 if build in builds else 1)
PY
then
    log "build $BUILD already published for $SC_CHANNEL, nothing to do"
    exit 0
fi

log "new build detected: $SC_CHANNEL $BUILD"

# ── is it safe to read ──────────────────────────────────────────────────────

# A patch rewrites Data.p4k while it runs. Extracting then yields garbage at
# best, so wait until nothing has touched the manifest for a while.
if [ -n "$(find "$MANIFEST" -mmin "-$SETTLE_MIN" 2>/dev/null)" ]; then
    log "build_manifest.id changed within the last $SETTLE_MIN minutes, waiting for the next run"
    exit 0
fi

if pgrep -f "StarCitizen_Launcher|RSI Launcher|StarCitizen.exe" >/dev/null 2>&1; then
    log "Star Citizen is running, waiting for the next run"
    exit 0
fi

[ -d "$DATA_REPO/.git" ] || die "$DATA_REPO is not a git repository"
if [ -n "$(git -C "$DATA_REPO" status --porcelain)" ]; then
    die "$DATA_REPO has uncommitted changes - refusing to mix them with an automated publish"
fi

# ── extract ─────────────────────────────────────────────────────────────────

cd "$APP_DIR"
log "building bp-extract"
cargo build --release --manifest-path src-tauri/Cargo.toml --bin bp-extract --features bp-extract \
    >/dev/null 2>&1 || die "bp-extract does not build - the tool is not covered by CI, so a change in the lib can break it"

log "extracting $SC_CHANNEL $BUILD"
OUTPUT=$(./src-tauri/target/release/bp-extract "$INSTALL_PATH" "$SC_CHANNEL" --publish "$DATA_REPO" 2>&1) \
    || die "extraction refused or failed:"$'\n'"$OUTPUT"

SUMMARY=$(printf '%s\n' "$OUTPUT" | sed -n '/=== publication ===/,$p')

if [ -z "$(git -C "$DATA_REPO" status --porcelain)" ]; then
    report "no change" "Build $BUILD produced data identical to what is already published."
    exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: leaving $DATA_REPO dirty, nothing committed"
    printf '%s\n' "$SUMMARY"
    exit 0
fi

# ── publish ─────────────────────────────────────────────────────────────────

git -C "$DATA_REPO" add -A
git -C "$DATA_REPO" commit -q -m "Data for Star Citizen $BUILD ($SC_CHANNEL)

Extracted automatically after the game updated to this build.

$SUMMARY" || die "commit failed"

git -C "$DATA_REPO" push -q origin HEAD || die "push failed - the commit is local, run the push by hand"

report "published" "Star Citizen $SC_CHANNEL updated to $BUILD and the blueprint data was published.

$SUMMARY"
