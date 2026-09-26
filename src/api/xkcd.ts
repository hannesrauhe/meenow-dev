// Second daily bonus card: the current xkcd comic. xkcd's API has no CORS
// headers, so our backend serves it same-origin from /xkcd.json, refreshing a
// server-side cache on the first request per TTL (server/src/xkcd.php).
//
// The response is still treated as untrusted input: every field is validated
// here — the image URL is allowlisted to https://imgs.xkcd.com, the comic link
// is constructed from the validated integer `num` (never read from the file),
// and text fields are length-capped and only ever rendered via textContent.

import { XKCD_URL } from '../config';

export interface XkcdBonus {
  num: number;
  title: string;
  img: string;
  alt: string;
}

const CACHE_KEY = 'meenow:xkcd-bonus';
const MAX_TEXT_LEN = 1000;

interface CachedXkcd {
  date: string;
  bonus: XkcdBonus | null;
}

function todayKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function comicUrl(bonus: XkcdBonus): string {
  return `https://xkcd.com/${bonus.num}/`;
}

// The untrusted-input boundary: rejects the whole payload unless every field
// is exactly what the mirror script produces.
function sanitize(data: unknown): XkcdBonus | null {
  if (typeof data !== 'object' || data === null) return null;
  const { num, title, img, alt } = data as Record<string, unknown>;
  if (!Number.isInteger(num) || (num as number) <= 0) return null;
  if (typeof img !== 'string') return null;
  try {
    const url = new URL(img);
    if (url.protocol !== 'https:' || url.hostname !== 'imgs.xkcd.com') return null;
  } catch {
    return null;
  }
  if (typeof title !== 'string' || typeof alt !== 'string') return null;
  return {
    num: num as number,
    title: title.slice(0, MAX_TEXT_LEN),
    img,
    alt: alt.slice(0, MAX_TEXT_LEN),
  };
}

export async function fetchXkcdBonus(): Promise<XkcdBonus | null> {
  const date = todayKey(new Date());
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as CachedXkcd | null;
    if (cached?.date === date) return sanitize(cached.bonus);
  } catch { /* ignore corrupt cache */ }

  let bonus: XkcdBonus | null = null;
  try {
    const res = await fetch(XKCD_URL);
    if (!res.ok) return null; // don't cache transient failures
    bonus = sanitize(await res.json());
  } catch {
    return null;
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date, bonus } satisfies CachedXkcd));
  } catch { /* storage full — just refetch next time */ }
  return bonus;
}
