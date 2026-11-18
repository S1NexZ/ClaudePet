import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModels, pickModel, MODEL_ID, DEFAULT_MODEL } from './registry.js';

const root = () => mkdtempSync(join(tmpdir(), 'reg-'));
const model = (base: string, id: string, meta: object | string = { id, displayName: id.toUpperCase() }) => {
  mkdirSync(join(base, id), { recursive: true });
  writeFileSync(join(base, id, 'pet.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
};

describe('model registry', () => {
  it('lists bundled then user models with their metadata; bundled ones are marked', () => {
    const b = root(), u = root();
    model(b, 'clawd', { id: 'clawd', displayName: 'Clawd', description: 'd', source: 'codex-pets.net' });
    model(u, 'mine', { displayName: 'Mine' });
    const l = listModels(b, u);
    expect(l.map((m) => [m.id, m.name, m.bundled, m.source])).toEqual([['clawd', 'Clawd', true, 'codex-pets.net'], ['mine', 'Mine', false, '']]);
  });
  it('ignores temp folders, odd names, files, broken pet.json; a user model cannot shadow a bundled id', () => {
    const b = root(), u = root();
    model(b, 'clawd');
    model(u, 'clawd', { displayName: 'Impostor' });
    model(u, '.tmp-123');
    model(u, 'Bad Name');
    model(u, 'broken', '{nope');
    writeFileSync(join(u, 'stray.txt'), 'x');
    const l = listModels(b, u);
    expect(l.map((m) => m.id)).toEqual(['clawd']);
    expect(l[0].name).toBe('CLAWD');
  });
  it('missing folders give an empty list', () => expect(listModels('/nonexistent/a', '/nonexistent/b')).toEqual([]));
  it('Claude-maiden is the default on a fresh install; a missing choice (e.g. the removed Clawd) falls back to it', () => {
    const b = root(); model(b, 'claude-maiden'); model(b, 'other');
    const l = listModels(b, root());
    expect(DEFAULT_MODEL).toBe('claude-maiden');
    expect(pickModel(l, undefined)?.id).toBe('claude-maiden');
    expect(pickModel(l, 'other')?.id).toBe('other');
    expect(pickModel(l, 'clawd')?.id).toBe('claude-maiden');
    expect(pickModel([], 'x')).toBeNull();
  });
  it('model ids are plain folder names', () => {
    for (const ok of ['clawd', 'a', 'shy-miku', '0abc']) expect(MODEL_ID.test(ok)).toBe(true);
    for (const bad of ['', '-x', 'A', 'a b', '../x', 'a/b', 'a\\b', 'a.b', 'x'.repeat(41), '.tmp']) expect(MODEL_ID.test(bad)).toBe(false);
  });
  it('the bundled default pack is shown as cPet (no "Claude" in a feature name); a user pack keeps its own name', () => {
    const b = root(); model(b, 'claude-maiden');
    const u = root(); model(u, 'mine');
    const l = listModels(b, u);
    expect(l.find((m) => m.id === 'claude-maiden')?.name).toBe('cPet');
    expect(l.find((m) => m.id === 'mine')?.name).not.toBe('cPet');
  });
});
