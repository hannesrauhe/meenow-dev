// Component: push-notification opt-in nudge banner (rendered over the feed and awaiting-capture screens).
import { isPushSupported, isNotificationsEnabled, enableNotifications } from '../notifications';
import { isNotificationNudgeDismissed, dismissNotificationNudge } from '../state';

export function removeNotificationNudge(): void {
  document.getElementById('notification-nudge')?.remove();
}

export async function renderNotificationNudge(): Promise<void> {
  if (!isPushSupported() || Notification.permission === 'denied') return;
  if (isNotificationNudgeDismissed()) return;
  if (await isNotificationsEnabled()) return;
  if (document.getElementById('notification-nudge')) return;

  const banner = document.createElement('div');
  banner.id = 'notification-nudge';
  banner.className = [
    'fixed bottom-0 left-0 right-0 z-50',
    'bg-ink text-cream',
    'px-5 pt-4 pb-4 safe-area-bottom',
    'flex items-start gap-4',
    'border-t border-white/10',
  ].join(' ');

  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium leading-snug">Enable daily notifications</p>
      <p class="text-xs text-cream/55 mt-0.5 leading-snug">Get notified once a day when it&#39;s time to post.</p>
    </div>
    <button id="btn-enable-notif" class="shrink-0 bg-gold text-ink rounded-full px-4 py-1.5 text-sm font-medium">Enable</button>
    <button id="btn-dismiss-notif" class="shrink-0 text-cream/40 text-xl leading-none" aria-label="Dismiss">&times;</button>
  `;

  document.body.appendChild(banner);

  banner.querySelector('#btn-enable-notif')?.addEventListener('click', async () => {
    const btn = banner.querySelector('#btn-enable-notif') as HTMLButtonElement;
    btn.textContent = '…';
    btn.disabled = true;
    try {
      const result = await enableNotifications();
      if (result === 'granted' || result === 'denied') {
        banner.remove();
      } else {
        btn.textContent = 'Retry';
        btn.disabled = false;
      }
    } catch {
      btn.textContent = 'Retry';
      btn.disabled = false;
    }
  });

  banner.querySelector('#btn-dismiss-notif')?.addEventListener('click', () => {
    dismissNotificationNudge();
    banner.remove();
  });
}
