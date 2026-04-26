#!/usr/bin/env bash
# Penguin Citizen — Development Mode
# Startet `npm run tauri dev` für UI-Iteration und Hot-Reload.
#
# WICHTIG: Mit dem Dev-Build kann Star Citizen NICHT zuverlässig gestartet werden —
# Easy Anti Cheat (EAC) lehnt Sessions aus dem Dev-Build ab (Fehler 70003,
# Authentication failed). Für tatsächliche Game-Launch-Tests `./sc.sh` nutzen.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

echo ">> Penguin Citizen — Dev-Mode"
echo "   Hot-Reload aktiv. Für Game-Launch-Tests stattdessen ./sc.sh nutzen."
echo

exec npm run tauri dev
