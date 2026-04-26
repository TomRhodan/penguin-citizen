#!/usr/bin/env bash
# Penguin Citizen — Release-Build starten (EAC-tauglich für Star Citizen)
#
# Baut bei Bedarf das Release-Binary und startet es. Nur dieser Build kann
# Star Citizen zuverlässig launchen — der Dev-Build (`npm run tauri dev`)
# triggert Easy Anti Cheat (EAC-Fehler 70003, Authentication failed).
#
# Optionen:
#   --rebuild, -r   Erzwingt Neubau auch wenn das Binary existiert.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

BIN="src-tauri/target/release/penguin-citizen"
REBUILD=0

if [[ "${1:-}" == "--rebuild" || "${1:-}" == "-r" ]]; then
    REBUILD=1
fi

if [[ ! -x "$BIN" || "$REBUILD" -eq 1 ]]; then
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
fi

echo ">> Penguin Citizen — Release-Build wird gestartet (Game-Launch-tauglich)…"
exec "$BIN" "$@"
