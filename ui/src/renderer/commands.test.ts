import { describe, it, expect } from 'vitest';
import { matchCommands, planSlash, findCommand, COMMANDS } from './commands.js';

describe('matchCommands', () => {
  it('lists everything for a lone slash', () => expect(matchCommands('/').length).toBe(COMMANDS.length));
  it('filters by prefix, case-insensitive', () => expect(matchCommands('/Mo').map((c) => c.name)).toEqual(['model']));
  it('no menu once an argument is being typed or the name is exact', () => {
    expect(matchCommands('/model sonnet')).toEqual([]);
    expect(matchCommands('/model')).toEqual([]);
  });
  it('no menu for plain text', () => { expect(matchCommands('hello')).toEqual([]); expect(matchCommands('a /m')).toEqual([]); });
  it('keeps longer names that share the prefix', () => expect(matchCommands('/s').map((c) => c.name)).toEqual(['stop', 'sessions', 'settings', 'status']));
  it('every command has a description', () => { for (const c of COMMANDS) expect(c.desc().length).toBeGreaterThan(3); });
});

describe('planSlash', () => {
  it('pet commands are handled by the pet', () => expect(planSlash({ name: 'stop', args: '' }, false)).toEqual({ kind: 'pet', name: 'stop', args: '' }));
  it('Claude commands pass through when the session can be typed into', () => expect(planSlash({ name: 'compact', args: '' }, true)).toEqual({ kind: 'claude-pass' }));
  it('Claude commands are refused (with a reason) when it cannot', () => expect(planSlash({ name: 'compact', args: '' }, false)).toEqual({ kind: 'no-terminal', name: 'compact' }));
  it('unknown /words (skills, custom commands) pass through as before', () => expect(planSlash({ name: 'superpowers:x', args: '' }, false)).toEqual({ kind: 'claude-pass' }));
  it('not a command', () => expect(planSlash(null, true)).toBeNull());
  it('lookup is case-insensitive', () => expect(findCommand('MODEL')?.name).toBe('model'));
});
