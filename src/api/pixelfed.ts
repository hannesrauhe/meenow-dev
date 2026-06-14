import type { AuthState } from './auth';
import { patchAccountId } from './auth';

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
  return status.url;
}

// --- Feed ---

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
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  // Backfill accountId for users who logged in before it was stored
  let accountId = auth.accountId;
  if (!accountId) {
    try {
      const meRes = await fetch(`https://${auth.instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (meRes.ok) {
        const { id } = await meRes.json() as { id: string };
        accountId = id;
        patchAccountId(auth.instance, id);
      }
    } catch { /* proceed with home timeline only */ }
  }

  const [homeRes, ownRes] = await Promise.all([
    fetch(`https://${auth.instance}/api/v1/timelines/home?limit=40`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    }),
    accountId
      ? fetch(`https://${auth.instance}/api/v1/accounts/${accountId}/statuses?limit=20&exclude_replies=true`, {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        })
      : Promise.resolve(new Response('[]', { status: 200 })),
  ]);

  const home: MastodonStatus[] = homeRes.ok ? await homeRes.json() as MastodonStatus[] : [];
  const own: MastodonStatus[] = ownRes.ok ? await ownRes.json() as MastodonStatus[] : [];

  const seen = new Set<string>();
  return [...home, ...own]
    .filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return (
        new Date(s.created_at).getTime() > cutoff &&
        s.media_attachments.length > 0 &&
        s.tags.some(t => t.name.toLowerCase() === 'meenowapp')
      );
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(toFeedPost);
}

export async function fetchTodayPostCount(auth: AuthState): Promise<number> {
  if (!auth.accountId) return 0;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  try {
    const res = await fetch(
      `https://${auth.instance}/api/v1/accounts/${auth.accountId}/statuses?limit=10&exclude_replies=true`,
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    if (!res.ok) return 0;
    const statuses = await res.json() as MastodonStatus[];
    return statuses.filter(s =>
      new Date(s.created_at).getTime() >= todayStart.getTime() &&
      s.tags.some(t => t.name.toLowerCase() === 'meenowapp'),
    ).length;
  } catch {
    return 0;
  }
}
