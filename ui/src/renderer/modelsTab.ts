import { removeLightFringe } from '../sprite/fringe.js';
import { L } from '../../../shared/src/i18n.js';
export interface PetData { id: string; name: string; imageUrl: string; cell: { w: number; h: number }; rows: { frames: number; id?: string; loopMs?: number | null }[]; tweaks?: { trimHalfWidth?: Record<string, number>; lightFringe?: 'remove' | 'dark'; fringeCream?: boolean; stabilize?: boolean } }
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
    if (!d) { message = { kind: 'err', text: L('Не удалось загрузить модель.', 'Could not load the model.', '无法加载模型。') }; rerender(); return; }
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
    if (r.ok && r.models) { list = r.models; previewId = null; message = { kind: 'ok', text: L('Модель применена и сохранена.', 'Model applied and saved.', '模型已应用并保存。') }; }
    else message = { kind: 'err', text: r.error ?? L('Не удалось применить модель.', 'Could not apply the model.', '无法应用模型。') };
    rerender();
  };
  const remove = async (id: string) => {
    const r = await host.models.remove(id);
    if (r.canceled) return;
    if (r.ok && r.models) {
      list = r.models; thumbs.delete(id);
      if (previewId === id) previewId = null;
      if (r.pet) await api.show(r.pet);
      message = { kind: 'ok', text: L('Модель удалена.', 'Model removed.', '模型已移除。') };
    } else message = { kind: 'err', text: r.error ?? L('Не удалось удалить модель.', 'Could not remove the model.', '无法移除模型。') };
    rerender();
  };
  const afterInstall = async (r: OpResult) => {
    busy = false; progress = null;
    if (r.canceled) { rerender(); return; }
    if (r.ok && r.models && r.model) {
      list = r.models; for (const m of list) void thumb(m.id);
      message = { kind: 'ok', text: L(`Установлена: «${r.model.name}». Нажмите «Применить», чтобы оставить её.`, `Installed: “${r.model.name}”. Press Apply to keep it.`, `已安装：“${r.model.name}”。点“应用”以保留。`) };
      await preview(r.model.id); // shown on the pet right away; applied only on request
    } else message = { kind: 'err', text: r.error ?? L('Не удалось установить модель.', 'Could not install the model.', '无法安装模型。') };
    rerender();
  };
  const installZip = async (path?: string) => { busy = true; message = null; progress = { percent: 0, message: L('Начало', 'Starting', '正在启动') }; rerender(); await afterInstall(await host.models.installZip(path)); };
  host.models.onProgress((p) => { if (busy) { progress = { percent: p.percent, message: p.message }; rerender(); } });

  const renderList = (box: HTMLElement) => {
    const sec = el('div', 's-section');
    sec.append(el('div', 's-title', L('Установленные модели', 'Installed models', '已安装的模型')));
    const ul = el('div', 'm-list');
    for (const m of list) {
      const shown = previewId ? m.id === previewId : m.active;
      const row = el('div', `m-row${shown ? ' on' : ''}`);
      const t = el('img', 'm-thumb') as HTMLImageElement; t.alt = ''; if (thumbs.get(m.id)) t.src = thumbs.get(m.id)!;
      const info = el('div', 'm-info');
      info.append(el('div', 'm-name', m.name), el('div', 's-hint', [m.bundled ? L('встроенная', 'built-in', '内置') : L('своя', 'custom', '自定义'), m.source ? `${L('источник', 'source', '来源')}: ${m.source}` : '', m.active ? L('активна', 'active', '当前使用') : ''].filter(Boolean).join(' · ')));
      const acts = el('div', 'm-acts');
      acts.append(btn(shown ? L('Выбрана', 'Selected', '已选择') : L('Выбрать', 'Select', '选择'), 's-btn', () => void preview(m.id), shown));
      if (!m.bundled) { const x = btn('✕', 's-btn m-del', () => void remove(m.id)); x.title = L('Удалить модель', 'Remove model', '移除模型'); x.setAttribute('aria-label', L(`Удалить модель ${m.name}`, `Remove model ${m.name}`, `移除模型 ${m.name}`)); acts.append(x); }
      row.append(t, info, acts);
      ul.append(row);
    }
    if (!list.length) ul.append(el('div', 's-hint', L('Моделей пока нет.', 'No models yet.', '还没有模型。')));
    sec.append(ul);
    if (previewId) {
      const pv = list.find((m) => m.id === previewId);
      const bar = el('div', 'm-preview');
      bar.append(el('span', '', `${L('Предпросмотр', 'Preview', '预览')}: ${pv?.name ?? previewId}`), btn(L('Применить', 'Apply', '应用'), 's-btn primary', () => void apply()), btn(L('Отмена', 'Cancel', '取消'), 's-btn', () => void cancelPreview()));
      sec.append(bar);
    }
    box.append(sec);
  };

  const renderNpm = (box: HTMLElement) => {
    box.append(el('div', 's-title', L('Установка через npm', 'Install via npm', '通过 npm 安装')));
    box.append(el('div', 's-hint', L('Модели формата Codex ставит сторонний пакет codex-pets (лицензия MIT, не связан с ccPet). Он кладёт модель в папку ~/.codex/pets, а ccPet устанавливает её оттуда после проверки.', 'Codex-format models are installed by the third-party package codex-pets (MIT license, not affiliated with ccPet). It puts the model into ~/.codex/pets and ccPet installs it from there after validation.', 'Codex 格式的模型由第三方包 codex-pets 安装（MIT 许可，与 ccPet 无关联）。它会把模型放入 ~/.codex/pets，ccPet 在验证后从那里安装。')));
    const code = el('div', 'm-code');
    code.append(el('code', '', NPM_COMMAND), btn(L('Копировать', 'Copy', '复制'), 's-btn', () => { host.copyText(NPM_COMMAND); message = { kind: 'ok', text: L('Команда скопирована.', 'Command copied.', '命令已复制。') }; rerender(); }));
    box.append(code);
    box.append(el('div', 's-hint', L('Замените <pet-id> на идентификатор модели из каталога codex-pets и выполните команду в терминале Windows (PowerShell). Папка ~/.codex/pets внутри WSL приложению не видна: для неё используйте ZIP.', 'Replace <pet-id> with a model id from the codex-pets catalog and run the command in a Windows terminal (PowerShell). The ~/.codex/pets folder inside WSL is not visible to the app: use a ZIP for that.', '把 <pet-id> 替换为 codex-pets 目录中的模型 id，并在 Windows 终端（PowerShell）中运行该命令。应用看不到 WSL 内的 ~/.codex/pets 文件夹：请改用 ZIP。')));
    const row = el('div', 'm-line');
    row.append(btn(L('Открыть пакет на npmjs.com', 'Open the package on npmjs.com', '在 npmjs.com 上打开该包'), 's-btn', () => host.openUrl(NPM_PAGE)), btn(L('Проверить папку', 'Check folder', '检查文件夹'), 's-btn', async () => { codex = await host.models.codexScan(); rerender(); }));
    box.append(row);
    if (codex) {
      box.append(el('div', 's-hint', codex.found.length ? L(`Найдено в ${codex.dir}:`, `Found in ${codex.dir}:`, `在 ${codex.dir} 中找到：`) : codex.exists ? L(`В ${codex.dir} моделей не найдено.`, `No models found in ${codex.dir}.`, `在 ${codex.dir} 中未找到模型。`) : L(`Папка ${codex.dir} ещё не создана (npm-установщик её создаёт).`, `The folder ${codex.dir} does not exist yet (the npm installer creates it).`, `文件夹 ${codex.dir} 尚不存在（npm 安装程序会创建它）。`)));
      for (const f of codex.found) {
        const r = el('div', 'm-line');
        r.append(el('span', 'm-name', f.name), f.installed ? el('span', 's-hint', L('уже установлена', 'already installed', '已安装')) : btn(L('Установить', 'Install', '安装'), 's-btn primary', async () => {
          busy = true; message = null; progress = { percent: 0, message: L('Начало', 'Starting', '正在启动') }; rerender();
          const res = await host.models.codexImport(f.id); await afterInstall(res); codex = await host.models.codexScan(); rerender();
        }, busy));
        box.append(r);
      }
    }
    box.append(el('div', 's-hint', L('ccPet сам npm не запускает и ничего не публикует. Собственного npm-пакета моделей у ccPet пока нет.', 'ccPet never runs npm itself and publishes nothing. ccPet has no npm model package of its own yet.', 'ccPet 自己从不运行 npm，也不会发布任何内容。ccPet 目前还没有自己的 npm 模型包。')));
  };

  const renderDownload = (box: HTMLElement) => {
    box.append(el('div', 's-title', L('Установка из ZIP-архива', 'Install from a ZIP archive', '从 ZIP 压缩包安装')));
    const drop = el('div', 'm-drop');
    drop.append(el('div', '', L('Перетащите ZIP-архив сюда', 'Drop a ZIP archive here', '将 ZIP 压缩包拖到这里')), btn(L('Выбрать ZIP…', 'Choose ZIP…', '选择 ZIP…'), 's-btn primary', () => void installZip(), busy));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (!f || busy) return;
      const p = host.models.pathForFile(f);
      if (!p || !/\.zip$/i.test(p)) { message = { kind: 'err', text: L('Нужен файл с расширением .zip.', 'A .zip file is required.', '需要 .zip 文件。') }; rerender(); return; }
      void installZip(p);
    });
    box.append(drop);
    box.append(el('div', 's-hint', L('Нужен пак формата Codex: pet.json и лист спрайтов 1536×1872 (.webp или .png). Скрипты и исполняемые файлы запрещены, архив проверяется до установки и ничего не запускает.', 'A Codex-format pack is required: pet.json and a 1536×1872 sprite sheet (.webp or .png). Scripts and executables are not allowed; the archive is checked before installing and nothing is run.', '需要 Codex 格式的包：pet.json 和 1536×1872 的雪碧图（.webp 或 .png）。不允许脚本和可执行文件；安装前会检查压缩包，不会运行任何内容。')));
    box.append(btn(L('Открыть папку моделей', 'Open models folder', '打开模型文件夹'), 's-link', () => host.models.reveal()));
  };

  const render = (box: HTMLElement) => {
    if (!loaded) { void refresh(); box.append(el('div', 's-hint', L('Загрузка…', 'Loading…', '加载中…'))); return; }
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
    tab: { id: 'models', title: L('Модели', 'Models', '模型'), render },
    attach(fn: () => void) { rerender = fn; },
    cancelPreview,
    /** state for tests / the host */
    state: () => ({ previewId, sub, busy, loaded }),
  };
}
