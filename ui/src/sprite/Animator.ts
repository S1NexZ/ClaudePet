import type { PetState, Reaction } from '../../../shared/src/types.js';
import { ROW_FRAMES, ROW_LOOP_MS, rowForState } from './stateMap.js';

/** "done": jump once, then wave for as long as the state lasts. */
const DONE_JUMP_ROW = 4;
const DONE_WAVE_ROW = 3;
const RUN_ROW = { right: 1, left: 2 } as const;
/** a reaction to something that just happened: happy jumps and waves, sad shows the failure row; then the state comes back */
const SAD_ROW = 5;
export const REACT_MS = 2600;
export type DragDir = keyof typeof RUN_ROW;

/** States that must show at once: the user has to act. */
const URGENT: ReadonlySet<PetState> = new Set<PetState>(['waiting', 'error']);

export interface AnimatorOpts {
  /** Fixed ms per frame; default derives it from each row's loop time. */
  frameMs?: number;
  /** A shown animation is kept at least this long before switching to a non-urgent state (anti-flicker). */
  minHoldMs?: number;
  rowFrames?: readonly number[];
}

export interface LayoutRow { frames: number; id?: string; loopMs?: number }
export interface Frame { row: number; col: number; /** col of the following frame in the same row (wraps) */ next: number; /** 0..1 progress within the current frame */ mix: number }

/** Layout packs: a state is a row id; a missing row falls back along this chain (idle falls back to row 0). */
const LAYOUT_FALLBACK: Partial<Record<PetState, PetState>> = {
  sleeping: 'idle', thinking: 'idle', writing: 'thinking', running: 'thinking', testing: 'reading', subagent: 'idle', waiting: 'idle', error: 'idle', done: 'idle',
};
const LAYOUT_LOOP_MS = 1800;

export class Animator {
  private shown: PetState = 'idle';
  private want: PetState = 'idle';
  private startedAt: number | null = null;
  private drag: DragDir | null = null;
  private dragStartedAt: number | null = null;
  private reaction: { kind: Reaction; at: number } | null = null;
  private rowFrames: readonly number[];
  private layout: LayoutRow[] | null = null;
  private readonly frameMs?: number;
  private readonly minHoldMs: number;

  constructor(o: AnimatorOpts = {}) {
    this.rowFrames = o.rowFrames ?? ROW_FRAMES;
    this.frameMs = o.frameMs;
    this.minHoldMs = o.minHoldMs ?? 900;
  }

  /** A pack with another row layout (e.g. the 11-row v2 sheets) was loaded. */
  setRowFrames(frames: readonly number[]): void { this.rowFrames = frames; }

  /** A layout pack (rows by id) was loaded; null = back to the standard atlas rows. */
  setLayout(rows: LayoutRow[] | null): void {
    this.layout = rows;
    if (rows) this.rowFrames = rows.map((r) => r.frames);
  }

  /** True when a layout is active: the renderer blends `frame.mix` between `col` and `next`. */
  smooth(): boolean { return this.layout !== null; }

  /** Row of a state in the layout: its own id, else along the fallback chain, else row 0. */
  private layoutRow(s: PetState | 'lifted'): number {
    const rows = this.layout!;
    for (let k: PetState | 'lifted' | undefined = s; k; k = LAYOUT_FALLBACK[k as PetState]) {
      const i = rows.findIndex((r) => r.id === k);
      if (i >= 0) return i;
    }
    return 0;
  }

  /** Row shown while dragging: the layout's 'lifted' row, else the old run rows. */
  private dragRow(dir: DragDir): number {
    if (this.layout) { const i = this.layout.findIndex((r) => r.id === 'lifted'); if (i >= 0) return i; }
    return RUN_ROW[dir] < this.rowFrames.length ? RUN_ROW[dir] : 0;
  }

  private stateRow(s: PetState): number {
    if (this.layout) return this.layoutRow(s);
    const row = rowForState(s);
    return row < this.rowFrames.length ? row : 0;
  }

  setState(s: PetState): void {
    this.want = s;
  }

  /** A short one-off animation (tests passed / failed, a commit); a state that needs the user cuts it short. */
  react(kind: Reaction, now: number): void { this.reaction = { kind, at: now }; }

  private reacting(now: number): Frame | null {
    const r = this.reaction;
    if (!r) return null;
    const t = now - r.at;
    if (t >= REACT_MS || URGENT.has(this.want)) { this.reaction = null; this.shown = this.want; this.startedAt = now; return null; }
    if (this.layout) return this.cycle(this.layoutRow(r.kind === 'sad' ? 'error' : 'done'), t);
    if (r.kind === 'sad') return this.cycle(SAD_ROW < this.rowFrames.length ? SAD_ROW : 0, t);
    return this.sequence(t);
  }

  /** While the window is dragged the pet runs in that direction; null = released. */
  setDrag(dir: DragDir | null): void {
    if (dir === this.drag) return;
    this.drag = dir;
    this.dragStartedAt = null;
    // after release show the current state straight away (the drag already broke continuity)
    if (!dir) { this.shown = this.want; this.startedAt = null; }
  }

  frame(now: number): Frame {
    if (this.drag) {
      this.dragStartedAt ??= now;
      return this.cycle(this.dragRow(this.drag), now - this.dragStartedAt);
    }
    const r = this.reacting(now);
    if (r) return r;
    this.startedAt ??= now;
    if (this.want !== this.shown && (URGENT.has(this.want) || now - this.startedAt >= this.minHoldMs)) {
      this.shown = this.want;
      this.startedAt = now;
    }
    const elapsed = now - this.startedAt;
    if (this.shown === 'done' && !this.layout) return this.sequence(elapsed);
    return this.cycle(this.stateRow(this.shown), elapsed);
  }

  /**
   * Milliseconds until frame() may return something else: the end of the current frame, or the end of the hold before a wanted state.
   * The render loop sleeps until then instead of waking 60 times a second.
   */
  msToNextFrame(now: number): number {
    let step: number, elapsed: number;
    if (this.drag) {
      step = this.stepMs(this.dragRow(this.drag)); elapsed = now - (this.dragStartedAt ?? now);
    } else if (this.reaction) {
      const t = now - this.reaction.at;
      if (t >= REACT_MS || URGENT.has(this.want)) return 0;
      if (this.layout) {
        step = this.stepMs(this.layoutRow(this.reaction.kind === 'sad' ? 'error' : 'done'));
        return Math.max(1, Math.min(step - (t % step), REACT_MS - t));
      }
      const row = this.reaction.kind === 'sad' ? SAD_ROW : t < this.rowFrames[DONE_JUMP_ROW] * this.stepMs(DONE_JUMP_ROW) ? DONE_JUMP_ROW : DONE_WAVE_ROW;
      step = this.stepMs(row < this.rowFrames.length ? row : 0);
      return Math.max(1, Math.min(step - (t % step), REACT_MS - t));
    } else {
      const started = this.startedAt ?? now;
      const row = this.shown === 'done' && !this.layout ? DONE_JUMP_ROW : this.stateRow(this.shown);
      step = this.stepMs(row < this.rowFrames.length ? row : 0); elapsed = now - started;
      if (this.want !== this.shown) return URGENT.has(this.want) ? 0 : Math.max(0, Math.min(step - (elapsed % step), this.minHoldMs - elapsed));
    }
    return step - (elapsed % step);
  }

  private cycle(row: number, elapsed: number): Frame {
    const step = this.stepMs(row), n = this.rowFrames[row], f = Math.floor(elapsed / step);
    return { row, col: f % n, next: (f + 1) % n, mix: (elapsed - f * step) / step };
  }

  /** Jump once (if the atlas has the row), then loop the wave (or idle, if there is no wave row). */
  private sequence(elapsed: number): Frame {
    let t = elapsed;
    if (DONE_JUMP_ROW < this.rowFrames.length) {
      const len = this.rowFrames[DONE_JUMP_ROW] * this.stepMs(DONE_JUMP_ROW);
      if (t < len) return this.cycle(DONE_JUMP_ROW, t);
      t -= len;
    }
    return this.cycle(DONE_WAVE_ROW < this.rowFrames.length ? DONE_WAVE_ROW : 0, t);
  }

  private stepMs(row: number): number {
    // the per-frame pace of the standard layout, so a pack with an extra frame in a row simply runs a bit longer
    if (this.layout) return this.frameMs ?? (this.layout[row].loopMs ?? LAYOUT_LOOP_MS) / this.layout[row].frames;
    return this.frameMs ?? (row < ROW_LOOP_MS.length ? ROW_LOOP_MS[row] / ROW_FRAMES[row] : 250);
  }
}
