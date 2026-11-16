#!/usr/bin/env bash
# Launch (or summon, if already running) Claude Pet: the installed app if present, else the repo build.
set -euo pipefail
LAD=$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
EXE="$LAD/Programs/claude-pet/Claude Pet.exe"
if [ -f "$EXE" ]; then
  cd "$(dirname "$EXE")" && exec "./Claude Pet.exe"
fi
exec bash "$(dirname "$0")/start.sh"
