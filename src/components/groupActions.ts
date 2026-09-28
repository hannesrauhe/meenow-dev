// Invite / Leave pills for a group, shared by the circle's Groups section and
// the roster screen. Minting a fresh invite per share is what makes a forwarded
// link a non-event; Leave is two-tap like every disconnect.
import type { AuthState } from '../api/auth';
import { createInvite, leaveGroup } from '../api/groups';

const GOLD = 'text-xs rounded-full px-3 py-1.5 border border-gold/40 text-gold';
const MUTED = 'text-xs rounded-full px-3 py-1.5 border border-ink/10 text-ink/30';

export function makeGroupInviteButton(auth: AuthState, groupId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = GOLD;
  btn.textContent = 'Invite';
  btn.addEventListener('click', () => void shareGroup(auth, groupId, btn));
  return btn;
}

export function makeGroupLeaveButton(auth: AuthState, groupId: string, onLeft: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = MUTED;
  btn.textContent = 'Leave';
  let confirming = false;
  btn.addEventListener('click', () => {
    if (!confirming) {
      confirming = true;
      btn.textContent = 'Sure?';
      btn.className = GOLD;
      window.setTimeout(() => {
        if (!confirming || !btn.isConnected) return;
        confirming = false;
        btn.textContent = 'Leave';
        btn.className = MUTED;
      }, 3000);
      return;
    }
    btn.disabled = true;
    void leaveGroup(auth, groupId).then(onLeft).catch(() => {
      btn.disabled = false;
      btn.textContent = 'Try again';
    });
  });
  return btn;
}

async function shareGroup(auth: AuthState, groupId: string, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  let url: string;
  try {
    const invite = await createInvite(auth, groupId);
    url = `${window.location.origin}/?join=${encodeURIComponent(invite.token)}`;
  } catch {
    btn.disabled = false;
    btn.textContent = 'Try again';
    window.setTimeout(() => { btn.textContent = original; }, 2000);
    return;
  }
  btn.disabled = false;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'meenow', text: 'Join my meenow group', url });
      btn.textContent = original;
      return;
    } catch { /* user cancelled or share failed — fall back to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  window.setTimeout(() => { btn.textContent = original; }, 2000);
}
