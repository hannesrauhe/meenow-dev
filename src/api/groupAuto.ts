// The automatic half of group membership: approve a newcomer and follow them
// back, or sever someone who was removed. Runs in the SERVICE WORKER as well as
// the app, which is the only reason it exists as its own module — the server
// holds no instance credentials, so it can only tell us something happened. The
// follow/unfollow/authorize calls have to come from a member's own device.
//
// Nothing here throws at its caller and everything is idempotent: these run
// unattended, often more than once for the same event (a push and the catch-up
// poll can both deliver it), and a half-done pass is corrected by the next one.
import type { AuthState } from './authState';
import {
  acceptAndBackFollow, connectTo, disconnect, fetchFollowRequests,
  fetchRelationships, resolveHandle,
} from './social';

// Handles arrive from three places (the roster, the push payload, Pixelfed's own
// account objects) with different casing and an optional leading @. Compare on
// this and nowhere else.
export function normAcct(acct: string): string {
  return acct.trim().toLowerCase().replace(/^@/, '');
}

// Resolve a group member's handle to a followable id on our instance. Same-
// instance members are addressed by their stored id directly, which skips a
// WebFinger round-trip; remote ones go through the instance. '' = unresolvable.
export async function memberId(auth: AuthState, account: string, acct: string): Promise<string> {
  const sep = account.lastIndexOf(':');
  if (sep > 0 && account.slice(0, sep) === auth.instance) return account.slice(sep + 1);
  const conn = await resolveHandle(auth, acct).catch(() => null);
  return conn?.id ?? '';
}

// Handle a 'join' event: make this member and the newcomer mutually connected.
//
// `final` marks the last attempt of a retry ladder. On earlier attempts we only
// act on a follow request that has actually arrived, because the normal path is
// the joiner's device having just followed us and federation takes a second or
// two. Only when the ladder runs out do we follow them ourselves, so a slow or
// partially-failed joiner still ends up in everyone's circle — doing it eagerly
// would litter their inbox with requests their own auto-approve then has to
// clear, and would follow people who never asked to be followed by us.
export async function applyJoinEvent(
  auth: AuthState,
  joiner: { account: string; acct: string },
  final: boolean,
): Promise<boolean> {
  // One inbox read does double duty: it says whether approval is needed at all,
  // and it supplies the account id that authorize requires.
  try {
    const requests = await fetchFollowRequests(auth);
    const mine = requests.find(r => normAcct(r.acct) === normAcct(joiner.acct));
    if (mine) {
      // Authorize, then follow back. The order is load-bearing — Pixelfed's
      // follow endpoint cannot resolve an incoming request itself — and a failed
      // back-follow returns null rather than rejecting, because the accept
      // already happened server-side.
      await acceptAndBackFollow(auth, mine.id);
      return true;
    }
  } catch {
    return false; // inbox unreadable (offline, rate limit) — the next pass retries
  }

  if (!final) return false;

  // No request ever arrived, so the joiner's own follow-all must have failed.
  // Follow them anyway — a group means everyone sees everyone — and let their
  // side approve. If they are locked this simply queues there, which is correct.
  const id = await memberId(auth, joiner.account, joiner.acct);
  if (!id) return false;
  try {
    const rel = (await fetchRelationships(auth, [id])).get(id);
    if (rel?.following || rel?.requested) return true;
    await connectTo(auth, id);
    return true;
  } catch {
    return false;
  }
}

// Handle a 'remove' event: cut ties with one account. This is what makes a
// removal protect the circle — the roster row is gone, but only severing stops
// the removed person reading anyone's photos.
//
// The relationship is read first so a no-op (already severed, or never connected)
// costs no writes. When it does act it uses the shared `disconnect` from
// social.ts — the same two calls the connect button makes on a manual
// "Disconnect?" — so the automatic sweep and the manual tap cannot drift apart.
export async function applyRemoveEvent(
  auth: AuthState,
  target: { account: string; acct: string },
): Promise<boolean> {
  const id = await memberId(auth, target.account, target.acct);
  if (!id) return false;
  try {
    const rel = (await fetchRelationships(auth, [id])).get(id);
    if (!rel) return false;
    if (!rel.following && !rel.followedBy) return true; // nothing left to sever
    await disconnect(auth, id, rel.followedBy);
    return true;
  } catch {
    return false;
  }
}

// The joiner's symmetric half: approve the follow requests that the members'
// back-follows create. Without this, a joiner whose account is already locked
// (the app auto-locks every account) would strand every member's back-follow in
// their own inbox, leaving the circle one-way — the members could see the
// newcomer's photos and not the other way round.
//
// Single-shot by design: the members' back-follows arrive on their own schedule,
// so the caller runs this as a short ladder. Anything still pending afterwards
// is visible in the Circle inbox, where the one-tap Accept has always been.
export async function approveGroupMembers(
  auth: AuthState,
  members: { account: string; acct: string }[],
): Promise<number> {
  const wanted = new Set(members.map(m => normAcct(m.acct)));
  if (wanted.size === 0) return 0;
  let settled = 0;
  try {
    for (const req of await fetchFollowRequests(auth)) {
      if (!wanted.has(normAcct(req.acct))) continue;
      await acceptAndBackFollow(auth, req.id);
      settled++;
    }
  } catch {
    // Best-effort — see the note above.
  }
  return settled;
}
