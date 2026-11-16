import { describe, it, expect } from 'vitest';
import { confirmOptions, isConfirmed } from './dialogs.js';

describe('confirm dialogs', () => {
  const o = confirmOptions({ type: 'warning', message: 'm', detail: 'd', action: 'Отправить', cancel: 'Отмена' });
  it('the safe button is first and default, so a stray Enter cancels', () => {
    expect(o.buttons).toEqual(['Отмена', 'Отправить']);
    expect(o.defaultId).toBe(0);
    expect(o.cancelId).toBe(0);
    expect(o.noLink).toBe(true); // command-link mode made Enter pick the action when defaultId === cancelId
  });
  it('only the second button confirms', () => {
    expect(isConfirmed({ response: 1 })).toBe(true);
    expect(isConfirmed({ response: 0 })).toBe(false);
  });
});
