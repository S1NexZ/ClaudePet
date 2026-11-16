/** Size of the pet relative to its default (1 = 115x125 px). Kept in a sane range, in steps of 0.05. */
export const PET_SCALE_MIN = 0.6, PET_SCALE_MAX = 1.8, PET_SCALE_DEFAULT = 1;
export function clampScale(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : PET_SCALE_DEFAULT;
  return Math.round(Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, v)) * 20) / 20;
}
