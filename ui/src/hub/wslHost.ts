import { spawn, type ChildProcess } from 'node:child_process';
import { wslBridgeArgs, splitLines } from '../bridgeLaunch.js';

export interface WslHostOptions {
  /** 'wsl' for the default distro (the primary host), 'wsl:<distro>' for the others */
  id: string;
  /** '' = the default distro */
  distro: string;
  /** TCP port of this bridge's hook receiver (distros share one network namespace, so every bridge needs its own) */
  port: number;
  bridgePath: string;
  /** Linux / macOS: the bridge runs on this machine, inside the app's own runtime (no wsl.exe) */
  native?: boolean;
  /** a secondary host only follows sessions: no usage polling */
  secondary: boolean;
  log(line: string): void;
  onSnapshot(snap: any | null): void;
  onMessage(m: any): void;
  onUp(up: boolean): void;
  onReady(host: WslHost, info: { claude: string; distro: string }): void;
  /** a `hooks` status message nobody asked for (the probe sent when the bridge starts) */
  onHooks(host: WslHost, m: any): void;
}

export interface WslHost {
  readonly id: string;
  readonly distro: string;
  readonly port: number;
  readonly secondary: boolean;
  isUp(): boolean;
  claude(): string;
  /** the distro's real name once the bridge said hello (the default distro starts with '') */
  name(): string;
  start(): void;
  stop(): void;
  send(cmd: object): void;
  /** send a command and wait for its answer message of `replyType` (default `hooks`); null: no answer in time / bridge down */
  request(cmd: object, replyType?: 'hooks' | 'statusline'): Promise<any>;
  /** give the session's terminal tab a recognisable title (false: no live terminal) */
  markTerminal(sessionId: string, text: string): Promise<boolean>;
}

/** One bridge process inside a WSL distro, JSON lines over stdio. Restarts itself with a growing back-off. */
export function createWslHost(o: WslHostOptions): WslHost {
  let child: ChildProcess | null = null;
  let rest = '', up = false, stopped = false, backoff = 1000, claude = '', name = o.distro;
  // answers come back in the order the commands went out (the bridge handles these synchronously): one FIFO queue per answer type.
  // A timed-out request keeps its place, so its late answer is dropped instead of being handed to the next caller.
  const replyWaiters = new Map<string, Array<(m: any) => void>>();
  const takeWaiter = (type: string) => { const q = replyWaiters.get(type); const w = q?.shift(); if (q && !q.length) replyWaiters.delete(type); return w; };
  const markWaiters = new Map<string, (ok: boolean) => void>();

  const send = (cmd: object) => { if (child?.stdin?.writable) child.stdin.write(JSON.stringify(cmd) + '\n'); };
  const setUp = (v: boolean) => { up = v; if (!v) { o.onSnapshot(null); for (const q of replyWaiters.values()) for (const w of q) w(null); replyWaiters.clear(); } o.onUp(v); };

  const host: WslHost = {
    id: o.id, distro: o.distro, port: o.port, secondary: o.secondary,
    isUp: () => up, claude: () => claude, name: () => name,
    start() { stopped = false; spawnBridge(); },
    stop() { stopped = true; child?.stdin?.end(); const c = child; setTimeout(() => c?.kill(), 500); },
    send,
    request: (cmd, replyType = 'hooks') => new Promise((resolve) => {
      if (!up) { resolve(null); return; }
      let settled = false;
      const t = setTimeout(() => { settled = true; resolve(null); }, 4000);
      const q = replyWaiters.get(replyType) ?? [];
      q.push((m) => { if (settled) return; settled = true; clearTimeout(t); resolve(m); });
      replyWaiters.set(replyType, q);
      send(cmd);
    }),
    markTerminal: (sessionId, text) => new Promise((resolve) => {
      if (!up) { resolve(false); return; }
      const t = setTimeout(() => { markWaiters.delete(sessionId); resolve(false); }, 3000);
      markWaiters.set(sessionId, (ok) => { clearTimeout(t); resolve(ok); });
      send({ type: 'term-mark', sessionId, text });
    }),
  };

  const onLine = (line: string) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'ready') {
      backoff = 1000; claude = String(m.claude ?? ''); name = String(m.distro ?? o.distro);
      setUp(true); o.log(`bridge ${o.id} ready (claude=${m.claude}, distro=${m.distro})`);
      o.onReady(host, { claude, distro: name });
      return;
    }
    if (m.type === 'termMark') { const w = markWaiters.get(String(m.sessionId)); if (w) { markWaiters.delete(String(m.sessionId)); w(!!m.ok); } return; }
    if (m.type === 'statusline') { takeWaiter('statusline')?.(m); return; }
    if (m.type === 'hooks') { const w = takeWaiter('hooks'); if (w) { w(m); return; } o.onHooks(host, m); return; }
    if (m.type === 'snapshot') { o.onSnapshot(m); return; }
    o.onMessage(m);
  };

  const spawnBridge = () => {
    rest = '';
    if (o.native) { const n = nativeBridgeSpawn(o.bridgePath); child = spawn(n.file, n.args, { env: n.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    else child = spawn('wsl.exe', wslBridgeArgs(o.bridgePath, { distro: o.distro || undefined, port: o.secondary ? o.port : undefined, noUsage: o.secondary }), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', (e) => o.log(`bridge ${o.id} stdin: ${e.message}`)); // EPIPE if it just died; the exit handler restarts it
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { const r = splitLines(rest, chunk); rest = r.rest; r.lines.forEach(onLine); });
    child.stderr!.on('data', (d) => o.log(`bridge ${o.id} stderr: ${String(d).trim().slice(0, 500)}`));
    child.on('error', (e) => o.log(`bridge ${o.id} spawn error: ${e.message}`));
    child.on('exit', (code) => {
      o.log(`bridge ${o.id} exited (${code})`);
      setUp(false);
      // a secondary distro that cannot run the bridge (no Node.js, shut down) is retried slowly and quietly
      if (!stopped) { setTimeout(spawnBridge, backoff); backoff = Math.min(backoff * 2, o.secondary ? 60_000 : 10_000); }
    });
  };
  return host;
}

/** Parses `wsl.exe -l -v` (already decoded) into distros; the default one is marked with `*`. */
export function parseDistroList(text: string): Array<{ name: string; running: boolean; isDefault: boolean; version: number }> {
  const out: Array<{ name: string; running: boolean; isDefault: boolean; version: number }> = [];
  for (const raw of text.replace(/\0/g, '').split(/\r?\n/).slice(1)) {
    const m = raw.match(/^\s*(\*)?\s*(\S.*?)\s{2,}(\S+)\s+(\d)\s*$/);
    if (m) out.push({ name: m[2], running: /^running$/i.test(m[3]), isDefault: !!m[1], version: Number(m[4]) });
  }
  return out;
}

/** A stable port per distro name in a range that stays clear of the fixed ones; `taken` ports are skipped. */
export function portForDistro(name: string, taken: Set<number>): number {
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  let p = 47900 + (h % 100);
  while (taken.has(p)) p = p >= 47999 ? 47900 : p + 1;
  return p;
}

/** Distros worth following besides the default: running WSL 2 ones (we never start a stopped distro), not Docker's internal ones. */
export function secondaryDistros(list: ReturnType<typeof parseDistroList>): string[] {
  return list.filter((d) => d.running && !d.isDefault && d.version === 2 && !/^docker-desktop/i.test(d.name)).map((d) => d.name);
}

/** How the bridge starts on Linux / macOS: the app's own executable acting as Node (Electron's ELECTRON_RUN_AS_NODE), talking JSON lines over stdio. */
export function nativeBridgeSpawn(bridgePath: string, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { file: execPath, args: [bridgePath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}
