import { L } from '../../../shared/src/i18n.js';

/** `pet`: handled by the pet itself; `claude`: typed into the session's terminal as is (Claude Code runs it). */
export interface Command { name: string; kind: 'pet' | 'claude'; args?: string; desc: () => string }

export const COMMANDS: Command[] = [
  { name: 'model', kind: 'pet', args: '[model]', desc: () => L('Выбрать модель для чата', 'Pick the model for this chat', '为此聊天选择模型') },
  { name: 'btw', kind: 'pet', args: '<question>', desc: () => L('Побочный вопрос по чату, не попадает в историю', 'A side question about the chat, kept out of its history', '关于聊天的旁支提问，不计入历史') },
  { name: 'stop', kind: 'pet', desc: () => L('Остановить Claude', 'Stop Claude', '停止 Claude') },
  { name: 'new', kind: 'pet', desc: () => L('Новый чат в папке…', 'New chat in a folder…', '在文件夹中新建聊天…') },
  { name: 'end', kind: 'pet', desc: () => L('Завершить сессию', 'End the session', '结束会话') },
  { name: 'sessions', kind: 'pet', desc: () => L('Сменить чат', 'Switch chat', '切换聊天') },
  { name: 'terminal', kind: 'pet', desc: () => L('Открыть чат в терминале или приложении', 'Open the chat in the terminal or the app', '在终端或应用中打开聊天') },
  { name: 'usage', kind: 'pet', desc: () => L('Лимиты плана', 'Plan limits', '套餐额度') },
  { name: 'settings', kind: 'pet', desc: () => L('Настройки питомца', 'Pet settings', '宠物设置') },
  { name: 'help', kind: 'pet', desc: () => L('Список команд', 'List of commands', '命令列表') },
  { name: 'compact', kind: 'claude', args: '[focus]', desc: () => L('Сжать историю чата', 'Compact the conversation', '压缩对话') },
  { name: 'clear', kind: 'claude', desc: () => L('Очистить контекст', 'Clear the context', '清空上下文') },
  { name: 'cost', kind: 'claude', desc: () => L('Расход токенов сессии', 'Token use of the session', '会话令牌用量') },
  { name: 'context', kind: 'claude', desc: () => L('Из чего состоит контекст', 'What fills the context', '上下文构成') },
  { name: 'status', kind: 'claude', desc: () => L('Состояние Claude Code', 'Claude Code status', 'Claude Code 状态') },
  { name: 'memory', kind: 'claude', desc: () => L('Файлы памяти', 'Memory files', '记忆文件') },
  { name: 'init', kind: 'claude', desc: () => L('Создать CLAUDE.md', 'Create CLAUDE.md', '创建 CLAUDE.md') },
  { name: 'review', kind: 'claude', args: '[PR]', desc: () => L('Ревью изменений', 'Review changes', '审查更改') },
  { name: 'resume', kind: 'claude', desc: () => L('Вернуться в прошлый чат', 'Resume an earlier chat', '恢复之前的聊天') },
];

/** Commands whose name starts with what is typed after "/" (only while the name itself is still being typed). */
export function matchCommands(text: string): Command[] {
  const m = /^\s*\/([^\s/]*)$/.exec(text);
  if (!m) return [];
  const p = m[1].toLowerCase();
  const hit = COMMANDS.filter((c) => c.name.startsWith(p));
  return hit.length === 1 && hit[0].name === p ? [] : hit; // an exactly typed name needs no menu
}

export const findCommand = (name: string): Command | undefined => COMMANDS.find((c) => c.name === name.toLowerCase());

/** What to do with a `/word` in the composer. `claude-pass`: forward to the session; `no-terminal`: a Claude command but the session cannot be typed into. */
export type SlashPlan = { kind: 'pet'; name: string; args: string } | { kind: 'claude-pass' } | { kind: 'no-terminal'; name: string };

export function planSlash(sl: { name: string; args: string } | null, canType: boolean): SlashPlan | null {
  if (!sl) return null;
  const c = findCommand(sl.name);
  if (c?.kind === 'pet') return { kind: 'pet', name: c.name, args: sl.args };
  if (c?.kind === 'claude' && !canType) return { kind: 'no-terminal', name: c.name };
  return { kind: 'claude-pass' }; // unknown /commands (skills, user commands) go through as typed, like before
}

/** Model names Claude Code's own `/model <name>` accepts; the pet lists them without starting a second claude (the real model list needs the Agent SDK). */
export const MODEL_ALIASES: Array<{ value: string; label: () => string }> = [
  { value: 'default', label: () => L('Модель по умолчанию вашего плана', 'Your plan\'s default model', '套餐默认模型') },
  { value: 'opus', label: () => L('Самая сильная, для сложных задач', 'Most capable, for hard tasks', '能力最强，适合复杂任务') },
  { value: 'sonnet', label: () => L('Быстрая и сбалансированная', 'Fast and balanced', '快速且均衡') },
  { value: 'haiku', label: () => L('Самая быстрая и дешёвая', 'Fastest and cheapest', '最快最省') },
  { value: 'opusplan', label: () => L('Opus для плана, Sonnet для работы', 'Opus to plan, Sonnet to work', 'Opus 规划，Sonnet 执行') },
];

/** The line typed into a terminal session for a pet command that Claude Code itself runs (`/model <name>`, `/btw <question>`); null for the rest. */
export function typedLine(name: string, args: string): string | null {
  if (name === 'btw') return args ? `/btw ${args}` : null;
  if (name === 'model') return args ? `/model ${args}` : null;
  return null;
}
