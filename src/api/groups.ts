// Bootstrap-groups client: membership lives on meenow's own PHP backend
// (same-origin /groups/*, guarded by the Bearer header like /push/*), not on
// the Pixelfed instance. Following the members themselves goes through
// social.ts — the group is only the roster that makes a first circle possible.
//
// Three things sit on that roster: invite links (a random token, never the group
// slug), auto-approve on join, and admin removal. The last two are driven by
// group events, which the service worker consumes too — so the event types here
// are shared vocabulary between the app and the SW, and the shapes must keep
// matching server/src/groups.php.
import type { AuthState } from './authState';
import { GROUPS_URL } from '../config';
import { connectTo, fetchMyAccount, fetchRelationships, resolveHandle } from './social';

export interface GroupMember {
  account: string; // "<instance>:<accountId>"
  acct: string;    // fediverse handle, user@instance
}

export interface Group {
  id: string;
  name: string;
  // Whether the account that was asked about is the group's admin — the oldest
  // member, derived server-side and never stored.
  admin: boolean;
}

export interface GroupBan {
  group_id: string;
  account: string;
  acct: string;
}

export type GroupEventKind = 'join' | 'remove';

export interface GroupEvent {
  id: number;
  group_id: string;
  kind: GroupEventKind;
  account: string;  // the subject: who joined / who was removed
  acct: string;
  actor: string;    // who caused it ('' for a self-join)
  name: string;     // group display name, for the notification body
}

// The push payload's group_event, mirroring groups_notify() in the backend.
export interface PushGroupEvent {
  id: number;
  kind: GroupEventKind;
  group: string;
  name: string;
  account: string;
  acct: string;
  actor: string;
}

// Server errors that the UI must answer differently. `invite_not_found` and
// `invite_expired` read the same to a person holding a link, but "ask someone
// for a fresh one" is only honest for the second — and `banned` must never be
// shown as a broken link.
export type GroupApiErrorCode =
  | 'invite_not_found' | 'invite_expired' | 'invite_exhausted' | 'invite_required'
  | 'banned' | 'not_member' | 'not_admin' | 'group_not_found' | 'unknown';

export class GroupApiError extends Error {
  readonly code: GroupApiErrorCode;
  constructor(code: GroupApiErrorCode, status: number) {
    super(`groups: ${code} (${status})`);
    this.code = code;
  }
}

// Map a failed response onto a code. The body is JSON on every path we care
// about; anything unrecognisable becomes `unknown` and renders as a generic
// failure rather than being guessed at.
async function groupError(res: Response): Promise<GroupApiError> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  const code = (body?.error ?? '') as GroupApiErrorCode;
  const known: GroupApiErrorCode[] = [
    'invite_not_found', 'invite_expired', 'invite_exhausted', 'invite_required',
    'banned', 'not_member', 'not_admin', 'group_not_found',
  ];
  return new GroupApiError(known.includes(code) ? code : 'unknown', res.status);
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

// Full roster plus the caller's admin status. `account` is optional: the roster
// is readable by any signed-in user, but `admin` (and the ban list, which only
// the admin receives) is about the caller. Throws on 404 — callers that prefer
// null catch GroupApiError.
export async function fetchGroup(
  auth: AuthState,
  id: string,
  account?: string,
): Promise<Group & { members: GroupMember[]; bans: GroupBan[] }> {
  const url = new URL(`${GROUPS_URL}/${encodeURIComponent(id)}`, self.location.origin);
  const acct = account ?? accountKey(auth);
  if (acct) url.searchParams.set('account', acct);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw await groupError(res);
  const data = await res.json() as {
    id: string; name: string; members: GroupMember[]; admin?: boolean; bans?: GroupBan[];
  };
  return {
    id: data.id,
    name: data.name,
    admin: !!data.admin,
    members: Array.isArray(data.members) ? data.members : [],
    bans: Array.isArray(data.bans) ? data.bans : [],
  };
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

// --- Invites ---------------------------------------------------------------

export interface Invite {
  token: string;
  group: string;
  expires_at: number;
  max_uses: number;
}

// Mint an invite for a group the caller belongs to. The token — not the group
// slug — is what goes in the link, so a shared URL grants access without making
// the group discoverable, and it stops working on its own.
export async function createInvite(auth: AuthState, groupId: string): Promise<Invite> {
  const res = await fetch(`${GROUPS_URL}/invite`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ group: groupId, account: accountKey(auth) }),
  });
  if (!res.ok) throw await groupError(res);
  return await res.json() as Invite;
}

export interface RedeemedInvite {
  id: string;
  name: string;
  members: GroupMember[];
  expires_at: number;
  probably_spent: boolean;
}

// Preview an invite link. Does not consume a use, so a link can be opened,
// abandoned and reopened. Throws GroupApiError with invite_not_found /
// invite_expired / banned, which the join screen renders distinctly.
export async function redeemInvite(auth: AuthState, token: string): Promise<RedeemedInvite> {
  const res = await fetch(`${GROUPS_URL}/redeem`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ token, account: accountKey(auth) }),
  });
  if (!res.ok) throw await groupError(res);
  const data = await res.json() as RedeemedInvite & { members?: GroupMember[] };
  return { ...data, members: Array.isArray(data.members) ? data.members : [] };
}

// Join a group. `token` is required to ENTER but not to stay: an existing member
// re-joining from a new device sends none, so an expired link cannot lock someone
// out of a group they are already in.
export async function joinGroup(auth: AuthState, id: string, token?: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/join`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({
      account: accountKey(auth),
      acct: await myAcct(auth),
      ...(token ? { token } : {}),
    }),
  });
  if (!res.ok) throw await groupError(res);
}

export async function leaveGroup(auth: AuthState, id: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/leave`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ account: accountKey(auth) }),
  });
  if (!res.ok) throw new Error(`Could not leave group (${res.status})`);
}

// --- Admin actions ---------------------------------------------------------

// Evict someone and block them. Only the group's admin may; the server answers
// 403 not_admin otherwise. The server also writes the event that makes every
// member's device sever the follow, so this call alone is the whole removal.
export async function removeMember(auth: AuthState, id: string, account: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/remove`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ account, actor: accountKey(auth) }),
  });
  if (!res.ok) throw await groupError(res);
}

// Lift a block. The person still needs a fresh invite to come back, which is
// what proves they still want in.
export async function unbanMember(auth: AuthState, id: string, account: string): Promise<void> {
  const res = await fetch(`${GROUPS_URL}/${encodeURIComponent(id)}/unban`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify({ account, actor: accountKey(auth) }),
  });
  if (!res.ok) throw await groupError(res);
}

// --- Event catch-up --------------------------------------------------------

export interface GroupEventPage {
  events: GroupEvent[];
  bans: GroupBan[];
}

// Events this account has not applied yet, oldest first, plus the current ban
// set. This is the same information the push carries, for a device that was
// offline when it fired — the reason a removal still takes effect on a phone that
// missed the notification. `since` is the highest event id already applied.
export async function fetchGroupEvents(
  auth: AuthState,
  since: number,
): Promise<GroupEventPage> {
  const url = new URL(`${GROUPS_URL}/events`, self.location.origin);
  url.searchParams.set('account', accountKey(auth));
  url.searchParams.set('since', String(since));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw await groupError(res);
  const data = await res.json() as { events?: GroupEvent[]; bans?: GroupBan[] };
  return {
    events: Array.isArray(data.events) ? data.events : [],
    bans: Array.isArray(data.bans) ? data.bans : [],
  };
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
