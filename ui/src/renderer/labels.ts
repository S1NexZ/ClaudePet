import type { PetState, Snapshot } from '../../../shared/src/types.js';
import { L, getLang } from '../../../shared/src/i18n.js';

const RU_LABEL: Record<PetState, string> = {
  idle: 'Готов', thinking: 'Думает', reading: 'Изучает', writing: 'Пишет код',
  running: 'Запускает команду', testing: 'Тестирует', waiting: 'Ждёт разрешения',
  subagent: 'Субагент работает', done: 'Готово', error: 'Ошибка', sleeping: 'Спит',
};
const EN_LABEL: Record<PetState, string> = {
  idle: 'Ready', thinking: 'Thinking', reading: 'Reading', writing: 'Writing code',
  running: 'Running a command', testing: 'Testing', waiting: 'Needs permission',
  subagent: 'Subagent working', done: 'Done', error: 'Error', sleeping: 'Asleep',
};
const ZH_LABEL: Record<PetState, string> = {
  idle: '就绪', thinking: '思考中', reading: '阅读中', writing: '编写代码',
  running: '运行命令', testing: '测试中', waiting: '需要权限',
  subagent: '子代理工作中', done: '完成', error: '出错', sleeping: '休眠',
};
/** read lazily, so the label follows the language chosen at runtime */
export const STATE_LABEL = new Proxy({} as Record<PetState, string>, {
  get: (_t, k) => ({ en: EN_LABEL, ru: RU_LABEL, zh: ZH_LABEL } as const)[getLang()][k as PetState],
});

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface StatusView { label: string; detail: string; state: PetState; attention: boolean }

export function statusView(snap: Snapshot | null, connected: boolean, now: number): StatusView {
  if (!connected || !snap) return { label: L('Нет связи с Claude Code', 'No connection to Claude Code', '无法连接 Claude Code'), detail: '', state: 'sleeping', attention: false };
  const s = snap.sessions.find((x) => x.id === snap.attention);
  if (!s) return { label: L('Жду Claude Code…', 'Waiting for Claude Code…', '正在等待 Claude Code…'), detail: '', state: 'idle', attention: false };
  return {
    label: STATE_LABEL[s.state],
    detail: `${s.project} · ${formatElapsed(now - s.since)}`,
    state: s.state,
    attention: s.state === 'waiting' || s.state === 'error',
  };
}
