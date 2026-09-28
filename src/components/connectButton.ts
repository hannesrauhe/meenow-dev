// A self-contained pill button that reflects a Relationship and performs the
// one-tap mutual connect / disconnect. Shared by the peer-connections and
// connect-landing screens. The state→label mapping is the single source of truth
// for how a connection is presented across the app.
import type { AuthState } from '../api/auth';
import { connectTo, unfollow, removeFollower, fetchRelationships, type Relationship } from '../api/social';

const PILL = 'text-xs rounded-full px-3 py-1.5 border transition-colors';
const ACTIVE = `${PILL} text-gold border-gold/40`;
const MUTED = `${PILL} text-ink/30 border-ink/10`;
const DONE = `${PILL} text-ink/40 border-ink/15`;

export function makeConnectButton(
  auth: AuthState,
  accountId: string,
  initial: Relationship | undefined,
  onChange?: (rel: Relationship) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  let state = initial;
  let confirming = false;

  const apply = (): void => {
    confirming = false;
    btn.disabled = false;
    const r = state;
    if (r?.blocking || r?.blockedBy) {
      btn.textContent = 'Unavailable';
      btn.disabled = true;
      btn.className = MUTED;
    } else if (r?.following && r?.followedBy) {
      btn.textContent = 'Connected';
      btn.className = DONE;
    } else if (r?.following) {
      btn.textContent = 'Waiting for them';
      btn.className = MUTED;
    } else if (r?.requested) {
      btn.textContent = 'Requested';
      btn.className = MUTED;
    } else if (r?.followedBy) {
      btn.textContent = 'Connect back';
      btn.className = ACTIVE;
    } else {
      btn.textContent = 'Connect';
      btn.className = ACTIVE;
    }
  };

  const run = async (fn: () => Promise<Relationship>): Promise<void> => {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      state = await fn();
      apply();
      if (state) onChange?.(state);
    } catch {
      // Reverting straight back to "Connect" is indistinguishable from the tap
      // having done nothing — show that it was tried and failed instead.
      apply();
      btn.textContent = 'Try again';
    }
  };

  // Full severance: unfollow them AND (when they follow us) drop them from our
  // followers. In a followers-only app the removal is the point — unfollowing
  // alone would leave them reading your daily photos. Partial success still
  // counts (the refreshed relationship shows the truth); an instance without
  // the remove endpoint degrades to a plain unfollow instead of a dead button.
  const disconnect = async (removeThem: boolean): Promise<Relationship> => {
    const [un, rm] = await Promise.allSettled([
      unfollow(auth, accountId),
      removeThem ? removeFollower(auth, accountId) : Promise.resolve(),
    ]);
    if (un.status === 'rejected' && (!removeThem || rm.status === 'rejected')) {
      throw un.reason as Error;
    }
    const rel = (await fetchRelationships(auth, [accountId])).get(accountId);
    if (rel) return rel;
    throw new Error('Could not refresh relationship');
  };

  btn.addEventListener('click', () => {
    const r = state;
    if (r?.blocking || r?.blockedBy) return;
    // Any follow we hold — mutual or one-way — is undone by a two-tap
    // "Disconnect?". There is deliberately no plain unfollow: in a
    // followers-only app the meaningful severance is also removing them from
    // your followers, so the action always severs both directions that exist.
    if (r?.following) {
      if (!confirming) {
        confirming = true;
        btn.textContent = 'Disconnect?';
        btn.className = ACTIVE;
        window.setTimeout(() => { if (confirming) apply(); }, 3000);
        return;
      }
      void run(() => disconnect(r.followedBy));
      return;
    }
    // Pending request: two-tap cancel (Pixelfed's unfollow endpoint also
    // deletes a pending FollowRequest; there is no follower to remove yet).
    if (r?.requested) {
      if (!confirming) {
        confirming = true;
        btn.textContent = 'Cancel?';
        btn.className = ACTIVE;
        window.setTimeout(() => { if (confirming) apply(); }, 3000);
        return;
      }
      void run(() => unfollow(auth, accountId));
      return;
    }
    void run(() => connectTo(auth, accountId));
  });

  apply();
  return btn;
}
