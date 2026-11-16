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

describe('splitLines', () => {
  it('yields complete lines and keeps the unfinished tail', () => {
    expect(splitLines('', '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitLines('{"b"', ':2}\r\n\n')).toEqual({ lines: ['{"b":2}'], rest: '' });
  });
});
