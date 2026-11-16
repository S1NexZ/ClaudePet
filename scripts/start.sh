#!/usr/bin/env bash
# Dev start: builds the WSL bridge and the UI, then launches the Windows Electron window.
# The window starts the bridge inside WSL by itself. A second launch just summons the running pet.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
node daemon/build.mjs
node ui/build.mjs
exec cmd.exe /c "cd /d $(wslpath -w "$PWD/ui") && npx electron ."
