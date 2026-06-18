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
  account: MastodonAccount;
  media_attachments: MastodonMediaAttachment[];
  tags: MastodonTag[];
}

// --- Public types ---

export interface FeedPost {
  id: string;
  url: string;
  createdAt: Date;
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
  const status = await res.json() as { url: string };
  // Invalidate so the feed picks up the new post on next render
  _homeCache = null;
  return status.url;
}

// --- Feed ---

// Short-lived cache for the home timeline. fetchTodayPostCount (called from init())
// and fetchMeenowFeed (called when the feed renders) both need this data; the cache
// lets them share one network request per page load.
let _homeCache: { ts: number; data: Promise<MastodonStatus[]> } | null = null;

function fetchHomeTimeline(auth: AuthState): Promise<MastodonStatus[]> {
  if (_homeCache && Date.now() - _homeCache.ts < 30_000) return _homeCache.data;
  const p = fetch(`https://${auth.instance}/api/v1/timelines/home?limit=40`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  }).then(r => (r.ok ? (r.json() as Promise<MastodonStatus[]>) : Promise.resolve([])));
  _homeCache = { ts: Date.now(), data: p };
  return p;
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
