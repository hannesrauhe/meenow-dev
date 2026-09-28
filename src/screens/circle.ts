// Circle screen: the follower-network hub. Shows pending follow requests (one-tap
// mutual accept), the user's mutual circle, an invite-share affordance, and a
// reversible lock toggle. Auto-locks the account on first open (and migrates
// existing users) so new followers must be approved.
import { CHEVRON_LEFT_ICON, SLEEPING_CAT } from '../icons';
import type { AuthState } from '../api/auth';
import {
  fetchMyAccount, fetchFollowRequests, fetchConnections, fetchRelationships,
  setAccountPrivacy, acceptAndBackFollow, rejectFollowRequest, removeFollower,
  invalidatePendingRequestCache,
  type Connection, type Relationship,
} from '../api/social';
import { isLockedApplied, setLockedApplied } from '../state';
import { makeAccountRow } from '../components/accountRow';
import { makeConnectButton } from '../components/connectButton';
import { fetchMyGroups, leaveGroup, type Group } from '../api/groups';

export function renderCircle(
  auth: AuthState,
  onBack: () => void,
  onOpenPeer: (peer: Connection) => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-circle';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] border-b border-ink/10';

  const backBtn = document.createElement('button');
  // [&>svg]:size-5 gives the chevron an explicit size; without it WebKit collapses
  // a viewBox-only SVG to 0×0 as a flex item, hiding the back button on iOS.
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1 [&>svg]:size-5';
  backBtn.setAttribute('aria-label', 'Back to feed');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'Your circle';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  loadCircle(content, auth, onOpenPeer);
  return root;
}

async function loadCircle(
  container: HTMLElement,
  auth: AuthState,
  onOpenPeer: (peer: Connection) => void,
): Promise<void> {
  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 spinner"></div>
    </div>
  `;

  let account: { id: string; acct: string; locked: boolean };
  try {
    account = await fetchMyAccount(auth);
  } catch {
    showError(container, () => loadCircle(container, auth, onOpenPeer));
    return;
  }
  if (!container.isConnected) return;

  // Auto-lock on first open / migration; reflect the effective state in the toggle.
  const lockedNow = await ensureLocked(auth, account.locked);
  if (!container.isConnected) return;

  let requests: Connection[];
  let following: Connection[];
  let followers: Connection[];
  let groups: Group[];
  try {
    [requests, following, followers, groups] = await Promise.all([
      fetchFollowRequests(auth),
      fetchConnections(auth, account.id, 'following'),
      // Fail-soft: an unreadable follower list must never hide the inbox.
      fetchConnections(auth, account.id, 'followers').catch(() => []),
      // Fail-soft too: no backend reachability simply hides the Groups section.
      fetchMyGroups(auth),
    ]);
  } catch {
    showError(container, () => loadCircle(container, auth, onOpenPeer));
    return;
  }
  if (!container.isConnected) return;

  // Followers we don't already follow. These can exist without ever appearing
  // in the inbox: a back-follow that failed after we accepted, follows from
  // before the account was locked, or remote auto-accepts.
  const followingIds = new Set(following.map(c => c.id));
  const followsYou = followers.filter(c => !followingIds.has(c.id));

  const rels = await fetchRelationships(auth, [
    ...following.map(c => c.id),
    ...followsYou.map(c => c.id),
  ]);
  if (!container.isConnected) return;

  const inviteHandle = account.acct.includes('@') ? account.acct : `${account.acct}@${auth.instance}`;

  container.innerHTML = '';
  container.appendChild(makeInviteBlock(inviteHandle));
  if (groups.length > 0) {
    container.appendChild(makeGroupsSection(auth, groups, () => loadCircle(container, auth, onOpenPeer)));
  }
  if (requests.length > 0) {
    container.appendChild(makeRequestsSection(auth, requests, () => loadCircle(container, auth, onOpenPeer)));
  }
  if (followsYou.length > 0) {
    container.appendChild(makeFollowsYouSection(auth, followsYou, rels, onOpenPeer, () => loadCircle(container, auth, onOpenPeer)));
  }
  container.appendChild(makeCircleSection(auth, following, followsYou.length, rels, onOpenPeer, () => loadCircle(container, auth, onOpenPeer)));
  container.appendChild(makeLockRow(auth, lockedNow));
}

async function ensureLocked(auth: AuthState, currentlyLocked: boolean): Promise<boolean> {
  if (isLockedApplied(auth.instance)) return currentlyLocked;
  if (!currentlyLocked) {
    const ok = await setAccountPrivacy(auth, true);
    if (ok) { setLockedApplied(auth.instance); return true; }
    return false;
  }
  setLockedApplied(auth.instance);
  return true;
}

function showError(container: HTMLElement, retry: () => void): void {
  if (!container.isConnected) return;
  container.innerHTML = `
    <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
      <p class="text-sm text-ink/50">Could not load your circle.</p>
      <button id="btn-circle-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
    </div>
  `;
  container.querySelector('#btn-circle-retry')?.addEventListener('click', retry);
}

function makeInviteBlock(handle: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'px-4 py-4 flex flex-col items-center gap-2 border-b border-ink/8';

  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.textContent = 'Invite a friend';
  btn.addEventListener('click', () => void shareInvite(handle, btn));
  wrap.appendChild(btn);

  const hint = document.createElement('p');
  hint.className = 'text-xs text-ink/40 text-center';
  hint.textContent = 'Share a link. They connect, you approve — and you both see each other’s photos.';
  wrap.appendChild(hint);

  return wrap;
}

// Bootstrap groups the user has joined (see server/src/groups.php). Offers the
// same invite link for the group and a two-tap leave; the circle itself is
// unaffected by leaving — the group is only the bootstrap roster.
function makeGroupsSection(auth: AuthState, groups: Group[], reload: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'border-b border-ink/8';
  section.appendChild(makeSectionHeading(`Groups · ${groups.length}`));

  for (const g of groups) {
    // Deliberately NOT makeAccountRow: its "@handle" subtitle would make the
    // slug look like a fediverse account (@crew might be a real one). The group
    // is a meenow-only concept; the slug only matters inside the invite link.
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 px-4 py-3';
    const avatar = document.createElement('img');
    avatar.src = GROUP_AVATAR;
    avatar.className = 'w-9 h-9 rounded-full object-cover bg-gold-light shrink-0';
    avatar.alt = '';
    row.appendChild(avatar);
    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const nameEl = document.createElement('p');
    nameEl.className = 'text-sm font-medium text-ink truncate';
    nameEl.textContent = g.name;
    info.appendChild(nameEl);
    const metaEl = document.createElement('p');
    metaEl.className = 'text-xs text-ink/40 truncate';
    metaEl.textContent = 'meenow group';
    info.appendChild(metaEl);
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'shrink-0 flex items-center gap-2';
    row.appendChild(actions);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'text-xs rounded-full px-3 py-1.5 border border-gold/40 text-gold';
    shareBtn.textContent = 'Invite';
    shareBtn.addEventListener('click', () => void shareGroup(g.id, shareBtn));
    actions.appendChild(shareBtn);

    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'text-xs rounded-full px-3 py-1.5 border border-ink/10 text-ink/30';
    leaveBtn.textContent = 'Leave';
    let confirming = false;
    leaveBtn.addEventListener('click', () => {
      if (!confirming) {
        confirming = true;
        leaveBtn.textContent = 'Sure?';
        leaveBtn.className = 'text-xs rounded-full px-3 py-1.5 border border-gold/40 text-gold';
        window.setTimeout(() => {
          if (!confirming || !leaveBtn.isConnected) return;
          confirming = false;
          leaveBtn.textContent = 'Leave';
          leaveBtn.className = 'text-xs rounded-full px-3 py-1.5 border border-ink/10 text-ink/30';
        }, 3000);
        return;
      }
      leaveBtn.disabled = true;
      void leaveGroup(auth, g.id).then(reload).catch(() => {
        leaveBtn.disabled = false;
        leaveBtn.textContent = 'Try again';
      });
    });
    actions.appendChild(leaveBtn);

    section.appendChild(row);
  }
  return section;
}

const GROUP_AVATAR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="36" fill="#F3E8D0"/><circle cx="28" cy="30" r="9" fill="#B08947"/><circle cx="45" cy="33" r="7" fill="#B08947" opacity="0.7"/><path d="M14 56c2-10 10-14 14-14s12 4 14 14z" fill="#B08947"/><path d="M38 56c1-7 5-10 7-10s6 3 7 10z" fill="#B08947" opacity="0.7"/></svg>',
)}`;

async function shareGroup(groupId: string, btn: HTMLButtonElement): Promise<void> {
  const url = `${window.location.origin}/?group=${encodeURIComponent(groupId)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'meenow', text: 'Join this meenow group', url });
      return;
    } catch { /* user cancelled or share failed — fall back to copy */ }
  }
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  window.setTimeout(() => { btn.textContent = original; }, 2000);
}

async function shareInvite(handle: string, btn: HTMLButtonElement): Promise<void> {
  const url = `${window.location.origin}/?add=${encodeURIComponent(handle)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'meenow', text: 'Connect with me on meenow', url });
      return;
    } catch { /* user cancelled or share failed — fall back to copy */ }
  }
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  window.setTimeout(() => { btn.textContent = original; }, 2000);
}

function makeSectionHeading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'text-xs font-semibold text-ink/40 px-4 pt-4 pb-1 uppercase tracking-wider';
  h.textContent = text;
  return h;
}

function makeRequestsSection(auth: AuthState, requests: Connection[], reload: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'border-b border-ink/8';
  section.appendChild(makeSectionHeading(`Requests · ${requests.length}`));

  // Once every request is handled, reload so accepted people move into the
  // circle list and the Requests heading clears.
  let pending = requests.length;
  const resolved = (actions: HTMLElement, label: string): void => {
    actions.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'text-xs text-ink/40';
    tag.textContent = label;
    actions.appendChild(tag);
    pending -= 1;
    if (pending === 0) reload();
  };

  for (const req of requests) {
    const { row, actions } = makeAccountRow({ displayName: req.displayName, handle: req.acct, avatarUrl: req.avatarUrl });

    const accept = document.createElement('button');
    accept.className = 'text-xs rounded-full px-3 py-1.5 bg-ink text-cream font-medium';
    accept.textContent = 'Accept';

    const reject = document.createElement('button');
    reject.className = 'text-xs rounded-full px-3 py-1.5 border border-ink/15 text-ink/50';
    reject.textContent = 'Reject';

    accept.addEventListener('click', async () => {
      accept.disabled = true; reject.disabled = true; accept.textContent = '…';
      try {
        const rel = await acceptAndBackFollow(auth, req.id);
        invalidatePendingRequestCache();
        // Mutual immediately, unless the requester is also locked or the
        // back-follow failed — either way they are accepted, and show up under
        // "Follows you" with a one-tap retry once the section reloads.
        resolved(actions, rel?.following && rel.followedBy ? 'Connected' : 'Accepted');
      } catch {
        // A failed request is otherwise indistinguishable from a tap that did
        // nothing, so show it was tried and failed rather than reverting silently.
        accept.textContent = 'Try again';
        accept.disabled = false; reject.disabled = false;
      }
    });

    reject.addEventListener('click', async () => {
      accept.disabled = true; reject.disabled = true; reject.textContent = '…';
      try {
        await rejectFollowRequest(auth, req.id);
        invalidatePendingRequestCache();
        resolved(actions, 'Declined');
      } catch {
        reject.textContent = 'Try again';
        accept.disabled = false; reject.disabled = false;
      }
    });

    actions.appendChild(reject);
    actions.appendChild(accept);
    section.appendChild(row);
  }

  return section;
}

function makeFollowsYouSection(
  auth: AuthState,
  followsYou: Connection[],
  rels: Map<string, Relationship>,
  onOpenPeer: (peer: Connection) => void,
  reload: () => void,
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'border-b border-ink/8';
  section.appendChild(makeSectionHeading(`Follows you · ${followsYou.length}`));

  // Connecting moves the row into the circle list, so the screen is rebuilt —
  // but only once, however many rows the user connects in one visit.
  let reloadScheduled = false;

  for (const c of followsYou) {
    const { row, actions } = makeAccountRow({ displayName: c.displayName, handle: c.acct, avatarUrl: c.avatarUrl });
    row.classList.add('cursor-pointer');
    row.addEventListener('click', () => onOpenPeer(c));
    // The pill's own tap must not also drill into the peer screen via the row.
    actions.addEventListener('click', e => e.stopPropagation());

    // These people follow you, so they see your daily photos until removed —
    // the only remedy for a follower you never accepted (pre-lock follows,
    // failed back-follows, remote auto-accepts). Two-tap like every disconnect.
    const remove = document.createElement('button');
    remove.className = 'text-xs rounded-full px-3 py-1.5 border border-ink/15 text-ink/50';
    remove.textContent = 'Remove';
    let confirming = false;
    remove.addEventListener('click', () => {
      if (!confirming) {
        confirming = true;
        remove.textContent = 'Sure?';
        window.setTimeout(() => {
          if (!confirming || !remove.isConnected) return;
          confirming = false;
          remove.textContent = 'Remove';
        }, 3000);
        return;
      }
      confirming = false;
      remove.disabled = true;
      void removeFollower(auth, c.id).then(() => {
        if (reloadScheduled) return;
        reloadScheduled = true;
        window.setTimeout(reload, 600);
      }).catch(() => {
        remove.disabled = false;
        remove.textContent = 'Try again';
      });
    });
    actions.appendChild(remove);

    actions.appendChild(makeConnectButton(auth, c.id, rels.get(c.id), rel => {
      if (rel.following && rel.followedBy && !reloadScheduled) {
        reloadScheduled = true;
        window.setTimeout(reload, 900);
      }
    }));
    section.appendChild(row);
  }

  return section;
}

function makeCircleSection(
  auth: AuthState,
  following: Connection[],
  followsYouCount: number,
  rels: Map<string, Relationship>,
  onOpenPeer: (peer: Connection) => void,
  reload: () => void,
): HTMLElement {
  const section = document.createElement('div');

  // The circle proper: people you both follow each other with.
  const mutuals = following.filter(c => rels.get(c.id)?.followedBy);
  const oneWay = following.filter(c => !rels.get(c.id)?.followedBy);

  if (following.length === 0 && followsYouCount === 0) {
    section.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <div class="w-36 h-24">${SLEEPING_CAT}</div>
        <p class="text-sm">Your circle is empty — invite a friend to get started.</p>
      </div>
    `;
    return section;
  }

  section.appendChild(makeSectionHeading(`Your circle · ${mutuals.length}`));
  for (const c of mutuals) section.appendChild(makePeerRow(auth, c, rels.get(c.id), onOpenPeer, reload));

  if (oneWay.length > 0) {
    section.appendChild(makeSectionHeading('Waiting for them'));
    for (const c of oneWay) section.appendChild(makePeerRow(auth, c, rels.get(c.id), onOpenPeer, reload));
  }

  return section;
}

function makePeerRow(
  auth: AuthState,
  c: Connection,
  rel: Relationship | undefined,
  onOpenPeer: (peer: Connection) => void,
  reload: () => void,
): HTMLElement {
  const { row, actions } = makeAccountRow({ displayName: c.displayName, handle: c.acct, avatarUrl: c.avatarUrl });
  row.classList.add('cursor-pointer');
  row.addEventListener('click', () => onOpenPeer(c));
  // The pill's own tap must not also drill into the peer screen via the row.
  actions.addEventListener('click', e => e.stopPropagation());

  // The pill is also the disconnect affordance (two-tap), which is the only way
  // to leave a connection — the row itself only drills in. Any state change
  // moves the row between groups (or out of the list), so rebuild once.
  let reloadScheduled = false;
  actions.appendChild(makeConnectButton(auth, c.id, rel, () => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    window.setTimeout(reload, 900);
  }));

  return row;
}

function makeLockRow(auth: AuthState, locked: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'px-4 py-5 mt-2 border-t border-ink/8 flex items-start justify-between gap-4';

  const text = document.createElement('div');
  text.className = 'flex-1 min-w-0';
  const label = document.createElement('p');
  label.className = 'text-sm font-medium text-ink';
  label.textContent = 'Approve new followers';
  text.appendChild(label);
  const sub = document.createElement('p');
  sub.className = 'text-xs text-ink/40 mt-0.5';
  sub.textContent = 'When on, new followers need your approval and your account stays out of discovery. Invites still work.';
  text.appendChild(sub);
  row.appendChild(text);

  const toggle = document.createElement('button');
  toggle.className = 'shrink-0 text-xs rounded-full px-3 py-1.5 border transition-colors';
  let on = locked;
  const paint = (): void => {
    toggle.textContent = on ? 'On' : 'Off';
    toggle.className = `shrink-0 text-xs rounded-full px-3 py-1.5 border transition-colors ${on ? 'text-gold border-gold/40' : 'text-ink/40 border-ink/15'}`;
  };
  paint();
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    const next = !on;
    const ok = await setAccountPrivacy(auth, next);
    if (ok) on = next;
    paint();
    toggle.disabled = false;
  });
  row.appendChild(toggle);

  return row;
}
