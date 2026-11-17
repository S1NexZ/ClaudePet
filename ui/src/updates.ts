/**
 * Update check: one GET to GitHub's public "latest release" endpoint (no account, no user data, a generic User-Agent).
 * The pet only tells the user and opens the release page; it never downloads or installs anything by itself.
 */
export const RELEASES_API = 'https://api.github.com/repos/S1NexZ/ccPet/releases/latest';

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const parse = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
};

/** `candidate` is a later release than `current` (a pre-release counts as earlier than its final version). */
export function newerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i];
  return !a.pre && !!b.pre;
}

export async function checkLatest(current: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<{ version: string; url: string } | null> {
  try {
    const r = await fetchFn(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ccPet-update-check' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const tag = typeof j?.tag_name === 'string' ? j.tag_name : '';
    const url = typeof j?.html_url === 'string' ? j.html_url : '';
    if (j?.draft || j?.prerelease || !url.startsWith('https://github.com/S1NexZ/ccPet/')) return null;
    if (!newerVersion(tag, current)) return null;
    return { version: tag.replace(/^v/, ''), url };
  } catch { return null; }
}
