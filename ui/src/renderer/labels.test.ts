import { describe, it, expect } from 'vitest';
import { formatElapsed, statusView } from './labels.js';
import type { Snapshot, Session } from '../../../shared/src/types.js';

const sess = (o: Partial<Session>): Session =>
  ({ id: 'a', cwd: '/x/proj', project: 'proj', state: 'idle', since: 0, lastEventAt: 0, owned: false, ...o });
const snap = (sessions: Session[], attention: string | null = sessions[0]?.id ?? null): Snapshot =>
  ({ type: 'snapshot', sessions, attention });

describe('formatElapsed', () => {
  it.each([[0, '0:00'], [134_000, '2:14'], [59_999, '0:59'], [3_725_000, '1:02:05'], [-5, '0:00']])(
    '%i ms -> %s', (ms, out) => expect(formatElapsed(ms)).toBe(out));
});

describe('statusView', () => {
  it('disconnected daemon', () => {
    expect(statusView(null, false, 0)).toMatchObject({ label: 'Нет связи с Claude Code', state: 'sleeping', attention: false });
  });
  it('connected but no sessions', () => {
    expect(statusView(snap([]), true, 0)).toMatchObject({ label: 'Жду Claude Code…', state: 'idle', attention: false });
  });
  it('shows label, project and elapsed time of the attention session', () => {
    const v = statusView(snap([sess({ state: 'testing', since: 1000 })]), true, 135_000);
    expect(v).toMatchObject({ label: 'Тестирует', detail: 'proj · 2:14', state: 'testing', attention: false });
  });
  it.each(['waiting', 'error'] as const)('%s needs attention', (state) => {
    expect(statusView(snap([sess({ state })]), true, 0).attention).toBe(true);
  });
  it('has a Russian label for every state', () => {
    for (const st of ['idle','thinking','reading','writing','running','testing','waiting','subagent','done','error','sleeping'] as const)
      expect(statusView(snap([sess({ state: st })]), true, 0).label).toMatch(/[А-Яа-я]/);
  });
});

import { hostTag, chipLabel } from './labels.js';
describe('hostTag', () => {
  it('names the host and the Claude Code front end', () => {
    expect(hostTag({ host: 'windows', source: 'claude-desktop' })).toBe('Win · App');
    expect(hostTag({ host: 'wsl' })).toBe('WSL');
    expect(hostTag({ host: 'windows', source: 'vscode' })).toBe('Win · VS Code');
    expect(hostTag({})).toBe('');
    expect(hostTag({ host: 'wsl', source: 'sdk-cli' })).toBe('WSL');
  });
});

describe('island words', () => {
  it('every state has one short word, and the status view carries it', () => {
    const states = ['idle', 'thinking', 'reading', 'writing', 'running', 'testing', 'waiting', 'subagent', 'done', 'error', 'sleeping'] as const;
    for (const st of states) { expect(chipLabel(st).length).toBeGreaterThan(0); expect(chipLabel(st).length).toBeLessThanOrEqual(11); }
    expect(statusView(null, false, 0).chip).toBe('Нет связи');
  });
});

import { sessionLabel } from './labels.js';
import { setLang } from '../../../shared/src/i18n.js';
describe('sessionLabel', () => {
  it('counts several running subagents', () => {
    setLang('en');
    expect(sessionLabel({ state: 'subagent', subagents: 3 })).toBe('Subagent working ×3');
    expect(sessionLabel({ state: 'subagent', subagents: 1 })).toBe('Subagent working');
    expect(sessionLabel({ state: 'thinking', subagents: 2 })).toBe('Thinking');
  });
});
