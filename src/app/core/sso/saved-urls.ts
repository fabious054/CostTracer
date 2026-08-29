/**
 * Locally-remembered IAM Identity Center Start URLs, so they don't have to be retyped every
 * connection. Purely local (`localStorage`, same as `ct.locale` / `ct.scan.collapsed.*`) — a
 * Start URL is a public org portal address, never a secret, and nothing here touches AWS.
 */

export interface SavedSsoUrl {
  url: string;
  /** The region entered alongside this URL last time — picking the URL refills it. */
  region: string;
  lastUsedAt: number;
}

const KEY = 'ct.sso.startUrls';
const MAX = 8;

export function listSavedSsoUrls(): SavedSsoUrl[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is SavedSsoUrl => !!e && typeof e.url === 'string' && e.url.length > 0)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  } catch {
    return [];
  }
}

export function rememberSsoUrl(url: string, region: string): void {
  const u = url.trim();
  if (!u) return;
  try {
    const kept = listSavedSsoUrls().filter((e) => e.url !== u);
    kept.unshift({ url: u, region: region.trim(), lastUsedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(kept.slice(0, MAX)));
  } catch {
    /* storage blocked — the URL just isn't remembered this time */
  }
}

export function forgetSsoUrl(url: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(listSavedSsoUrls().filter((e) => e.url !== url)),
    );
  } catch {
    /* ignore */
  }
}
