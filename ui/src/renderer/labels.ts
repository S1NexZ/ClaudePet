import type { PetState, Snapshot } from '../../../shared/src/types.js';
import { L, getLang } from '../../../shared/src/i18n.js';

const RU_LABEL: Record<PetState, string> = {
  idle: 'Готов', thinking: 'Думает', reading: 'Изучает', writing: 'Пишет код',
  running: 'Запускает команду', testing: 'Тестирует', waiting: 'Ждёт разрешения',
  subagent: 'Агент работает', done: 'Готово', error: 'Ошибка', sleeping: 'Спит',
};
const EN_LABEL: Record<PetState, string> = {
  idle: 'Ready', thinking: 'Thinking', reading: 'Reading', writing: 'Writing code',
  running: 'Running a command', testing: 'Testing', waiting: 'Needs permission',
  subagent: 'Agent working', done: 'Done', error: 'Error', sleeping: 'Asleep',
};
const ZH_LABEL: Record<PetState, string> = {
  idle: '就绪', thinking: '思考中', reading: '阅读中', writing: '编写代码',
  running: '运行命令', testing: '测试中', waiting: '需要权限',
  subagent: '代理工作中', done: '完成', error: '出错', sleeping: '休眠',
};
/** One short word per state for the status island (the long labels above stay for the session lists and notifications). */
const RU_CHIP: Record<PetState, string> = { idle: 'Готов', thinking: 'Думает', reading: 'Читает', writing: 'Пишет', running: 'Запуск', testing: 'Тесты', waiting: 'Разрешить?', subagent: 'Агент', done: 'Готово', error: 'Ошибка', sleeping: 'Спит' };
const EN_CHIP: Record<PetState, string> = { idle: 'Ready', thinking: 'Thinking', reading: 'Reading', writing: 'Writing', running: 'Running', testing: 'Testing', waiting: 'Allow?', subagent: 'Agent', done: 'Done', error: 'Error', sleeping: 'Asleep' };
const ZH_CHIP: Record<PetState, string> = { idle: '就绪', thinking: '思考中', reading: '阅读中', writing: '编写中', running: '运行中', testing: '测试中', waiting: '需授权', subagent: '代理', done: '完成', error: '出错', sleeping: '休眠' };
const chipTable = () => ({ en: EN_CHIP, ru: RU_CHIP, zh: ZH_CHIP } as const)[getLang()];
export const chipLabel = (st: PetState): string => chipTable()[st];
/** read lazily, so the label follows the language chosen at runtime */
export const STATE_LABEL = new Proxy({} as Record<PetState, string>, {
  get: (_t, k) => ({ en: EN_LABEL, ru: RU_LABEL, zh: ZH_LABEL } as const)[getLang()][k as PetState],
});

/** A short tag for where a session runs: its host and, when known, the Claude Code front end (desktop app, IDE). '' when there is nothing to tell. */
export function hostTag(s: { host?: string; source?: string; distro?: string }): string {
  const host = s.host === 'windows' ? 'Win' : s.host === 'wsl' ? (s.distro ? `WSL ${s.distro}` : 'WSL') : '';
  const src = ({ 'claude-desktop': 'App', vscode: 'VS Code', 'claude-vscode': 'VS Code', jetbrains: 'JetBrains' } as Record<string, string>)[s.source ?? ''] ?? '';
  return [host, src].filter(Boolean).join(' · ');
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** how many agents run: " ×2" (empty when none) */
const agentCount = (n?: number): string => (n ?? 0) > 0 ? ` ×${n}` : '';

/** a session's state in words; running agents get their count ("Agent working ×2") */
export function sessionLabel(s: { state: PetState; subagents?: number }): string {
  return s.state === 'subagent' ? `${STATE_LABEL[s.state]}${agentCount(s.subagents)}` : STATE_LABEL[s.state];
}

export interface StatusView { label: string; /** the short word for the island */ chip: string; detail: string; state: PetState; attention: boolean }

export function statusView(snap: Snapshot | null, connected: boolean, now: number): StatusView {
  if (!connected || !snap) return { label: L('Нет связи с Claude Code', 'No connection to Claude Code', '无法连接 Claude Code'), chip: L('Нет связи', 'Offline', '未连接'), detail: '', state: 'sleeping', attention: false };
  const s = snap.sessions.find((x) => x.id === snap.attention);
  if (!s) return { label: L('Жду Claude Code…', 'Waiting for Claude Code…', '正在等待 Claude Code…'), chip: L('Ожидание', 'Waiting', '等待中'), detail: '', state: 'idle', attention: false };
  return {
    // Claude asks a question (not a tool permission): say so
    label: s.pendingPermission?.questions ? L('Claude задаёт вопрос', 'Claude asks a question', 'Claude 在提问') : sessionLabel(s),
    chip: s.pendingPermission?.questions ? L('Вопрос', 'Question', '提问') : `${chipLabel(s.state)}${s.state === 'subagent' ? agentCount(s.subagents) : ''}`,
    detail: `${s.project} · ${formatElapsed(now - s.since)}`,
    state: s.state,
    attention: s.state === 'waiting' || s.state === 'error',
  };
}
