import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HookPayload } from './hookSocket.js';
import type { Mailbox } from './mailbox.js';

export interface HookServerOpts {
  /** 0 picks a free port (tests) */
  port: number;
  /** random per install; part of every URL path, so another local program cannot feed the pet */
  token: string;
  onEvent(e: HookPayload): void;
  mailbox: Mailbox;
  /** answers a PermissionRequest hook; null = no opinion (Claude Code then shows its normal dialog). Absent = never answer. */
  onPermission?(e: HookPayload): Promise<'allow' | 'deny' | null>;
  /** how long one mailbox long-poll may last (the hook re-polls) */
  waitMs?: number;
}

const MAX_BODY = 1_000_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * HTTP receiver for Claude Code `http` hooks (and the mailbox long-poll of the `asyncRewake` waiter), loopback only.
 *   POST /hook/<token>/<Event>      body: the hook's JSON            -> 200 (PermissionRequest: the decision JSON, or empty)
 *   GET  /mailbox/<token>/<session> long-poll                        -> 200 text (a message) | 204 (none yet) | 409 (already waiting)
 */
export async function startHookServer(o: HookServerOpts): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [, kind, token, rest] = url.pathname.split('/');
    if (token !== o.token || (kind !== 'hook' && kind !== 'mailbox') || !rest) { res.writeHead(404).end(); return; }

    if (kind === 'mailbox' && req.method === 'GET') {
      const sid = decodeURIComponent(rest);
      if (!SAFE_ID.test(sid)) { res.writeHead(400).end(); return; }
      if (o.mailbox.hasWaiter(sid)) { res.writeHead(409).end(); return; }
      let done = false;
      res.on('close', () => { if (!done) o.mailbox.cancel(sid); });
      void o.mailbox.wait(sid, o.waitMs ?? 50_000).then((m) => {
        done = true;
        if (m === 'busy') res.writeHead(409).end();
        else if (m === null) res.writeHead(204).end();
        else res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(m);
      });
      return;
    }

    if (kind === 'hook' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => { body += d; if (body.length > MAX_BODY) { body = ''; req.destroy(); } });
      req.on('error', () => { /* client vanished */ });
      req.on('end', () => {
        let e: any;
        try { e = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!e || typeof e.session_id !== 'string') { res.writeHead(400).end(); return; }
        const ev: HookPayload = { ...e, hook_event_name: typeof e.hook_event_name === 'string' ? e.hook_event_name : decodeURIComponent(rest), cwd: typeof e.cwd === 'string' ? e.cwd : '' };
        if (ev.hook_event_name === 'PermissionRequest') {
          const answer = o.onPermission ? o.onPermission(ev).catch(() => null) : Promise.resolve(null);
          void answer.then((d) => {
            if (!d) { res.writeHead(200).end(); return; }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: d } } }));
          });
          return;
        }
        try { o.onEvent(ev); } catch { /* never fail Claude Code because of the pet */ }
        res.writeHead(200).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port, '127.0.0.1', resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
