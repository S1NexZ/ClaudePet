// Compiles helper/PetHelper.cs into ui/helper/pet-helper.exe with the .NET Framework compiler every Windows has (no SDK needed).
// Works from Windows or from WSL (through cmd.exe). Skips quietly when csc.exe is not there: the app then runs without the mailbox waiter.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'helper', 'PetHelper.cs');
const outDir = join(root, 'ui', 'helper');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'pet-helper.exe');
const wsl = process.platform !== 'win32';
const win = (p) => (wsl ? execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim() : p);
const csc = wsl ? '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' : join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) { console.log('csc.exe not found: pet-helper.exe not built'); process.exit(0); }
const args = ['/nologo', '/optimize+', '/target:exe', `/out:${win(out)}`, win(src)];
execFileSync(csc, args, { stdio: 'inherit' });
console.log('built', out);
