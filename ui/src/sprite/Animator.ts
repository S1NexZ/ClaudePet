import type { PetState } from '../../../shared/src/types.js';
import { ROW_FRAMES, ROW_LOOP_MS, rowForState } from './stateMap.js';

/** "done": jump once, then wave for as long as the state lasts. */
const DONE_JUMP_ROW = 4;
const DONE_WAVE_ROW = 3;
const RUN_ROW = { right: 1, left: 2 } as const;
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

export class Animator {
  private shown: PetState = 'idle';
  private want: PetState = 'idle';
  private startedAt: number | null = null;
  private drag: DragDir | null = null;
  private dragStartedAt: number | null = null;
  private rowFrames: readonly number[];
  private readonly frameMs?: number;
  private readonly minHoldMs: number;

  constructor(o: AnimatorOpts = {}) {
    this.rowFrames = o.rowFrames ?? ROW_FRAMES;
    this.frameMs = o.frameMs;
    this.minHoldMs = o.minHoldMs ?? 900;
  }

  /** A pack with another row layout (e.g. the 11-row v2 sheets) was loaded. */
  setRowFrames(frames: readonly number[]): void { this.rowFrames = frames; }

  setState(s: PetState): void {
    this.want = s;
  }

  /** While the window is dragged the pet runs in that direction; null = released. */
  setDrag(dir: DragDir | null): void {
    if (dir === this.drag) return;
    this.drag = dir;
    this.dragStartedAt = null;
    // after release show the current state straight away (the drag already broke continuity)
    if (!dir) { this.shown = this.want; this.startedAt = null; }
  }

  frame(now: number): { row: number; col: number } {
    if (this.drag) {
      this.dragStartedAt ??= now;
      const row = RUN_ROW[this.drag];
      if (row >= this.rowFrames.length) return this.cycle(0, now - this.dragStartedAt);
      return this.cycle(row, now - this.dragStartedAt);
    }
    this.startedAt ??= now;
    if (this.want !== this.shown && (URGENT.has(this.want) || now - this.startedAt >= this.minHoldMs)) {
      this.shown = this.want;
      this.startedAt = now;
    }
    const elapsed = now - this.startedAt;
    if (this.shown === 'done') return this.sequence(elapsed);
    let row = rowForState(this.shown);
    if (row >= this.rowFrames.length) row = 0;
    return this.cycle(row, elapsed);
  }

  /**
   * Milliseconds until frame() may return something else: the end of the current frame, or the end of the hold before a wanted state.
   * The render loop sleeps until then instead of waking 60 times a second.
   */
  msToNextFrame(now: number): number {
    let step: number, elapsed: number;
    if (this.drag) {
      const row = RUN_ROW[this.drag] < this.rowFrames.length ? RUN_ROW[this.drag] : 0;
      step = this.stepMs(row); elapsed = now - (this.dragStartedAt ?? now);
    } else {
      const started = this.startedAt ?? now;
      const row = this.shown === 'done' ? DONE_JUMP_ROW : rowForState(this.shown);
      step = this.stepMs(row < this.rowFrames.length ? row : 0); elapsed = now - started;
      if (this.want !== this.shown) return URGENT.has(this.want) ? 0 : Math.max(0, Math.min(step - (elapsed % step), this.minHoldMs - elapsed));
    }
    return step - (elapsed % step);
  }

  private cycle(row: number, elapsed: number): { row: number; col: number } {
    return { row, col: Math.floor(elapsed / this.stepMs(row)) % this.rowFrames[row] };
  }

  /** Jump once (if the atlas has the row), then loop the wave (or idle, if there is no wave row). */
  private sequence(elapsed: number): { row: number; col: number } {
    let t = elapsed;
    if (DONE_JUMP_ROW < this.rowFrames.length) {
      const len = this.rowFrames[DONE_JUMP_ROW] * this.stepMs(DONE_JUMP_ROW);
      if (t < len) return { row: DONE_JUMP_ROW, col: Math.floor(t / this.stepMs(DONE_JUMP_ROW)) };
      t -= len;
    }
    return this.cycle(DONE_WAVE_ROW < this.rowFrames.length ? DONE_WAVE_ROW : 0, t);
  }

  private stepMs(row: number): number {
    // the per-frame pace of the standard layout, so a pack with an extra frame in a row simply runs a bit longer
    return this.frameMs ?? (row < ROW_LOOP_MS.length ? ROW_LOOP_MS[row] / ROW_FRAMES[row] : 250);
  }
}
