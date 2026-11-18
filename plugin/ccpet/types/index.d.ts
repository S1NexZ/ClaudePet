/** Plan limits as the band shows them: percent used and the reset time (Unix ms), per window. */
export type CcpetWindow = { pct: number; resetsAt: number }
export type CcpetLimits = { five: CcpetWindow | null; seven: CcpetWindow | null; etaMs: number | null }

declare module 'claude-code' {
  interface PluginState {
    ccpet: { limits: CcpetLimits | null; bandHidden: boolean; spinnerPet: boolean; linked: boolean }
  }
}
