import { describe, it, expect } from 'vitest';
import { parseDistroList, portForDistro, secondaryDistros } from './wslHost.js';

const LIST = `  NAME              STATE           VERSION
* Ubuntu            Running         2
  Debian            Running         2
  Ubuntu-20.04      Stopped         2
  docker-desktop    Running         2
  Old               Running         1
`;

describe('wsl distro discovery', () => {
  it('parses wsl -l -v and marks the default', () => {
    const l = parseDistroList(LIST);
    expect(l.map((d) => d.name)).toEqual(['Ubuntu', 'Debian', 'Ubuntu-20.04', 'docker-desktop', 'Old']);
    expect(l[0]).toMatchObject({ isDefault: true, running: true, version: 2 });
    expect(l[2].running).toBe(false);
  });
  it('tolerates NUL padding from UTF-16 output', () => {
    expect(parseDistroList(LIST.split('').join('\0')).length).toBe(5);
  });
  it('follows only running WSL 2 distros that are not the default or Docker\'s', () => {
    expect(secondaryDistros(parseDistroList(LIST))).toEqual(['Debian']);
  });
  it('gives a distro a stable port in 47900-47999 and skips taken ones', () => {
    const a = portForDistro('Debian', new Set());
    expect(a).toBe(portForDistro('Debian', new Set()));
    expect(a).toBeGreaterThanOrEqual(47900); expect(a).toBeLessThanOrEqual(47999);
    expect(portForDistro('Debian', new Set([a]))).not.toBe(a);
  });
});
