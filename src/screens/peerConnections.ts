// Peer-connections screen: a plain list of who a circle member is connected to,
// with a one-tap mutual connect per row. Strictly pull-driven — no ranking, no
// suggestions. Reached by tapping a member on the circle screen.
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchConnections, fetchRelationships, type Connection, type ConnectionKind } from '../api/social';
import { makeAccountRow } from '../components/accountRow';
import { makeConnectButton } from '../components/connectButton';

export function renderPeerConnections(auth: AuthState, peer: Connection, onBack: () => void): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-peer';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] border-b border-ink/10';

  const backBtn = document.createElement('button');
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1';
  backBtn.setAttribute('aria-label', 'Back');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink truncate';
  title.textContent = peer.displayName;
  header.appendChild(title);

  root.appendChild(header);

  // Following / Followers toggle.
  const tabs = document.createElement('div');
  tabs.className = 'flex border-b border-ink/8';
  const content = document.createElement('div');
  content.className = 'flex-1';

  let kind: ConnectionKind = 'following';
  const makeTab = (label: string, value: ConnectionKind): HTMLButtonElement => {
    const tab = document.createElement('button');
    tab.textContent = label;
    tab.dataset.kind = value;
    tab.className = 'flex-1 py-2.5 text-sm font-medium';
    tab.addEventListener('click', () => {
      if (kind === value) return;
      kind = value;
      paintTabs();
      loadList(content, auth, peer, kind);
    });
    return tab;
  };
  const followingTab = makeTab('Following', 'following');
  const followersTab = makeTab('Followers', 'followers');
  const paintTabs = (): void => {
    for (const tab of [followingTab, followersTab]) {
      const active = tab.dataset.kind === kind;
      tab.className = `flex-1 py-2.5 text-sm font-medium ${active ? 'text-ink border-b-2 border-gold' : 'text-ink/40'}`;
    }
  };
  tabs.appendChild(followingTab);
  tabs.appendChild(followersTab);
  paintTabs();

  root.appendChild(tabs);
  root.appendChild(content);

  loadList(content, auth, peer, kind);
  return root;
}

async function loadList(
  container: HTMLElement,
  auth: AuthState,
  peer: Connection,
  kind: ConnectionKind,
): Promise<void> {
  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 spinner"></div>
    </div>
  `;

  let conns: Connection[];
  try {
    conns = await fetchConnections(auth, peer.id, kind);
  } catch {
    // hide_collections or a non-2xx: present as nothing to show, not an error.
    conns = [];
  }
  if (!container.isConnected) return;

  conns = conns.filter(c => c.id !== auth.accountId);

  if (conns.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <p class="text-sm">No connections to show.</p>
      </div>
    `;
    return;
  }

  const rels = await fetchRelationships(auth, conns.map(c => c.id));
  if (!container.isConnected) return;

  container.innerHTML = '';
  for (const c of conns) {
    const { row, actions } = makeAccountRow({ displayName: c.displayName, handle: c.acct, avatarUrl: c.avatarUrl });
    actions.appendChild(makeConnectButton(auth, c.id, rels.get(c.id)));
    container.appendChild(row);
  }
}
