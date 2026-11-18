// Runs after the app is packed, before installers are made.
const { execFileSync } = require('node:child_process');
const { renameSync, writeFileSync, chmodSync } = require('node:fs');
const path = require('node:path');

// Linux: Chromium's sandbox needs either a setuid-root chrome-sandbox (the .deb sets it on install) or unprivileged
// user namespaces, which Ubuntu 24.04+ blocks for unconfined apps: an AppImage then dies at start. A tiny launcher
// keeps the sandbox where it works and runs without it otherwise. It stays out of the way in node mode (hooks).
const LAUNCHER = (bin) => `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
if [ -n "$ELECTRON_RUN_AS_NODE" ]; then exec "$HERE/${bin}" "$@"; fi
SB="$HERE/chrome-sandbox"
if [ -u "$SB" ] && [ "$(stat -c %u "$SB" 2>/dev/null)" = 0 ]; then exec "$HERE/${bin}" "$@"; fi
exec "$HERE/${bin}" --no-sandbox "$@"
`;

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'linux') {
    const exe = path.join(ctx.appOutDir, ctx.packager.executableName);
    renameSync(exe, `${exe}.bin`);
    writeFileSync(exe, LAUNCHER(`${ctx.packager.executableName}.bin`));
    chmodSync(exe, 0o755);
  }
  // macOS refuses unsigned apps on Apple Silicon ("ccPet is damaged"): without a Developer ID, sign ad-hoc
  if (ctx.electronPlatformName === 'darwin') {
    const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  }
};
