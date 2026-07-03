// Component: PWA install-to-home-screen nudge banner (rendered over the feed and login screens).
import { isPwaInstalled, isInstallDismissed, dismissInstall, isIOS } from '../state';

type BeforeInstallPromptEvent = Event & { prompt(): Promise<void> };
let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
});

// True once the browser has offered a native install prompt (Android/desktop Chrome).
export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export async function promptInstall(): Promise<void> {
  if (deferredPrompt) await deferredPrompt.prompt();
}

export function removeInstallNudge(): void {
  document.getElementById('install-nudge')?.remove();
}

// Returns true if a banner is on screen, so callers can skip a second one.
export function renderInstallNudge(): boolean {
  if (isPwaInstalled() || isInstallDismissed()) return false;
  const existing = document.getElementById('install-nudge');
  if (existing) return true;

  const ios = isIOS();
  const canPrompt = !ios && canPromptInstall();

  let instructions: string;
  if (ios) {
    instructions = 'Tap <strong>Share ↑</strong> then <strong>Add to Home Screen</strong>.';
  } else if (canPrompt) {
    instructions = 'Get the full native experience with notifications.';
  } else {
    instructions = 'Open your browser menu and tap <strong>Add to Home Screen</strong>.';
  }

  const banner = document.createElement('div');
  banner.id = 'install-nudge';
  banner.className = [
    'fixed bottom-0 left-0 right-0 z-50',
    'bg-ink text-cream',
    'px-5 pt-4 pb-4 safe-area-bottom',
    'flex items-start gap-4',
    'border-t border-white/10',
  ].join(' ');

  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium leading-snug">Add meenow to your home screen</p>
      <p class="text-xs text-cream/55 mt-0.5 leading-snug">${instructions}</p>
    </div>
    ${canPrompt ? '<button id="btn-install" class="shrink-0 bg-gold text-ink rounded-full px-4 py-1.5 text-sm font-medium">Install</button>' : ''}
    <button id="btn-dismiss-install" class="shrink-0 text-cream/40 text-xl leading-none" aria-label="Dismiss">&times;</button>
  `;

  document.body.appendChild(banner);

  banner.querySelector('#btn-install')?.addEventListener('click', async () => {
    if (canPromptInstall()) {
      await promptInstall();
      banner.remove();
    }
  });

  banner.querySelector('#btn-dismiss-install')?.addEventListener('click', () => {
    dismissInstall();
    banner.remove();
  });
  return true;
}
