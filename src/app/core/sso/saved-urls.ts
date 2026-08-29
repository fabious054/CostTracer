/**
 * Locally-remembered IAM Identity Center Start URLs, so they don't have to be retyped every
 * connection. Purely local (`localStorage`, same as `ct.locale` / `ct.scan.collapsed.*`) — a
 * Start URL is a public org portal address, never a secret, and nothing here touches AWS.
 *
 * Entries can be pinned: a pinned URL sorts above the rest and is never dropped to stay under
 * the cap, so a rarely-used-but-important org portal survives a burst of one-off connections.
 */

export interface SavedSsoUrl {
  url: string;
  /** The region entered alongside this URL last time — picking the URL refills it. */
  region: string;
  lastUsedAt: number;
  /** Kept regardless of recency, sorted first. Set via the star toggle on the SSO screen. */
  pinned?: boolean;
}

const KEY = 'ct.sso.startUrls';
/** How many unpinned entries to keep. Pinned ones are always kept, on top of this. */
const MAX_UNPINNED = 8;

export function listSavedSsoUrls(): SavedSsoUrl[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is SavedSsoUrl => !!e && typeof e.url === 'string' && e.url.length > 0)
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      });
  } catch {
    return [];
  }
}

function persist(entries: SavedSsoUrl[]): void {
  const pinned = entries.filter((e) => e.pinned);
  const unpinned = entries.filter((e) => !e.pinned).slice(0, MAX_UNPINNED);
  try {
    localStorage.setItem(KEY, JSON.stringify([...pinned, ...unpinned]));
  } catch {
    /* storage blocked — nothing is remembered this time */
  }
}

export function rememberSsoUrl(url: string, region: string): void {
  const u = url.trim();
  if (!u) return;
  const current = listSavedSsoUrls();
  const previous = current.find((e) => e.url === u);
  const rest = current.filter((e) => e.url !== u);
  persist([
    { url: u, region: region.trim(), lastUsedAt: Date.now(), pinned: previous?.pinned },
    ...rest,
  ]);
}

export function togglePinSsoUrl(url: string): void {
  persist(
    listSavedSsoUrls().map((e) => (e.url === url ? { ...e, pinned: !e.pinned } : e)),
  );
}

export function forgetSsoUrl(url: string): void {
  persist(listSavedSsoUrls().filter((e) => e.url !== url));
}
