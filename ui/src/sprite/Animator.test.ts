import { describe, it, expect } from 'vitest';
import { Animator } from './Animator.js';
import { ROW_LOOP_MS, ROW_FRAMES } from './stateMap.js';

// fixed 100 ms frames, no hold: isolates the frame-stepping logic
const plain = (rowFrames?: readonly number[]) => new Animator({ frameMs: 100, minHoldMs: 0, rowFrames });

describe('Animator frame stepping', () => {
  it('cycles the frames of the state row', () => {
    const a = plain();
    a.setState('thinking');
    expect(a.frame(0)).toMatchObject({ row: 7, col: 0 });
    expect(a.frame(100)).toMatchObject({ row: 7, col: 1 });
    expect(a.frame(550)).toMatchObject({ row: 7, col: 5 });
    expect(a.frame(600)).toMatchObject({ row: 7, col: 0 });
  });
  it('resets to column 0 when the state changes', () => {
    const a = plain();
    a.setState('thinking'); a.frame(0); a.frame(300);
    a.setState('reading');
    expect(a.frame(310)).toMatchObject({ row: 8, col: 0 });
    expect(a.frame(410)).toMatchObject({ row: 8, col: 1 });
  });
  it('setting the same state again does not restart the animation', () => {
    const a = plain();
    a.setState('thinking'); a.frame(0);
    a.setState('thinking');
    expect(a.frame(200)).toMatchObject({ row: 7, col: 2 });
  });
  it('done plays the 5-frame jump once, then keeps waving (never settles into idle while done)', () => {
    const a = plain();
    a.setState('done');
    expect(a.frame(0)).toMatchObject({ row: 4, col: 0 });
    expect(a.frame(400)).toMatchObject({ row: 4, col: 4 });
    expect(a.frame(500)).toMatchObject({ row: 3, col: 0 });
    expect(a.frame(800)).toMatchObject({ row: 3, col: 3 });
    expect(a.frame(900)).toMatchObject({ row: 3, col: 0 });
    expect(a.frame(30_000).row).toBe(3);
  });
  it('done without a jump row in the atlas waves straight away', () => {
    const a = plain([6, 8, 8, 4]);
    a.setState('done');
    expect(a.frame(0)).toMatchObject({ row: 3, col: 0 });
    expect(a.frame(500)).toMatchObject({ row: 3, col: 1 });
  });
  it('a row missing from the atlas falls back to row 0', () => {
    const a = plain([6]);
    a.setState('error');
    expect(a.frame(0)).toMatchObject({ row: 0, col: 0 });
  });
});

describe('Animator pacing (defaults)', () => {
  it('every row loops in 1.1-2.3 s, i.e. much calmer than the old fixed 8 fps (125 ms/frame)', () => {
    expect(ROW_LOOP_MS).toHaveLength(ROW_FRAMES.length);
    ROW_LOOP_MS.forEach((ms, r) => {
      expect(ms).toBeGreaterThanOrEqual(1100);
      expect(ms).toBeLessThanOrEqual(2300);
      if (r !== 1 && r !== 2) expect(ms / ROW_FRAMES[r]).toBeGreaterThanOrEqual(200); // non-run rows: >=200 ms/frame
    });
  });
  it('idle steps one frame per loop/frames ms', () => {
    const a = new Animator();
    const step = ROW_LOOP_MS[0] / ROW_FRAMES[0];
    expect(a.frame(0)).toMatchObject({ row: 0, col: 0 });
    expect(a.frame(step - 1).col).toBe(0);
    expect(a.frame(step + 1).col).toBe(1);
  });
});

describe('Animator hold (anti-flicker)', () => {
  it('holds the current animation for minHoldMs before switching to a non-urgent state', () => {
    const a = new Animator({ minHoldMs: 900, frameMs: 100 });
    a.setState('thinking'); a.frame(0);
    expect(a.frame(900).row).toBe(7);          // idle held 900 ms, then thinking shows
    a.setState('reading');
    expect(a.frame(1200).row).toBe(7);         // only 300 ms into thinking: held
    a.setState('thinking');                    // flipped back: reading never shown
    expect(a.frame(1300).row).toBe(7);
    a.setState('reading');
    expect(a.frame(1700).row).toBe(7);         // 800 ms into thinking: still held
    expect(a.frame(1800).row).toBe(8);         // 900 ms since thinking began -> switches
  });
  it('urgent states (waiting, error) switch immediately', () => {
    const a = new Animator({ minHoldMs: 900, frameMs: 100 });
    a.setState('thinking'); a.frame(0); a.frame(900);
    a.setState('waiting');
    expect(a.frame(950).row).toBe(6);
    a.setState('error');
    expect(a.frame(960).row).toBe(5);
  });
});

describe('Animator drag (run while the window is dragged)', () => {
  it('runs right / left at once (no hold), cycling the run row', () => {
    const a = new Animator({ minHoldMs: 900, frameMs: 100 });
    a.setState('thinking'); a.frame(0); a.frame(900);
    a.setDrag('right');
    expect(a.frame(950)).toMatchObject({ row: 1, col: 0 });
    expect(a.frame(1050)).toMatchObject({ row: 1, col: 1 });
    a.setDrag('left');
    expect(a.frame(1060)).toMatchObject({ row: 2, col: 0 });
    expect(a.frame(1860)).toMatchObject({ row: 2, col: 0 }); // 8 frames wrap
  });
  it('same direction again does not restart the run', () => {
    const a = new Animator({ minHoldMs: 0, frameMs: 100 });
    a.setDrag('right'); a.frame(0);
    a.setDrag('right');
    expect(a.frame(300)).toMatchObject({ row: 1, col: 3 });
  });
  it('after release the current state shows again, from its first frame', () => {
    const a = new Animator({ minHoldMs: 900, frameMs: 100 });
    a.setState('thinking'); a.frame(0); a.frame(900);
    a.setDrag('left'); a.frame(1000);
    a.setState('reading');            // arrives during the drag
    a.setDrag(null);
    expect(a.frame(1500)).toMatchObject({ row: 8, col: 0 });
    expect(a.frame(1600)).toMatchObject({ row: 8, col: 1 });
  });
  it('an atlas without run rows stays on row 0 while dragging', () => {
    const a = new Animator({ minHoldMs: 0, frameMs: 100, rowFrames: [6] });
    a.setDrag('right');
    expect(a.frame(0).row).toBe(0);
  });
});

describe('msToNextFrame (the render loop sleeps until then)', () => {
  it('time left in the current frame', () => {
    const a = plain();
    a.setState('thinking');
    a.frame(0);
    expect(a.msToNextFrame(0)).toBe(100);
    expect(a.msToNextFrame(30)).toBe(70);
    // the frame really changes at that moment
    expect(a.frame(30 + a.msToNextFrame(30) - 1).col).toBe(0);
    expect(a.frame(30 + a.msToNextFrame(30)).col).toBe(1);
  });
  it('a wanted state waiting for the hold time wakes the loop when the hold ends', () => {
    const a = new Animator({ frameMs: 400, minHoldMs: 900 });
    a.setState('thinking'); a.frame(0);
    a.setState('reading');
    expect(a.msToNextFrame(100)).toBe(300); // next frame comes first
    a.frame(800);
    expect(a.msToNextFrame(850)).toBe(50); // the hold ends at 900, before the next frame (1200)
  });
  it('while dragged and in the done sequence it still answers', () => {
    const a = plain();
    a.setDrag('right'); a.frame(0);
    expect(a.msToNextFrame(40)).toBe(60);
    const b = plain(); b.setState('done'); b.frame(0);
    expect(b.msToNextFrame(10)).toBe(90);
  });
});


describe('Animator reactions', () => {
  it('sad shows the failure row, then the state comes back', () => {
    const a = plain();
    a.setState('thinking');
    a.frame(0);
    a.react('sad', 100);
    expect(a.frame(100).row).toBe(5);
    expect(a.frame(2000).row).toBe(5);
    expect(a.frame(2800).row).toBe(7);
  });
  it('happy jumps, then waves', () => {
    const a = plain();
    a.react('happy', 0);
    expect(a.frame(0).row).toBe(4);
    expect(a.frame(ROW_FRAMES[4] * 100 + 50).row).toBe(3);
    expect(a.msToNextFrame(10)).toBeGreaterThan(0);
  });
  it('a state that needs the user cuts the reaction short', () => {
    const a = plain();
    a.react('happy', 0);
    a.setState('waiting');
    expect(a.frame(50).row).toBe(6);
  });
});

describe('Animator layout packs', () => {
  const rows = [
    { id: 'idle', frames: 4, loopMs: 2400 }, { id: 'done', frames: 6, loopMs: 1800 }, { id: 'error', frames: 3, loopMs: 900 },
    { id: 'reading', frames: 2 }, { id: 'lifted', frames: 2, loopMs: 400 },
  ];
  const lay = (r = rows) => { const a = new Animator({ minHoldMs: 0 }); a.setLayout(r); return a; };
  it('maps state to row id with fallbacks, idle to row 0', () => {
    const a = lay();
    expect(a.smooth()).toBe(true);
    expect(new Animator().smooth()).toBe(false);
    for (const [s, row] of [['idle', 0], ['thinking', 0], ['writing', 0], ['sleeping', 0], ['testing', 3], ['reading', 3], ['waiting', 0], ['error', 2], ['done', 1]] as const) {
      const b = lay(); b.setState(s);
      expect(b.frame(0).row, s).toBe(row);
    }
    const c = lay([{ id: 'weird', frames: 2 }]); c.setState('error');
    expect(c.frame(0).row).toBe(0);
  });
  it('done loops only its own row', () => {
    const a = lay(); a.setState('done');
    expect(a.frame(0)).toMatchObject({ row: 1, col: 0 });
    expect(a.frame(300)).toMatchObject({ row: 1, col: 1 });
    expect(a.frame(1800)).toMatchObject({ row: 1, col: 0 });
  });
  it('reactions: sad -> error row, others -> done row', () => {
    const a = lay(); a.react('sad', 0);
    expect(a.frame(10).row).toBe(2);
    const b = lay(); b.react('happy' as any, 0);
    expect(b.frame(10).row).toBe(1);
    expect(b.msToNextFrame(10)).toBeGreaterThan(0);
  });
  it('drag shows the lifted row for both directions, else the run rows', () => {
    for (const d of ['left', 'right'] as const) { const a = lay(); a.setDrag(d); expect(a.frame(0).row).toBe(4); expect(a.frame(200)).toMatchObject({ col: 1 }); }
    const b = lay(rows.slice(0, 3)); b.setDrag('right');
    expect(b.frame(0).row).toBe(1);
  });
  it('pace is loopMs/frames (default 1800) and next/mix are filled', () => {
    const a = lay(); a.setState('reading'); a.frame(0);          // 2 frames, 1800 ms -> 900 per frame
    expect(a.frame(450)).toEqual({ row: 3, col: 0, next: 1, mix: 0.5 });
    expect(a.frame(1350)).toEqual({ row: 3, col: 1, next: 0, mix: 0.5 });
    expect(a.msToNextFrame(450)).toBe(450);
  });
  it('old packs get next/mix too', () => {
    const a = plain(); a.setState('thinking');
    a.frame(0);
    expect(a.frame(150)).toEqual({ row: 7, col: 1, next: 2, mix: 0.5 });
  });
});
