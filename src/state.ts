export const MAX_POSTS_PER_TRIGGER = 2;

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
