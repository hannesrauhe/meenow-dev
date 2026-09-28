// Group-join screen: the target of a group invite deep link (?group=<id>).
// Lists the group's members and offers one-tap "follow all" — the bootstrap
// that turns a fresh account into a follower circle. Joining records the
// membership on meenow's backend (so the user appears in the roster for the
// next joiner); the circle itself then lives on the instances. Members are
// locked accounts, so the follows arrive in their Circle inbox as one-tap
// accepts.
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import {
  fetchGroup, joinGroup, followAllGroupMembers, accountKey,
  type GroupMember,
} from '../api/groups';
import { fetchRelationships, resolveHandle, type Relationship } from '../api/social';
import { makeConnectButton } from '../components/connectButton';
import { makeAccountRow } from '../components/accountRow';

export function renderGroupJoin(auth: AuthState, groupId: string, onDone: () => void): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-group';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] border-b border-ink/10';

  const backBtn = document.createElement('button');
  // [&>svg]:size-5 keeps the chevron visible on iOS (see connectLanding).
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1 [&>svg]:size-5';
  backBtn.setAttribute('aria-label', 'Done');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onDone);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'Group';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  loadGroup(content, auth, groupId, onDone);
  return root;
}

async function loadGroup(
  container: HTMLElement,
  auth: AuthState,
  groupId: string,
  onDone: () => void,
): Promise<void> {
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 gap-3 text-center px-6">
      <div class="w-8 h-8 spinner"></div>
      <p class="text-sm text-ink/40">Loading group…</p>
    </div>
  `;

  let group: Awaited<ReturnType<typeof fetchGroup>>;
  try {
    group = await fetchGroup(auth, groupId);
  } catch {
    group = null;
  }
  if (!container.isConnected) return;

  if (!group) {
    renderMessage(container, 'This group link is no longer valid.', onDone,
      () => loadGroup(container, auth, groupId, onDone));
    return;
  }

  const isMember = group.members.some((m) => m.account === accountKey(auth));
  const others = group.members.filter((m) => m.account !== accountKey(auth));
  const memberIds = await resolveIds(auth, others);
  if (!container.isConnected) return;

  const rels = await fetchRelationships(auth, [...memberIds.values()].filter(Boolean));
  if (!container.isConnected) return;

  renderGroup(container, auth, groupId, group.name, isMember, others, memberIds, rels, onDone);
}

// Map member account -> followable id on our instance (local ids directly,
// remote handles via resolveHandle). Empty string = unresolvable.
async function resolveIds(
  auth: AuthState,
  members: GroupMember[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  await Promise.all(members.map(async (m) => {
    const sep = m.account.lastIndexOf(':');
    const instance = m.account.slice(0, sep);
    const accountId = m.account.slice(sep + 1);
    if (instance === auth.instance && accountId) {
      ids.set(m.account, accountId);
      return;
    }
    const conn = await resolveHandle(auth, m.acct).catch(() => null);
    ids.set(m.account, conn?.id ?? '');
  }));
  return ids;
}

function renderGroup(
  container: HTMLElement,
  auth: AuthState,
  groupId: string,
  name: string,
  isMember: boolean,
  members: GroupMember[],
  ids: Map<string, string>,
  rels: Map<string, Relationship>,
  onDone: () => void,
): void {
  container.innerHTML = '';

  const intro = document.createElement('div');
  intro.className = 'px-6 pt-8 pb-4 text-center';
  const h = document.createElement('p');
  h.className = 'text-lg font-semibold text-ink';
  h.textContent = name;
  intro.appendChild(h);
  const sub = document.createElement('p');
  sub.className = 'text-sm text-ink/40 mt-1';
  sub.textContent = members.length === 0
    ? isMember
      ? 'You’re the only member so far.'
      : 'Nobody has joined yet — you would be the first.'
    : `Follow the ${members.length} member${members.length === 1 ? '' : 's'} to build your circle.`;
  intro.appendChild(sub);
  container.appendChild(intro);

  const status = document.createElement('p');
  status.className = 'text-sm text-ink/50 text-center min-h-[1.5rem] px-6';
  container.appendChild(status);

  // Declared before the button so the click closure can re-render it after a
  // bulk follow; append order below is what controls the visual layout.
  const list = document.createElement('div');
  list.className = 'border-t border-ink/10';
  if (members.length > 0) renderMemberRows(list, auth, members, ids, rels, status);

  if (members.length > 0) {
    const followAll = document.createElement('button');
    followAll.className = 'btn-primary my-2';
    followAll.textContent = `Follow all ${members.length}`;
    followAll.addEventListener('click', () => {
      void runFollowAll(followAll, status, auth, groupId, members, ids, list);
    });
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-center pb-4';
    wrap.appendChild(followAll);
    container.appendChild(wrap);
  } else if (!isMember) {
    // Empty group: nothing to follow, but joining still seeds the roster —
    // this is how the first member of an operator-created group arrives.
    const joinBtn = document.createElement('button');
    joinBtn.className = 'btn-primary my-2';
    joinBtn.textContent = 'Join group';
    joinBtn.addEventListener('click', () => {
      void runJoinOnly(joinBtn, status, auth, groupId);
    });
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-center pb-4';
    wrap.appendChild(joinBtn);
    container.appendChild(wrap);
  }

  if (members.length > 0) container.appendChild(list);

  const done = document.createElement('button');
  done.className = 'block mx-auto text-sm text-gold underline underline-offset-2 py-6';
  done.textContent = 'Done';
  done.addEventListener('click', onDone);
  container.appendChild(done);
}

function renderMemberRows(
  list: HTMLElement,
  auth: AuthState,
  members: GroupMember[],
  ids: Map<string, string>,
  rels: Map<string, Relationship>,
  status: HTMLElement,
): void {
  list.innerHTML = '';
  for (const m of members) {
    const id = ids.get(m.account) ?? '';
    const { row, actions } = makeAccountRow({
      displayName: m.acct.split('@')[0] || m.acct,
      handle: m.acct,
      avatarUrl: placeholderAvatar(m.acct),
    });
    if (id) {
      const btn = makeConnectButton(auth, id, rels.get(id), (r) => {
        if (r.following) status.textContent = '';
      });
      actions.appendChild(btn);
    } else {
      const span = document.createElement('span');
      span.className = 'text-xs text-ink/30';
      span.textContent = 'Unavailable';
      actions.appendChild(span);
    }
    list.appendChild(row);
  }
}

async function runJoinOnly(
  btn: HTMLButtonElement,
  status: HTMLElement,
  auth: AuthState,
  groupId: string,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    await joinGroup(auth, groupId);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Try again';
    return;
  }
  if (!btn.isConnected) return;
  btn.remove();
  status.textContent = 'You’re in — the first member. Share the link from your circle to grow it.';
}

async function runFollowAll(
  btn: HTMLButtonElement,
  status: HTMLElement,
  auth: AuthState,
  groupId: string,
  members: GroupMember[],
  ids: Map<string, string>,
  list: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Joining…';
  // Membership first: the joiner becomes part of the roster for whoever
  // follows the same link next. It is idempotent, so a retry is safe.
  try {
    await joinGroup(auth, groupId);
  } catch { /* still follow — membership self-heals on the next join attempt */ }
  btn.textContent = 'Following…';
  const res = await followAllGroupMembers(auth, members, (done, t) => {
    status.textContent = `Following ${done} of ${t}…`;
  }, ids);
  if (!btn.isConnected) return;
  btn.remove();
  // Re-read the relationships so every pill reflects the bulk result (the
  // per-row buttons were built from the pre-follow state).
  const fresh = await fetchRelationships(auth, [...ids.values()].filter(Boolean));
  if (list.isConnected) renderMemberRows(list, auth, members, ids, fresh, status);
  const parts: string[] = [];
  if (res.followed) parts.push(`${res.followed} followed`);
  if (res.skipped) parts.push(`${res.skipped} already connected`);
  if (res.failed) parts.push(`${res.failed} unavailable`);
  status.textContent = parts.length ? `${parts.join(' · ')}. They’ll see your photos once they approve.` : '';
}

function renderMessage(container: HTMLElement, message: string, onDone: () => void, retry?: () => void): void {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col items-center gap-4 px-6 py-16 text-center';

  const p = document.createElement('p');
  p.className = 'text-sm text-ink/50';
  p.textContent = message;
  wrap.appendChild(p);

  if (retry) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'text-sm text-gold underline underline-offset-2';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', retry);
    wrap.appendChild(retryBtn);
  }

  const done = document.createElement('button');
  done.className = 'text-sm text-gold underline underline-offset-2';
  done.textContent = 'Done';
  done.addEventListener('click', onDone);
  wrap.appendChild(done);

  container.appendChild(wrap);
}

// The backend stores handles, not avatars (it never talks to the instance), so
// rows get a deterministic initial-based placeholder instead.
function placeholderAvatar(acct: string): string {
  const letter = (acct.replace(/^@/, '')[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="#F3E8D0"/><text x="36" y="46" font-size="30" text-anchor="middle" fill="#B08947" font-family="sans-serif">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
