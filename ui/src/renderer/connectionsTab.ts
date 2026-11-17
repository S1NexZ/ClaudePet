import { L } from '../../../shared/src/i18n.js';

export interface HostState {
  up: boolean;
  events: boolean; mailbox: boolean; permissions: boolean;
  /** what installing / updating would change; '' = nothing */
  diff: string;
  error?: string;
  port?: number;
  distro?: string;
  settingsPath?: string;
  /** Claude Code's status line (feeds the limits ring): ours, wrapping the user's own, or not connected; undefined where it does not apply */
  statusLine?: 'none' | 'ours' | 'chained';
  statusLineDiff?: string;
  statusLineError?: string;
  /** newest hook activity from this host (ms), null = none since the pet started */
  lastEventAt?: number | null;
}
import { wrapperLine } from '../psLine.js';

export interface WrapperState { state: 'none' | 'ours' | 'partial' | 'stale' | 'ansi'; files: string[]; policy: string | null }
export interface ConnectionsState { answerPermissions: boolean; sdkChats?: boolean; /** where new chats start (terminal sessions) */ newChatIn?: 'wsl' | 'windows'; helper: boolean; /** the claude wrapper in the PowerShell profiles */ wrapper?: WrapperState | null; /** full path of pet-helper.exe (for the PowerShell wrapper line) */ helperPath?: string; windows: HostState; wsl: HostState; /** other WSL distros that are followed */ others?: Array<HostState & { id: string }> }
export interface ConnectionsHost {
  copy?(text: string): void;
  get(): Promise<ConnectionsState>;
  apply(host: string, action: 'connect' | 'disconnect' | 'statusline' | 'statusline-off' | 'wrapper' | 'wrapper-off'): Promise<ConnectionsState>;
  answerPermissions(on: boolean): Promise<ConnectionsState>;
  sdkChats(on: boolean): Promise<ConnectionsState>;
  newChatIn?(where: 'wsl' | 'windows'): Promise<ConnectionsState>;
  /** builds the report and puts it on the clipboard */
  diagnostics?(): Promise<string>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};

/** "Подключения" tab: which Claude Code sessions the pet can see (Windows terminals and the desktop app, WSL) and the permission switch. */
export function createConnectionsTab(host: ConnectionsHost) {
  let state: ConnectionsState | null = null;
  let loading = false;
  let busy = false;
  let rerender = () => {};
  const load = async () => { if (loading) return; loading = true; try { state = await host.get(); } catch { /* keep the old state */ } loading = false; rerender(); };
  const run = async (p: Promise<ConnectionsState>) => { busy = true; rerender(); try { state = await p; } catch { /* keep */ } busy = false; rerender(); };

  const chip = (ok: boolean, label: string) => { const c = el('span', `c-chip${ok ? ' on' : ''}`, `${ok ? '✓' : '○'} ${label}`); return c; };

  const hostRow = (id: string, h: HostState) => {
    const row = el('div', 's-section c-host');
    const connected = h.events;
    const title = id === 'windows'
      ? L('Windows: PowerShell, CMD, терминалы, приложение Claude', 'Windows: PowerShell, CMD, terminals, the Claude app', 'Windows：PowerShell、CMD、终端、Claude 应用')
      : `WSL${h.distro ? ` (${h.distro})` : ''}${h.port ? ` · ${L('порт', 'port', '端口')} ${h.port}` : ''}`;
    row.append(el('div', 's-title', title));
    if (!h.up) { row.append(el('div', 's-hint', id === 'windows' ? L('Приёмник не запущен (порт занят?).', 'The receiver is not running (port busy?).', '接收器未运行（端口被占用？）') : L('Нет связи с WSL.', 'No connection to WSL.', '无法连接 WSL。'))); return row; }
    const chips = el('div', 'c-chips');
    chips.append(chip(h.events, L('события', 'events', '事件')), chip(h.mailbox, L('сообщения в сессии', 'messages to sessions', '向会话发消息')), chip(h.permissions, L('разрешения', 'permissions', '权限')));
    row.append(chips);
    if (connected) {
      const at = h.lastEventAt;
      const mins = at ? Math.round((Date.now() - at) / 60000) : 0;
      row.append(el('div', 's-hint', at
        ? L(`Последнее событие от Claude Code: ${mins < 1 ? 'только что' : `${mins} мин назад`}`, `Last event from Claude Code: ${mins < 1 ? 'just now' : `${mins} min ago`}`, `Claude Code 最近事件：${mins < 1 ? '刚刚' : `${mins} 分钟前`}`)
        : L('Событий от Claude Code пока не было: запустите или перезапустите сессию здесь.', 'No events from Claude Code yet: start or restart a session here.', '尚未收到 Claude Code 事件：请在此启动或重启会话。')));
    }
    if (h.error) row.append(el('div', 's-hint c-err', h.error));
    const line = el('div', 's-swatches');
    const needsUpdate = connected && !!h.diff;
    const connect = el('button', `s-btn${connected && !needsUpdate ? '' : ' primary'}`, connected ? (needsUpdate ? L('Обновить', 'Update', '更新') : L('Подключено', 'Connected', '已连接')) : L('Подключить', 'Connect', '连接'));
    connect.type = 'button'; connect.disabled = busy || !!h.error || (connected && !needsUpdate);
    connect.addEventListener('click', () => void run(host.apply(id, 'connect')));
    line.append(connect);
    if (connected || h.mailbox) {
      const off = el('button', 's-btn', L('Отключить', 'Disconnect', '断开')); off.type = 'button'; off.disabled = busy;
      off.addEventListener('click', () => void run(host.apply(id, 'disconnect')));
      line.append(off);
    }
    row.append(line);
    if (h.statusLine !== undefined && !h.statusLineError) {
      const sl = el('div', 'c-sl');
      const on = h.statusLine !== 'none';
      sl.append(chip(on, L('лимиты через статус-строку', 'limits via the status line', '通过状态栏获取额度')));
      if (h.statusLine === 'chained') sl.append(el('span', 's-hint', L(' (ваша строка сохранена и продолжает работать)', ' (your own line is kept and keeps working)', '（您自己的状态栏已保留并继续工作）')));
      const b = el('button', `s-btn${on ? '' : ' primary'}`, on ? L('Отключить', 'Disconnect', '断开') : L('Подключить', 'Connect', '连接')); b.type = 'button'; b.disabled = busy;
      b.addEventListener('click', () => void run(host.apply(id, on ? 'statusline-off' : 'statusline')));
      sl.append(b);
      row.append(sl);
    }
    return row;
  };

  const render = (box: HTMLElement) => {
    if (!state) { box.append(el('div', 's-hint', L('Загрузка…', 'Loading…', '加载中…'))); void load(); return; }
    box.append(el('div', 's-hint', L('Питомец видит сессии Claude Code там, где подключены хуки. Хуки пишутся в ~/.claude/settings.json с показом изменений и копией файла.', 'The pet sees Claude Code sessions wherever the hooks are connected. They are written to ~/.claude/settings.json after showing the changes, with a backup.', '宠物能看到已连接钩子的 Claude Code 会话。钩子会在显示改动后写入 ~/.claude/settings.json，并保留备份。')));
    box.append(hostRow('windows', state.windows));
    if (state.helperPath && host.copy) {
      const w = el('div', 's-section c-host');
      w.append(el('div', 's-title', L('Windows: Esc, «Стоп» и ввод из питомца', 'Windows: Esc, Stop and typing from the pet', 'Windows：从宠物按 Esc、停止和输入')));
      const wr = state.wrapper;
      const on = wr?.state === 'ours';
      w.append(el('div', 's-hint', L('Чтобы питомец мог нажимать Esc, «Стоп» и печатать в Windows-сессии как в терминале, claude запускается через обёртку. Питомец может добавить её в профиль PowerShell сам (с показом изменений и копией файла).', 'To let the pet press Esc, Stop and type into a Windows session like a terminal, claude starts through the wrapper. The pet can add it to your PowerShell profile (showing the changes, with a backup).', '要让宠物像终端一样在 Windows 会话中按 Esc、停止和输入，claude 需通过包装器启动。宠物可以把它添加到 PowerShell 配置文件（显示改动并保留备份）。')));
      const wline = el('div', 'c-sl');
      wline.append(chip(on, wr?.state === 'stale' ? L('обёртка устарела', 'wrapper is out of date', '包装器已过期') : L('обёртка в профиле PowerShell', 'wrapper in the PowerShell profile', 'PowerShell 配置文件中的包装器')));
      const wb = el('button', `s-btn${on ? '' : ' primary'}`, on ? L('Убрать', 'Remove', '移除') : wr?.state === 'stale' || wr?.state === 'partial' ? L('Обновить', 'Update', '更新') : L('Добавить', 'Add', '添加')); wb.type = 'button'; wb.disabled = busy || wr?.state === 'ansi';
      wb.addEventListener('click', () => void run(host.apply('windows', on ? 'wrapper-off' : 'wrapper')));
      wline.append(wb);
      w.append(wline);
      if (wr?.state === 'ansi') w.append(el('div', 's-hint c-err', L('Профиль PowerShell сохранён в кодировке ANSI: питомец не меняет его, чтобы не испортить русский текст. Добавьте строку ниже вручную.', 'The PowerShell profile is saved in an ANSI code page: the pet does not edit it so as not to garble its text. Add the line below yourself.', 'PowerShell 配置文件以 ANSI 编码保存：宠物不会修改它，以免损坏文本。请手动添加下面这一行。')));
      if (wr?.policy && /^(Restricted|AllSigned|Undefined)$/i.test(wr.policy)) w.append(el('div', 's-hint c-err', L(`Политика выполнения PowerShell «${wr.policy}» не даёт запускать профиль: обёртка не сработает. Разрешить можно командой: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, `The PowerShell execution policy "${wr.policy}" does not run profiles, so the wrapper will not work. You can allow it with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, `PowerShell 执行策略“${wr.policy}”不允许运行配置文件，包装器不会生效。可用以下命令允许：Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`)));
      w.append(el('div', 's-hint', L('Или добавьте строку вручную (notepad $PROFILE):', 'Or add the line yourself (notepad $PROFILE):', '或手动添加这一行（notepad $PROFILE）：')));
      const line = wrapperLine(state.helperPath);
      const code = el('code', 'c-code', line);
      const cp = el('button', 's-btn', L('Копировать строку', 'Copy the line', '复制该行')); cp.type = 'button';
      cp.addEventListener('click', () => { host.copy!(line); cp.textContent = L('Скопировано', 'Copied', '已复制'); });
      w.append(code, cp);
      box.append(w);
    }
    box.append(hostRow('wsl', state.wsl));
    for (const o of state.others ?? []) box.append(hostRow(o.id, o));
    if (!state.helper) box.append(el('div', 's-hint c-err', L('pet-helper.exe не найден: сообщения в Windows-сессии доставляться не будут.', 'pet-helper.exe was not found: messages to Windows sessions cannot be delivered.', '未找到 pet-helper.exe：无法向 Windows 会话发送消息。')));
    const perm = el('label', 's-radio'); perm.style.display = 'block';
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.answerPermissions; cb.disabled = busy;
    cb.addEventListener('change', () => void run(host.answerPermissions(cb.checked)));
    perm.append(cb, el('span', '', ` ${L('Отвечать на запросы разрешений в питомце', 'Answer permission questions in the pet', '在宠物中回答权限请求')}`));
    box.append(perm, el('div', 's-hint', L('Выключено по умолчанию. Если питомец не ответил за 30 с, Claude Code покажет обычный диалог.', 'Off by default. If the pet does not answer within 30 s, Claude Code shows its normal dialog.', '默认关闭。如果宠物在 30 秒内未回答，Claude Code 会显示常规对话框。')));
    if (host.newChatIn) {
      const nc = el('div', 's-section');
      nc.append(el('div', 's-title', L('Где запускать новые чаты', 'Where new chats start', '新聊天在哪里启动')));
      const opts: Array<['wsl' | 'windows', string]> = [['wsl', 'WSL'], ['windows', L('Windows (через обёртку)', 'Windows (through the wrapper)', 'Windows（通过包装器）')]];
      for (const [v, label] of opts) {
        const r = el('label', 's-radio');
        const i = el('input'); i.type = 'radio'; i.name = 'new-chat-in'; i.checked = (state.newChatIn ?? 'wsl') === v; i.disabled = busy;
        i.addEventListener('change', () => { if (i.checked) void run(host.newChatIn!(v)); });
        r.append(i, el('span', '', ` ${label}`));
        nc.append(r);
      }
      nc.append(el('div', 's-hint', L('Новый чат открывает окно терминала с Claude Code в выбранной папке. Если WSL недоступен, чат стартует в Windows.', 'A new chat opens a terminal window with Claude Code in the chosen folder. If WSL is unavailable, it starts on Windows.', '新聊天会在所选文件夹中打开一个运行 Claude Code 的终端窗口。如果 WSL 不可用，则在 Windows 中启动。')));
      box.append(nc);
    }
    if (host.diagnostics) {
      const d = el('div', 's-section');
      d.append(el('div', 's-title', L('Не видно сессию?', 'A session is missing?', '看不到会话？')));
      d.append(el('div', 's-hint', L('Отчёт со всеми проверками подключений (без имени пользователя и токенов) копируется в буфер обмена.', 'A report of every connection check (no user name or tokens) is copied to the clipboard.', '包含所有连接检查的报告（不含用户名和令牌）会复制到剪贴板。')));
      const b = el('button', 's-btn', L('Скопировать отчёт', 'Copy the report', '复制报告')); b.type = 'button';
      const out = el('pre', 'c-code c-report'); out.hidden = true;
      b.addEventListener('click', () => void host.diagnostics!().then((t) => { out.textContent = t; out.hidden = false; b.textContent = L('Скопировано', 'Copied', '已复制'); }));
      d.append(b, out);
      box.append(d);
    }
    const sdk = el('label', 's-radio'); sdk.style.display = 'block';
    const sb = el('input'); sb.type = 'checkbox'; sb.checked = !!state.sdkChats; sb.disabled = busy;
    sb.addEventListener('change', () => void run(host.sdkChats(sb.checked)));
    sdk.append(sb, el('span', '', ` ${L('Разрешить запуск Claude Code через Agent SDK', 'Allow starting Claude Code through the Agent SDK', '允许通过 Agent SDK 启动 Claude Code')}`));
    box.append(sdk, el('div', 's-hint', L('Выключено по умолчанию. Без этого новые чаты открываются в терминале, а запущенные сессии доступны через хуки.', 'Off by default. Without it new chats open in a terminal, and running sessions are reached through the hooks.', '默认关闭。关闭时，新聊天在终端中打开，已运行的会话通过钩子联系。')));
  };

  return {
    tab: { id: 'connections', title: L('Подключения', 'Connections', '连接'), render: (box: HTMLElement) => render(box) },
    attach(fn: () => void) { rerender = fn; },
  };
}
