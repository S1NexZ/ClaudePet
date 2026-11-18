import type { HookEvent, PetState } from '../../shared/src/types.js';

const TEST_RUNNERS = [
  /\b(pytest|py\.test|vitest|jest|mocha|rspec|phpunit)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bdotnet\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\w*\s+test\b/,
];

/** A command that runs a test suite (shown as 'testing'; its result makes the pet react) */
export const isTestCommand = (cmd: string): boolean => TEST_RUNNERS.some((re) => re.test(cmd));

const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const WRITING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function toolState(ev: HookEvent): PetState {
  const tool = ev.tool_name ?? '';
  if (READING.has(tool)) return 'reading';
  if (WRITING.has(tool)) return 'writing';
  if (tool === 'Task' || tool === 'Agent') return 'subagent'; // Claude Code renamed Task to Agent
  if (tool === 'Bash') {
    const cmd = String(ev.tool_input?.command ?? '');
    return isTestCommand(cmd) ? 'testing' : 'running';
  }
  return 'running';
}

/** Maps a Claude Code hook event to a pet state; null means "no change". */
export function mapEvent(ev: HookEvent): PetState | null {
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit': return 'thinking';
    case 'PreToolUse': return toolState(ev);
    case 'PostToolUse': return ev.tool_response?.is_error ? 'error' : 'thinking';
    // a failed command is ordinary work: Claude reads the error and goes on
    case 'PostToolUseFailure': return 'thinking';
    case 'Notification': return /permission/i.test(ev.message ?? '') ? 'waiting' : null;
    case 'Stop': return 'done';
    case 'SessionStart': return 'idle';
    case 'SessionEnd': return 'sleeping';
    default: return null;
  }
}
