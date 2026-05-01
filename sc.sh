#!/usr/bin/env bash
# Penguin Citizen — Release-Build starten (EAC-tauglich für Star Citizen)
#
# Baut IMMER frisch und startet das Release-Binary. Dieser Pfad wird nur
# aufgerufen, wenn ein echter Star-Citizen-Launch ansteht (Dev-Build triggert
# EAC-Fehler 70003), daher lohnt sich ein zusätzlicher Stale-Binary-Check nicht.
# Für UI-Iteration ohne Game-Launch ist `./dev.sh` die richtige Wahl.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

BIN="src-tauri/target/release/penguin-citizen"

echo ">> Penguin Citizen — Release-Build wird erstellt…"
echo "   (AppImage-Bundling kann am Ende fehlschlagen — egal, wir brauchen nur das Binary.)"
echo
# tauri build kann scheitern wenn linuxdeploy fehlt (AppImage-Step).
# Das Binary wird trotzdem zuverlässig gebaut. Daher den Exit-Code tolerant prüfen.
if ! npm run tauri build; then
    echo ">> Warnung: Bundling-Schritt hatte Fehler. Prüfe ob das Binary trotzdem da ist…"
fi
if [[ ! -x "$BIN" ]]; then
    echo "FEHLER: Release-Binary konnte nicht erzeugt werden ($BIN)."
    echo "Schau die obige Build-Ausgabe nach Cargo-Fehlern an."
    exit 1
fi
echo

echo ">> Penguin Citizen — Release-Build wird gestartet (Game-Launch-tauglich)…"
exec "$BIN" "$@"
