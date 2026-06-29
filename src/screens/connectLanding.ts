// Connect-landing screen: the target of an invite deep link (?add=user@instance).
// Resolves the handle and offers a one-tap connect. Surfaced after login when the
// recipient followed the link while logged out (the handle is carried through the
// OAuth redirect via localStorage; see main.ts).
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { resolveHandle, fetchRelationships, type Connection, type Relationship } from '../api/social';
import { makeConnectButton } from '../components/connectButton';

export function renderConnectLanding(auth: AuthState, handle: string, onDone: () => void): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-connect';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 py-3 border-b border-ink/10';

  const backBtn = document.createElement('button');
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1';
  backBtn.setAttribute('aria-label', 'Done');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onDone);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'Add friend';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  loadLanding(content, auth, handle, onDone);
  return root;
}

async function loadLanding(
  container: HTMLElement,
  auth: AuthState,
  handle: string,
  onDone: () => void,
): Promise<void> {
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 gap-3 text-center px-6">
      <div class="w-8 h-8 spinner"></div>
      <p class="text-sm text-ink/40">Finding @${escapeHtml(handle.replace(/^@/, ''))}…</p>
    </div>
  `;

  let conn: Connection | null;
  try {
    conn = await resolveHandle(auth, handle);
  } catch {
    conn = null;
  }
  if (!container.isConnected) return;

  if (!conn) {
    renderMessage(container, `Couldn’t find @${handle.replace(/^@/, '')}.`, onDone, () => loadLanding(container, auth, handle, onDone));
    return;
  }
  if (conn.id === auth.accountId) {
    renderMessage(container, 'That’s you! Share your invite link with a friend instead.', onDone);
    return;
  }

  const rels = await fetchRelationships(auth, [conn.id]);
  if (!container.isConnected) return;

  renderCard(container, auth, conn, rels.get(conn.id), onDone);
}

function renderCard(
  container: HTMLElement,
  auth: AuthState,
  conn: Connection,
  rel: Relationship | undefined,
  onDone: () => void,
): void {
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'flex flex-col items-center gap-3 px-6 py-12 text-center';

  const avatar = document.createElement('img');
  avatar.src = conn.avatarUrl;
  avatar.className = 'w-20 h-20 rounded-full object-cover bg-gold-light';
  avatar.alt = '';
  card.appendChild(avatar);

  const name = document.createElement('p');
  name.className = 'text-lg font-semibold text-ink';
  name.textContent = conn.displayName;
  card.appendChild(name);

  const handleEl = document.createElement('p');
  handleEl.className = 'text-sm text-ink/40';
  handleEl.textContent = `@${conn.acct}`;
  card.appendChild(handleEl);

  const status = document.createElement('p');
  status.className = 'text-sm text-ink/50 max-w-xs mt-2 min-h-[2.5rem]';
  if (rel?.following && rel?.followedBy) status.textContent = 'You’re already connected.';
  card.appendChild(status);

  const btn = makeConnectButton(auth, conn.id, rel, (r) => {
    if (r.requested && !r.following) {
      status.textContent = 'Request sent — you’ll see each other’s photos once they approve.';
    } else if (r.following && !r.followedBy) {
      status.textContent = 'Connected — waiting for them to add you back.';
    } else if (r.following && r.followedBy) {
      status.textContent = 'You’re connected!';
    }
  });
  btn.classList.add('mt-1');
  card.appendChild(btn);

  const done = document.createElement('button');
  done.className = 'text-sm text-gold underline underline-offset-2 mt-6';
  done.textContent = 'Done';
  done.addEventListener('click', onDone);
  card.appendChild(done);

  container.appendChild(card);
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

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
