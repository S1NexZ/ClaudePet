import { describe, it, expect } from 'vitest';
import { wslBridgeArgs, splitLines } from './bridgeLaunch.js';

describe('wslBridgeArgs', () => {
  it('runs node on the bridge file converted to a WSL path, preferring ~/.local/node', () => {
    const a = wslBridgeArgs('C:\\Users\\v\\AppData\\Local\\Programs\\Claude Pet\\resources\\bridge\\bridge.cjs');
    expect(a.slice(0, 3)).toEqual(['-e', 'bash', '-c']);
    expect(a[3]).toContain('$HOME/.local/node/bin/node');
    expect(a[3]).toContain('command -v node');
    expect(a[3]).toContain(`exec "$N" '/mnt/c/Users/v/AppData/Local/Programs/Claude Pet/resources/bridge/bridge.cjs'`);
  });
  it('quotes apostrophes in the path', () => {
    expect(wslBridgeArgs("D:\\it's\\bridge.cjs")[3]).toContain(`'/mnt/d/it'\\''s/bridge.cjs'`);
  });
});

describe('wslBridgeArgs for another distro', () => {
  it('targets the distro, gets its own hook port and does not poll usage', () => {
    const a = wslBridgeArgs('C:\\b\\bridge.cjs', { distro: 'Debian', port: 47930, noUsage: true });
    expect(a.slice(0, 4)).toEqual(['-d', 'Debian', '-e', 'bash']);
    const script = a[a.length - 1];
    expect(script).toContain('export CLAUDE_PET_HOOK_PORT=47930;');
    expect(script).toContain('export CLAUDE_PET_LIVE_USAGE=0;');
  });
});

describe('splitLines', () => {
  it('yields complete lines and keeps the unfinished tail', () => {
    expect(splitLines('', '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitLines('{"b"', ':2}\r\n\n')).toEqual({ lines: ['{"b":2}'], rest: '' });
  });
});
