import { describe, it, expect } from 'vitest';
import { newerVersion, checkLatest, RELEASES_API } from './updates.js';

describe('update check', () => {
  it('compares versions numerically; a v prefix and pre-release tags are handled', () => {
    expect(newerVersion('0.5.1', '0.5.0')).toBe(true);
    expect(newerVersion('v0.10.0', '0.9.9')).toBe(true);
    expect(newerVersion('0.5.0', '0.5.0')).toBe(false);
    expect(newerVersion('0.4.9', '0.5.0')).toBe(false);
    expect(newerVersion('1.0.0-beta.1', '0.9.0')).toBe(true);
    expect(newerVersion('0.6.0-beta.1', '0.6.0')).toBe(false); // a pre-release of the installed version is not an update
    expect(newerVersion('garbage', '0.5.0')).toBe(false);
  });
  it('asks only the public releases endpoint, with a generic client name and nothing about the user', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const r = await checkLatest('0.5.0', async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ tag_name: 'v0.5.1', html_url: 'https://github.com/S1NexZ/ccPet/releases/tag/v0.5.1', draft: false, prerelease: false }) } as any; });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RELEASES_API);
    expect(calls[0].init.headers['User-Agent']).toBe('ccPet-update-check');
    expect(Object.keys(calls[0].init.headers).sort()).toEqual(['Accept', 'User-Agent']);
    expect(r).toEqual({ version: '0.5.1', url: 'https://github.com/S1NexZ/ccPet/releases/tag/v0.5.1' });
  });
  it('no update, an odd answer, a non-GitHub link or a network error: null (never throws)', async () => {
    const ans = (j: any, ok = true) => async () => ({ ok, json: async () => j }) as any;
    expect(await checkLatest('0.5.0', ans({ tag_name: 'v0.5.0', html_url: 'https://github.com/x' }))).toBeNull();
    expect(await checkLatest('0.5.0', ans({ tag_name: 'v9.0.0', html_url: 'https://evil.example/ccPet' }))).toBeNull();
    expect(await checkLatest('0.5.0', ans({}, false))).toBeNull();
    expect(await checkLatest('0.5.0', ans({ tag_name: 'v9.0.0', html_url: 'https://github.com/S1NexZ/ccPet/releases/tag/v9.0.0', draft: true }))).toBeNull();
    expect(await checkLatest('0.5.0', async () => { throw new Error('offline'); })).toBeNull();
  });
});
