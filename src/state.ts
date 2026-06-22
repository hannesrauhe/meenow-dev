// Persistent local state: localStorage helpers for notification dismiss, install dismiss, and push subscription filename.
export const MAX_POSTS_PER_TRIGGER = 2;

export function isNotificationNudgeDismissed(): boolean {
  const raw = localStorage.getItem('meenow:notif-dismiss');
  if (!raw) return false;
  return Date.now() - Number(raw) < 30 * 24 * 60 * 60 * 1000;
}

export function dismissNotificationNudge(): void {
  localStorage.setItem('meenow:notif-dismiss', String(Date.now()));
}

// Tracks the filename written to the subscriptions repo so we don't create
// duplicate files if the user re-enables notifications on the same device.
export function getPushSubFilename(): string | null {
  return localStorage.getItem('meenow:push-sub-file');
}

export function setPushSubFilename(filename: string): void {
  localStorage.setItem('meenow:push-sub-file', filename);
}

export function clearPushSubFilename(): void {
  localStorage.removeItem('meenow:push-sub-file');
}

// Set when the active push subscription was created in PWA standalone mode.
// Until this is set, the subscription was created in a browser tab and Chrome
// routes its notifications to Chrome rather than to the installed PWA.
export function isPwaSubbed(): boolean {
  return localStorage.getItem('meenow:pwa-subbed') === 'true';
}

export function setPwaSubbed(): void {
  localStorage.setItem('meenow:pwa-subbed', 'true');
}

export function isInstallDismissed(): boolean {
  const raw = localStorage.getItem('meenow:install-dismiss');
  if (!raw) return false;
  return Date.now() - Number(raw) < 7 * 24 * 60 * 60 * 1000;
}

export function dismissInstall(): void {
  localStorage.setItem('meenow:install-dismiss', String(Date.now()));
}

export function isPwaInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
