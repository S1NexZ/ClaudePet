/**
 * "Why don't I see my session?": a plain-text report of every connection check, for the user to read or paste into an issue.
 * It never contains the user name (paths are masked), hook tokens or e-mail addresses.
 */
export interface HostDiag {
  id: string; distro?: string; up: boolean;
  events: boolean; mailbox: boolean; permissions: boolean; statusLine?: string;
  lastEventAt: number | null; sessions: number; sources: string[]; error?: string;
}
export interface DiagData {
  version: string; os: string; now: number; user: string;
  hosts: HostDiag[];
  helper: boolean; wrapper: string | null; policy: string | null; desktopChats: number; newChatIn: string; sdkChats: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, names: string[]): string {
  let t = text
    .replace(/\/hook\/[0-9a-f]{16,}\//gi, '/hook/<token>/')
    .replace(/\/mailbox\/[0-9a-f]{16,}/gi, '/mailbox/<token>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  for (const n of names.filter((x) => x && x.length > 1)) {
    t = t.replace(new RegExp(`([\\\\/](?:Users|home)[\\\\/])${esc(n)}(?=[\\\\/]|$)`, 'gi'), '$1<user>');
  }
  return t;
}

/** Newest hook-driven activity per host id ('windows', 'wsl', 'wsl:<distro>'). */
export const hostIdOf = (s: { host?: string; hostId?: string }): string => s.hostId ?? (s.host === 'windows' ? 'windows' : 'wsl');

export function lastEventByHost(sessions: Array<{ host?: string; hostId?: string; lastEventAt: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) {
    const id = hostIdOf(s);
    out[id] = Math.max(out[id] ?? 0, s.lastEventAt);
  }
  return out;
}

export function ago(at: number | null, now: number): string | null {
  if (at == null) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

const yn = (b: boolean) => (b ? 'yes' : 'no');

export function formatDiagnostics(d: DiagData): string {
  const lines = [`ccPet ${d.version} · ${d.os}`, ''];
  lines.push('Connections:');
  for (const h of d.hosts) {
    const name = h.distro ? `${h.id} (${h.distro})` : h.id;
    if (!h.up) { lines.push(`- ${name}: DOWN${h.error ? ` (${h.error})` : ''}`); continue; }
    const last = ago(h.lastEventAt, d.now);
    lines.push(`- ${name}: up, events ${yn(h.events)}, messages ${yn(h.mailbox)}, permissions ${yn(h.permissions)}${h.statusLine ? `, status line ${h.statusLine}` : ''}, ${last ? `last event ${last} ago` : 'no events yet'}, sessions ${h.sessions}${h.sources.length ? ` (${h.sources.join(', ')})` : ''}${h.error ? `, error: ${h.error}` : ''}`);
  }
  lines.push('', 'Windows:');
  lines.push(`- pet-helper.exe: ${d.helper ? 'found' : 'MISSING (no messages, Stop or typing for Windows sessions)'}`);
  lines.push(`- PowerShell wrapper: ${d.wrapper ?? 'n/a'}${d.policy ? `, execution policy ${d.policy}` : ''}`);
  lines.push(`- desktop app chats found: ${d.desktopChats}`);
  lines.push(`- new chats start in: ${d.newChatIn}; Agent SDK: ${d.sdkChats ? 'on' : 'off'}`);
  lines.push('', 'Hints:');
  const hints: string[] = [];
  for (const h of d.hosts) {
    if (!h.up) hints.push(`${h.id}: the pet cannot reach it (WSL not running, or the port is busy).`);
    else if (!h.events) hints.push(`${h.id}: hooks are not connected — Settings → Connections → Connect, then restart open Claude Code terminals.`);
    else if (h.lastEventAt == null) hints.push(`${h.id}: hooks are connected but no session has reported yet — start or restart a Claude Code session there.`);
  }
  if (!hints.length) hints.push('Everything looks connected. A session started before the hooks were connected shows up after its next message.');
  lines.push(...hints.map((x) => `- ${x}`));
  return redact(lines.join('\n'), [d.user]);
}
