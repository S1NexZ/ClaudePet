import { posix } from 'node:path';
import { mapEvent } from './mapEvent.js';
import type { HookEvent, PendingPermission, PetState, Session } from '../../shared/src/types.js';

const BUSY_DECAY_MS = 120_000;
const WAITING_DECAY_MS = 30 * 60_000;
const DONE_TO_IDLE_MS = 30_000;
const SLEEPING_DROP_MS = 60 * 60_000;
/** A quiet "idle" session that sent nothing for this long is most likely a closed terminal (no SessionEnd was ever sent). */
const IDLE_TO_SLEEP_MS = 3 * 60 * 60_000;
/** Hard cap on the list: beyond it the longest-quiet sleeping/idle sessions go (a live one reappears with its next event). */
const MAX_SESSIONS = 15;
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

  apply(ev: HookEvent, now: number = Date.now()): void {
    let s = this.sessions.get(ev.session_id);
    if (!s) {
      s = { id: ev.session_id, cwd: ev.cwd, project: projectName(ev.cwd), state: 'idle',
            since: now, lastEventAt: now, owned: false };
      this.sessions.set(s.id, s);
    }
    s.lastEventAt = now;
    const pty = (ev as { pet_pty?: unknown }).pet_pty;
    if (typeof pty === 'string' && pty) s.pty = pty;
    if (ev.hook_event_name === 'SessionEnd') {
      delete s.pty; // the wrapper (and its socket) goes away with the claude process
      if (s.owned) return;                                   // the pet can still resume it
      if (s.state === 'done') { this.ended.add(s.id); return; } // let "done" stay visible
    } else {
      this.ended.delete(s.id);
    }
    const next = mapEvent(ev);
    if (next && next !== s.state) this.setState(s, next, now);
  }

  tick(now: number): void {
    for (const s of this.sessions.values()) {
      const quietFor = now - s.lastEventAt;
      if (s.state === 'done' && now - s.since >= DONE_TO_IDLE_MS) {
        this.setState(s, this.ended.delete(s.id) ? 'sleeping' : 'idle', now);
      }
      else if (s.state === 'waiting' && quietFor >= WAITING_DECAY_MS) this.setState(s, 'sleeping', now);
      else if (!QUIET.includes(s.state) && s.state !== 'waiting' && quietFor >= BUSY_DECAY_MS)
        this.setState(s, 'sleeping', now);
      else if (s.state === 'idle' && !s.owned && quietFor >= IDLE_TO_SLEEP_MS) this.setState(s, 'sleeping', now);
      else if (s.state === 'sleeping' && now - s.since > SLEEPING_DROP_MS) { this.sessions.delete(s.id); this.ended.delete(s.id); }
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
      this.sessions.delete(x.id); this.ended.delete(x.id);
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
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
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
