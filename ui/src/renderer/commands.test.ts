import { describe, it, expect } from 'vitest';
import { matchCommands, planSlash, findCommand, COMMANDS, typedLine, MODEL_ALIASES } from './commands.js';

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

describe('typedLine (pet commands that go into the terminal as typed)', () => {
  it('/model <name> and /btw <question> become the same line', () => { expect(typedLine('model', 'sonnet')).toBe('/model sonnet'); expect(typedLine('btw', 'why?')).toBe('/btw why?'); });
  it('without an argument there is nothing to type', () => { expect(typedLine('model', '')).toBeNull(); expect(typedLine('btw', '')).toBeNull(); });
  it('other commands are not typed', () => expect(typedLine('stop', 'x')).toBeNull());
  it('the alias list has the usual names and descriptions', () => { expect(MODEL_ALIASES.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'opusplan']); for (const m of MODEL_ALIASES) expect(m.label().length).toBeGreaterThan(3); });
});
