// Group roster screen: the admin's management view. Lists the group's members,
// lets the admin remove one (which bans them and tells every member's device to
// sever the follow), and lists the people who have been removed so the admin can
// restore one.
//
// Reached only from the Circle's Groups section, and only for the group's admin —
// the oldest member, a fact the backend derives rather than stores. A non-admin
// who somehow lands here sees the roster but no controls, and the server refuses
// every action anyway: the admin check lives there, not here.
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import {
  fetchGroup, removeMember, unbanMember, accountKey,
  GroupApiError, type GroupBan, type GroupMember,
} from '../api/groups';
import { makeAccountRow } from '../components/accountRow';

export function renderGroupMembers(
  auth: AuthState,
  groupId: string,
  onBack: () => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-group-members';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] border-b border-ink/10';

  const backBtn = document.createElement('button');
  // [&>svg]:size-5 keeps the chevron visible on iOS (a viewBox-only SVG collapses
  // to 0×0 as a flex item otherwise).
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1 [&>svg]:size-5';
  backBtn.setAttribute('aria-label', 'Back to circle');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'Group members';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  load(content, auth, groupId);
  return root;
}

async function load(container: HTMLElement, auth: AuthState, groupId: string): Promise<void> {
  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 spinner"></div>
    </div>
  `;

  let group;
  try {
    group = await fetchGroup(auth, groupId);
  } catch (err) {
    if (!container.isConnected) return;
    const gone = err instanceof GroupApiError && err.code === 'group_not_found';
    const debug = err instanceof GroupApiError ? err.debug : undefined;
    renderMessage(container, gone
      ? 'This group no longer exists.'
      : debug ?? 'Could not load the group.', () => load(container, auth, groupId));
    return;
  }
  if (!container.isConnected) return;

  container.innerHTML = '';
  const me = accountKey(auth);

  const intro = document.createElement('div');
  intro.className = 'px-6 pt-6 pb-2';
  const name = document.createElement('p');
  name.className = 'text-base font-semibold text-ink';
  name.textContent = group.name;
  intro.appendChild(name);
  const hint = document.createElement('p');
  hint.className = 'text-xs text-ink/40 mt-1';
  hint.textContent = group.admin
    ? 'You run this group. Removing someone also disconnects them from everyone in it.'
    : 'Members of this group.';
  intro.appendChild(hint);
  container.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'border-t border-ink/10';
  for (const m of group.members) {
    list.appendChild(memberRow(auth, group.id, m, me, group.admin, () => load(container, auth, groupId)));
  }
  container.appendChild(list);

  // The ban list is admin-only and only appears once there is someone to restore,
  // so a healthy group shows nothing extra.
  if (group.admin && group.bans.length > 0) {
    container.appendChild(makeSectionHeading('Removed'));
    const banList = document.createElement('div');
    banList.className = 'border-t border-ink/10';
    for (const b of group.bans) {
      banList.appendChild(banRow(auth, group.id, b, () => load(container, auth, groupId)));
    }
    container.appendChild(banList);
  }
}

function memberRow(
  auth: AuthState,
  groupId: string,
  m: GroupMember,
  me: string,
  isAdmin: boolean,
  reload: () => void,
): HTMLElement {
  const isSelf = m.account === me;
  const { row, actions } = makeAccountRow({
    displayName: m.acct.split('@')[0] || m.acct,
    handle: m.acct,
    avatarUrl: placeholderAvatar(m.acct),
  });

  if (isSelf) {
    const tag = document.createElement('span');
    tag.className = 'text-xs text-ink/30';
    tag.textContent = 'You';
    actions.appendChild(tag);
    return row;
  }

  if (!isAdmin) return row;

  // Two-tap confirm, matching the Leave pill in the Circle: the same 3-second
  // revert, so an accidental first tap expires on its own.
  const btn = document.createElement('button');
  const IDLE = 'text-xs rounded-full px-3 py-1.5 border border-ink/10 text-ink/30';
  const ARMED = 'text-xs rounded-full px-3 py-1.5 border border-gold/40 text-gold';
  btn.className = IDLE;
  btn.textContent = 'Remove';
  let confirming = false;

  btn.addEventListener('click', () => {
    if (!confirming) {
      confirming = true;
      btn.textContent = 'Sure?';
      btn.className = ARMED;
      window.setTimeout(() => {
        if (!confirming || !btn.isConnected) return;
        confirming = false;
        btn.textContent = 'Remove';
        btn.className = IDLE;
      }, 3000);
      return;
    }
    btn.disabled = true;
    btn.textContent = '…';
    // Awaited before reloading on purpose: a removed row that reappears because
    // the request was still in flight is worse than a momentary spinner.
    void removeMember(auth, groupId, m.account).then(reload).catch((err) => {
      btn.disabled = false;
      btn.textContent = 'Try again';
      showDebug(container, err);
    });
  });

  actions.appendChild(btn);
  return row;
}

function banRow(auth: AuthState, groupId: string, b: GroupBan, reload: () => void): HTMLElement {
  const { row, actions } = makeAccountRow({
    displayName: b.acct.split('@')[0] || b.acct,
    handle: b.acct,
    avatarUrl: placeholderAvatar(b.acct),
  });

  const btn = document.createElement('button');
  btn.className = 'text-xs rounded-full px-3 py-1.5 border border-gold/40 text-gold';
  btn.textContent = 'Restore';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '…';
    // Lifting the block only: they come back the way anyone does, through a fresh
    // invite link — which is also what shows they still want in.
    void unbanMember(auth, groupId, b.account).then(reload).catch((err) => {
      btn.disabled = false;
      btn.textContent = 'Try again';
      showDebug(container, err);
    });
  });
  actions.appendChild(btn);
  return row;
}

function makeSectionHeading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'text-xs font-semibold text-ink/40 px-4 pt-4 pb-1 uppercase tracking-wider';
  h.textContent = text;
  return h;
}

// Server debug mode: append the real error under the roster. No-op unless the
// response carried debug text.
function showDebug(container: HTMLElement, err: unknown): void {
  if (!(err instanceof GroupApiError) || !err.debug) return;
  let box = container.querySelector('#debug-error');
  if (!box) {
    box = document.createElement('p');
    box.id = 'debug-error';
    box.className = 'text-xs text-red-600 font-mono px-6 py-3 break-all whitespace-pre-wrap';
    container.appendChild(box);
  }
  box.textContent = err.debug;
}

function renderMessage(container: HTMLElement, message: string, retry: () => void): void {
  container.innerHTML = `
    <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
      <p class="text-sm text-ink/50"></p>
    </div>
  `;
  // textContent, not innerHTML: `message` can be raw server error text.
  container.querySelector('p')!.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'block mx-auto text-sm text-gold underline underline-offset-2';
  btn.textContent = 'Retry';
  btn.addEventListener('click', retry);
  container.appendChild(btn);
}

// The backend stores handles, not avatars (it never talks to the instance), so
// rows get a deterministic initial-based placeholder instead. Shared shape with
// the join screen's rows, so the two lists look alike.
function placeholderAvatar(acct: string): string {
  const letter = (acct.replace(/^@/, '')[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="#F3E8D0"/><text x="36" y="46" font-size="30" text-anchor="middle" fill="#B08947" font-family="sans-serif">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
