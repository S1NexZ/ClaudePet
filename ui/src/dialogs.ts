/**
 * Confirmation dialogs: the SAFE button is first and the default, the action is second.
 * A stray Enter (the user is typing when the dialog pops up) must cancel. Measured on the installed app (Windows 11):
 * with command-link buttons and defaultId === cancelId Enter picked the OTHER button (the action); with `noLink: true`
 * (plain buttons) Enter picks defaultId, here the safe one. Keep noLink.
 */
export interface Confirm { type: 'warning' | 'question'; message: string; detail: string; action: string; cancel: string }

export function confirmOptions(c: Confirm) {
  return { type: c.type, title: 'Claude Pet', message: c.message, detail: c.detail,
    buttons: [c.cancel, c.action], defaultId: 0, cancelId: 0, noLink: true };
}

/** true only when the action button (index 1) was chosen */
export const isConfirmed = (r: { response: number }): boolean => r.response === 1;
