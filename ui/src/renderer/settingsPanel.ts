import { ACCENT_PRESETS, PRIMARY_PRESETS, DEFAULT_ACCENT, accentVars, spriteFilter, cleanAppearance, type Appearance } from '../appearance.js';
import type { PermissionPolicy } from '../../../shared/src/types.js';
import { gsap } from 'gsap';
import { boost } from './motion.js';
import { STATE_LABEL } from './labels.js';
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
  let lastShown = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** paints the colors on the live UI: immediate preview, no restart */
  const paint = () => {
    const v = accentVars(appearance.accent);
    const s = document.documentElement.style;
    if (appearance.accent) { s.setProperty('--teal', v.accent); s.setProperty('--accent-ink', v.ink); }
    else { s.removeProperty('--teal'); s.removeProperty('--accent-ink'); }
    deps.sprite.style.filter = spriteFilter(appearance, deps.baseHue());
  };
  /** `redraw` false while a slider is being dragged: rebuilding the panel under the user's hand would drop it */
  const change = (next: Appearance, redraw = true) => {
    appearance = cleanAppearance(next);
    paint();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => deps.save(appearance), 250); // persisted shortly after the last change
    if (redraw && !root.hidden && tab === 'colors') render();
  };
  /** the RGB editors stay open until the user closes them (one per color row) */
  const rgbOpen = new Set<string>();
  const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const parseHex = (h: string): [number, number, number] | null => { const m = /^#?([0-9a-f]{6})$/i.exec(h.trim()); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number] : null; };

  const colorRow = (title: string, hint: string, presets: readonly string[], value: string | null, fallback: string, set: (c: string | null, commit?: boolean) => void) => {
    const row = el('div', 's-section');
    row.append(el('div', 's-title', title), el('div', 's-hint', hint));
    const sw = el('div', 's-swatches');
    for (const c of presets) {
      const b = el('button', `s-swatch${value === c ? ' on' : ''}`);
      b.type = 'button'; b.title = c; b.setAttribute('aria-label', `${title}: ${c}`); b.style.background = c;
      b.addEventListener('click', () => set(c));
      sw.append(b);
    }
    const open = rgbOpen.has(title);
    const pick = el('button', `s-link${open ? ' on' : ''}`, 'RGB'); pick.type = 'button'; pick.title = L('Свой цвет', 'Custom color', '自定义颜色'); pick.setAttribute('aria-expanded', String(open));
    pick.addEventListener('click', () => { if (rgbOpen.has(title)) rgbOpen.delete(title); else rgbOpen.add(title); render(); });
    const reset = el('button', 's-link', L('По умолчанию', 'Default', '默认')); reset.type = 'button';
    reset.disabled = value === null;
    reset.addEventListener('click', () => set(null));
    sw.append(pick, reset);
    row.append(sw);
    if (open) {
      const cur = parseHex(value ?? fallback) ?? [217, 119, 87];
      const ed = el('div', 's-rgb');
      const preview = el('span', 's-rgb-prev'); preview.style.background = `#${cur.map(hex2).join('')}`;
      const hexIn = el('input', 's-hex'); hexIn.type = 'text'; hexIn.maxLength = 7; hexIn.spellcheck = false; hexIn.value = `#${cur.map(hex2).join('')}`; hexIn.setAttribute('aria-label', 'HEX');
      const vals = [...cur]; const outs: HTMLElement[] = []; const ranges: HTMLInputElement[] = [];
      const apply = (hex: string, commit: boolean) => { preview.style.background = hex; set(hex, commit); };
      ['R', 'G', 'B'].forEach((ch, i) => {
        const line = el('label', 's-rgb-line'); line.append(el('span', 's-rgb-ch', ch));
        const r = el('input', 's-range s-rgb-range'); r.type = 'range'; r.min = '0'; r.max = '255'; r.value = String(vals[i]); r.setAttribute('aria-label', ch);
        const out = el('span', 's-hint s-rgb-val', String(vals[i]));
        r.addEventListener('input', () => { vals[i] = Number(r.value); out.textContent = r.value; const h = `#${vals.map(hex2).join('')}`; hexIn.value = h; apply(h, false); });
        r.addEventListener('change', () => { set(`#${vals.map(hex2).join('')}`, true); });
        ranges.push(r); outs.push(out); line.append(r, out); ed.append(line);
      });
      hexIn.addEventListener('input', () => { const c = parseHex(hexIn.value); if (!c) return; c.forEach((v, i) => { vals[i] = v; ranges[i].value = String(v); outs[i].textContent = String(v); }); apply(`#${c.map(hex2).join('')}`, false); });
      hexIn.addEventListener('change', () => { const c = parseHex(hexIn.value); if (c) set(`#${c.map(hex2).join('')}`, true); });
      const top = el('div', 's-rgb-top'); top.append(preview, hexIn);
      ed.prepend(top); row.append(ed);
    }
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
    renderLegend(box);
  };

  const LEGEND: Array<[string, string]> = [['idle', '#34d399'], ['thinking', '#4f8cff'], ['reading', '#22d3ee'], ['writing', '#a78bfa'], ['running', '#fb923c'], ['testing', '#facc15'], ['waiting', '#ef4444'], ['subagent', '#f472b6'], ['done', '#a3e635'], ['sleeping', '#8b93a7']];
  const renderLegend = (box: HTMLElement) => {
    const row = el('div', 's-section');
    row.append(el('div', 's-title', L('Цвета статуса', 'Status colors', '状态颜色')));
    const grid = el('div', 's-legend');
    for (const [st, c] of LEGEND) {
      const it = el('span', 's-leg'); const d = el('i'); d.style.background = c; d.style.boxShadow = `0 0 6px ${c}88`;
      it.append(d, document.createTextNode(STATE_LABEL[st as keyof typeof STATE_LABEL]));
      grid.append(it);
    }
    row.append(grid); box.append(row);
  };

  /** a live copy of the status control: the dot (status) inside the arc (limit, in the accent colour) with the one-word status */
  const chipPreview = () => {
    const wrap = el('div', 's-section');
    const prev = el('div', 's-prev');
    const ring = el('span', 's-prev-ring');
    ring.innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15.9155"/><circle class="arc" cx="18" cy="18" r="15.9155" stroke-dasharray="42 100"/></svg>';
    ring.append(el('i', 's-prev-dot'));
    prev.append(ring, el('span', 's-prev-word', STATE_LABEL.idle));
    wrap.append(prev, el('div', 's-hint', L('Так выглядит значок статуса: точка внутри дуги. Точка показывает, что делает Claude, дуга показывает лимит и берёт акцентный цвет.', 'This is the status control: a dot inside an arc. The dot shows what Claude is doing, the arc shows the limit and takes the accent colour.', '这是状态图标：圆点位于圆弧内。圆点表示 Claude 正在做什么，圆弧表示额度并使用强调色。')));
    return wrap;
  };

  const renderColors = (box: HTMLElement) => {
    box.append(chipPreview(),
      colorRow(L('Цвет питомца', 'Pet color', '宠物颜色'), L('Перекрашивает самого питомца. Изменения видны сразу.', 'Recolors the pet itself. Changes show at once.', '给宠物本身换色。立即生效。'), PRIMARY_PRESETS, appearance.primary, '#d97757', (c, commit = true) => change({ ...appearance, primary: c }, commit)),
      colorRow(L('Акцентный цвет', 'Accent color', '强调色'), L('Кнопки, индикаторы и подсветка интерфейса.', 'Buttons, indicators and UI highlights.', '按钮、指示器和界面高亮。'), ACCENT_PRESETS, appearance.accent, DEFAULT_ACCENT, (c, commit = true) => change({ ...appearance, accent: c }, commit)),
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
    const keepScroll = lastShown === tab ? (root.querySelector('.s-body') as HTMLElement | null)?.scrollTop ?? 0 : 0; // a change inside a tab redraws it: stay where the user scrolled
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
    if (keepScroll) body.scrollTop = keepScroll;
    if (lastShown !== tab && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      boost();
      gsap.fromTo(body.children, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.28, stagger: 0.04, ease: 'power2.out', clearProps: 'opacity,transform' });
    }
    lastShown = tab;
  };

  const api = {
    open(which?: string) { if (which) tab = which; root.hidden = false; render(); },
    close() { root.hidden = true; lastShown = ''; deps.onClose?.(); },
    toggle() { if (root.hidden) api.open(); else api.close(); },
    isOpen: () => !root.hidden,
    /** re-applies the colors (after the model changed, its base hue differs) */
    repaint: paint,
    rerender() { if (!root.hidden) render(); },
  };
  paint();
  return api;
}
