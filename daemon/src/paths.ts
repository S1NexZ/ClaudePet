/** Converts a Windows (or \\wsl$ UNC) path coming from the Electron UI into a WSL path. */
export function toWslPath(p: string): string {
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+\\?(.*)$/i.exec(p);
  if (unc) return '/' + unc[1].replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^([a-zA-Z]):[\\/]*(.*)$/.exec(p);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${drive[1].toLowerCase()}${rest ? '/' + rest : ''}`;
  }
  return p;
}
