import { describe, it, expect } from 'vitest';
import { placeWindow, placeStage, restoreAnchor } from './placement.js';

const wa = { x: 0, y: 0, width: 1600, height: 900 };

describe('placeWindow', () => {
  it('keeps the bottom-centre anchor (where the pet stands)', () => {
    expect(placeWindow({ cx: 800, bottom: 700 }, 240, 260, wa)).toEqual({ x: 680, y: 440, width: 240, height: 260 });
  });
  it('growing near the top edge pushes the window down into the work area', () => {
    expect(placeWindow({ cx: 800, bottom: 300 }, 420, 640, wa)).toMatchObject({ y: 0, height: 640 });
  });
  it('near the left / right edges it is shifted inside', () => {
    expect(placeWindow({ cx: 50, bottom: 700 }, 420, 640, wa).x).toBe(0);
    expect(placeWindow({ cx: 1590, bottom: 700 }, 420, 640, wa).x).toBe(1180);
  });
  it('rounds to whole pixels', () => {
    expect(placeWindow({ cx: 800.6, bottom: 700.4 }, 241, 260, wa)).toEqual({ x: 680, y: 440, width: 241, height: 260 });
  });
});

describe('restoreAnchor', () => {
  it('reads the saved anchor; old {x,bottom} files are converted with the old width', () => {
    expect(restoreAnchor('{"cx":500,"bottom":600}')).toEqual({ cx: 500, bottom: 600 });
    expect(restoreAnchor('{"x":1246,"bottom":586}')).toEqual({ cx: 1246 + 212, bottom: 586 });
  });
  it('garbage gives null', () => {
    expect(restoreAnchor('{nope')).toBeNull();
    expect(restoreAnchor('{"cx":"a","bottom":1}')).toBeNull();
  });
});

describe('placeStage', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  it('puts the anchor (IDLE_H below the window top) on the anchor point and lets the lower part stick out of the screen', () => {
    expect(placeStage({ cx: 800, bottom: 700 }, 424, 780, wa)).toEqual({ x: 588, y: 462, width: 424, height: 780 });
  });
  it('keeps the pet on screen: the anchor is pulled inside the work area', () => {
    expect(placeStage({ cx: 5, bottom: 2000 }, 424, 780, wa)).toEqual({ x: -152, y: 802, width: 424, height: 780 });
  });
});
