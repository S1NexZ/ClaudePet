import { describe, it, expect, vi } from 'vitest';
import { createMailbox } from './mailbox.js';

describe('mailbox', () => {
  it('delivers to an armed waiter', async () => {
    const m = createMailbox();
    const w = m.wait('s1', 1000);
    expect(m.hasWaiter('s1')).toBe(true);
    expect(m.send('s1', 'hello')).toBe('delivered');
    expect(await w).toBe('hello');
    expect(m.hasWaiter('s1')).toBe(false);
  });
  it('queues a message sent while nobody waits and hands it to the next waiter (not lost)', async () => {
    const m = createMailbox();
    expect(m.send('s1', 'one')).toBe('queued');
    expect(m.send('s1', 'two')).toBe('queued');
    expect(m.pending('s1')).toBe(2);
    expect(await m.wait('s1', 1000)).toBe('one\n\ntwo');
    expect(m.pending('s1')).toBe(0);
  });
  it('drops queued messages older than the ttl', async () => {
    let t = 0;
    const m = createMailbox({ ttlMs: 1000, now: () => t });
    m.send('s1', 'old');
    t = 2000;
    vi.useFakeTimers();
    const w = m.wait('s1', 50);
    vi.advanceTimersByTime(60);
    expect(await w).toBeNull();
    vi.useRealTimers();
  });
  it('a second waiter for the same session is told it is busy; sessions are independent', async () => {
    const m = createMailbox();
    const w = m.wait('s1', 1000);
    expect(await m.wait('s1', 1000)).toBe('busy');
    expect(m.send('s2', 'x')).toBe('queued');
    m.send('s1', 'go');
    expect(await w).toBe('go');
  });
  it('a waiter that times out leaves the slot free', async () => {
    vi.useFakeTimers();
    const m = createMailbox();
    const w = m.wait('s1', 100);
    vi.advanceTimersByTime(150);
    expect(await w).toBeNull();
    expect(m.hasWaiter('s1')).toBe(false);
    vi.useRealTimers();
  });
});
