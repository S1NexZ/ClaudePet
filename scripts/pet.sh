#!/usr/bin/env bash
# Launch (or summon, if already running) the installed ccPet.
set -euo pipefail
LAD=$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
EXE="$LAD/ccPet/ccpet-app.exe"
[ -f "$EXE" ] || { echo "ccPet is not installed: $EXE" >&2; exit 1; }
cd "$(dirname "$EXE")" && exec "./$(basename "$EXE")"
