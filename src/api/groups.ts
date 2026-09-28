// Bootstrap-groups client: membership lives on meenow's own PHP backend
// (same-origin /groups/*, guarded by the Bearer header like /push/*), not on
// the Pixelfed instance. Following the members themselves goes through
// social.ts — the group is only the roster that makes a first circle possible.
import type { AuthState } from './auth';
import { GROUPS_URL } from '../config';
import { connectTo, fetchMyAccount, fetchRelationships, resolveHandle } from './social';

export interface GroupMember {
  account: string; // "<instance>:<accountId>"
  acct: string;    // fediverse handle, user@instance
}

export interface Group {
  id: string;
  name: string;
}

function authHeaders(auth: AuthState): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
  };
}

// The membership key the backend stores — same string push subscriptions use.
export function accountKey(auth: AuthState): string {
  return `${auth.instance}:${auth.accountId}`;
}

// Full handle for the current user, needed so other members can resolve and
// follow us. Falls back to the bare acct shape the API would echo.
async function myAcct(auth: AuthState): Promise<string> {
  try {
    const me = await fetchMyAccount(auth);
    return me.acct.includes('@') ? me.acct : `${me.acct}@${auth.instance}`;
  } catch {
    return `${auth.accountId}@${auth.instance}`;
  }
}

// null when the group does not exist (a stale/revoked invite link).
export async function fetchGroup(auth: AuthState, id: string): Promise<Group & { members: GroupMember[] } | null> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load group (${res.status})`);
  const data = await res.json() as { id: string; name: string; members: GroupMember[] };
  return { id: data.id, name: data.name, members: Array.isArray(data.members) ? data.members : [] };
}

// Best-effort: the Circle screen hides the whole section on failure.
export async function fetchMyGroups(auth: AuthState): Promise<Group[]> {
  try {
    const url = `${GROUPS_URL}/mine?account=${encodeURIComponent(accountKey(auth))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as { groups?: Group[] };
    return Array.isArray(data.groups) ? data.groups : [];
  } catch {
    return [];
  }
}

export async function joinGroup(auth: AuthState, id: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/join`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ account: accountKey(auth), acct: await myAcct(auth) }),
  });
  if (!res.ok) throw new Error(`Could not join group (${res.status})`);
}

export async function leaveGroup(auth: AuthState, id: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/leave`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ account: accountKey(auth) }),
  });
  if (!res.ok) throw new Error(`Could not leave group (${res.status})`);
}

export interface FollowAllResult {
  followed: number;
  skipped: number; // already connected/pending, or self
  failed: number;
}

// Follow every member of a group. Members are stored as handles because the
// follower must live on their own account's reach: same-instance ids are used
// directly, remote ones are resolved through our instance (WebFinger). `knownIds`
// (account -> followable id, '' = unresolvable) lets a screen that already
// resolved them for its own rows hand the result over instead of paying for
// WebFinger twice. The circle is small by design (<20), so follows run
// sequentially and per-member failures are tolerated — a partial follow-up is
// still a bootstrap.
export async function followAllGroupMembers(
  auth: AuthState,
  members: GroupMember[],
  onProgress?: (done: number, total: number) => void,
  knownIds?: Map<string, string>,
): Promise<FollowAllResult> {
  const others = members.filter((m) => m.account !== accountKey(auth));
  const result: FollowAllResult = { followed: 0, skipped: 0, failed: 0 };

  // Resolve everyone first so one relationship batch can skip the connected.
  const ids: string[] = [];
  await Promise.all(others.map(async (m, i) => {
    const known = knownIds?.get(m.account);
    if (known !== undefined) {
      ids[i] = known;
      return;
    }
    const sep = m.account.lastIndexOf(':');
    const instance = m.account.slice(0, sep);
    const accountId = m.account.slice(sep + 1);
    if (instance === auth.instance && accountId) {
      ids[i] = accountId;
      return;
    }
    const conn = await resolveHandle(auth, m.acct).catch(() => null);
    ids[i] = conn?.id ?? '';
  }));

  const rels = await fetchRelationships(auth, ids.filter(Boolean));
  for (let i = 0; i < others.length; i++) {
    if (!ids[i]) {
      result.failed++;
    } else if (rels.get(ids[i])?.following || rels.get(ids[i])?.requested) {
      result.skipped++;
    } else {
      try {
        await connectTo(auth, ids[i]);
        result.followed++;
      } catch {
        result.failed++;
      }
    }
    onProgress?.(i + 1, others.length);
  }
  return result;
}
