import { removeLightFringe } from '../sprite/fringe.js';
import { L } from '../../../shared/src/i18n.js';
export interface PetData { id: string; name: string; imageUrl: string; cell: { w: number; h: number }; rows: { frames: number }[]; tweaks?: { trimHalfWidth?: Record<string, number>; lightFringe?: 'remove' | 'dark'; fringeCream?: boolean; stabilize?: boolean } }
export interface ModelRow { id: string; name: string; description: string; source: string; bundled: boolean; active: boolean }
interface CodexScan { dir: string; exists: boolean; found: Array<{ id: string; name: string; installed: boolean }> }
interface OpResult { ok: boolean; canceled?: boolean; error?: string; models?: ModelRow[]; model?: { id: string; name: string }; pet?: PetData | null }

export interface ModelsHost {
  models: {
    list(): Promise<ModelRow[]>;
    data(id: string): Promise<PetData | null>;
    use(id: string): Promise<OpResult>;
    installZip(path?: string): Promise<OpResult>;
    remove(id: string): Promise<OpResult>;
    codexScan(): Promise<CodexScan>;
    codexImport(id: string): Promise<OpResult>;
    onProgress(cb: (p: { step: string; percent: number; message: string }) => void): void;
    reveal(): void;
    pathForFile(f: File): string;
  };
  copyText(t: string): void;
  openUrl(u: string): void;
}

/** The documented npm installer for Codex-format pets (third party, MIT). The id is a placeholder the user fills in. */
export const NPM_COMMAND = 'npx codex-pets add <pet-id>';
export const NPM_PAGE = 'https://www.npmjs.com/package/codex-pets';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const btn = (text: string, cls: string, on: () => void, disabled = false) => {
  const b = el('button', cls, text); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', on); return b;
};

/** "Модели" tab of the settings panel: installed models (live preview, apply, remove) and an NPM / Download install section. */
export function createModelsTab(host: ModelsHost, api: { show(data: PetData): Promise<void> }) {
  let list: ModelRow[] = [];
  let loaded = false;
  let previewId: string | null = null;
  let sub: 'npm' | 'download' = 'download';
  let busy = false;
  let message: { kind: 'ok' | 'err'; text: string } | null = null;
  let progress: { percent: number; message: string } | null = null;
  let codex: CodexScan | null = null;
  const thumbs = new Map<string, string>();
  let rerender = () => {};

  const active = () => list.find((m) => m.active) ?? null;

  /** a small picture of the model (first idle frame), made once per model */
  const thumb = async (id: string) => {
    if (thumbs.has(id)) return;
    thumbs.set(id, '');
    const d = await host.models.data(id);
    if (!d) return;
    const img = new Image(); img.src = d.imageUrl;
    try { await img.decode(); } catch { return; }
    // draw the cell at full size, peel the light rim the same way the pet does, then scale down
    const full = document.createElement('canvas'); full.width = d.cell.w; full.height = d.cell.h;
    const fx = full.getContext('2d', { willReadFrequently: true })!;
    fx.drawImage(img, 0, 0, d.cell.w, d.cell.h, 0, 0, d.cell.w, d.cell.h);
    if (d.tweaks?.lightFringe) {
      const px = fx.getImageData(0, 0, d.cell.w, d.cell.h);
      removeLightFringe(px.data, d.cell.w, d.cell.h, d.tweaks.lightFringe, 3, !!d.tweaks.fringeCream);
      fx.putImageData(px, 0, 0);
    }
    const c = document.createElement('canvas'); c.width = 48; c.height = 52;
    const cx = c.getContext('2d')!; cx.imageSmoothingQuality = 'high';
    cx.drawImage(full, 0, 0, d.cell.w, d.cell.h, 0, 0, 48, 52);
    thumbs.set(id, c.toDataURL('image/png'));
    rerender();
  };

  const refresh = async () => { list = await host.models.list(); loaded = true; for (const m of list) void thumb(m.id); rerender(); };

  const preview = async (id: string) => {
    const d = await host.models.data(id);
    if (!d) { message = { kind: 'err', text: L('Не удалось загрузить модель.', 'Could not load the model.') }; rerender(); return; }
    previewId = id === active()?.id ? null : id;
    await api.show(d);
    rerender();
  };
  const cancelPreview = async () => {
    if (!previewId) return;
    previewId = null;
    const a = active();
    if (a) { const d = await host.models.data(a.id); if (d) await api.show(d); }
    rerender();
  };
  const apply = async () => {
    if (!previewId) return;
    const r = await host.models.use(previewId);
    if (r.ok && r.models) { list = r.models; previewId = null; message = { kind: 'ok', text: L('Модель применена и сохранена.', 'Model applied and saved.') }; }
    else message = { kind: 'err', text: r.error ?? L('Не удалось применить модель.', 'Could not apply the model.') };
    rerender();
  };
  const remove = async (id: string) => {
    const r = await host.models.remove(id);
    if (r.canceled) return;
    if (r.ok && r.models) {
      list = r.models; thumbs.delete(id);
      if (previewId === id) previewId = null;
      if (r.pet) await api.show(r.pet);
      message = { kind: 'ok', text: L('Модель удалена.', 'Model removed.') };
    } else message = { kind: 'err', text: r.error ?? L('Не удалось удалить модель.', 'Could not remove the model.') };
    rerender();
  };
  const afterInstall = async (r: OpResult) => {
    busy = false; progress = null;
    if (r.canceled) { rerender(); return; }
    if (r.ok && r.models && r.model) {
      list = r.models; for (const m of list) void thumb(m.id);
      message = { kind: 'ok', text: L(`Установлена: «${r.model.name}». Нажмите «Применить», чтобы оставить её.`, `Installed: “${r.model.name}”. Press Apply to keep it.`) };
      await preview(r.model.id); // shown on the pet right away; applied only on request
    } else message = { kind: 'err', text: r.error ?? L('Не удалось установить модель.', 'Could not install the model.') };
    rerender();
  };
  const installZip = async (path?: string) => { busy = true; message = null; progress = { percent: 0, message: L('Начало', 'Starting') }; rerender(); await afterInstall(await host.models.installZip(path)); };
  host.models.onProgress((p) => { if (busy) { progress = { percent: p.percent, message: p.message }; rerender(); } });

  const renderList = (box: HTMLElement) => {
    const sec = el('div', 's-section');
    sec.append(el('div', 's-title', L('Установленные модели', 'Installed models')));
    const ul = el('div', 'm-list');
    for (const m of list) {
      const shown = previewId ? m.id === previewId : m.active;
      const row = el('div', `m-row${shown ? ' on' : ''}`);
      const t = el('img', 'm-thumb') as HTMLImageElement; t.alt = ''; if (thumbs.get(m.id)) t.src = thumbs.get(m.id)!;
      const info = el('div', 'm-info');
      info.append(el('div', 'm-name', m.name), el('div', 's-hint', [m.bundled ? L('встроенная', 'built-in') : L('своя', 'custom'), m.source ? `${L('источник', 'source')}: ${m.source}` : '', m.active ? L('активна', 'active') : ''].filter(Boolean).join(' · ')));
      const acts = el('div', 'm-acts');
      acts.append(btn(shown ? L('Выбрана', 'Selected') : L('Выбрать', 'Select'), 's-btn', () => void preview(m.id), shown));
      if (!m.bundled) { const x = btn('✕', 's-btn m-del', () => void remove(m.id)); x.title = L('Удалить модель', 'Remove model'); x.setAttribute('aria-label', L(`Удалить модель ${m.name}`, `Remove model ${m.name}`)); acts.append(x); }
      row.append(t, info, acts);
      ul.append(row);
    }
    if (!list.length) ul.append(el('div', 's-hint', L('Моделей пока нет.', 'No models yet.')));
    sec.append(ul);
    if (previewId) {
      const pv = list.find((m) => m.id === previewId);
      const bar = el('div', 'm-preview');
      bar.append(el('span', '', `${L('Предпросмотр', 'Preview')}: ${pv?.name ?? previewId}`), btn(L('Применить', 'Apply'), 's-btn primary', () => void apply()), btn(L('Отмена', 'Cancel'), 's-btn', () => void cancelPreview()));
      sec.append(bar);
    }
    box.append(sec);
  };

  const renderNpm = (box: HTMLElement) => {
    box.append(el('div', 's-title', L('Установка через npm', 'Install via npm')));
    box.append(el('div', 's-hint', L('Модели формата Codex ставит сторонний пакет codex-pets (лицензия MIT, не связан с Claude Pet). Он кладёт модель в папку ~/.codex/pets, а Claude Pet устанавливает её оттуда после проверки.', 'Codex-format models are installed by the third-party package codex-pets (MIT license, not affiliated with Claude Pet). It puts the model into ~/.codex/pets and Claude Pet installs it from there after validation.')));
    const code = el('div', 'm-code');
    code.append(el('code', '', NPM_COMMAND), btn(L('Копировать', 'Copy'), 's-btn', () => { host.copyText(NPM_COMMAND); message = { kind: 'ok', text: L('Команда скопирована.', 'Command copied.') }; rerender(); }));
    box.append(code);
    box.append(el('div', 's-hint', L('Замените <pet-id> на идентификатор модели из каталога codex-pets и выполните команду в терминале Windows (PowerShell). Папка ~/.codex/pets внутри WSL приложению не видна: для неё используйте ZIP.', 'Replace <pet-id> with a model id from the codex-pets catalog and run the command in a Windows terminal (PowerShell). The ~/.codex/pets folder inside WSL is not visible to the app: use a ZIP for that.')));
    const row = el('div', 'm-line');
    row.append(btn(L('Открыть пакет на npmjs.com', 'Open the package on npmjs.com'), 's-btn', () => host.openUrl(NPM_PAGE)), btn(L('Проверить папку', 'Check folder'), 's-btn', async () => { codex = await host.models.codexScan(); rerender(); }));
    box.append(row);
    if (codex) {
      box.append(el('div', 's-hint', codex.found.length ? L(`Найдено в ${codex.dir}:`, `Found in ${codex.dir}:`) : codex.exists ? L(`В ${codex.dir} моделей не найдено.`, `No models found in ${codex.dir}.`) : L(`Папка ${codex.dir} ещё не создана (npm-установщик её создаёт).`, `The folder ${codex.dir} does not exist yet (the npm installer creates it).`)));
      for (const f of codex.found) {
        const r = el('div', 'm-line');
        r.append(el('span', 'm-name', f.name), f.installed ? el('span', 's-hint', L('уже установлена', 'already installed')) : btn(L('Установить', 'Install'), 's-btn primary', async () => {
          busy = true; message = null; progress = { percent: 0, message: L('Начало', 'Starting') }; rerender();
          const res = await host.models.codexImport(f.id); await afterInstall(res); codex = await host.models.codexScan(); rerender();
        }, busy));
        box.append(r);
      }
    }
    box.append(el('div', 's-hint', L('Claude Pet сам npm не запускает и ничего не публикует. Собственного npm-пакета моделей у Claude Pet пока нет.', 'Claude Pet never runs npm itself and publishes nothing. Claude Pet has no npm model package of its own yet.')));
  };

  const renderDownload = (box: HTMLElement) => {
    box.append(el('div', 's-title', L('Установка из ZIP-архива', 'Install from a ZIP archive')));
    const drop = el('div', 'm-drop');
    drop.append(el('div', '', L('Перетащите ZIP-архив сюда', 'Drop a ZIP archive here')), btn(L('Выбрать ZIP…', 'Choose ZIP…'), 's-btn primary', () => void installZip(), busy));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (!f || busy) return;
      const p = host.models.pathForFile(f);
      if (!p || !/\.zip$/i.test(p)) { message = { kind: 'err', text: L('Нужен файл с расширением .zip.', 'A .zip file is required.') }; rerender(); return; }
      void installZip(p);
    });
    box.append(drop);
    box.append(el('div', 's-hint', L('Нужен пак формата Codex: pet.json и лист спрайтов 1536×1872 (.webp или .png). Скрипты и исполняемые файлы запрещены, архив проверяется до установки и ничего не запускает.', 'A Codex-format pack is required: pet.json and a 1536×1872 sprite sheet (.webp or .png). Scripts and executables are not allowed; the archive is checked before installing and nothing is run.')));
    box.append(btn(L('Открыть папку моделей', 'Open models folder'), 's-link', () => host.models.reveal()));
  };

  const render = (box: HTMLElement) => {
    if (!loaded) { void refresh(); box.append(el('div', 's-hint', L('Загрузка…', 'Loading…'))); return; }
    renderList(box);
    const install = el('div', 's-section');
    const tabs = el('div', 'm-subtabs'); tabs.setAttribute('role', 'tablist');
    for (const [id, title] of [['npm', 'NPM'], ['download', 'Download']] as const) {
      const b = btn(title, `m-subtab${sub === id ? ' on' : ''}`, () => { sub = id; message = null; rerender(); });
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(sub === id)); tabs.append(b);
    }
    install.append(tabs);
    (sub === 'npm' ? renderNpm : renderDownload)(install);
    if (progress) {
      const bar = el('div', 'm-progress'); const fill = el('i'); fill.style.width = `${progress.percent}%`; bar.append(fill);
      install.append(bar, el('div', 's-hint', progress.message));
    }
    if (message) install.append(el('div', message.kind === 'ok' ? 'm-ok' : 'm-err', message.text));
    box.append(install);
  };

  return {
    tab: { id: 'models', title: L('Модели', 'Models'), render },
    attach(fn: () => void) { rerender = fn; },
    cancelPreview,
    /** state for tests / the host */
    state: () => ({ previewId, sub, busy, loaded }),
  };
}
