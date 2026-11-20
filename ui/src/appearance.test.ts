import { describe, it, expect } from 'vitest';
import { cleanColor, cleanAppearance, hueOf, hueShift, dominantHue, accentVars, spriteFilter, rgbToHsl, DEFAULT_ACCENT, DEFAULT_APPEARANCE } from './appearance.js';

describe('colors', () => {
  it('only #rrggbb is accepted; everything else means "default"', () => {
    expect(cleanColor('#39C5BB')).toBe('#39c5bb');
    for (const bad of ['#fff', 'red', '39c5bb', '#12345g', '#1234567', '', null, undefined, 5, '#ff0000; background:url(x)']) expect(cleanColor(bad)).toBeNull();
    expect(cleanAppearance({ primary: '#FF0000', accent: 'nope', extra: 1 })).toEqual({ primary: '#ff0000', accent: null });
    expect(cleanAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(cleanAppearance('x')).toEqual(DEFAULT_APPEARANCE);
  });
  it('hue of the primary colors', () => {
    expect(hueOf('#ff0000')).toBe(0);
    expect(hueOf('#00ff00')).toBe(120);
    expect(hueOf('#0000ff')).toBe(240);
    expect(Math.round(hueOf('#d97757'))).toBe(15);
    expect(rgbToHsl(128, 128, 128)).toEqual({ h: 0, s: 0, l: 128 / 255 });
  });
});

describe('pet tint', () => {
  it('hue shift is the shortest way round; no color or unknown base means no change', () => {
    expect(hueShift('#00ff00', 0)).toBe(120);
    expect(hueShift('#ff0000', 350)).toBe(10);
    expect(hueShift('#0000ff', 20)).toBe(-140);
    expect(hueShift(null, 10)).toBe(0);
    expect(hueShift('#00ff00', null)).toBe(0);
    expect(spriteFilter({ primary: null, accent: null }, 15)).toBe('none');
    expect(spriteFilter({ primary: '#0000ff', accent: null }, 240)).toBe('none');
    expect(spriteFilter({ primary: '#00ff00', accent: null }, 0)).toBe('hue-rotate(120deg)');
  });
  const px = (...p: number[][]) => Uint8ClampedArray.from(p.flat());
  it('dominant hue ignores transparent, gray, near-black and near-white pixels', () => {
    const orange = [217, 119, 87, 255];
    const data = px(orange, orange, orange, [0, 0, 255, 255], [200, 200, 200, 255], [10, 10, 10, 255], [255, 255, 255, 255], [0, 255, 0, 40]);
    expect(dominantHue(data)).toBe(15);
    expect(dominantHue(px([128, 128, 128, 255], [0, 0, 0, 0]))).toBeNull();
    expect(dominantHue(new Uint8ClampedArray(0))).toBeNull();
  });
});

describe('accent', () => {
  it('default accent keeps the built-in look; a light accent gets dark ink, a dark one light ink', () => {
    expect(accentVars(null)).toEqual({ accent: DEFAULT_ACCENT, ink: '#2a1307' });
    expect(accentVars('#e8794a').ink).toBe('#10151a'); // a mid-tone orange reads better with dark ink than with white
    expect(accentVars('#ffe066').ink).toBe('#10151a');
    expect(accentVars('#1b2a6b').ink).toBe('#ffffff');
    expect(accentVars('#4f8cff').accent).toBe('#4f8cff');
  });
});
