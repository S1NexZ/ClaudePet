import { toWslPath } from '../../daemon/src/paths.js';
import { L } from '../../shared/src/i18n.js';

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Arguments for `wsl.exe` that run the bridge (a Windows file path) with WSL's node, talking over stdio. */
export function wslBridgeArgs(bridgeWinPath: string, o: { distro?: string; port?: number; noUsage?: boolean } = {}): string[] {
  const script =
    'N="$HOME/.local/node/bin/node"; [ -x "$N" ] || N="$(command -v node)"; ' +
    `[ -n "$N" ] || { echo '{"type":"error","message":"${L('В WSL не найден Node.js', 'Node.js was not found in WSL', '在 WSL 中未找到 Node.js')}"}'; exit 1; }; ` +
    `${o.port ? `export CLAUDE_PET_HOOK_PORT=${Math.trunc(o.port)}; ` : ''}${o.noUsage ? 'export CLAUDE_PET_LIVE_USAGE=0; ' : ''}` +
    `exec "$N" ${sq(toWslPath(bridgeWinPath))}`;
  return [...(o.distro ? ['-d', o.distro] : []), '-e', 'bash', '-c', script];
}

/** Line splitter for the bridge's stdout stream. */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split('\n');
  const tail = parts.pop() ?? '';
  return { lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0), rest: tail };
}
