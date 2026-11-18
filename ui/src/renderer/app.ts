import { statusView, STATE_LABEL, formatElapsed, hostTag, chipLabel } from './labels.js';
import { createConnectionsTab, type ConnectionsHost } from './connectionsTab.js';
import { pinSnapshot, focusSnapshot } from './view.js';
import { sessionRows, nextChatId, isQuiet } from './switcher.js';
import { matchCommands, planSlash, COMMANDS, typedLine, MODEL_ALIASES, type Command } from './commands.js';
import { decideSend, placeholderFor, isBusyReply, canStop, parseSlash, type Mode } from './compose.js';
import { applyChat, mergeHistory } from './chatStore.js';
import { mdBlocks, mdInline } from './md.js';
import { summaryHead, summaryRows } from './summaryCard.js';
import { parseAt } from '../hub/messageQueue.js';
import { Animator } from '../sprite/Animator.js';
import { cleanCell } from '../sprite/cleanCell.js';
import { headCenter, trimAround, shiftCell } from '../sprite/stabilize.js';
import { rectsKey, type Rect } from '../hitTest.js';
import { panelModel, ringModel } from './usage.js';
import { createSettingsPanel } from './settingsPanel.js';
import { createModelsTab, type ModelsHost } from './modelsTab.js';
import { clampScale } from '../petScale.js';
import { localizeHtml } from './htmlText.js';
import { syncRows, type RowData } from './rowList.js';
import { initTooltips } from './tooltip.js';
import { createMotion, animatePanels } from './motion.js';
import { removeLightFringe, removeColorSpill } from '../sprite/fringe.js';
import { dominantHue, type Appearance } from '../appearance.js';
import type { AppCommand, AskQuestion, BridgeMessage, ChatItem, PendingPermission, Reaction, Session, Snapshot, TurnSummary, UsageInfo, PermissionPolicy } from '../../../shared/src/types.js';
import { L, setLang, type Lang, type LangPref } from '../../../shared/src/i18n.js';

interface PetConfig {
  bridge: boolean;
  snapshot: Snapshot | null;
  expanded?: boolean;
  panel?: boolean;
  appearance?: Appearance;
  permissions?: PermissionPolicy;
  lang?: Lang;
  petScale?: number;
  language?: LangPref;
  pet: { imageUrl: string; cell: { w: number; h: number }; rows: { frames: number }[]; tweaks?: { trimHalfWidth?: Record<string, number>; lightFringe?: 'remove' | 'dark'; fringeCream?: boolean; stabilize?: boolean; spill?: boolean } };
}
declare global {
  interface Window {
    petHost: {
      config(): Promise<PetConfig>;
      send(cmd: AppCommand): void;
      onMsg(cb: (m: BridgeMessage) => void): void;
      onBridge(cb: (up: boolean) => void): void;
      onSummon(cb: () => void): void;
      pickFolder(): Promise<string | null>;
      openTerminal(sessionId: string): void;
      focus(): void;
      rects(r: Rect[]): void;
      resize(w: number, h: number): void;
      onMoving(cb: (dx: number) => void): void;
      notify(title: string, body: string): void;
      setAppearance(a: Appearance): void;
      setPermissions(m: PermissionPolicy): void;
      setLanguage(l: LangPref): void;
      setPetScale(s: number): void;
      onScale(cb: (s: number) => void): void;
      hoverRects(r: Rect[]): void;
      onHover(cb: (h: boolean) => void): void;
      connections: ConnectionsHost;
      models: ModelsHost['models'];
      copyText: ModelsHost['copyText'];
      openUrl: ModelsHost['openUrl'];
      onOpenSettings(cb: () => void): void;
    };
  }
}

const SCALE = 0.6;
const $ = (id: string) => document.getElementById(id)!;
const host = window.petHost;

/** "Done" card after a turn that changed files: files with +/- lines, time, tokens */
function summaryNode(sm: TurnSummary): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg summary';
  const head = document.createElement('div'); head.className = 'sum-head'; head.textContent = summaryHead(sm);
  el.append(head);
  for (const r of summaryRows(sm)) {
    const row = document.createElement('div'); row.className = 'sum-file'; row.title = r.path;
    const n = document.createElement('span'); n.className = 'sum-name'; n.textContent = r.name;
    const st = document.createElement('span'); st.className = 'sum-stat'; st.textContent = r.stat;
    row.append(n, st);
    el.append(row);
  }
  return el;
}

function messageNode(it: ChatItem): HTMLElement {
  if (it.role === 'summary' && it.summary) return summaryNode(it.summary);
  const el = document.createElement('div');
  el.className = `msg ${it.role}${it.streaming ? ' streaming' : ''}`;
  if (it.role !== 'assistant') { el.textContent = it.text; if (it.role === 'tool') el.title = it.text; return el; }
  for (const b of mdBlocks(it.text)) {
    if (b.type === 'code') { const pre = document.createElement('pre'); pre.textContent = b.text; el.append(pre); continue; }
    if (b.type === 'h') { const p = document.createElement('p'); const st = document.createElement('strong'); st.textContent = b.text; p.append(st); el.append(p); continue; }
    const p = document.createElement('p');
    for (const i of mdInline(b.text)) {
      if (i.t === 'text') { p.append(i.v); continue; }
      const n = document.createElement(i.t === 'code' ? 'code' : 'strong');
      n.textContent = i.v;
      p.append(n);
    }
    el.append(p);
  }
  if (!el.firstChild) el.append(document.createElement('p'));
  return el;
}

async function main() {
  const cfg = await host.config();
  setLang(cfg.lang ?? 'ru');
  localizeHtml();
  initTooltips();
  const { pet } = cfg;

  // ---- state ----
  let raw: Snapshot | null = cfg.snapshot;
  let connected = cfg.bridge;
  let pinnedId: string | null = null;
  const chats = new Map<string, ChatItem[]>();
  const historyAsked = new Set<string>();
  const eff = (): Snapshot | null => pinSnapshot(raw, pinnedId);
  const current = (): Session | null => { const s = eff(); return s?.sessions.find((x) => x.id === s.attention) ?? null; };
  // The open chat sticks to the session the user opened it on (status/sprite still follow attention).
  let chatId: string | null = null;
  let newChatChosen = false; // the user explicitly asked for a new chat: do not auto-attach to a session
  const chatSnap = (): Snapshot | null => focusSnapshot(raw, chatId);
  /** Switch to a session's chat in one step: opens the chat if it is closed, the sprite follows it. */
  const openChat = (id: string | null) => {
    chatId = id; pinnedId = id; mode = id ? 'reply' : 'new'; newChatChosen = false;
    if (id) historyAsked.delete(id); // reopening re-reads the transcript (it may have been unknown or stale)
    if (!expanded) setExpanded(true);
    input.focus();
  };
  const chatSession = (): Session | null => (chatId ? raw?.sessions.find((x) => x.id === chatId) ?? null : null);

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string) => {
    const n = $('notice'); n.textContent = text; n.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, 5000);
  };

  // composer state lives here too: bridge messages can arrive before the rest of the UI is set up
  let folder: string | null = null;
  try { folder = localStorage.getItem('pet.folder'); } catch { /* storage unavailable */ }
  let mode: Mode = 'reply';
  let expanded = false;
  const chatMenu = $('chat-menu');
  const switchBtn = $('chat-switch');

  // ---- /model picker ----
  let pickerFor: string | null = null; // session the picked model applies to (null = new chats)
  const hideModels = () => { $('models').hidden = true; };
  const showModels = (models: Array<{ value: string; displayName: string; description: string }>) => {
    const box = $('models');
    box.replaceChildren();
    const hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = pickerFor ? L('Выбери модель для этого чата', 'Pick a model for this chat', '为此聊天选择模型') : L('Выбери модель для новых чатов', 'Pick a model for new chats', '为新聊天选择模型');
    box.append(hint);
    for (const m of models) {
      const b = document.createElement('button'); b.className = 'm';
      const n = document.createElement('b'); n.textContent = m.displayName;
      const d = document.createElement('span'); d.textContent = m.description; b.title = `${m.value} — ${m.description}`;
      b.append(n, d);
      b.addEventListener('click', () => host.send({ type: 'setModel', sessionId: pickerFor, model: m.value }));
      box.append(b);
    }
    box.hidden = false;
    (box.querySelector('.m') as HTMLElement | null)?.focus();
  };
  $('models').addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideModels(); input.focus(); } });

  // ---- subscription limits (real Claude plan limits fed by Claude Code's statusLine; never invented) ----
  let lastText = '', lastNotified = '';
  let usage: UsageInfo | null = null, usageOpen = false;
  const usageRing = $('usage-ring'), usagePanel = $('usage');
  const barLevel = (p: number) => (p >= 90 ? 'high' : p >= 75 ? 'warn' : '');
  const renderUsage = () => {
    const now = Date.now();
    const r = ringModel(usage, now);
    usageRing.dataset.level = r.level;
    usageRing.classList.toggle('stale', r.stale);
    usageRing.title = r.title; usageRing.setAttribute('aria-label', r.title);
    $('usage-ring-text').textContent = r.text;
    usageRing.querySelector('.arc')!.setAttribute('stroke-dasharray', `${r.pct ?? 0} 100`);
    if (!usageOpen) return;
    const m = panelModel(usage, now);
    usagePanel.classList.toggle('stale', m.status === 'stale');
    const part = (cls: string, text: string) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    const nodes: HTMLElement[] = [part('u-head', m.header)];
    for (const row of m.rows) {
      const box = document.createElement('div'); box.className = 'u-row';
      const bar = document.createElement('div'); bar.className = 'u-bar';
      const fill = document.createElement('i');
      if (row.pct !== null) { fill.style.width = `${row.pct}%`; const lv = barLevel(row.pct); if (lv) fill.className = lv; }
      bar.append(fill);
      box.append(part('u-label', row.label), part('u-sub', row.sub), bar, part('u-val', row.value));
      nodes.push(box);
    }
    if (m.message) nodes.push(part('u-msg', m.message));
    if (m.footer) nodes.push(part('u-foot', m.footer));
    if (m.note) nodes.push(part('u-note', m.note));
    usagePanel.replaceChildren(...nodes);
  };
  const setUsageOpen = (open: boolean) => {
    usageOpen = open;
    usagePanel.hidden = !open;
    usageRing.setAttribute('aria-expanded', String(open));
    if (open) host.send({ type: 'usage-refresh' }); // the user looks: one live query (at most one a minute) on top of the status-line file
    renderUsage();
  };
  usageRing.addEventListener('click', () => setUsageOpen(!usageOpen));
  document.addEventListener('mousedown', (e) => {
    const t = e.target as Node;
    if (usageOpen && !usagePanel.contains(t) && !usageRing.contains(t)) setUsageOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (usageOpen && e.key === 'Escape') { e.stopPropagation(); setUsageOpen(false); }
  }, true);
  setInterval(renderUsage, 60_000); // only repaints (age, "stale", expired windows); no I/O

  /** sets `hidden` only when it changes (setting the same value still counts as a DOM change and would wake the loop) */
  const show = (el: HTMLElement, on: boolean) => { if (el.hidden === on) el.hidden = !on; };
  /** wakes the frame loop at once (it sleeps between sprite frames); anything that can change what is on screen calls it */
  let wake: () => void = () => {};
  /** set once the animator exists: tests passed or failed, a commit went in */
  let onReact: (r: Reaction) => void = () => {};
  host.onBridge((up) => { connected = up; if (!up) raw = null; if (up) host.send({ type: 'usage' }); wake(); });
  if (connected) host.send({ type: 'usage' });
  host.onMsg((m) => {
    wake();
    if (m.type === 'snapshot') raw = m;
    else if (m.type === 'chat') chats.set(m.sessionId, applyChat(chats.get(m.sessionId) ?? [], m.event));
    else if (m.type === 'history') chats.set(m.sessionId, mergeHistory(chats.get(m.sessionId), m.items));
    else if (m.type === 'started') { pinnedId = m.sessionId; chatId = m.sessionId; mode = 'reply'; }
    else if (m.type === 'models') showModels(m.models);
    else if (m.type === 'modelSet') { hideModels(); notify(`${L('Модель', 'Model', '模型')}: ${m.model}${m.sessionId ? '' : L(' (для новых чатов)', ' (for new chats)', ' （用于新聊天）')}`); }
    else if (m.type === 'usage') { usage = m.usage; renderUsage(); }
    else if (m.type === 'react') onReact(m.reaction);
    else if (m.type === 'error') notify(m.message);
  });


  // ---- sprite: shown at once from the raw sheet, cleaned cell by cell in the background ----
  const sprite = $('sprite') as HTMLCanvasElement;
  const cw = pet.cell.w, ch = pet.cell.h;
  const w = cw * SCALE, h = ch * SCALE;
  const dpr = window.devicePixelRatio || 1;
  // pet size: the box follows the --ps CSS variable, the canvas keeps its backing store matched so it stays crisp
  let petScale = clampScale(cfg.petScale ?? 1), sizeVersion = 0;
  const applyPetScale = (s: number, save = false) => {
    petScale = clampScale(s);
    document.documentElement.style.setProperty('--ps', String(petScale));
    sprite.width = Math.round(w * petScale * dpr); sprite.height = Math.round(h * petScale * dpr);
    ctx.imageSmoothingQuality = 'high';
    sizeVersion++;
    if (save) host.setPetScale(petScale);
  };
  const ctx = sprite.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  applyPetScale(petScale);
  host.onScale((s) => applyPetScale(s));
  // The sprite sheet of the active model: shown at once raw, cleaned cell by cell in the background. loadSprite can be called
  // again to switch models without restarting; a newer call cancels the cleaning of an older one.
  let atlas = document.createElement('canvas');
  let baseHue: number | null = null; // the model's body color, for the primary-color tint
  let atlasVersion = 0; // bumped per cleaned cell so the current frame is redrawn
  let spriteToken = 0;
  let onSpriteLoaded: () => void = () => {};
  const petWin = window as unknown as { __petAtlas: HTMLCanvasElement; __petAtlasReady?: boolean };
  const anim = new Animator();
  onReact = (r) => { anim.react(r, performance.now()); wake(); };
  const loadSprite = async (data: typeof pet) => {
    const token = ++spriteToken;
    const img = new Image();
    img.src = data.imageUrl;
    await img.decode();
    if (token !== spriteToken) return;
    const a = document.createElement('canvas');
    a.width = img.naturalWidth; a.height = img.naturalHeight;
    const ax = a.getContext('2d', { willReadFrequently: true })!;
    ax.drawImage(img, 0, 0);
    atlas = a; petWin.__petAtlas = a; petWin.__petAtlasReady = false;
    anim.setRowFrames(data.rows.map((r) => r.frames));
    baseHue = dominantHue(ax.getImageData(0, 0, a.width, a.height).data);
    atlasVersion++;
    onSpriteLoaded();
    void (async () => {
      for (let r = 0; r * ch < a.height && r < data.rows.length; r++) for (let c = 0; c * cw < a.width; c++) {
        if (token !== spriteToken) return;
        const cell = ax.getImageData(c * cw, r * ch, cw, ch);
        const stabilize = data.tweaks?.stabilize !== false;
        if (stabilize) cleanCell(cell.data, cw, ch);
        const fringe = data.tweaks?.lightFringe ? removeLightFringe(cell.data, cw, ch, data.tweaks.lightFringe, 3, !!data.tweaks.fringeCream) : 0;
        // a purple rim left by the key colour the pack was cut out of (off with tweaks.json {"spill": false})
        const spill = data.tweaks?.spill === false ? 0 : removeColorSpill(cell.data, cw, ch);
        const hx = stabilize ? headCenter(cell.data, cw, ch) : null;
        if (hx !== null) {
          const half = data.tweaks?.trimHalfWidth?.[String(r)];
          if (half) trimAround(cell.data, cw, ch, hx, half);
          const shifted = shiftCell(cell.data, cw, ch, Math.round(cw / 2 - hx)) as Uint8ClampedArray<ArrayBuffer>;
          ax.putImageData(new ImageData(shifted, cw, ch), c * cw, r * ch);
          atlasVersion++;
        } else if (fringe || spill) {
          ax.putImageData(cell, c * cw, r * ch);
          atlasVersion++;
        }
        await new Promise((res) => setTimeout(res, 0)); // keep the UI responsive
      }
      if (token === spriteToken) petWin.__petAtlasReady = true;
    })();
  };
  await loadSprite(pet);

  // ---- settings panel: appearance colors + permissions + pet model manager ----
  let permissions: PermissionPolicy = cfg.permissions ?? 'ask';
  const connectionsTab = createConnectionsTab({ ...host.connections, copy: (t: string) => host.copyText(t) });
  const modelsTab = createModelsTab(host, { show: (d) => loadSprite(d as typeof pet) });
  const settingsPanel = createSettingsPanel($('settings'), {
    save: (a) => host.setAppearance(a), sprite,
    petScale: { get: () => petScale, set: (s) => applyPetScale(s, true) },
    language: { get: () => cfg.language ?? 'auto', set: (l) => host.setLanguage(l) },
    permissions: { get: () => permissions, set: (m) => { permissions = m; host.setPermissions(m); } }, baseHue: () => baseHue,
    tabs: [connectionsTab.tab, modelsTab.tab], onClose: () => void modelsTab.cancelPreview(),
  }, cfg.appearance ?? { primary: null, accent: null });
  modelsTab.attach(() => settingsPanel.rerender());
  connectionsTab.attach(() => settingsPanel.rerender());
  onSpriteLoaded = () => settingsPanel.repaint(); // a model has its own body hue: the tint is recomputed
  $('btn-settings').addEventListener('click', () => settingsPanel.toggle());
  host.onOpenSettings(() => settingsPanel.open());


  // ---- window behaviour: report interactive boxes (main decides click-through) and content size ----
  let rectsSent = '';
  const reportRects = () => {
    const rects: Rect[] = Array.from(document.querySelectorAll<HTMLElement>('.hit'))
      .filter((el) => !el.hidden && el.offsetParent !== null && !el.classList.contains('rest'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const key = rectsKey(rects);
    if (key !== rectsSent) { rectsSent = key; host.rects(rects); }
  };
  // the window's height follows the content (the width is constant); it hangs from the pet's top, so growing never moves the pet
  let sizeSent = 0;
  const fitWindow = () => {
    const h = Math.ceil($('stage').offsetHeight) + 8;
    if (h !== sizeSent) { sizeSent = h; host.resize(424, h); }
  };
  // the pet runs the way the window is being dragged (the OS moves it; main reports each step)
  let movedAt = 0;
  host.onMoving((dx) => { movedAt = performance.now(); anim.setDrag(dx > 0 ? 'right' : 'left'); wake(); });

  // ---- chat + composer ----
  const input = $('input') as HTMLInputElement;
  const list = $('chat-list');
  let pendingBottom = false;
  const setExpanded = (on: boolean) => {
    expanded = on;
    // the sessions panel belongs to the open chat: it folds away with it
    if (!on) { chatMenu.hidden = true; switchBtn.setAttribute('aria-expanded', 'false'); $('sessions').hidden = true; }
    $('compose').hidden = !on; $('pill').hidden = !on; $('dock').hidden = on; $('chat').hidden = !on;
    if (on) {
      if (!chatSession()) chatId = current()?.id ?? null;
      mode = chatSession() ? 'reply' : 'new';
      host.focus(); input.focus();
      // a hidden list forgets its scroll position (display: none): open at the last message, also for what arrived while it was closed
      pendingBottom = true; list.scrollTop = list.scrollHeight;
    }
  };
  const chooseFolder = async (): Promise<boolean> => {
    const p = await host.pickFolder();
    if (!p) return false;
    folder = p; mode = 'new'; newChatChosen = true;
    try { localStorage.setItem('pet.folder', p); } catch { /* ignore */ }
    input.focus();
    return true;
  };
  // ---- "/" command menu ----
  let cmdSel = 0, cmdList: Command[] = [];
  const hideCmds = () => { $('cmds').hidden = true; cmdList = []; };
  const renderCmds = () => {
    cmdList = matchCommands(input.value);
    const box = $('cmds');
    if (!cmdList.length) { box.hidden = true; return; }
    cmdSel = Math.min(cmdSel, cmdList.length - 1);
    box.replaceChildren(...cmdList.map((c, i) => {
      const b = document.createElement('button'); b.className = `c${c.kind === 'claude' ? ' cl' : ''}${i === cmdSel ? ' on' : ''}`; b.tabIndex = -1; b.setAttribute('role', 'option');
      const n = document.createElement('b'); n.textContent = `/${c.name}`;
      b.append(n);
      if (c.args) { const a = document.createElement('i'); a.textContent = c.args; b.append(a); }
      const d = document.createElement('span'); d.textContent = c.desc(); b.append(d);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); pickCmd(c); });
      return b;
    }));
    box.hidden = false;
    (box.querySelector('.on') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  };
  const pickCmd = (c: Command) => { input.value = `/${c.name}${c.args ? ' ' : ''}`; hideCmds(); input.focus(); if (!c.args) void submit(); };
  input.addEventListener('input', () => { cmdSel = 0; renderCmds(); });
  input.addEventListener('keydown', (e) => {
    if (!cmdList.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : cmdList.length - 1)) % cmdList.length; renderCmds(); }
    else if (e.key === 'Tab') { e.preventDefault(); input.value = `/${cmdList[cmdSel].name}${cmdList[cmdSel].args ? ' ' : ''}`; renderCmds(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); pickCmd(cmdList[cmdSel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hideCmds(); }
  }, true);
  const submit = async () => {
    if (!connected) { notify(L('Нет связи с мостом Claude Code', 'No connection to the Claude Code bridge', '无法连接 Claude Code 桥接')); return; }
    // commands the pet handles itself; every other /command goes to Claude Code as typed
    const sl = parseSlash(input.value);
    if (askFor && !sl && input.value.trim()) { chooseAnswer(askFor, input.value.trim()); input.value = ''; return; }
    const target = mode === 'reply' ? chatSession() : null;
    const plan = planSlash(sl, !!target?.pty);
    hideCmds();
    if (plan?.kind === 'no-terminal') {
      notify(target ? L(`/${plan.name} выполняет сам Claude Code: сессия без терминала питомца её не примет. Откройте чат в терминале`, `/${plan.name} is run by Claude Code itself: a session without the pet's terminal link cannot take it. Open the chat in the terminal`, `/${plan.name} 由 Claude Code 自己执行：没有宠物终端连接的会话无法接收。请在终端中打开聊天`)
        : L(`/${plan.name} нужен открытый чат`, `/${plan.name} needs an open chat`, `/${plan.name} 需要已打开的聊天`));
      return;
    }
    if (plan?.kind === 'pet') {
      const { name, args } = plan;
      // a session with the pet's terminal link: Claude Code runs /model and /btw itself, the pet only types the line (no Agent SDK, no second process)
      const typable = !!target?.pty && !target.owned;
      if (typable && (name === 'model' || name === 'btw')) {
        const line = typedLine(name, args);
        if (line) host.send({ type: 'send', sessionId: target!.id, text: line });
        else if (name === 'btw') { notify(L('Напиши вопрос после /btw', 'Type your question after /btw', '请在 /btw 后输入你的问题')); return; }
        else {
          const box = $('models');
          const hint = Object.assign(document.createElement('div'), { className: 'hint', textContent: L('Выбери модель для этого чата (команда уйдёт в терминал)', 'Pick a model for this chat (the command is typed into the terminal)', '为此聊天选择模型（命令将输入到终端）') });
          box.replaceChildren(hint, ...MODEL_ALIASES.map((m) => {
            const b = document.createElement('button'); b.className = 'm';
            const n = document.createElement('b'); n.textContent = m.value;
            const d = document.createElement('span'); d.textContent = m.label();
            b.append(n, d);
            b.addEventListener('click', () => { host.send({ type: 'send', sessionId: target!.id, text: `/model ${m.value}` }); hideModels(); });
            return b;
          }));
          box.hidden = false;
          (box.querySelector('.m') as HTMLElement | null)?.focus();
          return;
        }
      } else if (name === 'model') {
        pickerFor = target?.id ?? null;
        if (args) host.send({ type: 'setModel', sessionId: pickerFor, model: args });
        else { const box = $('models'); box.replaceChildren(Object.assign(document.createElement('div'), { className: 'hint', textContent: L('Загружаю список моделей…', 'Loading the model list…', '正在加载模型列表…') })); box.hidden = false; host.send({ type: 'models' }); }
      } else if (name === 'btw') {
        if (!target) { notify(L('/btw задаёт вопрос по открытому чату: сначала выбери сессию', '/btw asks about the open chat: pick a session first', '/btw 针对已打开的聊天提问：请先选择会话')); return; }
        if (!args) { notify(L('Напиши вопрос после /btw', 'Type your question after /btw', '请在 /btw 后输入你的问题')); return; }
        host.send({ type: 'btw', sessionId: target.id, text: args });
      } else if (name === 'at') {
        if (!target) { notify(L('/at отправляет сообщение в открытый чат: сначала выбери сессию', '/at sends to the open chat: pick a session first', '/at 发送到已打开的聊天：请先选择会话')); return; }
        const p = parseAt(args, new Date(), usage?.fiveHour?.resetsAt ?? null);
        if (!p) { notify(L('Формат: /at 23:30 текст или /at reset текст (после сброса 5-часового лимита)', 'Format: /at 23:30 text, or /at reset text (when the 5-hour limit resets)', '格式：/at 23:30 文本，或 /at reset 文本（5 小时额度重置后）')); return; }
        host.send({ type: 'queue', sessionId: target.id, text: p.text, at: p.at });
        notify(L(`Отправлю в ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, `Will send at ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, `将于 ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 发送`));
      } else if (name === 'stop') {
        if (target) host.send({ type: 'interrupt', sessionId: target.id }); else notify(L('Нечего останавливать: чат не открыт', 'Nothing to stop: no chat is open', '没有可停止的内容'));
      } else if (name === 'new') { input.value = ''; await chooseFolder(); return; }
      else if (name === 'end') { if (target) host.send({ type: 'end', sessionId: target.id }); else notify(L('Чат не открыт', 'No chat is open', '没有打开的聊天')); }
      else if (name === 'sessions') { input.value = ''; (document.getElementById('chat-switch') as HTMLElement).click(); return; }
      else if (name === 'terminal') { if (target) host.openTerminal(target.id); else notify(L('Чат не открыт', 'No chat is open', '没有打开的聊天')); }
      else if (name === 'usage') { input.value = ''; (document.getElementById('usage-ring') as HTMLElement).click(); return; }
      else if (name === 'settings') { input.value = ''; settingsPanel.toggle(); return; }
      else if (name === 'help') {
        const box = $('models');
        box.replaceChildren(...COMMANDS.map((c) => Object.assign(document.createElement('div'), { className: 'hint', textContent: `/${c.name}${c.args ? ' ' + c.args : ''} — ${c.desc()}${c.kind === 'claude' ? ' (Claude Code)' : ''}` })));
        box.hidden = false;
      }
      input.value = '';
      return;
    }
    let d = decideSend(input.value, chatSnap(), folder, mode);
    if (d.kind === 'needFolder') {
      if (!(await chooseFolder())) return;
      d = decideSend(input.value, chatSnap(), folder, mode);
    }
    if (d.kind === 'queue') { host.send({ type: 'queue', sessionId: d.sessionId, text: d.text }); input.value = ''; return; }
    if (d.kind === 'busy') { notify(L('Claude занят. Нажми «стоп» или «+», чтобы начать новый чат', 'Claude is busy. Press Stop or “+” to start a new chat', 'Claude 正忙。点“停止”或“+”开始新聊天')); return; }
    if (d.kind === 'empty' || d.kind === 'needFolder') return;
    if (d.kind === 'start') { pinnedId = null; chatId = null; host.send({ type: 'start', cwd: d.cwd, prompt: d.prompt }); }
    else host.send({ type: 'send', sessionId: d.sessionId, text: d.text });
    input.value = '';
  };
  $('btn-new').addEventListener('click', () => setExpanded(true));
  $('btn-close').addEventListener('click', () => setExpanded(false));
  $('btn-term').addEventListener('click', () => { const s = chatSession(); if (s) host.openTerminal(s.id); });
  $('btn-end').addEventListener('click', () => { const s = chatSession(); if (s) host.send({ type: 'end', sessionId: s.id }); });
  $('btn-folder').addEventListener('click', () => void chooseFolder());
  $('btn-send').addEventListener('click', () => void submit());
  $('btn-stop').addEventListener('click', () => { const s = chatSession(); if (s) host.send({ type: 'interrupt', sessionId: s.id }); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
    else if (e.key === 'Escape') setExpanded(false);
  });
  // ---- Claude's questions (AskUserQuestion): its options as buttons; several questions are answered one after another ----
  let askShown: string | null = null, askIdx = 0, askAnswers: Record<string, string> = {}, askPicked = new Set<string>();
  /** the question on screen: Enter in the composer answers it with the typed text (Claude Code's "Other") */
  let askFor: PendingPermission | null = null;
  const btn = (label: string, cls: string, title?: string) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; if (title) b.title = title; return b; };
  const chooseAnswer = (pp: PendingPermission, label: string) => {
    const q = pp.questions![askIdx];
    askAnswers[q.question] = label;
    askIdx++; askPicked = new Set();
    if (askIdx < pp.questions!.length) drawQuestion(pp);
    else { host.send({ type: 'permission', id: pp.id, allow: true, answers: askAnswers }); askFor = null; }
  };
  const drawQuestion = (pp: PendingPermission) => {
    const qs = pp.questions!, q: AskQuestion = qs[askIdx];
    $('perm-text').textContent = `${qs.length > 1 ? `${askIdx + 1}/${qs.length} · ` : ''}${q.header ? `${q.header}: ` : ''}${q.question}`;
    $('perm-text').title = q.question;
    const done = btn(L('Готово', 'Done', '完成'), 'ask-done');
    const opts = q.options.map((o) => {
      const b = btn(o.label, 'ask-opt', o.description);
      b.addEventListener('click', () => {
        if (!q.multiSelect) { chooseAnswer(pp, o.label); return; }
        if (askPicked.has(o.label)) askPicked.delete(o.label); else askPicked.add(o.label);
        b.classList.toggle('on', askPicked.has(o.label));
        done.disabled = askPicked.size === 0;
      });
      return b;
    });
    done.disabled = true;
    done.addEventListener('click', () => { if (askPicked.size) chooseAnswer(pp, q.options.map((o) => o.label).filter((l) => askPicked.has(l)).join(', ')); });
    const term = btn(L('В терминале', 'In the terminal', '在终端中'), 'ask-skip', L('Ответить в терминале или приложении', 'Answer in the terminal or the app', '在终端或应用中回答'));
    term.addEventListener('click', () => { host.send({ type: 'permission', id: pp.id, allow: false }); askFor = null; });
    $('perm-q').replaceChildren(...opts, ...(q.multiSelect ? [done] : []), term);
  };
  const renderAsk = (pp: PendingPermission) => {
    const qs = pp.questions;
    show($('btn-allow'), !qs); show($('btn-deny'), !qs); show($('perm-q'), !!qs);
    $('perm').classList.toggle('ask', !!qs);
    askFor = qs ? pp : null;
    if (!qs) { askShown = null; return; }
    if (askShown === pp.id) return;
    askShown = pp.id; askIdx = 0; askAnswers = {}; askPicked = new Set();
    drawQuestion(pp);
  };
  // messages waiting for the turn to end (or for their time), under the chat; × takes one back
  let queueKey = '';
  const renderQueue = (sid: string | null, s: Session | null) => {
    const q = sid && s ? s.queue ?? [] : [];
    const key = `${sid}|${JSON.stringify(q)}`;
    if (key === queueKey) return;
    queueKey = key;
    const box = $('queue');
    box.replaceChildren(...q.map((m) => {
      const row = document.createElement('div'); row.className = 'q-row';
      const when = document.createElement('span'); when.className = 'q-when';
      when.textContent = m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : L('после ответа', 'after the reply', '回复后');
      const t = document.createElement('span'); t.className = 'q-text'; t.textContent = m.text; t.title = m.text;
      const x = btn('×', 'q-x', L('Убрать из очереди', 'Remove from the queue', '移出队列'));
      x.addEventListener('click', () => host.send({ type: 'unqueue', sessionId: sid!, id: m.id }));
      row.append(when, t, x);
      return row;
    }));
    show(box, q.length > 0);
  };

  const answer = (allow: boolean) => {
    const id = current()?.pendingPermission?.id;
    if (id) host.send({ type: 'permission', id, allow });
  };
  $('btn-allow').addEventListener('click', () => answer(true));
  $('btn-deny').addEventListener('click', () => answer(false));
  host.onSummon(() => setExpanded(true));
  if (cfg.expanded) setExpanded(true);

  // incremental chat rendering: only nodes from the first changed item are rebuilt
  let shownFor: string | null = null;
  let shown: ChatItem[] = [];
  const renderChat = (s: Session | null) => {
    if (!expanded) return;
    const newChat = mode === 'new' && !!folder;
    const sid = newChat ? null : s?.id ?? null;
    const title = newChat ? `${L('Новый чат', 'New chat', '新聊天')} · ${folder!.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}` : s ? `${s.project} · ${STATE_LABEL[s.state]}` : L('Чат', 'Chat', '聊天');
    if ($('chat-title').textContent !== title) $('chat-title').textContent = title;
    show($('btn-term'), !!sid); show($('btn-end'), !!sid);
    const openLabel = s?.desktopId ? L('Открыть в приложении Claude', 'Open in the Claude app', '在 Claude 应用中打开') : L('Открыть в терминале', 'Open in terminal', '在终端中打开');
    if ($('btn-term').getAttribute('aria-label') !== openLabel) { $('btn-term').title = openLabel; $('btn-term').setAttribute('aria-label', openLabel); }
    // ask for the transcript once per opening of this chat (even if /btw already put messages there)
    if (sid && !historyAsked.has(sid)) { historyAsked.add(sid); host.send({ type: 'history', sessionId: sid }); }
    renderQueue(sid, s);
    const items = sid ? chats.get(sid) ?? [] : [];
    if (sid !== shownFor) { shownFor = sid; shown = []; list.replaceChildren(); }
    let i = 0;
    while (i < shown.length && i < items.length && shown[i] === items[i]) i++;
    if (i === shown.length && i === items.length && list.firstChild) { if (pendingBottom) { list.scrollTop = list.scrollHeight; pendingBottom = false; } return; }
    const stick = pendingBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    pendingBottom = false;
    while (list.children.length > i) list.lastChild!.remove();
    for (let k = i; k < items.length; k++) list.append(messageNode(items[k]));
    if (items.length === 0) {
      const e = document.createElement('div'); e.className = 'msg empty';
      e.textContent = newChat || !s ? L('Напиши задачу, Claude ответит здесь', 'Write a task, Claude will answer here', '写下任务，Claude 会在这里回答') : L('Переписка появится здесь', 'The conversation will appear here', '对话将显示在这里');
      list.append(e);
    }
    shown = items.slice();
    if (stick) list.scrollTop = list.scrollHeight;
  };

  // ---- chat header switcher: one click on a session switches to its chat ----
  const setMenu = (open: boolean) => { chatMenu.hidden = !open; switchBtn.setAttribute('aria-expanded', String(open)); if (open) hideModels(); };
  switchBtn.addEventListener('click', () => setMenu(chatMenu.hidden));
  // calm sessions are folded into one collapsed group; the arrow unfolds them (shared by both lists)
  let showQuiet = false, lastSnap: Snapshot | null = null;
  const foldRows = (rows: Array<RowData & { quiet: boolean }>): RowData[] => {
    const act = rows.filter((r) => !r.quiet), q = rows.filter((r) => r.quiet);
    if (q.length === 0) return act;
    const g: RowData = { id: '__quiet', current: false, tone: '', name: L(`Неактивные · ${q.length}`, `Inactive · ${q.length}`, `不活跃 · ${q.length}`), meta: '', tip: '', dismissable: false, group: true, open: showQuiet };
    return showQuiet ? [...act, g, ...q] : [...act, g];
  };
  const toggleQuiet = () => { showQuiet = !showQuiet; renderPanel(lastSnap); renderChatMenu(); };
  const dismissLabel = L('Убрать из списка', 'Remove from list', '从列表移除');
  let newRow: HTMLElement | null = null;
  const renderChatMenu = () => {
    if (chatMenu.hidden) return;
    const now = Date.now();
    const rows = sessionRows(raw?.sessions ?? [], chatId, now);
    if (!newRow) {
      newRow = document.createElement('button'); newRow.className = 'row new'; newRow.setAttribute('role', 'option');
      newRow.dataset.tip = L('Выбрать папку и начать новую задачу', 'Pick a folder and start a new task', '选择文件夹并开始新任务');
      const n = document.createElement('span'); n.className = 'name'; n.textContent = L('+ Новый чат…', '+ New chat…', '+ 新聊天…');
      newRow.append(n);
      newRow.addEventListener('click', async () => { setMenu(false); if (await chooseFolder()) { chatId = null; pinnedId = null; mode = 'new'; input.focus(); } });
    }
    if (newRow.parentElement !== chatMenu) chatMenu.append(newRow);
    const data = foldRows(rows.map((r) => ({ id: r.id, current: r.current, tone: r.tone === 'busy' ? '' : r.tone, name: r.title, meta: r.meta, tip: r.cwd, dismissable: !r.owned, quiet: r.quiet })));
    syncRows(chatMenu, data, { toggle: toggleQuiet, open: (id) => { setMenu(false); openChat(id); }, dismiss: (id) => host.send({ type: 'dismiss', sessionId: id }), dismissLabel }, newRow);
  };
  chatMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); input.focus(); } });
  // Ctrl+Tab / Ctrl+Shift+Tab cycle through the chats without touching the mouse
  document.addEventListener('keydown', (e) => {
    if (!expanded || !e.ctrlKey || e.key !== 'Tab') return;
    e.preventDefault();
    const id = nextChatId(sessionRows(raw?.sessions ?? [], chatId, 0).map((r) => r.id), chatId, e.shiftKey ? -1 : 1);
    if (id) openChat(id);
  });

  // ---- sessions switcher ----
  const panel = $('sessions');
  if (cfg.panel) panel.hidden = false;
  $('btn-activity').addEventListener('click', () => { panel.hidden = !panel.hidden; });
  let panelEmpty: HTMLElement | null = null;
  const renderPanel = (snap: Snapshot | null) => {
    if (panel.hidden) return;
    const now = Date.now();
    const list = [...(raw?.sessions ?? [])].sort((a, b) => b.lastEventAt - a.lastEventAt);
    if (list.length === 0) {
      if (!panelEmpty) { panelEmpty = document.createElement('div'); panelEmpty.className = 'empty'; panelEmpty.textContent = L('Сессий пока нет', 'No sessions yet', '还没有会话'); }
      panel.replaceChildren(panelEmpty); return;
    }
    if (panelEmpty?.parentElement === panel) panelEmpty.remove();
    const data = foldRows(list.map((x) => ({
      id: x.id, current: x.id === snap?.attention,
      tone: x.state === 'waiting' || x.state === 'error' ? 'alert' : x.state === 'idle' || x.state === 'sleeping' ? 'quiet' : '',
      name: x.project, meta: `${hostTag(x) ? `${hostTag(x)} · ` : ''}${STATE_LABEL[x.state]} · ${formatElapsed(now - x.since)}`, tip: x.cwd, dismissable: !x.owned, quiet: isQuiet(x, snap?.attention ?? null, now),
    })));
    syncRows(panel, data, { toggle: toggleQuiet, open: (id) => openChat(id), dismiss: (id) => host.send({ type: 'dismiss', sessionId: id }), dismissLabel });
  };

  // ---- hover dock: the buttons rest as a shadow under the pet and grow out of it while the cursor is over the pet ----
  const dockPill = $('dock-pill');
  let peek = false, peekOff: ReturnType<typeof setTimeout> | undefined;
  host.onHover((h) => {
    clearTimeout(peekOff);
    if (h) peek = true; else peekOff = setTimeout(() => { peek = false; wake(); }, 380); // a short grace: no flicker on the way to the buttons
    wake();
  });
  let hoverSent = '';
  const reportHover = () => {
    const rects = ['sprite-wrap', 'dock-pill', 'chip'].map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e && !e.hidden && e.offsetParent !== null)
      .map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const key = rectsKey(rects);
    if (key !== hoverSent) { hoverSent = key; host.hoverRects(rects); }
  };

  // ---- frame loop ----

  let detailOpen = false, lastHeavy = 0;
  // Smooth motion: frames cross-fade into each other (a state change fades a little longer and gets a soft "pop"),
  // and a calm pet breathes. All of it is skipped when the OS asks for reduced motion.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  animatePanels(['notice', 'perm', 'sessions', 'settings', 'usage', 'chat', 'chat-menu', 'models', 'cmds'].map((id) => document.getElementById(id)), reduceMotion);
  const motion = createMotion({ sprite, dockPill, chip: $('chip') }, reduceMotion);
  // a click on the chip (outside the ring, which opens the limits) shows or hides the session name
  $('chip').addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('#usage-ring')) return; detailOpen = !detailOpen; wake(); });
  // the island's left edge is placed so that the calm word ("Ready") is centred under the pet; the ring stays there whatever the word is
  const fitAnchor = () => {
    const w = $('label'), cs = getComputedStyle(w);
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    $('chip').style.setProperty('--ref', `${Math.ceil(7 + 26 + 8 + ctx.measureText(chipLabel('idle')).width + 15)}px`); // border + ring + gap + word + padding
  };
  fitAnchor();
  void document.fonts?.ready.then(fitAnchor);
  const FRAME_FADE_MS = 100, STATE_FADE_MS = 190;
  let curRow = -1, curCol = -1, prevRow = -1, prevCol = -1, fadeStart = 0, fadeMs = 0, fading = false, lastAtlasV = -1, lastSizeV = -1, drawnFade = 1;
  const smooth = (p: number) => p * p * (3 - 2 * p);
  const draw = (r: number, c: number, alpha: number) => {
    ctx.globalAlpha = alpha;
    ctx.drawImage(atlas, c * cw, r * ch, cw, ch, 0, 0, sprite.width, sprite.height);
    ctx.globalAlpha = 1;
  };
  let lastTick = 0;
  const tick = (t: number) => {
    own = true;
    if (t - lastTick < 15) { schedule(t); return; } // high-refresh displays (144 Hz+): ~60 updates a second are plenty
    lastTick = t;
    const snap = eff();
    const s = snap?.sessions.find((x) => x.id === snap.attention) ?? null;
    const v = statusView(snap, connected, Date.now());
    anim.setState(v.state);
    if (movedAt && t - movedAt > 180) { movedAt = 0; anim.setDrag(null); }
    const awake = peek || settingsPanel.isOpen() || usageOpen || dockPill.matches(':focus-within');
    dockPill.classList.toggle('rest', !awake);
    $('chip').classList.toggle('rest', !awake);
    motion.setAwake(awake || expanded);
    if (!awake) detailOpen = false;
    motion.setDetail(detailOpen);
    const { row, col } = anim.frame(t);
    if (row !== curRow || col !== curCol) {
      const rowChanged = curRow >= 0 && row !== curRow;
      prevRow = curRow; prevCol = curCol; curRow = row; curCol = col;
      fading = prevRow >= 0 && !reduceMotion && !(movedAt && rowChanged); // dragging flips rows constantly: no fade there
      fadeStart = t; fadeMs = rowChanged ? STATE_FADE_MS : FRAME_FADE_MS;
      if (rowChanged && !movedAt) motion.pop();
    }
    const p = fading ? Math.min(1, (t - fadeStart) / fadeMs) : 1;
    if (p >= 1) fading = false;
    if (p !== drawnFade || atlasVersion !== lastAtlasV || sizeVersion !== lastSizeV || fading) {
      drawnFade = p; lastAtlasV = atlasVersion; lastSizeV = sizeVersion;
      ctx.clearRect(0, 0, sprite.width, sprite.height);
      if (p < 1 && prevRow >= 0) { draw(prevRow, prevCol, 1); draw(curRow, curCol, smooth(p)); } else draw(curRow, curCol, 1);
    }
    motion.setBreathing(!movedAt && (v.state === 'idle' || v.state === 'sleeping'));
    const text = `${v.chip}|${v.detail}|${v.attention}`;
    if (text !== lastText) {
      lastText = text;
      motion.setWord(v.chip);
      $('detail').textContent = v.detail;
      $('chip').classList.toggle('attention', v.attention);
      $('chip').dataset.state = v.state;
      motion.setPulse(v.state !== 'idle' && v.state !== 'done' && v.state !== 'sleeping');
      $('chip').classList.toggle('offline', !connected);
    }
    // the heavy DOM work (panels, chat, rects, window size): when something changed (dirty), and once a second for the running clocks
    if (!dirty && t - lastHeavy < 1000) { schedule(t); return; }
    dirty = false;
    lastHeavy = t;
    const pp = s?.pendingPermission;
    show($('perm'), !!pp);
    if (pp) {
      renderAsk(pp);
      if (!pp.questions) $('perm-text').textContent = `${pp.tool}: ${pp.summary}`;
      if (pp.id !== lastNotified) { lastNotified = pp.id; host.notify(L('Claude ждёт разрешения', 'Claude needs permission', 'Claude 需要权限'), `${s!.project}: ${pp.tool} ${pp.summary}`); }
    }
    // a chat opened before any session was known follows the first one that appears
    if (expanded && !chatId && !newChatChosen) { const c = current(); if (c) { chatId = c.id; mode = 'reply'; } }
    const cs = chatSnap();
    const chatS = chatSession();
    const busy = isBusyReply(cs, mode);
    const ph = askFor ? L('Или напиши свой ответ на вопрос Claude…', 'Or type your own answer to Claude’s question…', '或输入你对 Claude 问题的回答…') : placeholderFor(cs, folder, mode);
    if (input.placeholder !== ph) input.placeholder = ph;
    if (input.disabled) input.disabled = false; // a busy session queues the message instead
    show($('btn-stop'), busy && canStop(chatS));
    show($('btn-send'), !(busy && canStop(chatS)));
    lastSnap = snap;
    renderPanel(snap);
    renderChatMenu();
    renderChat(chatS);
    fitWindow();
    reportRects();
    reportHover();
    schedule(t);
  };
  /**
   * The loop sleeps until something can change: the next sprite frame, the end of a cross-fade, the next second (elapsed-time labels),
   * the end of a drag. Events wake it at once (wake()). Before this it ran 60 times a second even for a pet sitting still.
   */
  let timer: ReturnType<typeof setTimeout> | undefined, queued = false, dirty = true;
  const runSoon = () => { if (!queued) { queued = true; requestAnimationFrame((t) => { queued = false; tick(t); }); } };
  function schedule(t: number) {
    // queued at the END of the tick: the observers' records of this tick's own writes are delivered before it
    queueMicrotask(() => { own = false; });
    if (fading || dirty) { runSoon(); return; }
    let ms = Math.min(anim.msToNextFrame(t), 1000 - (Date.now() % 1000) + 5);
    if (movedAt) ms = Math.min(ms, Math.max(0, 180 - (t - movedAt)));
    if (ms < 17) { runSoon(); return; }
    clearTimeout(timer);
    timer = setTimeout(runSoon, ms - 8); // wake just before the frame is due; rAF then aligns it to the display
  }
  wake = () => { dirty = true; clearTimeout(timer); runSoon(); };
  // anything the user does in the window, and any element shown, hidden or resized, may change the layout: recompute at once
  for (const ev of ['pointerdown', 'pointerover', 'pointerout', 'keydown', 'input', 'focusin', 'focusout', 'wheel', 'transitionend', 'animationend']) document.addEventListener(ev, () => wake(), { capture: true, passive: true });
  // the loop's own DOM writes must not wake it again (that would spin it at 60 fps): their records arrive before `own` is cleared
  let own = false;
  new MutationObserver(() => { if (!own) wake(); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  new ResizeObserver(() => { if (!own) wake(); }).observe(document.body);
  runSoon();
}
void main();
