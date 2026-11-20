/** User-chosen colors: `primary` tints the pet itself, `accent` is the interface accent (null = the built-in look). */
export interface Appearance { primary: string | null; accent: string | null }
export const DEFAULT_APPEARANCE: Appearance = { primary: null, accent: null };
export const DEFAULT_ACCENT = '#e8794a';
/** text on top of the accent (send button, "Allow"): the built-in dark ember ink */
const DEFAULT_INK = '#2a1307';

export const ACCENT_PRESETS = ['#e8794a', '#39c5bb', '#4f8cff', '#9b6bff', '#ff6b9d', '#7bd88f'] as const;
export const PRIMARY_PRESETS = ['#d97757', '#4f8cff', '#9b6bff', '#ff6b9d', '#7bd88f', '#e6c84a'] as const;

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (c: unknown): c is string => typeof c === 'string' && HEX.test(c);
/** "#ABC" is not accepted; anything that is not #rrggbb becomes null (= default). */
export const cleanColor = (c: unknown): string | null => (isHex(c) ? c.toLowerCase() : null);
export const cleanAppearance = (a: unknown): Appearance => {
  const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  return { primary: cleanColor(o.primary), accent: cleanColor(o.accent) };
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Hue in degrees [0, 360) and saturation/lightness in [0, 1]. */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export const hueOf = (hex: string): number => rgbToHsl(...hexToRgb(hex)).h;

/**
 * The hue of the pet's own body: the most common hue among clearly colored, opaque pixels (a 36-bin histogram weighted by
 * saturation). Gray pixels have no hue and are ignored. null for a sheet without any color.
 */
export function dominantHue(data: ArrayLike<number>): number | null {
  const bins = new Array<number>(36).fill(0);
  let any = false;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.25 || l < 0.12 || l > 0.92) continue;
    bins[Math.floor(h / 10) % 36] += s;
    any = true;
  }
  if (!any) return null;
  return bins.indexOf(Math.max(...bins)) * 10 + 5;
}

/** Degrees for CSS `hue-rotate()` that turn a sprite whose body hue is `baseHue` into `target` (in (-180, 180]). */
export function hueShift(target: string | null, baseHue: number | null): number {
  if (!target || baseHue === null) return 0;
  let d = (hueOf(target) - baseHue) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.round(d);
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** CSS custom properties for the interface: the accent and a readable ink for text drawn on it. */
export function accentVars(accent: string | null): { accent: string; ink: string } {
  if (!accent) return { accent: DEFAULT_ACCENT, ink: DEFAULT_INK };
  // contrast ratio against dark ink (luminance ~0.008) vs white: the higher one wins (mid tones such as orange read better dark)
  const y = luminance(hexToRgb(accent));
  return { accent, ink: (y + 0.05) / 0.058 >= 1.05 / (y + 0.05) ? '#10151a' : '#ffffff' };
}

export const spriteFilter = (a: Appearance, baseHue: number | null): string => {
  const d = hueShift(a.primary, baseHue);
  return d ? `hue-rotate(${d}deg)` : 'none';
};
