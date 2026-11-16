import { ACCENT_PRESETS, PRIMARY_PRESETS, DEFAULT_ACCENT, accentVars, spriteFilter, cleanAppearance, type Appearance } from '../appearance.js';
import type { PermissionPolicy } from '../../../shared/src/types.js';
import { L, type LangPref } from '../../../shared/src/i18n.js';

export interface SettingsDeps {
  /** persists the appearance (main process validates and writes settings.json) */
  save(a: Appearance): void;
  sprite: HTMLCanvasElement;
  /** body hue of the active model's sheet, null until known / for a colorless sheet */
  baseHue(): number | null;
  /** called when the panel closes (e.g. an unapplied model preview is undone) */
  onClose?(): void;
  /** how the chat answers Claude Code's tool permission requests */
  permissions?: { get(): PermissionPolicy; set(m: PermissionPolicy): void };
  /** UI language: 'auto' follows the system; changing it reloads the UI */
  /** pet size (0.6-1.8): applied live, saved by the callback */
  petScale?: { get(): number; set(s: number): void };
  language?: { get(): LangPref; set(l: LangPref): void };
  /** the panel's own tab bodies are built by other modules */
  tabs?: Array<{ id: string; title: string; render(box: HTMLElement): void }>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};

/** The settings panel next to the pet: tabs, appearance colors with live preview, restore defaults. */
export function createSettingsPanel(root: HTMLElement, deps: SettingsDeps, initial: Appearance) {
  let appearance = cleanAppearance(initial);
  let tab = 'size';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** paints the colors on the live UI: immediate preview, no restart */
  const paint = () => {
    const v = accentVars(appearance.accent);
    const s = document.documentElement.style;
    if (appearance.accent) { s.setProperty('--teal', v.accent); s.setProperty('--accent-ink', v.ink); }
    else { s.removeProperty('--teal'); s.removeProperty('--accent-ink'); }
    deps.sprite.style.filter = spriteFilter(appearance, deps.baseHue());
  };
  const change = (next: Appearance) => {
    appearance = cleanAppearance(next);
    paint();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => deps.save(appearance), 250); // persisted shortly after the last change
    if (!root.hidden && tab === 'colors') render();
  };

  const colorRow = (title: string, hint: string, presets: readonly string[], value: string | null, fallback: string, set: (c: string | null) => void) => {
    const row = el('div', 's-section');
    row.append(el('div', 's-title', title), el('div', 's-hint', hint));
    const sw = el('div', 's-swatches');
    for (const c of presets) {
      const b = el('button', `s-swatch${value === c ? ' on' : ''}`);
      b.type = 'button'; b.title = c; b.setAttribute('aria-label', `${title}: ${c}`); b.style.background = c;
      b.addEventListener('click', () => set(c));
      sw.append(b);
    }
    const pick = el('input', 's-color'); pick.type = 'color'; pick.value = value ?? fallback; pick.title = L('Свой цвет', 'Custom color', '自定义颜色');
    pick.addEventListener('input', () => set(pick.value));
    const reset = el('button', 's-link', L('По умолчанию', 'Default', '默认')); reset.type = 'button';
    reset.disabled = value === null;
    reset.addEventListener('click', () => set(null));
    sw.append(pick, reset);
    row.append(sw);
    return row;
  };

  const renderSize = (box: HTMLElement) => {
    if (deps.petScale) {
      const row = el('div', 's-section');
      const val = el('span', 's-hint', `${Math.round(deps.petScale.get() * 100)}%`);
      row.append(el('div', 's-title', L('Размер питомца', 'Pet size', '宠物大小')), el('div', 's-hint', L('Меняется сразу. Быстрый выбор есть и в меню трея.', 'Changes at once. Quick presets are also in the tray menu.', '立即生效。托盘菜单中也有快捷预设。')));
      const line = el('div', 's-swatches');
      const range = el('input', 's-range'); range.type = 'range'; range.min = '60'; range.max = '180'; range.step = '5';
      range.value = String(Math.round(deps.petScale.get() * 100)); range.setAttribute('aria-label', L('Размер питомца', 'Pet size', '宠物大小'));
      range.addEventListener('input', () => { const v = Number(range.value) / 100; val.textContent = `${range.value}%`; deps.petScale!.set(v); });
      const reset = el('button', 's-link', L('По умолчанию', 'Default', '默认')); reset.type = 'button';
      reset.addEventListener('click', () => { deps.petScale!.set(1); range.value = '100'; val.textContent = '100%'; });
      line.append(range, val, reset); row.append(line); box.append(row);
    }
  };

  const renderColors = (box: HTMLElement) => {
    box.append(
      colorRow(L('Цвет питомца', 'Pet color', '宠物颜色'), L('Перекрашивает самого питомца. Изменения видны сразу.', 'Recolors the pet itself. Changes show at once.', '给宠物本身换色。立即生效。'), PRIMARY_PRESETS, appearance.primary, '#d97757', (c) => change({ ...appearance, primary: c })),
      colorRow(L('Акцентный цвет', 'Accent color', '强调色'), L('Кнопки, индикаторы и подсветка интерфейса.', 'Buttons, indicators and UI highlights.', '按钮、指示器和界面高亮。'), ACCENT_PRESETS, appearance.accent, DEFAULT_ACCENT, (c) => change({ ...appearance, accent: c })),
    );
    const all = el('button', 's-btn', L('Сбросить все цвета', 'Reset all colors', '重置所有颜色')); all.type = 'button';
    all.disabled = appearance.primary === null && appearance.accent === null;
    all.addEventListener('click', () => change({ primary: null, accent: null }));
    box.append(all);
  };

  const renderLanguage = (box: HTMLElement) => {
    if (deps.language) {
      const row = el('div', 's-section');
      row.append(el('div', 's-title', L('Язык / Language', 'Language / Язык', 'Language / Язык / 语言')), el('div', 's-hint', L('Интерфейс перезагрузится после выбора.', 'The interface reloads after you choose.', '选择后界面会重新加载。')));
      const sw = el('div', 's-swatches');
      const cur = deps.language.get();
      for (const [id, name] of [['auto', L('Как в системе', 'System', '跟随系统')], ['ru', 'Русский'], ['en', 'English'], ['zh', '中文']] as Array<[LangPref, string]>) {
        const b = el('button', `s-btn${cur === id ? ' primary' : ''}`, name); b.type = 'button'; b.disabled = cur === id;
        b.addEventListener('click', () => deps.language!.set(id));
        sw.append(b);
      }
      row.append(sw); box.append(row);
    }
  };

  const PERMISSION_CHOICES: Array<{ id: PermissionPolicy; title: string; hint: string }> = [
    { id: 'ask', title: L('Спрашивать каждый раз', 'Ask every time', '每次都询问'), hint: L('Безопасно: на каждое действие Claude Code питомец покажет запрос «Разрешить / Отклонить».', 'Safe: the pet shows an Allow / Deny prompt for every Claude Code action.', '安全：宠物会对 Claude Code 的每个操作显示“允许 / 拒绝”提示。') },
    { id: 'edits', title: L('Правки файлов — без вопросов', 'File edits without asking', '编辑文件无需询问'), hint: L('Редактирование и запись файлов разрешаются сами; команды и остальное — по запросу.', 'Editing and writing files is allowed automatically; commands and everything else still ask.', '自动允许编辑和写入文件；命令和其他操作仍会询问。') },
    { id: 'all', title: L('Разрешать всё без вопросов', 'Allow everything without asking', '允许一切无需询问'), hint: L('Claude Code сможет без подтверждения запускать любые команды и менять файлы в папке сессии. Включайте, только если доверяете задаче.', 'Claude Code will run any command and change files in the session folder without confirmation. Turn it on only if you trust the task.', 'Claude Code 将不经确认运行任何命令并修改会话文件夹中的文件。仅在你信任该任务时开启。') },
  ];
  const renderPermissions = (box: HTMLElement) => {
    const cur = deps.permissions!.get();
    box.append(el('div', 's-title', L('Разрешения для чата питомца', 'Permissions for the pet chat', '宠物聊天的权限')),
      el('div', 's-hint', L('Касается только сообщений, которые вы отправляете через питомца. Сессии в терминале работают по своим правилам.', 'Applies only to messages you send through the pet. Terminal sessions follow their own rules.', '仅适用于通过宠物发送的消息。终端会话遵循各自的规则。')));
    for (const c of PERMISSION_CHOICES) {
      const row = el('label', 's-radio'); row.style.display = 'block'; row.style.margin = '3px 0';
      const r = el('input'); r.type = 'radio'; r.name = 'perm'; r.checked = c.id === cur;
      r.addEventListener('change', () => { deps.permissions!.set(c.id); render(); });
      const t = el('span', '', ` ${c.title}`);
      const h = el('div', 's-hint', c.hint); h.style.marginLeft = '22px';
      row.append(r, t, h); box.append(row);
    }
    if (cur === 'all') box.append(el('div', 's-hint', L('⚠ Сейчас включено «Разрешать всё»: подтверждений не будет.', '⚠ "Allow everything" is on: there will be no confirmations.', '⚠ “允许一切”已开启：不会有任何确认。')));
  };

  const render = () => {
    const tabs = [{ id: 'size', title: L('Вид', 'Look', '外观'), render: renderSize },
      { id: 'colors', title: L('Цвета', 'Colors', '颜色'), render: renderColors },
      ...(deps.language ? [{ id: 'language', title: L('Язык', 'Language', '语言'), render: renderLanguage }] : []),
      ...(deps.permissions ? [{ id: 'permissions', title: L('Разрешения', 'Permissions', '权限'), render: renderPermissions }] : []), ...(deps.tabs ?? [])];
    const head = el('div', 's-head');
    const bar = el('div', 's-tabs'); bar.setAttribute('role', 'tablist');
    for (const t of tabs) {
      const b = el('button', `s-tab${t.id === tab ? ' on' : ''}`, t.title); b.type = 'button';
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(t.id === tab));
      b.addEventListener('click', () => { tab = t.id; render(); });
      bar.append(b);
    }
    const close = el('button', 's-close'); close.type = 'button'; close.title = L('Закрыть', 'Close', '关闭'); close.setAttribute('aria-label', L('Закрыть настройки', 'Close settings', '关闭设置')); close.textContent = '×';
    close.addEventListener('click', () => api.close());
    head.append(bar, close);
    const body = el('div', 's-body');
    (tabs.find((t) => t.id === tab) ?? tabs[0]).render(body);
    root.replaceChildren(head, body);
  };

  const api = {
    open(which?: string) { if (which) tab = which; root.hidden = false; render(); },
    close() { root.hidden = true; deps.onClose?.(); },
    toggle() { if (root.hidden) api.open(); else api.close(); },
    isOpen: () => !root.hidden,
    /** re-applies the colors (after the model changed, its base hue differs) */
    repaint: paint,
    rerender() { if (!root.hidden) render(); },
  };
  paint();
  return api;
}
