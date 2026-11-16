import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, shell, Tray, nativeImage, nativeTheme, screen } from 'electron';
import { confirmOptions, isConfirmed } from './dialogs.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadPet } from './sprite/loadPet.js';
import { listModels, pickModel, MODEL_ID, DEFAULT_MODEL } from './models/registry.js';
import { installModelFromZip, installModelFromDir, removeModel, scanPetFolder, ModelError } from './models/install.js';
import { loadSettings, saveSettings } from './settings.js';
import { wslBridgeArgs, splitLines } from './bridgeLaunch.js';
import { overAny, type Rect } from './hitTest.js';
import { placeStage, restoreAnchor, IDLE_H, type Anchor } from './placement.js';
import { terminalCommand } from './terminal.js';
import { toWslPath } from '../../daemon/src/paths.js';
import { cleanAppearance } from './appearance.js';
import { clampScale, PET_SCALE_MIN, PET_SCALE_MAX } from './petScale.js';
import { PERMISSION_POLICIES, type PermissionPolicy } from '../../shared/src/types.js';
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
const theme = process.env.CLAUDE_PET_THEME;
if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme;

/** the only addresses the app opens in a browser (npm pages of the pet installers it documents) */
const OPEN_URLS = new Set(['https://www.npmjs.com/package/codex-pets', 'https://www.npmjs.com/package/@codex-pets/cli']);
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
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true }); // click-through except over the pet's own elements

  // ---- bridge: one process inside WSL, JSON lines over stdio (no network) ----
  let child: ChildProcess | null = null;
  let rest = '', up = false, quitting = false, backoff = 1000, lastSnapshot: any = null, hooksManual = false;
  let wsl = { distro: '', claude: '' };
  const toBridge = (cmd: object) => { if (child?.stdin?.writable) child.stdin.write(JSON.stringify(cmd) + '\n'); };
  const setUp = (v: boolean) => { up = v; if (!v) lastSnapshot = null; win.webContents.send('pet:bridge', v); };
  const info = (message: string, detail = '') => dialog.showMessageBox(win, { type: 'info', title: 'Claude Pet', message, detail });

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
  const onLine = (line: string) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'ready') {
      backoff = 1000; setUp(true); log(`bridge ready (claude=${m.claude}, distro=${m.distro})`);
      wsl = { distro: String(m.distro ?? ''), claude: String(m.claude ?? '') };
      if (!m.claude) void info(L('Claude Code не найден в WSL', 'Claude Code not found in WSL', '在 WSL 中未找到 Claude Code'), L('Установи Claude Code в WSL, чтобы питомец мог запускать сессии.', 'Install Claude Code in WSL so the pet can start sessions.', '请在 WSL 中安装 Claude Code，宠物才能启动会话。'));
      hooksManual = false;
      toBridge({ type: 'language', lang: getLang() });
      toBridge({ type: 'permission-mode', mode: settings.permissions });
      toBridge({ type: 'hooks', apply: false });
      if (demo) toBridge({ type: 'start', cwd: demo.cwd, prompt: demo.prompt });
      return;
    }
    if (m.type === 'hooks') { void onHooks(m); return; }
    if (m.type === 'snapshot') lastSnapshot = m;
    win.webContents.send('pet:msg', m);
  };
  const startBridge = () => {
    rest = '';
    child = spawn('wsl.exe', wslBridgeArgs(bridgePath), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', (e) => log(`bridge stdin: ${e.message}`)); // EPIPE if it just died; exit handler restarts it
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { const r = splitLines(rest, chunk); rest = r.rest; r.lines.forEach(onLine); });
    child.stderr!.on('data', (d) => log(`bridge stderr: ${String(d).trim().slice(0, 500)}`));
    child.on('error', (e) => log(`bridge spawn error: ${e.message}`));
    child.on('exit', (code) => {
      log(`bridge exited (${code})`);
      setUp(false);
      if (!quitting) { setTimeout(startBridge, backoff); backoff = Math.min(backoff * 2, 10_000); }
    });
  };

  // ---- settings, tray, hotkey ----
  const applySettings = () => {
    saveSettings(userFile('settings.json'), settings);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autostart });
  };
  /** Bring the pet to the front with the chat open (hotkey, second launch, /pet skill). */
  const summon = () => { win.show(); win.setAlwaysOnTop(true, 'floating'); win.focus(); win.webContents.send('pet:summon'); };
  const registerHotkey = () => {
    globalShortcut.unregisterAll();
    if (!settings.hotkey) return;
    let ok = false;
    try { ok = globalShortcut.register(settings.hotkey, () => (win.isVisible() && win.isFocused() ? win.hide() : summon())); }
    catch (e) { log(`hotkey: invalid accelerator ${settings.hotkey}: ${(e as Error).message}`); }
    log(`hotkey: ${settings.hotkey} registered=${ok}`);
    if (!ok && Notification.isSupported())
      new Notification({ title: 'Claude Pet', body: L(`Горячая клавиша ${settings.hotkey} недоступна (занята другим приложением)`, `The hotkey ${settings.hotkey} is unavailable (taken by another app)`, `快捷键 ${settings.hotkey} 不可用（已被其他应用占用）`) }).show();
  };
  const toggleWindow = () => (win.isVisible() ? win.hide() : (win.showInactive(), win.setAlwaysOnTop(true, 'floating')));
  /** Guided terminal setup: shows the one command to run in WSL (it asks before changing ~/.bashrc, backs it up, can be undone). */
  const showTerminalSetup = async () => {
    const script = app.isPackaged ? join(process.resourcesPath, 'scripts', 'install-shell-integration.sh') : join(__dirname, '../..', 'scripts', 'install-shell-integration.sh');
    const cmd = `bash '${toWslPath(script).replace(/'/g, `'\\''`)}'`;
    const r = await dialog.showMessageBox(win, confirmOptions({
      type: 'question', action: L('Копировать команду', 'Copy command', '复制命令'), cancel: L('Закрыть', 'Close', '关闭'), message: L('Подключить терминал (WSL)', 'Connect the terminal (WSL)', '连接终端（WSL）'),
      detail: L('Чтобы обычная команда `claude` запускалась через Claude Pet (общая сессия с питомцем), выполните в окне WSL-терминала:', 'To make the plain `claude` command run through Claude Pet (one shared session with the pet), run this in a WSL terminal:', '要让普通的 `claude` 命令通过 Claude Pet 运行（与宠物共用一个会话），请在 WSL 终端中运行：') + '\n\n' + cmd +
        L('\n\nСкрипт покажет изменение, спросит подтверждение, сохранит копию ~/.bashrc и его можно отменить: добавьте --uninstall. Без этого питомец тоже работает, но писать в терминальную сессию сможет только через запасной путь.', '\n\nThe script shows the change, asks for confirmation, keeps a copy of ~/.bashrc and can be undone with --uninstall. The pet works without it too, but can write into a terminal session only through a fallback path.', '\n\n脚本会显示改动并请求确认，保留 ~/.bashrc 的备份，可用 --uninstall 撤销。没有它宠物也能工作，但只能通过备用途径向终端会话写入。'),
    }));
    if (isConfirmed(r)) clipboard.writeText(cmd);
  };
  const trayMenu = () => Menu.buildFromTemplate([
    { label: win.isVisible() ? L('Скрыть питомца', 'Hide the pet', '隐藏宠物') : L('Показать питомца', 'Show the pet', '显示宠物'), click: toggleWindow },
    { label: `${L('Вызов питомца', 'Summon the pet', '唤出宠物')}: ${settings.hotkey || L('выключен', 'off', '关')}`, enabled: false },
    { type: 'separator' },
    { label: L('Настройки…', 'Settings…', '设置…'), click: () => { win.show(); win.setAlwaysOnTop(true, 'floating'); win.webContents.send('pet:open-settings'); } },
    { label: L('Подключить терминал (WSL)…', 'Connect the terminal (WSL)…', '连接终端（WSL）…'), click: () => void showTerminalSetup() },
    { label: L('Подключить хуки Claude Code…', 'Connect Claude Code hooks…', '连接 Claude Code 钩子…'), enabled: up, click: () => { hooksManual = true; toBridge({ type: 'hooks', apply: false }); } },
    { label: L('Уведомлять, когда нужно разрешение', 'Notify when permission is needed', '需要权限时通知'), type: 'checkbox', checked: settings.notify,
      click: (i) => { settings = { ...settings, notify: i.checked }; applySettings(); } },
    { label: L('Размер питомца', 'Pet size', '宠物大小'), submenu: [0.75, 1, 1.25, 1.5, 1.8].filter((v) => v >= PET_SCALE_MIN && v <= PET_SCALE_MAX).map((v) => ({
      label: `${Math.round(v * 100)}%`, type: 'radio' as const, checked: Math.abs(settings.petScale - v) < 0.03,
      click: () => { settings = { ...settings, petScale: v }; applySettings(); win.webContents.send('pet:scale', v); } })) },
    { label: L('Запускать вместе с Windows', 'Start with Windows', '随 Windows 启动'), type: 'checkbox', checked: settings.autostart, enabled: app.isPackaged,
      click: (i) => { settings = { ...settings, autostart: i.checked }; applySettings(); } },
    { type: 'separator' },
    { label: L('Выйти', 'Quit', '退出'), click: () => app.quit() },
  ]);
  const tray = new Tray(nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 32, height: 32 }));
  tray.setToolTip('Claude Pet');
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
    toBridge({ type: 'language', lang: getLang() });
    win.webContents.reload();
  });
  ipcMain.on('pet:permissions', (_e, mode: unknown) => {
    if (!PERMISSION_POLICIES.includes(mode as PermissionPolicy)) return;
    settings = { ...settings, permissions: mode as PermissionPolicy }; applySettings();
    toBridge({ type: 'permission-mode', mode: mode as PermissionPolicy });
  });
  ipcMain.on('pet:appearance', (_e, a) => { settings = { ...settings, appearance: cleanAppearance(a) }; applySettings(); });
  const sessionById = (id: string) => (lastSnapshot?.sessions ?? []).find((x: any) => x.id === id);
  const warnedTerminal = new Set<string>();
  ipcMain.on('pet:cmd', async (_e, cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'send') {
      const s = sessionById(String(cmd.sessionId));
      if (s && !s.owned && !s.pty && !warnedTerminal.has(s.id)) {
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
    toBridge(cmd);
  });
  // open a session in a real terminal (claude --resume); a pet-owned one is released first so only one client writes
  ipcMain.on('pet:open-terminal', (_e, sessionId: string) => {
    const s = sessionById(String(sessionId));
    if (!s) return;
    if (s.owned) toBridge({ type: 'release', sessionId: s.id });
    const launch = (useWt: boolean) => {
      const c = terminalCommand({ distro: wsl.distro, cwd: s.cwd, claude: wsl.claude, sessionId: s.id }, useWt);
      const p = spawn(c.file, c.args, { detached: true, stdio: 'ignore' });
      p.on('error', (e) => { log(`terminal (${c.file}) failed: ${e.message}`); if (useWt) launch(false); });
      p.unref();
    };
    setTimeout(() => launch(true), s.owned ? 500 : 0);
  });
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
  startBridge();
  registerHotkey();
  app.on('second-instance', summon);
  app.on('before-quit', () => { quitting = true; child?.stdin?.end(); setTimeout(() => child?.kill(), 500); });

  if (iconArg) setTimeout(async () => {
    // app icon: the pet's face on a dark rounded tile, cut from the cleaned atlas
    const url: string = await win.webContents.executeJavaScript(`new Promise((ok) => { const t = setInterval(() => { if (!window.__petAtlasReady) return; clearInterval(t); ok((() => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const x = c.getContext('2d');
      x.beginPath(); x.roundRect(0, 0, 256, 256, 56); x.clip();
      x.fillStyle = '#1e1e22'; x.fillRect(0, 0, 256, 256);
      x.imageSmoothingQuality = 'high';
      x.drawImage(window.__petAtlas, 26, 0, 140, 140, 8, 20, 240, 240);
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
