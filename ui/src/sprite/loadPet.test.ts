import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { loadPet } from './loadPet.js';

// sprites/ is a local-only folder (not in the repository): those two tests run where it exists
const hasMiku = existsSync(fileURLToPath(new URL('../../../sprites/shy-miku/pet.json', import.meta.url)));

describe('loadPet', () => {
  it.skipIf(!hasMiku)('loads the bundled shy-miku pack', async () => {
    const dir = fileURLToPath(new URL('../../../sprites/shy-miku', import.meta.url));
    const pet = await loadPet(dir);
    expect(pet.id).toBe('shy-miku');
    expect(pet.displayName.length).toBeGreaterThan(0);
    expect(pet.cell).toEqual({ w: 192, h: 208 });
    expect(pet.rows).toHaveLength(9);
    expect(pet.rows[0].frames).toBe(6);
    expect(isAbsolute(pet.image)).toBe(true);
    expect(pet.image.endsWith('spritesheet.webp')).toBe(true);
  });
  it('rejects a pack without pet.json or without the spritesheet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pet-'));
    await expect(loadPet(empty)).rejects.toThrow(/pet\.json/);
    const noSheet = mkdtempSync(join(tmpdir(), 'pet-'));
    writeFileSync(join(noSheet, 'pet.json'), JSON.stringify({ id: 'x', displayName: 'X', spritesheetPath: 'nope.webp' }));
    await expect(loadPet(noSheet)).rejects.toThrow(/nope\.webp/);
  });

  it.skipIf(!hasMiku)('reads optional tweaks.json (trim half-widths per row); bundled miku trims the idle row', async () => {
    const dir = fileURLToPath(new URL('../../../sprites/shy-miku', import.meta.url));
    expect((await loadPet(dir)).tweaks).toEqual({ trimHalfWidth: { '0': 60 } });
    const plain = mkdtempSync(join(tmpdir(), 'pet-'));
    writeFileSync(join(plain, 'pet.json'), JSON.stringify({ id: 'x', displayName: 'X', spritesheetPath: 's.webp' }));
    writeFileSync(join(plain, 's.webp'), '');
    expect((await loadPet(plain)).tweaks).toEqual({});
    writeFileSync(join(plain, 'tweaks.json'), '{broken');
    expect((await loadPet(plain)).tweaks).toEqual({});
  });
  it('a layout pack gives its own cell and rows', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pet-'));
    writeFileSync(join(d, 'pet.json'), JSON.stringify({ id: 'x', spritesheetPath: 's.webp', layout: { cell: { w: 64, h: 80 }, cols: 4, rows: [{ id: 'idle', frames: 4, loopMs: 2400 }] } }));
    writeFileSync(join(d, 's.webp'), '');
    const pet = await loadPet(d);
    expect(pet.cell).toEqual({ w: 64, h: 80 });
    expect(pet.rows).toEqual([{ id: 'idle', frames: 4, loopMs: 2400 }]);
  });
});
