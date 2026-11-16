import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePack, installModelFromZip, installModelFromDir, removeModel, scanPetFolder, slugFromName, ModelError, type InstallProgress } from './install.js';
import { readZip } from './zip.js';
import { listModels } from './registry.js';
import { makeZip, goodPack, fakeWebp, fakePng } from './testZip.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'inst-'));
const dirs = () => ({ userDir: join(tmp(), 'user'), bundledDir: tmp() });
const zipFile = (entries: Parameters<typeof makeZip>[0], name = 'pack.codex-pet.zip') => { const f = join(tmp(), name); writeFileSync(f, makeZip(entries)); return f; };
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as ModelError).code; } return 'NO ERROR'; };
const validate = (entries: Parameters<typeof makeZip>[0], name = 'x.zip') => validatePack(readZip(makeZip(entries)), name);

describe('validatePack', () => {
  it('accepts a good pack and returns its id and name', () => {
    const p = validate(goodPack());
    expect([p.id, p.name, [...p.files.keys()].sort()]).toEqual(['my-pet', 'My Pet', ['pet.json', 'spritesheet.webp']]);
  });
  it('accepts a PNG sheet, tweaks.json, text docs and one wrapper folder', () => {
    const ok = validate([
      { name: 'pet/pet.json', data: JSON.stringify({ id: 'p1', spritesheetPath: 'sheet.png' }) }, { name: 'pet/sheet.png', data: fakePng(1536, 1872) },
      { name: 'pet/tweaks.json', data: '{"lightFringe":"remove"}' }, { name: 'pet/LICENSE.txt', data: 'MIT' }, { name: 'pet/README.md', data: '# hi' },
    ]);
    expect(ok.id).toBe('p1');
    expect(ok.files.has('tweaks.json')).toBe(true);
  });
  it('rejects scripts, executables and unknown files, whatever they are called', () => {
    for (const bad of ['run.exe', 'x.dll', 'setup.bat', 'a.ps1', 'x.js', 'x.sh', 'evil.html', 'logo.svg', 'x.lnk'])
      expect(code(() => validate([...goodPack(), { name: bad, data: 'x' }])), bad).toBe('risky');
    expect(code(() => validate([...goodPack(), { name: 'notes.docx', data: 'x' }]))).toBe('unsupported-file');
    expect(code(() => validate([...goodPack(), { name: 'sub/inner.txt', data: 'x' }]))).toBe('nested');
  });
  it('explains structural problems', () => {
    expect(code(() => validate([{ name: 'spritesheet.webp', data: fakeWebp(1536, 1872) }]))).toBe('no-pet-json');
    expect(code(() => validate(goodPack({ 'pet.json': '{nope' })))).toBe('bad-pet-json');
    expect(code(() => validate(goodPack({ 'pet.json': '[1]' })))).toBe('bad-pet-json');
    expect(code(() => validate(goodPack({ 'pet.json': JSON.stringify({ id: 'x', spritesheetPath: 'other.webp' }) })))).toBe('no-sheet');
    expect(code(() => validate(goodPack({ 'pet.json': JSON.stringify({ id: 'x', spritesheetPath: '../s.webp' }) })))).toBe('bad-sheet-path');
    expect(code(() => validate(goodPack({ 'pet.json': JSON.stringify({ id: 'x', spritesheetPath: 'run.exe' }) })))).toBe('bad-sheet-path');
    expect(code(() => validate(goodPack({ 'spritesheet.webp': Buffer.from('not an image at all, just text') })))).toBe('bad-image');
    expect(code(() => validate(goodPack({ 'spritesheet.webp': fakeWebp(100, 100) })))).toBe('bad-size');
    expect(code(() => validate([...goodPack(), { name: 'tweaks.json', data: '{broken' }]))).toBe('bad-tweaks');
  });
  it('the id is a plain slug; without a usable id the archive name is used, else an error', () => {
    expect(validate(goodPack({ 'pet.json': JSON.stringify({ id: 'Shy-Miku' }) })).id).toBe('shy-miku');
    expect(validate(goodPack({ 'pet.json': JSON.stringify({ id: '../etc' }) }), 'Cool Pet.codex-pet.zip').id).toBe('cool-pet');
    expect(code(() => validate(goodPack({ 'pet.json': JSON.stringify({ id: '../etc' }) }), '###.zip'))).toBe('bad-id');
    expect(slugFromName('clawd.codex-pet.zip')).toBe('clawd');
  });
});

describe('installModelFromZip', () => {
  it('installs into <user>/<id>, shows up in the registry, reports progress, leaves no temp folders', () => {
    const d = dirs(); const steps: InstallProgress[] = [];
    const info = installModelFromZip(zipFile(goodPack()), { ...d, onProgress: (p) => steps.push(p) });
    expect(info).toMatchObject({ id: 'my-pet', name: 'My Pet', bundled: false });
    expect(readdirSync(join(d.userDir, 'my-pet')).sort()).toEqual(['pet.json', 'spritesheet.webp']);
    expect(readdirSync(d.userDir)).toEqual(['my-pet']);
    expect(listModels(d.bundledDir, d.userDir).map((m) => m.id)).toEqual(['my-pet']);
    expect(steps.at(-1)).toMatchObject({ step: 'done', percent: 100 });
    expect(steps.map((s) => s.percent)).toEqual([...steps.map((s) => s.percent)].sort((a, b) => a - b)); // progress only moves forward
  });
  it('never overwrites: an installed or bundled id is refused, and a failed install leaves nothing behind', () => {
    const d = dirs();
    installModelFromZip(zipFile(goodPack()), d);
    expect(code(() => installModelFromZip(zipFile(goodPack()), d))).toBe('exists');
    mkdirSync(join(d.bundledDir, 'clawd')); writeFileSync(join(d.bundledDir, 'clawd', 'pet.json'), '{}');
    expect(code(() => installModelFromZip(zipFile(goodPack({}, 'clawd')), d))).toBe('exists');
    expect(readdirSync(d.userDir)).toEqual(['my-pet']);
    expect(code(() => installModelFromZip(zipFile([{ name: 'pet.json', data: '{}' }]), d))).not.toBe('NO ERROR');
    expect(readdirSync(d.userDir)).toEqual(['my-pet']);
  });
  it('hostile archives install nothing and write nothing outside the models folder', () => {
    const d = dirs(); const outside = join(tmp(), 'victim.txt');
    for (const entries of [
      [...goodPack(), { name: '../../victim.txt', data: 'pwned' }],
      [...goodPack(), { name: '/tmp/abs.txt', data: 'pwned' }],
      [...goodPack(), { name: 'run.exe', data: 'MZ' }],
      [...goodPack(), { name: 'link', data: '/etc/passwd', unixMode: 0o120777 }],
    ]) expect(code(() => installModelFromZip(zipFile(entries), d))).not.toBe('NO ERROR');
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(d.userDir) ? readdirSync(d.userDir) : []).toEqual([]);
  });
  it('reports unreadable, too big and not-a-zip files clearly', () => {
    const d = dirs();
    expect(code(() => installModelFromZip('/nonexistent/x.zip', d))).toBe('unreadable');
    expect(code(() => installModelFromZip(tmp(), d))).toBe('unreadable');
    const f = join(tmp(), 'junk.zip'); writeFileSync(f, 'junk junk junk junk junk junk');
    expect(code(() => installModelFromZip(f, d))).toBe('not-zip');
  });
});

describe('removeModel', () => {
  it('removes a user model only; bundled ones and odd ids are refused', () => {
    const d = dirs();
    installModelFromZip(zipFile(goodPack()), d);
    mkdirSync(join(d.bundledDir, 'clawd')); writeFileSync(join(d.bundledDir, 'clawd', 'pet.json'), '{}');
    expect(code(() => removeModel('clawd', d))).toBe('bundled');
    for (const bad of ['../x', '..', 'a/b', '', 'A']) expect(code(() => removeModel(bad, d))).toBe('bad-id');
    expect(code(() => removeModel('nothing', d))).toBe('missing');
    removeModel('my-pet', d);
    expect(existsSync(join(d.userDir, 'my-pet'))).toBe(false);
    expect(existsSync(join(d.bundledDir, 'clawd', 'pet.json'))).toBe(true);
  });
});

describe('npm/Codex pet folders', () => {
  const petFolder = (root: string, id: string, extra: Record<string, string> = {}) => {
    const p = join(root, id); mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'pet.json'), JSON.stringify({ id, displayName: id.toUpperCase() })); writeFileSync(join(p, 'spritesheet.webp'), fakeWebp(1536, 1872));
    for (const [n, c] of Object.entries(extra)) writeFileSync(join(p, n), c);
    return p;
  };
  it('lists pet folders and installs one by the same rules (checked copy, not a run)', () => {
    const root = tmp(); const d = dirs();
    petFolder(root, 'cat'); mkdirSync(join(root, 'junk')); writeFileSync(join(root, 'file.txt'), 'x');
    expect(scanPetFolder(root).map((f) => [f.id, f.name])).toEqual([['cat', 'CAT']]);
    expect(scanPetFolder('/nonexistent/pets')).toEqual([]);
    expect(installModelFromDir(join(root, 'cat'), d)).toMatchObject({ id: 'cat', bundled: false });
    expect(code(() => installModelFromDir(petFolder(root, 'bad', { 'run.exe': 'MZ' }), d))).toBe('risky');
    expect(code(() => installModelFromDir(join(root, 'cat'), d))).toBe('exists');
  });
  it('refuses symlinks and subfolders inside a pet folder', () => {
    const root = tmp(); const d = dirs();
    const p = petFolder(root, 'sneaky');
    symlinkSync('/etc/hostname', join(p, 'README.txt'));
    expect(code(() => installModelFromDir(p, d))).toBe('symlink');
    const q = petFolder(root, 'deep'); mkdirSync(join(q, 'sub'));
    expect(code(() => installModelFromDir(q, d))).toBe('nested');
  });
});
