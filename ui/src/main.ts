import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, shell, Tray, nativeImage, nativeTheme, screen } from 'electron';
import { confirmOptions, isConfirmed } from './dialogs.js';
import { join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { loadPet } from './sprite/loadPet.js';
import { listModels, pickModel, MODEL_ID, DEFAULT_MODEL } from './models/registry.js';
import { installModelFromZip, installModelFromDir, removeModel, scanPetFolder, ModelError } from './models/install.js';
import { loadSettings, saveSettings } from './settings.js';
import { focusByTitle, focusDesktopApp } from './focusWindow.js';
import { sendToDesktop, newChatLink, unhideDesktop } from './desktopSend.js';
import { formatDiagnostics, lastEventByHost, hostIdOf } from './diagnostics.js';
import { syncHelper } from './stableHelper.js';
import { checkLatest } from './updates.js';
import { planProfile, removeFromProfile, profileState, profilePaths, readProfile, applyProfile } from './psProfile.js';
import { overAny, type Rect } from './hitTest.js';
import { placeStage, restoreAnchor, IDLE_H, type Anchor } from './placement.js';
import { nativeTerminalCommand, nativeFocusCommand } from './nativeTerminal.js';
import { terminalCommand, windowsTerminalCommand, newSessionCommand, windowsNewSessionCommand, matchNewSession } from './terminal.js';
import { createWindowsHost, WINDOWS_HOST_PORT } from './hub/windowsHost.js';
import { createWslHost, parseDistroList, secondaryDistros, portForDistro, type WslHost } from './hub/wslHost.js';
import { mergeSnapshots, mergeUsage, hostOf, hostOfPermission, type HostPart } from './hub/merge.js';
import { createDesktopRegistry, findRegistryRoots, decorateDesktop, type DesktopEntry } from './hub/desktopRegistry.js';
import { pickAttention } from '../../daemon/src/sessionStore.js';
import { toWslPath } from '../../daemon/src/paths.js';
import { cleanAppearance } from './appearance.js';
import { MessageQueue } from './hub/messageQueue.js';
import { clampScale, PET_SCALE_MIN, PET_SCALE_MAX } from './petScale.js';
import { PERMISSION_POLICIES, type PermissionPolicy, type BridgeMessage, type UsageInfo, type Session } from '../../shared/src/types.js';
import { L, setLang, getLang, resolveLang, LANG_PREFS, type LangPref } from '../../shared/src/i18n.js';

/** Width is constant; the height starts at the pet's own part and the renderer grows it downwards when a panel opens (see pet:resize). */
/** the window never resizes: a transparent, click-through stage of this size, the pet stands at its bottom */
const STAGE_W = 424, STAGE_H = 260, MAX_H = 1000;
// Packaged: everything ships under resources/. Dev: bridge is built into <repo>/build, bundled pet models live in <repo>/models.
const res = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(__dirname, '../..', ...(p[0] === 'models' ? p : ['build', ...p])));
const bridgePath = process.env.CLAUDE_PET_BRIDGE ?? res('bridge', 'bridge.cjs');
/** Bundled models ship read-only with the app; the user's own models live in the user data folder, away from the app files. */
const bundledModelsDir = res('models');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const expandedArg = process.argv.includes('--expanded');
const panelArg = process.argv.includes('--panel');
const iconArg = arg('dump-icon');
const atlasArg = arg('dump-atlas'), shotArg = arg('screenshot'), shotDelay = Number(arg('shot-delay') ?? 3000);
const demo = process.env.CLAUDE_PET_DEMO_PROMPT ? { prompt: process.env.CLAUDE_PET_DEMO_PROMPT, cwd: process.env.CLAUDE_PET_DEMO_CWD ?? '' } : null;
/** Linux and macOS: one local bridge, no WSL, no Windows host, no desktop-app automation */
const NATIVE = process.platform !== 'win32';
/** donations page (ccPet stays free) */
const SUPPORT_URL = 'https://boosty.to/cpet';
/** the highest always-on-top band: above fullscreen players and games on macOS and Linux (Windows has one topmost band) */
const TOP_LEVEL = 'screen-saver' as const;
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // a pet behind a fullscreen window must keep drawing when it comes back on top
if (process.platform === 'linux') { // a transparent, always-on-top overlay needs X11 (XWayland under Wayland) and a transparent visual
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
const onPath = (bin: string) => (process.env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, bin)));
const theme = process.env.CLAUDE_PET_THEME;
if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme;

/** the only addresses the app opens in a browser (npm pages of the pet installers it documents) */
const OPEN_URLS = new Set(['https://www.npmjs.com/package/codex-pets', 'https://www.npmjs.com/package/@codex-pets/cli']);
// the app was called "Claude Pet": its settings, models and log stay in that folder so a rename loses nothing
app.setPath('userData', join(app.getPath('appData'), 'Claude Pet'));
const userFile = (n: string) => join(app.getPath('userData'), n);
const log = (m: string) => { try { appendFileSync(userFile('pet.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* non-fatal */ } };

function startAnchor(): Anchor {
  let a: Anchor | null = null;
  try { a = restoreAnchor(readFileSync(userFile('window.json'), 'utf8')); } catch { /* first run */ }
  if (a) {
    const wa = screen.getDisplayNearestPoint({ x: Math.round(a.cx), y: Math.round(a.bottom - 1) }).workArea;
    if (a.cx >= wa.x && a.cx <= wa.x + wa.width && a.bottom > wa.y + 60 && a.bottom <= wa.y + wa.height + 1) return a;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { cx: wa.x + wa.width - 160, bottom: Math.max(wa.y + 260, wa.y + wa.height - 440) }; // room below the pet for the chat and settings
}

// A second launch only summons the running pet (see 'second-instance'); it must not start anything itself.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

if (primary) app.whenReady().then(async () => {
  let settings = loadSettings(userFile('settings.json'));
  setLang(resolveLang(settings.language, app.getLocale()));
  const userModelsDir = userFile('models');
  const activeModel = () => pickModel(listModels(bundledModelsDir, userModelsDir), settings.model);
  const chosen = activeModel();
  if (!process.env.CLAUDE_PET_SPRITE && !chosen) throw new Error(`No pet model found in ${bundledModelsDir}`);
  const pet = await loadPet(process.env.CLAUDE_PET_SPRITE ?? chosen!.dir);
  const initialAnchor = startAnchor();
  const win = new BrowserWindow({
    ...(() => { const wa = screen.getDisplayNearestPoint({ x: Math.round(initialAnchor.cx), y: Math.round(initialAnchor.bottom - 1) }).workArea; return placeStage(initialAnchor, STAGE_W, STAGE_H, wa); })(), frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, TOP_LEVEL);
  if (NATIVE) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); // the pet follows the user across desktops
  if (process.platform === 'darwin') app.dock?.hide(); // a menu-bar style app: no Dock icon
  // the pet's page never navigates or opens windows (no links are rendered; this only closes the door)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.setIgnoreMouseEvents(true, { forward: true }); // click-through except over the pet's own elements

  // ---- hosts: a bridge process in every followed WSL distro (the default one is the primary), plus the Windows host (this process); the renderer sees one merged session list ----
  let up = false, quitting = false, lastSnapshot: any = null, hooksManual = false;
  let winUp = false, winSnap: any = null;
  const hostUp = new Map<string, boolean>();
  const hostSnap = new Map<string, any>();
  const wslHosts = new Map<string, WslHost>();
  const primary = () => wslHosts.get('wsl')!;
  const toBridge = (cmd: object) => primary().send(cmd); // new chats, models and limits stay with the default distro
  const toAllBridges = (cmd: object) => { for (const h of wslHosts.values()) h.send(cmd); };
  const hostParts = (): HostPart[] => [
    ...[...wslHosts.values()].map((h) => ({ host: h.id, snap: hostSnap.get(h.id) ?? null, distro: h.secondary || wslHosts.size > 1 ? h.name() : undefined })),
    ...(NATIVE ? [] : [{ host: 'windows', snap: winSnap }]),
  ];
  // the desktop app's own session list: chat titles, archived chats, ids to open them in the app (re-read at most every 5 s, changed files only)
  const desktopReg = createDesktopRegistry(() => (NATIVE ? [] : findRegistryRoots(process.env.LOCALAPPDATA ?? '', process.env.APPDATA ?? '')));
  let desktopMap = new Map<string, DesktopEntry>();
  let desktopAt = 0;
  const desktopEntries = () => {
    if (Date.now() - desktopAt > 5000) { desktopAt = Date.now(); try { desktopMap = desktopReg.byCliId(); } catch (e) { log(`desktop registry: ${(e as Error).message}`); } }
    return desktopMap;
  };
  /** limits come from every host (the WSL bridge, the Windows status line): the ring shows the freshest numbers */
  const usageBy = new Map<string, UsageInfo>();
  const hostMessage = (hostId: string, m: BridgeMessage) => {
    if (m.type === 'usage') { usageBy.set(hostId, m.usage); const u = mergeUsage([...usageBy.values()]); if (u) win.webContents.send('pet:msg', { type: 'usage', usage: u }); return; }
    win.webContents.send('pet:msg', m);
  };
  let pendingNewChat: { cwd: string; at: number; prompt: string; known: string[] } | null = null;
  /** the pet's command handler (set further down, where everything it needs exists); queued messages go out through it */
  let onCmd: (cmd: any) => Promise<void> = async () => {};
  const queueFile = userFile('queue.json');
  const queue = new MessageQueue((d) => writeFileSync(queueFile, JSON.stringify(d)), (() => { try { return JSON.parse(readFileSync(queueFile, 'utf8')); } catch { return undefined; } })());
  const drainQueue = () => {
    for (const { sessionId, message } of queue.due(lastSnapshot?.sessions ?? [], Date.now())) {
      const s = (lastSnapshot?.sessions ?? []).find((x: Session) => x.id === sessionId);
      // only a session the pet reaches without asking (its terminal link, its mailbox, the Windows host): never a dialog or a second process at night
      if (s && !s.owned && !s.pty && !s.mailbox && s.host !== 'windows') {
        log(`queue: ${sessionId} cannot take a message without the user; dropped`);
        win.webContents.send('pet:msg', { type: 'chat', sessionId, event: { kind: 'note', text: L(`Сообщение из очереди не отправлено: у сессии нет связи с питомцем. Текст: ${message.text}`, `A queued message was not sent: the session has no link to the pet. Text: ${message.text}`, `排队消息未发送：会话未连接到宠物。内容：${message.text}`) } });
        continue;
      }
      log(`queue: sending a waiting message to ${sessionId}`);
      void onCmd({ type: 'send', sessionId, text: message.text, queued: true });
    }
  };
  setInterval(drainQueue, 2000); // timed messages and turns that ended without a fresh snapshot
  const pushSnapshot = () => {
    const m = mergeSnapshots(hostParts());
    const sessions = queue.decorate(decorateDesktop(m.sessions, desktopEntries()));
    if (pendingNewChat) {
      const w = pendingNewChat;
      const id = matchNewSession(sessions, w);
      if (id) { pendingNewChat = null; void winHost.handle({ type: 'send', sessionId: id, text: w.prompt }); }
      else if (Date.now() - w.at > 120_000) { pendingNewChat = null; log('new Windows chat: the session did not appear in time, first prompt dropped'); }
    }
    lastSnapshot = { ...m, sessions, attention: sessions.some((x) => x.id === m.attention) ? m.attention : pickAttention(sessions)?.id ?? null };
    win.webContents.send('pet:msg', lastSnapshot);
    setTimeout(drainQueue, 0);
  };
  // a chat renamed, archived or deleted in the app shows up in the pet at once (the folder is watched; the 5 s re-read above stays as the fallback)
  const regWatchers = new Map<string, FSWatcher>();
  let regTimer: NodeJS.Timeout | null = null;
  const watchRegistry = () => {
    for (const r of (NATIVE ? [] : findRegistryRoots(process.env.LOCALAPPDATA ?? '', process.env.APPDATA ?? ''))) {
      if (regWatchers.has(r)) continue;
      try {
        const w = watch(r, { recursive: true }, () => { if (!regTimer) regTimer = setTimeout(() => { regTimer = null; desktopAt = 0; pushSnapshot(); }, 400); });
        w.on('error', () => { regWatchers.delete(r); try { w.close(); } catch { /* gone */ } });
        regWatchers.set(r, w);
      } catch (e) { log(`desktop registry watch: ${(e as Error).message}`); }
    }
  };
  watchRegistry();
  setInterval(watchRegistry, 60_000).unref(); // the app may be installed or first run later
  const sendUp = () => { up = winUp || [...hostUp.values()].some(Boolean); win.webContents.send('pet:bridge', up); };
  // hooks, the status line and the PowerShell wrapper use a stable copy of pet-helper.exe (it is in use for as long as sessions live;
  // the install folder must stay replaceable by the next installer). A busy copy is refreshed later.
  const installedHelper = app.isPackaged ? join(process.resourcesPath, 'helper', 'pet-helper.exe') : join(__dirname, '..', 'helper', 'pet-helper.exe');
  const helperDir = join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'ccPet', 'bin');
  const firstSync = NATIVE ? { path: undefined as string | undefined, error: undefined as string | undefined, updated: false } : syncHelper(installedHelper, helperDir);
  if (firstSync.error) log(`pet-helper copy: ${firstSync.error}`);
  const helperPath = firstSync.path;
  if (firstSync.error && helperPath !== installedHelper) setInterval(() => { const r = syncHelper(installedHelper, helperDir); if (r.updated) log('pet-helper copy updated'); }, 10 * 60_000).unref();
  const winHost = NATIVE ? (nullWindowsHost() as unknown as ReturnType<typeof createWindowsHost>) : createWindowsHost({
    dataDir: app.getPath('userData'), claudeHome: join(homedir(), '.claude'), port: WINDOWS_HOST_PORT, helperPath,
    permissionsFromPet: () => settings.answerPermissions,
    out: (m) => { if (m.type === 'snapshot') { winSnap = m; pushSnapshot(); } else hostMessage('windows', m); },
  });
  const info = (message: string, detail = '') => dialog.showMessageBox(win, { type: 'info', title: 'ccPet', message, detail });

  const onHooks = async (m: { diff: string; applied: boolean; installed: boolean; stale: boolean }) => {
    if (m.applied) { void info(L('Хуки подключены', 'Hooks connected', '钩子已连接'), L('Новые сессии Claude Code будут видны питомцу. Уже открытые терминалы нужно перезапустить.', 'New Claude Code sessions will be visible to the pet. Terminals that are already open need a restart.', '新的 Claude Code 会话将对宠物可见。已打开的终端需要重启。')); return; }
    if (!m.diff) { if (hooksManual) void info(L('Хуки уже подключены', 'Hooks are already connected', '钩子已经连接')); return; }
    // unasked, only offer when they're absent or broken; an install pointing at a working copy is left alone
    if (!hooksManual && m.installed && !m.stale) return;
    const added = m.diff.split('\n').filter((l) => l.startsWith('+ ')).length;
    const r = await dialog.showMessageBox(win, confirmOptions({
      type: 'question', action: L('Подключить', 'Connect', '连接'), cancel: L('Не сейчас', 'Not now', '暂不'),
      message: L('Подключить хуки Claude Code?', 'Connect Claude Code hooks?', '连接 Claude Code 钩子？'),
      detail: `${L(`Чтобы видеть сессии из терминала, питомец добавит свой хук в ~/.claude/settings.json (${added} строк, копия сохранится в settings.json.bak). Хук только сообщает питомцу о событиях и ничего не блокирует.`, `To see terminal sessions, the pet will add its hook to ~/.claude/settings.json (${added} lines, a copy is kept in settings.json.bak). The hook only tells the pet about events and blocks nothing.`, `为了显示终端会话，宠物会把它的钩子添加到 ~/.claude/settings.json（${added} 行，备份保存在 settings.json.bak）。该钩子只向宠物通知事件，不会阻止任何操作。`)}\n\n${m.diff.split('\n').slice(0, 14).join('\n')}\n…`,
    }));
    if (isConfirmed(r)) toBridge({ type: 'hooks', apply: true });
  };
  /** the session's own terminal: title its tab, then raise the window/tab with that title (false: no live terminal to move to) */
  const focusTerminalOf = async (s: { id: string; project: string; host?: string }): Promise<boolean> => {
    const mark = `${s.project} - Claude ${s.id.slice(0, 4)}`;
    const host = wslHosts.get(hostOf(s.id, hostParts()) ?? 'wsl') ?? primary();
    if (!(await host.markTerminal(s.id, mark))) return false;
    await new Promise((r) => setTimeout(r, 350)); // let the terminal apply the title
    if (NATIVE) return focusNative(mark);
    return focusByTitle(mark);
  };
  const focusNative = (title: string): Promise<boolean> => new Promise((resolve) => {
    const c = nativeFocusCommand(process.platform, title, onPath);
    if (!c) { resolve(false); return; }
    execFile(c.file, c.args, { timeout: 5000 }, (err, out) => resolve(!err && !/none/.test(String(out))));
  });
  const openNativeTerminal = (o: { cwd: string; claude: string; sessionId?: string; prompt?: string }): boolean => {
    const c = nativeTerminalCommand(process.platform, o, onPath);
    if (!c) { void info(L('Не найден терминал', 'No terminal found', '未找到终端'), L('Установите эмулятор терминала (gnome-terminal, konsole, xterm…), чтобы питомец мог открывать сессии.', 'Install a terminal emulator (gnome-terminal, konsole, xterm…) so the pet can open sessions.', '请安装终端模拟器（gnome-terminal、konsole、xterm…），宠物才能打开会话。')); return false; }
    const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore' });
    p.on('error', (e) => log(`terminal (${c.file}) failed: ${e.message}`));
    p.unref();
    return true;
  };
  const startHost = (o: { distro: string; port: number }) => {
    const id = o.distro ? `wsl:${o.distro}` : 'wsl';
    if (wslHosts.has(id)) return;
    const h = createWslHost({
      id, distro: o.distro, port: o.port, bridgePath, native: NATIVE, secondary: !!o.distro, log,
      onSnapshot: (snap) => { if (snap) hostSnap.set(id, snap); else hostSnap.delete(id); pushSnapshot(); },
      onMessage: (m) => hostMessage(id, m),
      onUp: (v) => { hostUp.set(id, v); sendUp(); },
      onReady: (host, r) => {
        if (!host.secondary) {
          if (!r.claude) void info(NATIVE ? L('Claude Code не найден', 'Claude Code not found', '未找到 Claude Code') : L('Claude Code не найден в WSL', 'Claude Code not found in WSL', '在 WSL 中未找到 Claude Code'), NATIVE ? L('Установи Claude Code (claude.com/claude-code), чтобы питомец мог запускать сессии.', 'Install Claude Code (claude.com/claude-code) so the pet can start sessions.', '请安装 Claude Code（claude.com/claude-code），宠物才能启动会话。') : L('Установи Claude Code в WSL, чтобы питомец мог запускать сессии.', 'Install Claude Code in WSL so the pet can start sessions.', '请在 WSL 中安装 Claude Code，宠物才能启动会话。'));
          hooksManual = false;
        }
        host.send({ type: 'language', lang: getLang() });
        host.send({ type: 'permission-mode', mode: settings.permissions });
        host.send({ type: 'hook-permissions', on: settings.answerPermissions });
        host.send({ type: 'sdk-chats', on: settings.sdkChats });
        if (!host.secondary) {
          host.send({ type: 'hooks', apply: false });
          if (demo) host.send({ type: 'start', cwd: demo.cwd, prompt: demo.prompt });
        }
        pushSnapshot();
      },
      onHooks: (host, m) => { if (!host.secondary) void onHooks(m); },
    });
    wslHosts.set(id, h);
    h.start();
  };
  startHost({ distro: '', port: 47822 });
  // other running WSL 2 distros are followed too (a stopped one is never started); checked every 30 s
  const scanDistros = () => execFile('wsl.exe', ['-l', '-v'], { encoding: 'buffer', windowsHide: true, timeout: 8000 }, (err, out) => {
    if (err || quitting) return;
    const names = secondaryDistros(parseDistroList(new TextDecoder('utf-16le').decode(out)));
    for (const name of names) {
      if (wslHosts.has(`wsl:${name}`)) continue;
      const taken = new Set<number>([47822, WINDOWS_HOST_PORT, ...[...wslHosts.values()].map((x) => x.port)]);
      log(`following WSL distro ${name}`);
      startHost({ distro: name, port: portForDistro(name, taken) });
    }
  });
  const distroTimer = NATIVE ? setInterval(() => undefined, 1 << 30) : setInterval(scanDistros, 30_000);
  if (!NATIVE) setTimeout(scanDistros, 4000);

  // ---- settings, tray, hotkey ----
  const applySettings = () => {
    saveSettings(userFile('settings.json'), settings);
    if (app.isPackaged) { if (process.platform === 'linux') setLinuxAutostart(settings.autostart); else app.setLoginItemSettings({ openAtLogin: settings.autostart }); }
  };
  /** Bring the pet to the front with the chat open (hotkey, second launch, /pet skill). */
  const summon = () => { win.show(); win.setAlwaysOnTop(true, TOP_LEVEL); win.focus(); win.webContents.send('pet:summon'); };
  const registerHotkey = () => {
    globalShortcut.unregisterAll();
    if (!settings.hotkey) return;
    let ok = false;
    try { ok = globalShortcut.register(settings.hotkey, () => (win.isVisible() && win.isFocused() ? win.hide() : summon())); }
    catch (e) { log(`hotkey: invalid accelerator ${settings.hotkey}: ${(e as Error).message}`); }
    log(`hotkey: ${settings.hotkey} registered=${ok}`);
    if (!ok && Notification.isSupported())
      new Notification({ title: 'ccPet', body: L(`Горячая клавиша ${settings.hotkey} недоступна (занята другим приложением)`, `The hotkey ${settings.hotkey} is unavailable (taken by another app)`, `快捷键 ${settings.hotkey} 不可用（已被其他应用占用）`) }).show();
  };
  /** How to install the ccPet plugin (a Claude Code mod): one command typed in Claude Code; the pet never edits anything for it */
  const PLUGIN_INSTALL = '/plugin install ccpet --marketplace S1NexZ/ccPet';
  const showPluginInfo = async () => {
    const r = await dialog.showMessageBox(win, confirmOptions({
      type: 'question', action: L('Копировать команду', 'Copy command', '复制命令'), cancel: L('Закрыть', 'Close', '关闭'),
      message: L('Плагин ccPet для Claude Code', 'The ccPet plugin for Claude Code', 'Claude Code 的 ccPet 插件'),
      detail: L(
        `Плагин работает внутри Claude Code (терминал, вкладка Code приложения Claude, VS Code). С ним сообщения из питомца приходят как ваши собственные, без обёртки терминала и без ввода в окно приложения, а лимиты плана попадают в питомца без отдельных запросов.\n\nВведите в Claude Code:\n${PLUGIN_INSTALL}\n\nЗатем перезапустите сессию (или /reload-plugins). Нужен Claude Code 2.1.287 или новее. Сессии WSL внутри приложения Claude плагины не загружают: для них остаются хуки.`,
        `The plugin runs inside Claude Code (terminal, the Code tab of the Claude app, VS Code). With it, messages from the pet arrive as your own, without the terminal wrapper or typing into the app's window, and plan limits reach the pet without extra queries.\n\nType in Claude Code:\n${PLUGIN_INSTALL}\n\nThen restart the session (or run /reload-plugins). Requires Claude Code 2.1.287 or later. WSL sessions inside the Claude app do not load plugins: hooks stay in use for them.`,
        `该插件在 Claude Code 内运行（终端、Claude 应用的 Code 标签页、VS Code）。安装后，来自宠物的消息会作为您自己的消息送达，无需终端包装器或向应用窗口输入；套餐额度也无需额外查询即可传给宠物。\n\n在 Claude Code 中输入：\n${PLUGIN_INSTALL}\n\n然后重启会话（或运行 /reload-plugins）。需要 Claude Code 2.1.287 或更高版本。Claude 应用中的 WSL 会话不加载插件，仍使用钩子。`),
    }));
    if (isConfirmed(r)) clipboard.writeText(PLUGIN_INSTALL);
  };
  const toggleWindow = () => (win.isVisible() ? win.hide() : (win.showInactive(), win.setAlwaysOnTop(true, TOP_LEVEL)));
  /** Guided terminal setup: shows the one command to run in WSL (it asks before changing ~/.bashrc, backs it up, can be undone). */
  const showTerminalSetup = async () => {
    const script = app.isPackaged ? join(process.resourcesPath, 'scripts', 'install-shell-integration.sh') : join(__dirname, '../..', 'scripts', 'install-shell-integration.sh');
    const cmd = `bash '${(NATIVE ? script : toWslPath(script)).replace(/'/g, `'\\''`)}'`;
    const r = await dialog.showMessageBox(win, confirmOptions({
      type: 'question', action: L('Копировать команду', 'Copy command', '复制命令'), cancel: L('Закрыть', 'Close', '关闭'), message: L('Подключить терминал (WSL)', 'Connect the terminal (WSL)', '连接终端（WSL）'),
      detail: L('Чтобы обычная команда `claude` запускалась через ccPet (общая сессия с питомцем), выполните в окне WSL-терминала:', 'To make the plain `claude` command run through ccPet (one shared session with the pet), run this in a WSL terminal:', '要让普通的 `claude` 命令通过 ccPet 运行（与宠物共用一个会话），请在 WSL 终端中运行：') + '\n\n' + cmd +
        L('\n\nСкрипт покажет изменение, спросит подтверждение, сохранит копию ~/.bashrc и его можно отменить: добавьте --uninstall. Без этого питомец тоже работает, но писать в терминальную сессию сможет только через запасной путь.', '\n\nThe script shows the change, asks for confirmation, keeps a copy of ~/.bashrc and can be undone with --uninstall. The pet works without it too, but can write into a terminal session only through a fallback path.', '\n\n脚本会显示改动并请求确认，保留 ~/.bashrc 的备份，可用 --uninstall 撤销。没有它宠物也能工作，但只能通过备用途径向终端会话写入。'),
    }));
    if (isConfirmed(r)) clipboard.writeText(cmd);
  };
  // ---- update check: once a day (first ~20 s after start), only tells the user; the release page opens on click ----
  let update: { version: string; url: string } | null = null;
  const checkUpdates = async () => {
    if (!settings.checkUpdates || !app.isPackaged) return;
    const u = await checkLatest(app.getVersion());
    if (!u || u.version === update?.version) return;
    update = u;
    log(`update available: ${u.version}`);
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'ccPet', body: L(`Доступна версия ${u.version}. Нажмите, чтобы открыть страницу релиза.`, `Version ${u.version} is available. Click to open the release page.`, `${u.version} 版本已发布。点击打开发布页面。`) });
      n.on('click', () => void shell.openExternal(u.url));
      n.show();
    }
  };
  setTimeout(() => void checkUpdates(), 20_000).unref();
  setInterval(() => void checkUpdates(), 24 * 3600_000).unref();
  const trayMenu = () => Menu.buildFromTemplate([
    ...(update ? [{ label: L(`Доступна версия ${update.version}…`, `Version ${update.version} is available…`, `${update.version} 版本可用…`), click: () => void shell.openExternal(update!.url) }, { type: 'separator' as const }] : []),
    { label: win.isVisible() ? L('Скрыть питомца', 'Hide the pet', '隐藏宠物') : L('Показать питомца', 'Show the pet', '显示宠物'), click: toggleWindow },
    { label: `${L('Вызов питомца', 'Summon the pet', '唤出宠物')}: ${settings.hotkey || L('выключен', 'off', '关')}`, enabled: false },
    { type: 'separator' },
    { label: L('Настройки…', 'Settings…', '设置…'), click: () => { win.show(); win.setAlwaysOnTop(true, TOP_LEVEL); win.webContents.send('pet:open-settings'); } },
    { label: NATIVE ? L('Подключить терминал…', 'Connect the terminal…', '连接终端…') : L('Подключить терминал (WSL)…', 'Connect the terminal (WSL)…', '连接终端（WSL）…'), click: () => void showTerminalSetup() },
    { label: L('Подключить хуки Claude Code…', 'Connect Claude Code hooks…', '连接 Claude Code 钩子…'), enabled: up, click: () => { hooksManual = true; toBridge({ type: 'hooks', apply: false }); } },
    { label: L('Плагин ccPet для Claude Code…', 'ccPet plugin for Claude Code…', 'Claude Code 的 ccPet 插件…'), click: () => void showPluginInfo() },
    { label: L('Уведомлять, когда нужно разрешение', 'Notify when permission is needed', '需要权限时通知'), type: 'checkbox', checked: settings.notify,
      click: (i) => { settings = { ...settings, notify: i.checked }; applySettings(); } },
    { label: L('Размер питомца', 'Pet size', '宠物大小'), submenu: [0.75, 1, 1.25, 1.5, 1.8].filter((v) => v >= PET_SCALE_MIN && v <= PET_SCALE_MAX).map((v) => ({
      label: `${Math.round(v * 100)}%`, type: 'radio' as const, checked: Math.abs(settings.petScale - v) < 0.03,
      click: () => { settings = { ...settings, petScale: v }; applySettings(); win.webContents.send('pet:scale', v); } })) },
    { label: NATIVE ? L('Запускать при входе в систему', 'Start at login', '登录时启动') : L('Запускать вместе с Windows', 'Start with Windows', '随 Windows 启动'), type: 'checkbox', checked: settings.autostart, enabled: app.isPackaged,
      click: (i) => { settings = { ...settings, autostart: i.checked }; applySettings(); } },
    { label: L('Проверять обновления (раз в день)', 'Check for updates (daily)', '检查更新（每天）'), type: 'checkbox', checked: settings.checkUpdates,
      click: (i) => { settings = { ...settings, checkUpdates: i.checked }; applySettings(); if (i.checked) void checkUpdates(); } },
    { type: 'separator' },
    // ccPet is free; a quiet link for those who want to help (never a popup or a reminder)
    { label: L('Поддержать проект ❤', 'Support the project ❤', '支持项目 ❤'), click: () => void shell.openExternal(SUPPORT_URL) },
    { label: L('Выйти', 'Quit', '退出'), click: () => app.quit() },
  ]);
  const tray = new Tray(nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: process.platform === 'darwin' ? 18 : 32, height: process.platform === 'darwin' ? 18 : 32 }));
  tray.setToolTip('ccPet');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));

  // ---- renderer IPC ----
  const petPayload = (p: Awaited<ReturnType<typeof loadPet>>) => ({
    id: p.id, name: p.displayName,
    imageUrl: `data:image/${p.image.toLowerCase().endsWith('.png') ? 'png' : 'webp'};base64,${readFileSync(p.image).toString('base64')}`,
    cell: p.cell, rows: p.rows, tweaks: p.tweaks,
  });
  ipcMain.handle('pet:config', () => ({
    bridge: up, snapshot: lastSnapshot, expanded: expandedArg, panel: panelArg, appearance: settings.appearance, permissions: settings.permissions, lang: getLang(), language: settings.language, petScale: settings.petScale,
    pet: petPayload(pet),
  }));

  // ---- pet models: list, switch, install from a ZIP / an npm pet folder, remove ----
  const modelOpts = (onProgress?: (p: unknown) => void) => ({ userDir: userModelsDir, bundledDir: bundledModelsDir, onProgress: onProgress as any });
  const listForUi = () => { const a = activeModel(); return listModels(bundledModelsDir, userModelsDir).map((m) => ({ id: m.id, name: m.name, description: m.description, source: m.source, bundled: m.bundled, active: m.id === a?.id })); };
  const findModel = (id: unknown) => (typeof id === 'string' && MODEL_ID.test(id) ? listModels(bundledModelsDir, userModelsDir).find((m) => m.id === id) : undefined);
  const failText = (e: unknown) => { if (e instanceof ModelError) return e.message; log(`models: ${(e as Error)?.stack ?? e}`); return L('Не удалось выполнить операцию с моделью. Подробности в журнале приложения.', 'The model operation failed. See the app log for details.', '模型操作失败。详情见应用日志。'); };
  const codexDir = join(homedir(), '.codex', 'pets');
  ipcMain.handle('pet:models:list', () => listForUi());
  ipcMain.handle('pet:models:data', async (_e, id) => { const m = findModel(id); if (!m) return null; try { return petPayload(await loadPet(m.dir)); } catch { return null; } });
  ipcMain.handle('pet:models:use', async (_e, id) => {
    const m = findModel(id);
    if (!m) return { ok: false, error: L('Такой модели нет.', 'There is no such model.', '没有这个模型。') };
    try { const payload = petPayload(await loadPet(m.dir)); settings = { ...settings, model: m.id }; applySettings(); return { ok: true, pet: payload, models: listForUi() }; }
    catch (e) { return { ok: false, error: failText(e) }; }
  });
  ipcMain.handle('pet:models:install-zip', async (_e, given?: string) => {
    let file = typeof given === 'string' && given ? given : null;
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: L('Установить модель питомца', 'Install a pet model', '安装宠物模型'), properties: ['openFile'], filters: [{ name: L('Модель питомца (ZIP)', 'Pet model (ZIP)', '宠物模型 (ZIP)'), extensions: ['zip'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      file = r.filePaths[0];
    }
    try {
      const m = installModelFromZip(file, modelOpts((p) => win.webContents.send('pet:models:progress', p)));
      return { ok: true, model: { id: m.id, name: m.name }, models: listForUi() };
    } catch (e) { return { ok: false, error: failText(e) }; }
  });
  ipcMain.handle('pet:models:remove', async (_e, id) => {
    const m = findModel(id);
    if (!m || m.bundled) return { ok: false, error: m ? L('Встроенную модель удалить нельзя.', 'A built-in model cannot be removed.', '内置模型无法删除。') : L('Такой модели нет.', 'There is no such model.', '没有这个模型。') };
    const r = await dialog.showMessageBox(win, confirmOptions({
      type: 'warning', action: L('Удалить', 'Delete', '删除'), cancel: L('Отмена', 'Cancel', '取消'), message: L(`Удалить модель «${m.name}»?`, `Delete the model “${m.name}”?`, `删除模型“${m.name}”？`),
      detail: L('Файлы модели будут удалены с компьютера. Встроенные модели и настройки не затрагиваются.', 'The model files will be deleted from this computer. Built-in models and settings are not affected.', '模型文件将从此电脑删除。内置模型和设置不受影响。'),
    }));
    if (!isConfirmed(r)) return { ok: false, canceled: true };
    try {
      removeModel(m.id, modelOpts());
      let pet2: ReturnType<typeof petPayload> | null = null;
      if (settings.model === m.id) { // the active one is gone: back to the default
        settings = { ...settings, model: DEFAULT_MODEL }; applySettings();
        const a = activeModel(); if (a) pet2 = petPayload(await loadPet(a.dir));
      }
      return { ok: true, models: listForUi(), pet: pet2 };
    } catch (e) { return { ok: false, error: failText(e) }; }
  });
  ipcMain.handle('pet:models:codex-scan', () => {
    const have = new Set(listModels(bundledModelsDir, userModelsDir).map((m) => m.id));
    return { dir: codexDir, exists: scanPetFolder(codexDir).length > 0 || existsSync(codexDir), found: scanPetFolder(codexDir).map((f) => ({ id: f.id, name: f.name, installed: have.has(f.id) })) };
  });
  ipcMain.handle('pet:models:codex-import', (_e, id) => {
    const f = scanPetFolder(codexDir).find((x) => x.id === id); // only folders that the scan itself found
    if (!f) return { ok: false, error: L('Папка модели не найдена.', 'Model folder not found.', '未找到模型文件夹。') };
    try { const m = installModelFromDir(f.dir, modelOpts((p) => win.webContents.send('pet:models:progress', p))); return { ok: true, model: { id: m.id, name: m.name }, models: listForUi() }; }
    catch (e) { return { ok: false, error: failText(e) }; }
  });
  ipcMain.on('pet:copy', (_e, text) => { if (typeof text === 'string' && text.length <= 500) clipboard.writeText(text); });
  ipcMain.on('pet:open-url', (_e, url) => { if (typeof url === 'string' && OPEN_URLS.has(url)) void shell.openExternal(url); });
  ipcMain.on('pet:reveal-models', () => { try { mkdirSync(userModelsDir, { recursive: true }); } catch { /* shown below */ } void shell.openPath(userModelsDir); });
  // a new language: remembered, applied to the bridge and the tray (built on demand), the UI reloads itself
  ipcMain.on('pet:scale', (_e, v: unknown) => { settings = { ...settings, petScale: clampScale(v) }; applySettings(); });
  ipcMain.on('pet:language', (_e, pref: unknown) => {
    if (!LANG_PREFS.includes(pref as LangPref)) return;
    settings = { ...settings, language: pref as LangPref }; applySettings();
    setLang(resolveLang(pref, app.getLocale()));
    toAllBridges({ type: 'language', lang: getLang() });
    win.webContents.reload();
  });
  ipcMain.on('pet:permissions', (_e, mode: unknown) => {
    if (!PERMISSION_POLICIES.includes(mode as PermissionPolicy)) return;
    settings = { ...settings, permissions: mode as PermissionPolicy }; applySettings();
    toAllBridges({ type: 'permission-mode', mode: mode as PermissionPolicy });
  });
  ipcMain.on('pet:appearance', (_e, a) => { settings = { ...settings, appearance: cleanAppearance(a) }; applySettings(); });
  const sessionById = (id: string) => (lastSnapshot?.sessions ?? []).find((x: any) => x.id === id);
  const warnedTerminal = new Set<string>();
  onCmd = async (cmd: any) => {
    if (!cmd || typeof cmd !== 'object') return;
    // messages for later live in the app: it routes every send (terminal, the Claude app's chats) and sees every host's state
    if (cmd.type === 'queue' && typeof cmd.sessionId === 'string' && typeof cmd.text === 'string' && cmd.text.trim()) { queue.add(cmd.sessionId, cmd.text.trim(), Number.isFinite(cmd.at) ? Number(cmd.at) : undefined); pushSnapshot(); return; }
    if (cmd.type === 'unqueue' && typeof cmd.sessionId === 'string') { queue.remove(cmd.sessionId, typeof cmd.id === 'string' ? cmd.id : undefined); pushSnapshot(); return; }
    if (cmd.type === 'start' && !settings.sdkChats && settings.newChatIn === 'desktop') { // a new chat inside the Claude desktop app (needs a Windows folder; the app fills the prompt, the pet presses Send)
      const prompt = String(cmd.prompt ?? '').trim();
      const link = prompt ? newChatLink(String(cmd.cwd), prompt) : null;
      if (link) {
        const r = await sendToDesktop({ text: prompt, prefillLink: link });
        if (r !== 'ok') {
          void focusDesktopApp();
          void info(L('Сообщение не отправлено', 'The message was not sent', '消息未发送'), r === 'needs-trust'
            ? L('Приложение Claude спрашивает, доверять ли этой папке. Решить это можете только вы: ответьте в приложении и нажмите «Отправить» (текст уже введён).', 'The Claude app asks whether to trust this folder. Only you can decide that: answer in the app and press Send (the text is already filled in).', 'Claude 应用正在询问是否信任此文件夹。只有您能决定：请在应用中回答并点击“发送”（文本已填好）。')
            : L('Чат открыт в приложении Claude, но питомец не смог нажать «Отправить» (' + r + '). Отправьте сообщение там сами.', 'The chat is open in the Claude app, but the pet could not press Send (' + r + '). Send the message there yourself.', '聊天已在 Claude 应用中打开，但宠物无法点击“发送”（' + r + '）。请在那里自行发送。'));
        }
        return;
      }
      if (!prompt) { void shell.openExternal(`claude://code/new?folder=${encodeURIComponent(String(cmd.cwd))}`).then(() => focusDesktopApp()).catch(() => undefined); return; }
      log('new chat in the desktop app needs a Windows folder; starting it in a terminal instead');
    }
    if (cmd.type === 'start' && !settings.sdkChats && NATIVE) {
      openNativeTerminal({ cwd: String(cmd.cwd), claude: primary().claude(), prompt: String(cmd.prompt ?? '') });
      return;
    }
    if (cmd.type === 'start' && !settings.sdkChats) { // no Agent SDK: a new chat is a new session in a real terminal (the pet sees it through the hooks)
      if (settings.newChatIn === 'windows' || !primary().isUp()) {
        const prompt = String(cmd.prompt ?? '').trim();
        const goWin = (useWt: boolean) => {
          const c = windowsNewSessionCommand({ cwd: String(cmd.cwd), helper: helperPath }, useWt);
          const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore', ...(c.cwd ? { cwd: c.cwd } : {}) });
          p.on('error', (e) => { log(`terminal (${c.file}) failed: ${e.message}`); if (useWt) goWin(false); });
          p.unref();
        };
        // the first prompt is typed into the new session once it shows up (it needs the wrapper's pipe for that)
        pendingNewChat = prompt && helperPath ? { cwd: String(cmd.cwd), at: Date.now(), prompt, known: (lastSnapshot?.sessions ?? []).map((x: Session) => x.id) } : null;
        if (prompt && !helperPath) { // without the wrapper nothing can type it: keep the text for the user instead of losing it
          clipboard.writeText(prompt);
          void info(L('Первое сообщение не отправлено', 'The first message was not sent', '首条消息未发送'), L('Без pet-helper.exe питомец не может ввести его в новую сессию. Текст скопирован в буфер обмена: вставьте его в открывшееся окно.', 'Without pet-helper.exe the pet cannot type it into the new session. The text is on the clipboard: paste it into the new window.', '没有 pet-helper.exe，宠物无法把它输入到新会话中。文本已复制到剪贴板：请粘贴到新窗口中。'));
        }
        goWin(true);
        return;
      }
      const th = primary();
      const go = (useWt: boolean) => {
        const c = newSessionCommand({ distro: th.name(), cwd: String(cmd.cwd), claude: th.claude(), prompt: String(cmd.prompt ?? '') }, useWt);
        const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore', ...(c.cwd ? { cwd: c.cwd } : {}) });
        p.on('error', (e) => { log(`terminal (${c.file}) failed: ${e.message}`); if (useWt) go(false); });
        p.unref();
      };
      go(true);
      return;
    }
    if (cmd.type === 'send') {
      const s = sessionById(String(cmd.sessionId));
      // a queued or scheduled message goes out when nobody may be at the computer: it never drives the Claude app's window (that
      // would take the keyboard focus, e.g. from a fullscreen game, and act in the app on its own); it goes through the hook instead
      // with the ccPet plugin in the session the message goes in through it, as the user's own words: no typing into the app's window
      if (s?.desktopId && !s.mod && settings.desktopSend === 'real' && !cmd.queued && typeof cmd.text === 'string' && cmd.text.trim() && !(Array.isArray(cmd.images) && cmd.images.length)) {
        const r = await sendToDesktop({ text: cmd.text, title: s.project, desktopId: s.desktopId });
        if (r === 'ok') return;
        log(`desktop send: ${r}; delivering through the hook instead`);
        win.webContents.send('pet:msg', { type: 'chat', sessionId: s.id, event: { kind: 'note', text: r === 'busy'
          ? L('Чат в приложении занят: сообщение доставлено через хук (в приложении оно выглядит бледной вставкой).', 'The chat in the app is busy: the message went through the hook (the app shows it as faint text).', '应用中的聊天正忙：消息已通过钩子发送（在应用中显示为淡色文字）。')
          : L('Не удалось ввести сообщение в приложение (' + r + '): оно доставлено через хук и выглядит там бледной вставкой.', 'Could not type the message into the app (' + r + '): it went through the hook and looks faint there.', '无法在应用中输入消息（' + r + '）：已通过钩子发送，在应用中显示为淡色文字。') } });
      }
      // the warning is for the SDK fallback only: a session reachable through its mailbox (or on the Windows host) is woken by a hook, no second process
      if (s && !s.owned && !s.pty && !s.mailbox && s.host !== 'windows' && !warnedTerminal.has(s.id)) {
        const r = await dialog.showMessageBox(win, confirmOptions({
          type: 'warning', action: L('Отправить', 'Send', '发送'), cancel: L('Отмена', 'Cancel', '取消'),
          message: L(`«${s.project}» открыта в терминале`, `“${s.project}” is open in a terminal`, `“${s.project}”已在终端中打开`),
          detail: L('Ответ запишется в тот же диалог, но в уже открытом окне терминала он не появится, пока сессию не откроют заново (кнопка «в терминал» в чате питомца). Писать в обе стороны одновременно не стоит.\n\nСовет: нажми «в терминал» в чате, и питомец продолжит эту сессию в новом окне.', 'The reply is written to the same conversation, but it will not appear in the terminal window that is already open until the session is reopened (the “terminal” button in the pet chat). Do not write from both sides at once.\n\nTip: press “terminal” in the chat and the pet will continue this session in a new window.', '回复会写入同一个对话，但在重新打开会话之前，不会显示在已打开的终端窗口中（宠物聊天中的“终端”按钮）。请勿同时从两边写入。\n\n提示：在聊天中点“终端”，宠物会在新窗口中继续此会话。'),
        }));
        if (!isConfirmed(r)) return;
        warnedTerminal.add(s.id);
      }
    }
    if (cmd.type === 'end') {
      const s = sessionById(String(cmd.sessionId));
      const r = await dialog.showMessageBox(win, confirmOptions({
        type: 'warning', action: L('Завершить', 'End', '结束'), cancel: L('Отмена', 'Cancel', '取消'),
        message: L(`Завершить сессию «${s?.project ?? cmd.sessionId}»?`, `End the session “${s?.project ?? cmd.sessionId}”?`, `结束会话“${s?.project ?? cmd.sessionId}”？`),
        detail: s?.owned
          ? L('Питомец закроет её процесс Claude Code. Переписка сохранится: её можно продолжить позже в терминале.', 'The pet will close its Claude Code process. The conversation is kept: you can continue it later in a terminal.', '宠物将关闭它的 Claude Code 进程。对话会保留：稍后可在终端中继续。')
          : L('Процесс claude этой сессии будет остановлен (окно терминала останется). Если Claude сейчас работает, текущий шаг прервётся.', 'The claude process of this session will be stopped (the terminal window stays). If Claude is working right now, the current step is interrupted.', '此会话的 claude 进程将被停止（终端窗口保留）。如果 Claude 正在工作，当前步骤会被中断。'),
      }));
      if (!isConfirmed(r)) return;
    }
    // a session's commands go to the host that owns it (new chats, models and limits stay with the WSL bridge)
    const h = cmd.type === 'permission' ? hostOfPermission(String(cmd.id), hostParts()) : typeof cmd.sessionId === 'string' ? hostOf(cmd.sessionId, hostParts()) : null;
    if (h === 'windows') { void winHost.handle(cmd); return; }
    // send() returns nothing, so `?.send(cmd) ?? toBridge(cmd)` ran both: every command to a WSL session reached the bridge twice (a typed message arrived doubled)
    const target = h ? wslHosts.get(h) : undefined;
    if (target) target.send(cmd); else toBridge(cmd);
  };
  ipcMain.on('pet:cmd', (_e, cmd) => void onCmd(cmd));
  // ---- connections: our hooks in each host's settings.json (always with the diff and the user's consent) ----
  const wslRequest = (cmd: object, host: WslHost = primary()): Promise<any> => host.request(cmd);
  const hostLabel = (h: WslHost) => (NATIVE ? L('этот компьютер', 'this computer', '本机') : h.name() ? `WSL: ${h.name()}` : 'WSL');
  const hostRowState = async (h: WslHost) => {
    const w = await wslRequest({ type: 'hooks', apply: false, permissions: settings.answerPermissions }, h);
    const sl = h.secondary ? null : await h.request({ type: 'statusline' }, 'statusline'); // the limits ring is fed from the default distro's status line
    return { id: h.id, statusLine: sl?.kind as string | undefined, statusLineDiff: String(sl?.diff ?? ''), statusLineError: sl?.error as string | undefined, up: h.isUp(), distro: h.name(), port: h.secondary ? h.port : undefined, events: !!w?.events, mailbox: !!w?.mailbox, permissions: !!w?.permissions, diff: String(w?.diff ?? ''), error: w?.error as string | undefined };
  };
  const connectionsState = async () => {
    const last = lastEventByHost(lastSnapshot?.sessions ?? []);
    const hosts = (await Promise.all([...wslHosts.values()].map(hostRowState))).map((h) => ({ ...h, lastEventAt: last[h.id] ?? null }));
    return {
      native: NATIVE, answerPermissions: settings.answerPermissions, sdkChats: settings.sdkChats, newChatIn: settings.newChatIn, desktopSend: settings.desktopSend, helper: !!helperPath, helperPath, wrapper: wrapperState(),
      windows: (() => { const sl = winHost.statusLine({}); return { ...winHost.state(settings.answerPermissions), port: winHost.port, up: winUp, statusLine: sl.kind, statusLineDiff: sl.diff, statusLineError: sl.error, lastEventAt: last.windows ?? null }; })(),
      wsl: hosts.find((x) => x.id === 'wsl')!,
      others: hosts.filter((x) => x.id !== 'wsl'),
    };
  };
  const confirmHooks = async (message: string, items: Array<{ file: string; diff: string }>, note?: string) => {
    const detail = items.map((i) => `${i.file}\n${i.diff.length > 1400 ? `${i.diff.slice(0, 1400)}\n…` : i.diff}`).join('\n\n') + `\n\n${note ?? L('Копия файла сохранится рядом (settings.json.bak). Хуки только сообщают питомцу о событиях; свои хуки пользователя не затрагиваются.', 'A copy of the file is kept next to it (settings.json.bak). The hooks only tell the pet about events; your own hooks are not touched.', '文件的备份会保存在旁边（settings.json.bak）。钩子只向宠物通知事件，不会改动你自己的钩子。')}`;
    const r = await dialog.showMessageBox(win, confirmOptions({ type: 'question', action: L('Применить', 'Apply', '应用'), cancel: L('Отмена', 'Cancel', '取消'), message, detail }));
    return isConfirmed(r);
  };
  const windowsSettings = join(homedir(), '.claude', 'settings.json');
  // ---- the `claude` wrapper in the PowerShell profiles (Windows PowerShell always; PowerShell 7 when its profile folder exists) ----
  const psProfiles = () => profilePaths(app.getPath('documents')).filter((p, i) => i === 0 || existsSync(dirname(p)));
  /** profiles do not run under the Restricted / AllSigned execution policy: then the wrapper line has no effect (we never change the policy) */
  let psPolicy: string | null = null;
  if (!NATIVE) execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { windowsHide: true, timeout: 15000 }, (err, out) => { if (!err) psPolicy = String(out).trim(); });
  const wrapperState = () => {
    if (!helperPath) return null;
    const states = psProfiles().map((p) => { try { return profileState(readProfile(p), helperPath); } catch { return 'ansi' as const; } });
    const state = states.includes('ansi') ? 'ansi' : states.includes('stale') ? 'stale' : states.every((x) => x === 'ours') ? 'ours' : states.some((x) => x === 'ours') ? 'partial' : 'none';
    return { state, files: psProfiles(), policy: psPolicy };
  };
  /**
   * Our Windows entries are there but out of date (the app moved, the helper changed, the token is new): offer to update them once per
   * start, with the diff. Absent entries are never offered here (connecting is the user's choice in Connections).
   */
  const offerWindowsRepair = async () => {
    try {
      const st = winHost.state(settings.answerPermissions);
      const sl = winHost.statusLine({});
      const items: Array<{ file: string; diff: string }> = [];
      if (!st.error && (st.events || st.mailbox) && st.diff) items.push({ file: windowsSettings, diff: st.diff });
      if (!sl.error && sl.kind !== 'none' && sl.diff) items.push({ file: `${windowsSettings} (statusLine)`, diff: sl.diff });
      if (!items.length) return;
      if (!(await confirmHooks(L('Обновить подключение Windows?', 'Update the Windows connection?', '更新 Windows 连接？'), items))) return;
      if (items.some((i) => i.diff === st.diff)) winHost.apply(settings.answerPermissions);
      if (sl.kind !== 'none' && sl.diff) winHost.statusLine({ apply: true });
    } catch (e) { log(`windows repair: ${(e as Error).message}`); }
  };
  ipcMain.handle('pet:connections', () => connectionsState());
  // "why don't I see my session": every check in one copyable report (no user name, tokens or e-mail in it)
  ipcMain.handle('pet:diagnostics', async () => {
    const c = await connectionsState();
    const sessions: Session[] = lastSnapshot?.sessions ?? [];
    const of = (id: string) => sessions.filter((x) => hostIdOf(x) === id);
    const row = (id: string, h: any) => ({
      id, distro: h.distro, up: !!h.up, events: !!h.events, mailbox: !!h.mailbox, permissions: !!h.permissions, statusLine: h.statusLine,
      lastEventAt: h.lastEventAt ?? null, sessions: of(id).length, sources: [...new Set(of(id).map((x) => x.source ?? '?'))] as string[], error: h.error,
    });
    const text = formatDiagnostics({
      version: app.getVersion(), os: `${process.platform} ${process.getSystemVersion()}`, now: Date.now(), user: userInfo().username,
      hosts: [...(NATIVE ? [] : [row('windows', c.windows)]), row(c.wsl.id, c.wsl), ...(c.others ?? []).map((o) => row(o.id, o))],
      helper: !!helperPath, wrapper: c.wrapper?.state ?? null, policy: c.wrapper?.policy ?? null,
      desktopChats: new Set([...desktopEntries().values()].map((e) => e.desktopId)).size, newChatIn: settings.newChatIn, sdkChats: settings.sdkChats,
    });
    clipboard.writeText(text);
    return text;
  });
  ipcMain.handle('pet:connections-apply', async (_e, hostId: unknown, action: unknown) => {
    const remove = action === 'disconnect';
    if (hostId === 'windows' && (action === 'wrapper' || action === 'wrapper-off') && helperPath) {
      const off = action === 'wrapper-off';
      try {
        const items = psProfiles().map((file) => { const cur = readProfile(file); const r = off ? removeFromProfile(cur) : planProfile(cur, helperPath); return { file, ...r }; }).filter((i) => i.diff);
        if (items.length && await confirmHooks(off ? L('Убрать обёртку claude из профиля PowerShell?', 'Remove the claude wrapper from the PowerShell profile?', '从 PowerShell 配置文件中移除 claude 包装器？') : L('Добавить обёртку claude в профиль PowerShell?', 'Add the claude wrapper to the PowerShell profile?', '将 claude 包装器添加到 PowerShell 配置文件？'), items, L('Копия файла сохранится рядом (.bak). Меняются только строки между метками ccPet. Новые окна PowerShell будут запускать claude через обёртку.', 'A copy of the file is kept next to it (.bak). Only the lines between the ccPet markers change. New PowerShell windows will start claude through the wrapper.', '文件的备份会保存在旁边（.bak）。只修改 ccPet 标记之间的行。新的 PowerShell 窗口将通过包装器启动 claude。')))
          for (const i of items) applyProfile(i.file, i.next);
      } catch (e) { void info(L('Не удалось изменить профиль PowerShell', 'Could not change the PowerShell profile', '无法修改 PowerShell 配置文件'), (e as Error).message); }
    } else if (hostId === 'windows' && (action === 'statusline' || action === 'statusline-off')) {
      const off = action === 'statusline-off';
      const p = winHost.statusLine({ remove: off });
      if (p.error) { void info(L('Не удалось прочитать settings.json', 'Could not read settings.json', '无法读取 settings.json'), p.error); return connectionsState(); }
      if (p.diff && await confirmHooks(off ? L('Отключить статус-строку от питомца?', 'Disconnect the status line from the pet?', '断开状态栏与宠物的连接？') : L('Подключить статус-строку (лимиты)?', 'Connect the status line (limits)?', '连接状态栏（额度）？'), [{ file: windowsSettings, diff: p.diff }])) {
        const r = winHost.statusLine({ apply: true, remove: off });
        if (r.error) void info(L('Не удалось записать настройки', 'Could not write the settings', '无法写入设置'), r.error);
        else void winHost.pushUsage();
      }
    } else if (hostId === 'windows') {
      const st = winHost.state(settings.answerPermissions);
      if (st.error) { void info(L('Не удалось прочитать settings.json', 'Could not read settings.json', '无法读取 settings.json'), st.error); return connectionsState(); }
      const diff = remove ? winHost.removeDiff() : st.diff;
      if (diff && await confirmHooks(remove ? L('Отключить Windows от питомца?', 'Disconnect Windows from the pet?', '断开 Windows 与宠物的连接？') : L('Подключить Windows-сессии Claude Code?', 'Connect Windows Claude Code sessions?', '连接 Windows 的 Claude Code 会话？'), [{ file: windowsSettings, diff }])) {
        try { remove ? winHost.remove() : winHost.apply(settings.answerPermissions); } catch (e) { void info(L('Не удалось записать настройки', 'Could not write the settings', '无法写入设置'), (e as Error).message); }
      }
    } else if (typeof hostId === 'string' && wslHosts.has(hostId) && (action === 'statusline' || action === 'statusline-off')) {
      const h = wslHosts.get(hostId)!;
      const off = action === 'statusline-off';
      const p = await h.request({ type: 'statusline', remove: off }, 'statusline');
      if (p?.error) { void info(L('Не удалось прочитать settings.json', 'Could not read settings.json', '无法读取 settings.json'), String(p.error)); return connectionsState(); }
      const label = hostLabel(h);
      if (p?.diff && await confirmHooks(off ? L('Отключить статус-строку от питомца?', 'Disconnect the status line from the pet?', '断开状态栏与宠物的连接？') : L('Подключить статус-строку (лимиты)?', 'Connect the status line (limits)?', '连接状态栏（额度）？'), [{ file: `~/.claude/settings.json (${label})`, diff: String(p.diff) }]))
        await h.request({ type: 'statusline', apply: true, remove: off }, 'statusline');
    } else if (typeof hostId === 'string' && wslHosts.has(hostId)) {
      const h = wslHosts.get(hostId)!;
      const p = await wslRequest({ type: 'hooks', apply: false, remove, permissions: settings.answerPermissions }, h);
      if (p?.error) { void info(L('Не удалось прочитать settings.json', 'Could not read settings.json', '无法读取 settings.json'), String(p.error)); return connectionsState(); }
      const label = hostLabel(h);
      if (p?.diff && await confirmHooks(remove ? L(`Отключить ${label} от питомца?`, `Disconnect ${label} from the pet?`, `断开 ${label} 与宠物的连接？`) : L(`Подключить сессии Claude Code (${label})?`, `Connect Claude Code sessions (${label})?`, `连接 Claude Code 会话（${label}）？`), [{ file: `~/.claude/settings.json (${label})`, diff: String(p.diff) }]))
        await wslRequest({ type: 'hooks', apply: true, remove, permissions: settings.answerPermissions }, h);
    }
    return connectionsState();
  });
  ipcMain.handle('pet:new-chat-in', (_e, where: unknown) => {
    settings = { ...settings, newChatIn: where === 'windows' || where === 'desktop' ? where : 'wsl' }; applySettings();
    return connectionsState();
  });
  ipcMain.handle('pet:desktop-send', (_e, how: unknown) => {
    settings = { ...settings, desktopSend: how === 'hook' ? 'hook' : 'real' }; applySettings();
    return connectionsState();
  });
  ipcMain.handle('pet:sdk-chats', async (_e, on: unknown) => {
    const wanted = on === true;
    if (wanted) {
      const r = await dialog.showMessageBox(win, confirmOptions({
        type: 'warning', action: L('Включить', 'Turn on', '开启'), cancel: L('Отмена', 'Cancel', '取消'),
        message: L('Разрешить питомцу запускать Claude Code через Agent SDK?', 'Let the pet start Claude Code through the Agent SDK?', '允许宠物通过 Agent SDK 启动 Claude Code？'),
        detail: L('Питомец сможет начинать новые чаты и продолжать терминальные сессии, запуская второй процесс claude под вашим входом (как если бы вы набрали команду сами). Важно: по правилам Anthropic (code.claude.com/docs/en/legal-and-compliance) сторонние программы на Agent SDK должны работать с API-ключом, а не через вход по подписке Free/Pro/Max. Включайте, только если Claude Code у вас вошёл по API-ключу или вы принимаете этот риск. Без этого новые чаты открываются в терминале, а общаться с уже запущенными сессиями можно через хуки.', 'The pet will be able to start new chats and continue terminal sessions by running a second claude process under your login (as if you typed the command yourself). Important: Anthropic rules (code.claude.com/docs/en/legal-and-compliance) say third-party tools built on the Agent SDK should use an API key, not a Free/Pro/Max subscription login. Turn this on only if your Claude Code signs in with an API key or you accept that risk. Without this, new chats open in a terminal, and running sessions can still be reached through the hooks.', '宠物将能够新建聊天并继续终端会话，方式是在您的登录下运行第二个 claude 进程（就像您自己输入命令）。重要：根据 Anthropic 的规则（code.claude.com/docs/en/legal-and-compliance），基于 Agent SDK 的第三方工具应使用 API 密钥，而不是 Free/Pro/Max 订阅登录。仅当您的 Claude Code 使用 API 密钥登录或您接受该风险时才开启。关闭时，新聊天会在终端中打开，已运行的会话仍可通过钩子联系。'),
      }));
      if (!isConfirmed(r)) return connectionsState();
    }
    settings = { ...settings, sdkChats: wanted }; applySettings();
    toAllBridges({ type: 'sdk-chats', on: wanted });
    return connectionsState();
  });
  ipcMain.handle('pet:answer-permissions', async (_e, on: unknown) => {
    const wanted = on === true;
    const items: Array<{ file: string; diff: string; apply: () => Promise<unknown> | unknown }> = [];
    const ws = winHost.state(wanted);
    if (ws.events && !ws.error && ws.diff) items.push({ file: windowsSettings, diff: ws.diff, apply: () => winHost.apply(wanted) });
    for (const h of wslHosts.values()) {
      const wp = await wslRequest({ type: 'hooks', apply: false, permissions: wanted }, h);
      if (wp?.events && !wp.error && wp.diff) items.push({ file: `~/.claude/settings.json (${hostLabel(h)})`, diff: String(wp.diff), apply: () => wslRequest({ type: 'hooks', apply: true, permissions: wanted }, h) });
    }
    if (items.length && !(await confirmHooks(wanted ? L('Отвечать на разрешения в питомце?', 'Answer permission questions in the pet?', '在宠物中回答权限请求？') : L('Больше не отвечать на разрешения в питомце?', 'Stop answering permission questions in the pet?', '不再在宠物中回答权限请求？'), items))) return connectionsState();
    for (const i of items) { try { await i.apply(); } catch (e) { void info(L('Не удалось записать настройки', 'Could not write the settings', '无法写入设置'), (e as Error).message); } }
    settings = { ...settings, answerPermissions: wanted }; applySettings();
    toAllBridges({ type: 'hook-permissions', on: wanted });
    return connectionsState();
  });
  // open a session in a real terminal (claude --resume); a pet-owned one is released first so only one client writes
  ipcMain.on('pet:open-terminal', (_e, sessionId: string) => {
    const s = sessionById(String(sessionId));
    if (!s) return;
    if (s.desktopId) { // a desktop app session: open that very chat in the app (its own deep link), never a second claude
      void shell.openExternal(`claude://code/continue?session=${encodeURIComponent(s.desktopId)}`).then(() => focusDesktopApp()).catch((e) => log(`desktop link: ${(e as Error).message}`));
      return;
    }
    if (s.host === 'windows') {
      // a wrapped session (pet-helper pty): raise its own terminal; otherwise (or if that fails) a new terminal resumes it
      const mark = `${s.project} - Claude ${s.id.slice(0, 4)}`;
      void winHost.markTerminal(s.id, mark).then(async (ok) => {
        if (ok) { await new Promise((r) => setTimeout(r, 350)); if (await focusByTitle(mark)) return; }
        launchWin(true);
      });
      const launchWin = (useWt: boolean) => {
        const c = windowsTerminalCommand({ cwd: s.cwd, sessionId: s.id }, useWt);
        const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore', ...(c.cwd ? { cwd: c.cwd } : {}) });
        p.on('error', (e) => { log(`terminal (${c.file}) failed: ${e.message}`); if (useWt) launchWin(false); });
        p.unref();
      };
      return;
    }
    if (!s.owned) {
      void focusTerminalOf(s).then((moved) => { if (!moved) openWslTerminal(s); });
      return;
    }
    (wslHosts.get(hostOf(s.id, hostParts()) ?? 'wsl') ?? primary()).send({ type: 'release', sessionId: s.id });
    openWslTerminal(s);
  });
  const openWslTerminal = (s: { id: string; cwd: string; owned: boolean }) => {
    const th = wslHosts.get(hostOf(s.id, hostParts()) ?? 'wsl') ?? primary();
    if (NATIVE) { setTimeout(() => openNativeTerminal({ cwd: s.cwd, claude: th.claude(), sessionId: s.id }), s.owned ? 500 : 0); return; }
    const launch = (useWt: boolean) => {
      const c = terminalCommand({ distro: th.name(), cwd: s.cwd, claude: th.claude(), sessionId: s.id }, useWt);
      const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore', ...(c.cwd ? { cwd: c.cwd } : {}) });
      p.on('error', (e) => { log(`terminal (${c.file}) failed: ${e.message}`); if (useWt) launch(false); });
      p.unref();
    };
    setTimeout(() => launch(true), s.owned ? 500 : 0);
  };
  ipcMain.handle('pet:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: L('Папка для Claude Code', 'Folder for Claude Code', 'Claude Code 的文件夹') });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('pet:focus', () => { if (process.env.CLAUDE_PET_DEBUG) log('focus requested'); win.focus(); });
  // Click-through: the window ignores the mouse except over the pet's own elements. The renderer reports
  // their boxes; the real cursor position is polled here (Chromium's forwarded moves are unreliable while
  // the ignore flag flips, which made clicks and drags fall through).
  let hitRects: Rect[] = [];
  let mouseOver = false;
  ipcMain.on('pet:rects', (_e, rects: Rect[]) => {
    if (!Array.isArray(rects)) return;
    hitRects = rects;
    if (process.env.CLAUDE_PET_DEBUG) log(`rects: ${rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round).join(',')).join(' | ')}`);
  });
  // The pet's own surface is a window-drag region, which swallows mouse events: hover is therefore decided here from the real cursor
  // and the renderer is told (the button dock grows out of the pet's shadow while the cursor is over the pet).
  let hoverRects: Rect[] = [];
  let hovering = false;
  ipcMain.on('pet:hover-rects', (_e, rects: Rect[]) => { if (Array.isArray(rects)) hoverRects = rects; });
  const hitTimer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const c = screen.getCursorScreenPoint(), b = win.getBounds();
    const hov = overAny(c.x - b.x, c.y - b.y, hoverRects, 4);
    if (hov !== hovering) { hovering = hov; win.webContents.send('pet:hover', hov); }
    const over = overAny(c.x - b.x, c.y - b.y, hitRects, 2);
    if (over === mouseOver) return;
    mouseOver = over;
    win.setIgnoreMouseEvents(!over, { forward: true });
    if (process.env.CLAUDE_PET_DEBUG) log(`hit=${over}`);
  }, 40);
  app.on('before-quit', () => clearInterval(hitTimer));
  // Dragging is the OS's own window move (CSS app-region on the sprite): smooth at the display's rate.
  // While it moves, the renderer is told the direction so the pet can run that way.
  let lastX = win.getBounds().x, moveSteps = 0, ownMoveUntil = 0;
  let dragging = false, dragIdle: NodeJS.Timeout | null = null;
  const anchorOf = (): Anchor => { const b = win.getBounds(); return { cx: b.x + b.width / 2, bottom: b.y + IDLE_H }; };
  let anchor: Anchor = initialAnchor; // where the pet stands; only the user's drags change it
  // the drag is over: remember where the pet stands
  let pendingH = 0;
  const applyHeight = (height: number) => {
    const b = win.getBounds();
    if (b.height === height) return;
    ownMoveUntil = Date.now() + 150;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height }); // the window hangs from the pet's top: growing downwards never moves the pet
    lastX = win.getBounds().x;
  };
  const endDrag = () => {
    if (dragIdle) { clearTimeout(dragIdle); dragIdle = null; }
    const wasDragging = dragging;
    dragging = false;
    anchor = anchorOf();
    if (pendingH) { const h = pendingH; pendingH = 0; applyHeight(h); }
    if (wasDragging) try { writeFileSync(userFile('window.json'), JSON.stringify(anchor)); } catch { /* non-fatal */ }
  };
  win.on('move', () => {
    const x = win.getBounds().x, dx = x - lastX;
    lastX = x;
    if (Date.now() < ownMoveUntil) return; // our own resize/reposition, not the user dragging
    moveSteps++;
    dragging = true;
    anchor = anchorOf(); // follows the window, so nothing can snap it back to an old spot mid-drag
    // 'moved' ends the drag; the timer covers a drag that never reports it
    if (dragIdle) clearTimeout(dragIdle);
    dragIdle = setTimeout(endDrag, 1500);
    if (dx) win.webContents.send('pet:moving', dx);
  });
  win.on('moved', () => {
    if (Date.now() < ownMoveUntil) return;
    if (process.env.CLAUDE_PET_DEBUG) log(`moved: ${moveSteps} steps`);
    moveSteps = 0;
    dragging = true; // persist even if the last 'move' was filtered
    endDrag();
    if (process.env.CLAUDE_PET_DEBUG) log(`anchor=${JSON.stringify(anchor)}`);
  });
  // ---- keep the pet visible ----
  // Fullscreen apps, games and video players can push a topmost window down, and Windows sometimes drops the flag after sleep or a
  // display change: put the pet back on top regularly (no focus is taken, nothing moves).
  const keepTop = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible() || dragging) return;
    // Electron caches the topmost state and skips the call when it thinks it is already set, but a fullscreen
    // player or game can take the window's topmost flag away: drop it and set it again so Windows really re-applies it
    if (process.platform === 'win32') win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, TOP_LEVEL);
    win.moveTop();
  }, 2000);
  // a monitor unplugged, a resolution or scaling change: a pet left outside every screen comes back next to where it stood
  const onSomeScreen = () => {
    const b = win.getBounds(), x = b.x + b.width / 2, y = b.y + IDLE_H / 2;
    return screen.getAllDisplays().some((d) => x >= d.workArea.x && x <= d.workArea.x + d.workArea.width && y >= d.workArea.y && y <= d.workArea.y + d.workArea.height);
  };
  const rescue = (why: string) => {
    if (win.isDestroyed() || onSomeScreen()) return;
    const b = win.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(anchor.cx), y: Math.round(anchor.bottom - 1) }).workArea;
    ownMoveUntil = Date.now() + 150;
    win.setBounds(placeStage(anchor, b.width, b.height, wa));
    lastX = win.getBounds().x; anchor = anchorOf();
    log(`the pet was off screen (${why}): moved back to ${JSON.stringify(anchor)}`);
  };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as any, () => setTimeout(() => rescue(ev), 600));
  // a crashed renderer or GPU process leaves a transparent window that shows nothing: log it and draw the pet again
  win.webContents.on('render-process-gone', (_e, d) => { log(`renderer gone: ${d.reason} (${d.exitCode})`); if (d.reason !== 'clean-exit' && !quitting) win.webContents.reload(); });
  win.webContents.on('unresponsive', () => log('renderer unresponsive'));
  app.on('child-process-gone', (_e, d) => {
    log(`${d.type} process gone: ${d.reason} (${d.exitCode})`);
    if (d.type === 'GPU' && !quitting) setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 1000);
  });
  app.on('before-quit', () => clearInterval(keepTop));
  // constant width; the height follows the content (grows downwards from the pet). While the user drags, the OS owns the window: wait for the drop.
  ipcMain.on('pet:resize', (_e, _w: number, h: number) => {
    const height = Math.min(MAX_H, Math.max(120, Math.ceil(Number(h) || 0)));
    if (dragging) { pendingH = height; return; }
    applyHeight(height);
  });
  // right-click on a drag region would open Windows' system menu: show ours instead
  win.on('system-context-menu', (e) => { e.preventDefault(); trayMenu().popup({ window: win }); });
  ipcMain.on('pet:notify', (_e, title: string, body: string) => {
    if (!settings.notify || !Notification.isSupported()) return;
    const n = new Notification({ title: String(title), body: String(body) });
    n.on('click', summon);
    n.show();
  });

  await win.loadFile(join(__dirname, 'index.html'));
  win.showInactive();
  log(`window bounds=${JSON.stringify(win.getBounds())} scale=${screen.getDisplayMatching(win.getBounds()).scaleFactor}`);
  if (!NATIVE) void unhideDesktop(); // a send cut short by a crash of the pet must not leave the Claude app's window invisible
  void winHost.start().then((ok) => { winUp = ok; sendUp(); if (ok) { void winHost.pushUsage(); void offerWindowsRepair(); }log(`windows host ${ok ? `listening on 127.0.0.1:${winHost.port}` : 'not started'}`); });
  const winTimer = setInterval(() => winHost.tick(Date.now()), 1500);
  registerHotkey();
  app.on('second-instance', summon);
  app.on('before-quit', () => { clearInterval(winTimer); void winHost.stop(); quitting = true; clearInterval(distroTimer); for (const h of wslHosts.values()) h.stop(); });

  if (iconArg) setTimeout(async () => {
    // app icon: the pet's face on a dark rounded tile, cut from the cleaned atlas
    const url: string = await win.webContents.executeJavaScript(`new Promise((ok) => { const t = setInterval(() => { if (!window.__petAtlasReady) return; clearInterval(t); ok((() => {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const x = c.getContext('2d');
      x.beginPath(); x.roundRect(0, 0, 512, 512, 112); x.clip();
      x.fillStyle = '#1e1e22'; x.fillRect(0, 0, 512, 512);
      x.imageSmoothingQuality = 'high';
      x.drawImage(window.__petAtlas, 26, 0, 140, 140, 16, 40, 480, 480);
      return c.toDataURL('image/png');
    })()); }, 50); })`);
    writeFileSync(iconArg, Buffer.from(url.split(',')[1], 'base64'));
    app.quit();
  }, 2500);
  if (atlasArg) setTimeout(async () => {
    const url: string = await win.webContents.executeJavaScript(`new Promise((ok) => { const t = setInterval(() => { if (window.__petAtlasReady) { clearInterval(t); ok(window.__petAtlas.toDataURL('image/png')); } }, 50); })`);
    writeFileSync(atlasArg, Buffer.from(url.split(',')[1], 'base64'));
    app.quit();
  }, 2500);
  if (shotArg) {
    await win.webContents.insertCSS('body{background:var(--shot-bg,#3b3b40) !important}');
    setTimeout(async () => { log(`screenshot bounds=${JSON.stringify(win.getBounds())}`); writeFileSync(shotArg, (await win.webContents.capturePage()).toPNG()); app.quit(); }, shotDelay);
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

/** Stand-in for the Windows host on Linux / macOS: reports "nothing there" so the shared code paths need no special cases. */
function nullWindowsHost() {
  const st = { installed: false, events: false, mailbox: false, permissions: false, stale: false, diff: '', settingsPath: '', error: undefined as string | undefined };
  return {
    port: 0, start: async () => false, stop: async () => undefined, tick: () => undefined, handle: async () => undefined, pushUsage: async () => undefined,
    state: () => st, statusLine: () => ({ kind: 'none', diff: '', error: undefined as string | undefined }), apply: () => undefined, remove: () => undefined, removeDiff: () => '',
    markTerminal: async () => false,
  };
}

/** Linux has no login-item API in Electron: a .desktop file in the XDG autostart folder does the same. */
function setLinuxAutostart(on: boolean): void {
  const f = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'ccpet.desktop');
  try {
    if (!on) { if (existsSync(f)) unlinkSync(f); return; }
    mkdirSync(dirname(f), { recursive: true });
    const exe = process.env.APPIMAGE || process.execPath.replace(/\.bin$/, ''); // the launcher next to the binary picks the sandbox mode
    writeFileSync(f, `[Desktop Entry]\nType=Application\nName=ccPet\nExec="${exe}"\nX-GNOME-Autostart-enabled=true\n`);
  } catch { /* non-fatal */ }
}
