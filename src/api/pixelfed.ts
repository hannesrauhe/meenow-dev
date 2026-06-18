import type { AuthState } from './auth';
import { patchAccountId } from './auth';
import { getLastTriggerTime } from '../timer';

// --- Mastodon/Pixelfed API types ---

interface MastodonAccount {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  url: string;
}

interface MastodonMediaAttachment {
  id: string;
  url: string;
  preview_url: string;
}

interface MastodonTag {
  name: string;
}

interface MastodonStatus {
  id: string;
  url: string;
  created_at: string;
  replies_count: number;
  account: MastodonAccount;
  media_attachments: MastodonMediaAttachment[];
  tags: MastodonTag[];
}

// --- Public types ---

export interface FeedPost {
  id: string;
  url: string;
  createdAt: Date;
  replyCount: number;
  account: {
    displayName: string;
    username: string;
    avatarUrl: string;
  };
  compositeUrl: string;
  allMediaUrls: string[];
}

export interface MastodonReply {
  id: string;
  created_at: string;
  account: {
    display_name: string;
    username: string;
    avatar: string;
  };
  content: string;
}

export interface PostContext {
  ancestors: MastodonReply[];
  descendants: MastodonReply[];
}

// --- Upload / post ---

async function uploadOne(auth: AuthState, blob: Blob, description: string): Promise<string> {
  const form = new FormData();
  form.append('file', blob, 'meenow.jpg');
  form.append('description', description);

  const res = await fetch(`https://${auth.instance}/api/v1/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Media upload failed (${res.status})`);
  const media = await res.json() as { id: string; url: string | null };

  if (media.url !== null) return media.id;

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(`https://${auth.instance}/api/v1/media/${media.id}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!poll.ok) throw new Error(`Media poll failed (${poll.status})`);
    const m = await poll.json() as { url: string | null };
    if (m.url !== null) return media.id;
  }
  throw new Error('Media processing timed out');
}

export async function postMeenow(
  auth: AuthState,
  composite: Blob,
  backPhoto: Blob,
  frontPhoto: Blob,
): Promise<string> {
  // Upload composite first so it gets the lowest attachment ID and appears first in the gallery
  const compositeId = await uploadOne(auth, composite, 'meenow — daily photo');
  const [backId, frontId] = await Promise.all([
    uploadOne(auth, backPhoto, 'meenow — surroundings'),
    uploadOne(auth, frontPhoto, 'meenow — selfie'),
  ]);

  const res = await fetch(`https://${auth.instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: '#meenowApp',
      media_ids: [compositeId, backId, frontId],
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new Error(`Post failed (${res.status})`);
  const statusData = await res.json() as MastodonStatus;
  // Prepend the new post so the feed shows it immediately without a re-fetch.
  // newestId advances so the next incremental fetch uses it as since_id.
  if (_homeCache) {
    _homeCache.statuses = [statusData, ..._homeCache.statuses];
    if (statusData.id > _homeCache.newestId) _homeCache.newestId = statusData.id;
  }
  return statusData.url;
}

// --- Feed ---

// Session-level home timeline cache. The first call does a full fetch; subsequent
// calls within HOME_CACHE_TTL_MS return the cached data directly. After the TTL,
// an incremental fetch with since_id is attempted; incoming posts are deduplicated
// by ID before merging because Pixelfed may return the full list regardless.
// _homePending deduplicates concurrent callers during the initial page-load sequence.
const HOME_TIMELINE_LIMIT = 40;
const HOME_CACHE_TTL_MS = 10_000;
interface HomeCache { statuses: MastodonStatus[]; newestId: string; fetchedAt: number }
let _homeCache: HomeCache | null = null;
let _homePending: Promise<MastodonStatus[]> | null = null;

function fetchHomeTimeline(auth: AuthState): Promise<MastodonStatus[]> {
  if (_homePending) return _homePending;
  if (_homeCache && Date.now() - _homeCache.fetchedAt < HOME_CACHE_TTL_MS) {
    return Promise.resolve(_homeCache.statuses);
  }

  const url = _homeCache?.newestId
    ? `https://${auth.instance}/api/v1/timelines/home?limit=${HOME_TIMELINE_LIMIT}&since_id=${_homeCache.newestId}`
    : `https://${auth.instance}/api/v1/timelines/home?limit=${HOME_TIMELINE_LIMIT}`;

  _homePending = fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } })
    .then(r => (r.ok ? (r.json() as Promise<MastodonStatus[]>) : Promise.resolve([])))
    .then(incoming => {
      const now = Date.now();
      if (_homeCache) {
        const seen = new Set(_homeCache.statuses.map(s => s.id));
        const fresh = incoming.filter(s => !seen.has(s.id));
        if (fresh.length > 0) {
          _homeCache.statuses = [...fresh, ..._homeCache.statuses];
          _homeCache.newestId = fresh[0].id;
        }
        _homeCache.fetchedAt = now;
      } else {
        _homeCache = { statuses: incoming, newestId: incoming[0]?.id ?? '', fetchedAt: now };
      }
      _homePending = null;
      return _homeCache.statuses;
    })
    .catch(err => { _homePending = null; throw err; });

  return _homePending;
}

async function resolveAccountId(auth: AuthState): Promise<string | undefined> {
  if (auth.accountId) return auth.accountId;
  try {
    const res = await fetch(`https://${auth.instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (res.ok) {
      const { id } = await res.json() as { id: string };
      patchAccountId(auth.instance, id);
      return id;
    }
  } catch { /* ignore */ }
  return undefined;
}

function hasMeenowTag(s: MastodonStatus): boolean {
  return s.tags.some(t => t.name.toLowerCase() === 'meenowapp');
}

function toFeedPost(s: MastodonStatus): FeedPost {
  return {
    id: s.id,
    url: s.url,
    createdAt: new Date(s.created_at),
    replyCount: s.replies_count,
    account: {
      displayName: s.account.display_name || s.account.username,
      username: s.account.username,
      avatarUrl: s.account.avatar,
    },
    compositeUrl: s.media_attachments[0]?.url ?? '',
    allMediaUrls: s.media_attachments.map(m => m.url),
  };
}

export async function fetchMeenowFeed(auth: AuthState): Promise<FeedPost[]> {
  const cutoff = getLastTriggerTime().getTime();
  const statuses = await fetchHomeTimeline(auth);
  return statuses
    .filter(s =>
      new Date(s.created_at).getTime() >= cutoff &&
      s.media_attachments.length > 0 &&
      hasMeenowTag(s)
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(toFeedPost);
}

export async function fetchTodayPostCount(auth: AuthState): Promise<number> {
  const accountId = await resolveAccountId(auth);
  if (!accountId) return 0;
  const periodStart = getLastTriggerTime().getTime();
  try {
    const statuses = await fetchHomeTimeline(auth);
    return statuses.filter(s =>
      s.account.id === accountId &&
      new Date(s.created_at).getTime() >= periodStart &&
      hasMeenowTag(s)
    ).length;
  } catch {
    return 0;
  }
}

export async function fetchPostContext(auth: AuthState, statusId: string): Promise<PostContext> {
  const res = await fetch(`https://${auth.instance}/api/v1/statuses/${statusId}/context`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`Context fetch failed (${res.status})`);
  const raw = await res.json() as { ancestors?: MastodonReply[]; descendants?: MastodonReply[] };
  return { ancestors: raw.ancestors ?? [], descendants: raw.descendants ?? [] };
}

export async function postReply(auth: AuthState, inReplyToId: string, content: string): Promise<void> {
  const res = await fetch(`https://${auth.instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: content,
      in_reply_to_id: inReplyToId,
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new Error(`Reply failed (${res.status})`);
}
