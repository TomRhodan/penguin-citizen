#!/usr/bin/env bash
# Penguin Citizen — Release-Build starten (EAC-tauglich für Star Citizen)
#
# Baut IMMER frisch und startet das Release-Binary. Dieser Pfad wird nur
# aufgerufen, wenn ein echter Star-Citizen-Launch ansteht (Dev-Build triggert
# EAC-Fehler 70003).
# Für UI-Iteration ohne Game-Launch ist `./dev.sh` die richtige Wahl.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

BIN="src-tauri/target/release/penguin-citizen"

# Zeitstempel des vorhandenen Binaries merken (0, wenn noch keins da ist).
# Damit laesst sich hinterher unterscheiden, ob dieser Lauf das Binary
# tatsaechlich angefasst hat.
mtime_of() { stat -c %Y "$1" 2>/dev/null || echo 0; }
BIN_MTIME_BEFORE="$(mtime_of "$BIN")"

echo ">> Penguin Citizen — Release-Build wird erstellt…"
echo "   (AppImage-Bundling kann am Ende fehlschlagen — egal, wir brauchen nur das Binary.)"
echo
# tauri build kann im Bundling-Schritt scheitern (z. B. fehlendes linuxdeploy).
# Das passiert NACH dem Linken, das Binary ist dann frisch und brauchbar —
# deshalb ist der Exit-Code hier tolerant.
BUILD_OK=1
if ! npm run tauri build; then
    BUILD_OK=0
fi

if [[ ! -x "$BIN" ]]; then
    echo "FEHLER: Release-Binary konnte nicht erzeugt werden ($BIN)."
    echo "Schau die obige Build-Ausgabe nach Cargo-Fehlern an."
    exit 1
fi

if [[ "$BUILD_OK" -eq 0 ]]; then
    # Scheitert der Build frueh (Dependency-Mismatch, Cargo-Fehler, Frontend-Build),
    # bleibt das alte Binary unveraendert liegen. Ohne diese Pruefung startet das
    # Skript es klaglos weiter — und man testet wochenalte Software im Glauben,
    # den aktuellen Stand vor sich zu haben.
    if [[ "$(mtime_of "$BIN")" == "$BIN_MTIME_BEFORE" ]]; then
        echo
        echo "FEHLER: Der Build ist fehlgeschlagen, BEVOR ein neues Binary entstand."
        echo "        $BIN stammt noch vom $(date -d "@$BIN_MTIME_BEFORE" '+%d.%m.%Y %H:%M') und wird NICHT gestartet."
        echo "        Die Ursache steht in der Build-Ausgabe oben."
        echo
        echo "        Haeufig: npm- und Rust-Seite eines Tauri-Plugins stehen auf"
        echo "        verschiedenen Minor-Versionen. Dann hilft im Verzeichnis src-tauri:"
        echo "            cargo update -p tauri-plugin-<name>"
        exit 1
    fi
    echo ">> Warnung: Der Build meldete einen Fehler, das Binary ist aber neu —"
    echo "   vermutlich nur der Bundling-Schritt. Weiter mit dem frischen Binary."
fi
echo

echo ">> Penguin Citizen — Release-Build wird gestartet (Game-Launch-tauglich)…"
exec "$BIN" "$@"
