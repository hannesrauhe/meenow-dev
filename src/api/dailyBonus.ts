// Daily bonus card content: Wikimedia's featured feed (Picture of the Day +
// "Did you know" facts). Free-licensed content, CORS-enabled, no auth needed.
// Best-effort like the Nominatim lookup in capture.ts — failures yield null
// and the feed simply renders without the card.

export interface DailyBonus {
  imageUrl: string;
  imageTitle: string;
  imageLink: string;
  imageCredit: string;
  dykText: string;
  dykLink: string;
}

const CACHE_KEY = 'meenow:daily-bonus';

interface CachedBonus {
  date: string;
  bonus: DailyBonus | null;
}

function todayKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

// Resolve the first link of a Parsoid HTML fragment against en.wikipedia.org
// (dyk hrefs are relative like "./Article" or protocol-relative).
function firstLink(html: string): string {
  const match = /href="([^"]+)"/.exec(html);
  if (!match) return '';
  const href = match[1];
  if (href.startsWith('./')) return `https://en.wikipedia.org/wiki/${href.slice(2)}`;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://en.wikipedia.org${href}`;
  return href;
}

export async function fetchDailyBonus(): Promise<DailyBonus | null> {
  const now = new Date();
  const date = todayKey(now);
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as CachedBonus | null;
    if (cached?.date === date) return cached.bonus;
  } catch { /* ignore corrupt cache */ }

  let bonus: DailyBonus | null = null;
  try {
    const path = date.replace(/-/g, '/');
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/featured/${path}`);
    if (!res.ok) return null; // don't cache transient failures
    const data = await res.json();

    const image = data.image;
    const dykList: Array<{ html?: string; text?: string }> = Array.isArray(data.dyk) ? data.dyk : [];
    // Deterministic per-day pick so remounts show the same fact.
    const dyk = dykList.length > 0 ? dykList[now.getDate() % dykList.length] : undefined;

    const imageUrl = image?.thumbnail?.source ?? '';
    // dyk texts arrive as "... that <fact>?" — drop the ellipsis so the card
    // reads "Did you know that <fact>?".
    const dykText = (dyk?.text ?? '').replace(/^[.…\s]+/, '').trim();
    if (imageUrl || dykText) {
      bonus = {
        imageUrl,
        imageTitle: (image?.title ?? '').replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' '),
        imageLink: image?.file_page ?? '',
        imageCredit: image?.artist?.text ?? '',
        dykText,
        dykLink: dyk?.html ? firstLink(dyk.html) : '',
      };
    }
  } catch {
    return null;
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date, bonus } satisfies CachedBonus));
  } catch { /* storage full — just refetch next time */ }
  return bonus;
}
