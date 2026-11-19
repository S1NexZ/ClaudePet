import { posix } from 'node:path';
import { mapEvent } from './mapEvent.js';
import type { HookEvent, PendingPermission, PetState, Session } from '../../shared/src/types.js';

/** a model turn can run silently for minutes (long thinking, a big answer): only a very long silence means the session is gone */
const BUSY_DECAY_MS = 30 * 60_000;
/** a tool is running (a long build, a test suite, a wait): its PostToolUse comes when it ends, so quiet means busy, not lost */
const TOOL_DECAY_MS = 30 * 60_000;
const WAITING_DECAY_MS = 30 * 60_000;
const DONE_TO_IDLE_MS = 30_000;
/** A session whose SessionEnd arrived (and that was not resumed) leaves the pet after this. */
const CLOSED_DROP_MS = 30_000;
const SLEEPING_DROP_MS = 60 * 60_000;
/** A quiet "idle" session that sent nothing for this long is most likely a closed terminal (no SessionEnd was ever sent). */
const IDLE_TO_SLEEP_MS = 3 * 60 * 60_000;
/** Hard cap on the list: beyond it the longest-quiet sleeping/idle sessions go (a live one reappears with its next event). */
const MAX_SESSIONS = 15;
/** SubagentStop may never come (crash, Esc): an agent silent this long is dropped. */
const SUBAGENT_STALE_MS = 10 * 60_000;
const QUIET: PetState[] = ['idle', 'sleeping', 'done'];

function projectName(cwd: string): string {
  // Windows paths use backslashes
  return posix.basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')) || cwd;
}

/** The session the pet should show: waiting > error > newest active > newest overall. Works on a merged list from several hosts. */
export function pickAttention(all: Session[]): Session | null {
  if (all.length === 0) return null;
  const newest = (xs: Session[]) => xs.reduce((a, b) => (b.lastEventAt >= a.lastEventAt ? b : a));
  for (const pick of [
    (x: Session) => x.state === 'waiting',
    (x: Session) => x.state === 'error',
    (x: Session) => !QUIET.includes(x.state),
  ]) {
    const hit = all.filter(pick);
    if (hit.length) return newest(hit);
  }
  return newest(all);
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  /** Sessions whose process exited while "done" was showing: they sleep after the done period. */
  private ended = new Set<string>();
  /** id -> when SessionEnd arrived; kept out of Session (which goes to the UI) */
  private closedAt = new Map<string, number>();

  /** session -> running subagent ids -> last seen */
  private agents = new Map<string, Map<string, number>>();
  /** the main agent sent Stop and has not started a new turn */
  private turnDone = new Set<string>();

  apply(ev: HookEvent, now: number = Date.now()): void {
    let s = this.sessions.get(ev.session_id);
    if (!s) {
      s = { id: ev.session_id, cwd: ev.cwd, project: projectName(ev.cwd), state: 'idle',
            since: now, lastEventAt: now, owned: false };
      this.sessions.set(s.id, s);
    }
    s.lastEventAt = now;
    // a session first seen without a folder (a bare waiter, an event body without cwd) gets it from the first event that has one
    if (!s.cwd && ev.cwd) { s.cwd = ev.cwd; s.project = projectName(ev.cwd); }
    const pty = (ev as { pet_pty?: unknown }).pet_pty;
    if (typeof pty === 'string' && pty) s.pty = pty;
    if (ev.hook_event_name === 'SessionEnd') {
      this.agents.delete(s.id); this.turnDone.delete(s.id);
      delete s.pty; // the wrapper (and its socket) goes away with the claude process
      if (s.owned) return;                                   // the pet can still resume it
      this.closedAt.set(s.id, now);
      if (s.state === 'done') { this.ended.add(s.id); return; } // let "done" stay visible
    } else {
      this.ended.delete(s.id);
      this.closedAt.delete(s.id); // resumed
    }
    const agent = ev.agent_id;
    if (agent) {
      const m = this.agents.get(s.id) ?? new Map<string, number>();
      this.agents.set(s.id, m);
      if (ev.hook_event_name === 'SubagentStop') {
        m.delete(agent);
        if (!m.size) {
          this.agents.delete(s.id);
          if (s.state === 'subagent') this.setState(s, this.turnDone.has(s.id) ? 'done' : 'thinking', now);
        }
        return;
      }
      m.set(agent, now);
      if (s.state !== 'waiting' && s.state !== 'subagent') this.setState(s, 'subagent', now);
      return;
    }
    if (ev.hook_event_name === 'Stop') this.turnDone.add(s.id);
    else if (ev.hook_event_name === 'UserPromptSubmit' || ev.hook_event_name === 'PreToolUse') this.turnDone.delete(s.id);
    let next = mapEvent(ev);
    if ((next === 'done' || next === 'idle' || next === 'thinking') && this.agents.get(s.id)?.size) next = 'subagent';
    if (next && next !== s.state) this.setState(s, next, now);
  }

  tick(now: number): void {
    for (const s of this.sessions.values()) {
      const closed = this.closedAt.get(s.id);
      if (closed !== undefined && now - closed >= CLOSED_DROP_MS) { this.remove(s.id); continue; }
      const m = this.agents.get(s.id);
      if (m) {
        for (const [a, seen] of m) if (now - seen >= SUBAGENT_STALE_MS) m.delete(a);
        if (!m.size) {
          this.agents.delete(s.id);
          if (s.state === 'subagent') this.setState(s, this.turnDone.has(s.id) ? 'done' : 'idle', now);
        }
      }
      const hasAgents = !!this.agents.get(s.id)?.size;
      const quietFor = now - s.lastEventAt;
      if (s.state === 'done' && now - s.since >= DONE_TO_IDLE_MS) {
        this.setState(s, this.ended.delete(s.id) ? 'sleeping' : 'idle', now);
      }
      else if (s.state === 'waiting' && quietFor >= WAITING_DECAY_MS) this.setState(s, 'sleeping', now);
      else if (!QUIET.includes(s.state) && s.state !== 'waiting' && !hasAgents && quietFor >= (s.state === 'running' || s.state === 'testing' ? TOOL_DECAY_MS : BUSY_DECAY_MS))
        this.setState(s, 'sleeping', now);
      else if (s.state === 'idle' && !s.owned && quietFor >= IDLE_TO_SLEEP_MS) this.setState(s, 'sleeping', now);
      else if (s.state === 'sleeping' && now - s.since > SLEEPING_DROP_MS) this.remove(s.id);
    }
    this.enforceCap();
  }

  private enforceCap(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const droppable = [...this.sessions.values()]
      .filter((x) => !x.owned && (x.state === 'sleeping' || x.state === 'idle'))
      .sort((a, b) => a.lastEventAt - b.lastEventAt);
    for (const x of droppable) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.remove(x.id);
    }
  }

  setSource(id: string, source: string): void {
    const s = this.sessions.get(id);
    if (s && source) s.source = source;
  }

  /** the session runs under a pseudoterminal wrapper: the pet can type into it */
  setPty(id: string, pty: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.pty === pty) return false;
    s.pty = pty; return true;
  }

  clearPty(id: string): void {
    const s = this.sessions.get(id);
    if (s) delete s.pty;
  }

  /** An interrupt (Esc) ends the turn without any Stop hook: show the session as idle right away. */
  markInterrupted(id: string, now: number = Date.now()): void {
    const s = this.sessions.get(id);
    if (s && !QUIET.includes(s.state)) { delete s.pendingPermission; this.setState(s, 'idle', now); }
  }

  /** Remembers the folder a session was started in. Written once: later changes of the working folder never alter it. */
  setResumeCwd(id: string, cwd: string): void {
    const s = this.sessions.get(id);
    if (s && !s.resumeCwd && cwd) s.resumeCwd = cwd;
  }

  /** Puts back what an aborted attempt had already changed (state, owned flag). */
  restore(id: string, prev: { state: PetState; since: number; owned: boolean }): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state = prev.state; s.since = prev.since; s.owned = prev.owned;
    delete s.pendingPermission;
  }

  setOwned(id: string, owned: boolean): void {
    const s = this.sessions.get(id);
    if (s) s.owned = owned;
  }

  setPending(id: string, p: PendingPermission | undefined): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (p) s.pendingPermission = p; else delete s.pendingPermission;
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.ended.delete(id);
    this.closedAt.delete(id);
    this.agents.delete(id);
    this.turnDone.delete(id);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => { const n = this.agents.get(s.id)?.size ?? 0; return n ? { ...s, subagents: n } : s; });
  }

  /** The session the pet should show (see pickAttention). */
  attention(): Session | null {
    return pickAttention(this.list());
  }

  private setState(s: Session, state: PetState, now: number): void {
    s.state = state;
    s.since = now;
  }
}
