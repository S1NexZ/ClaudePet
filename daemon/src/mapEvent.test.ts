import { describe, it, expect } from 'vitest';
import { mapEvent } from './mapEvent.js';
import type { HookEvent } from '../../shared/src/types.js';

const ev = (o: Partial<HookEvent> & { hook_event_name: string }): HookEvent =>
  ({ session_id: 's1', cwd: '/p', ...o });
const bash = (command: string) =>
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

describe('mapEvent', () => {
  it('UserPromptSubmit -> thinking', () => expect(mapEvent(ev({ hook_event_name: 'UserPromptSubmit' }))).toBe('thinking'));
  it.each(['Read', 'Grep', 'Glob'])('PreToolUse %s -> reading', (t) =>
    expect(mapEvent(ev({ hook_event_name: 'PreToolUse', tool_name: t }))).toBe('reading'));
  it.each(['Edit', 'Write'])('PreToolUse %s -> writing', (t) =>
    expect(mapEvent(ev({ hook_event_name: 'PreToolUse', tool_name: t }))).toBe('writing'));
  it('Task tool -> subagent', () =>
    expect(mapEvent(ev({ hook_event_name: 'PreToolUse', tool_name: 'Task' }))).toBe('subagent'));
  it.each(['pytest -x', 'npm test', 'go test ./...', 'npx vitest run'])('Bash "%s" -> testing', (c) =>
    expect(mapEvent(bash(c))).toBe('testing'));
  it.each(['ls -la', 'git status', 'npm install'])('Bash "%s" -> running', (c) =>
    expect(mapEvent(bash(c))).toBe('running'));
  it('Bash without command -> running', () =>
    expect(mapEvent(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }))).toBe('running'));
  it('permission Notification -> waiting', () =>
    expect(mapEvent(ev({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }))).toBe('waiting'));
  it('other Notification -> null', () =>
    expect(mapEvent(ev({ hook_event_name: 'Notification', message: 'hello' }))).toBeNull());
  it('Stop -> done', () => expect(mapEvent(ev({ hook_event_name: 'Stop' }))).toBe('done'));
  it('SubagentStop -> null', () => expect(mapEvent(ev({ hook_event_name: 'SubagentStop' }))).toBeNull());
  it('PostToolUse with error -> error', () =>
    expect(mapEvent(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { is_error: true } }))).toBe('error'));
  it('PostToolUse ok -> thinking (back to deciding next step)', () =>
    expect(mapEvent(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {} }))).toBe('thinking'));
  it('SessionStart -> idle, SessionEnd -> sleeping', () => {
    expect(mapEvent(ev({ hook_event_name: 'SessionStart' }))).toBe('idle');
    expect(mapEvent(ev({ hook_event_name: 'SessionEnd' }))).toBe('sleeping');
  });
  it('unknown event -> null', () => expect(mapEvent(ev({ hook_event_name: 'Weird' }))).toBeNull());
});
