#!/usr/bin/env bash
# Launch (or summon, if already running) ccPet: the installed app if present, else the repo build.
set -euo pipefail
LAD=$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
EXE="$LAD/Programs/claude-pet/ccPet.exe"
[ -f "$EXE" ] || EXE="$LAD/Programs/claude-pet/Claude Pet.exe"   # versions before the rename
if [ -f "$EXE" ]; then
  cd "$(dirname "$EXE")" && exec "./$(basename "$EXE")"
fi
exec bash "$(dirname "$0")/start.sh"
