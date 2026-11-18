// macOS refuses unsigned apps on Apple Silicon ("ccPet is damaged").
// Without a Developer ID we sign ad-hoc after packing, before dmg/zip are made.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
