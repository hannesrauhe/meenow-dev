// App entry point: screen mounting/routing, tick loop, overlay navigation (capture, post-detail, grid).
declare const __GIT_HASH__: string;

import './style.css';
import { getAuthState, handleOAuthCallback } from './api/auth';
import { getLastTriggerTime, type AppState } from './timer';
import { MAX_POSTS_PER_TRIGGER } from './state';
import { fetchTodayPostCount } from './api/pixelfed';
import { renderCapture } from './screens/capture';
import { renderFeed } from './screens/feed';
import { renderGrid } from './screens/grid';
import { renderLogin } from './screens/login';
import { renderPostDetail } from './screens/postDetail';
import type { FeedPost } from './api/pixelfed';
import { renderInstallNudge, removeInstallNudge } from './components/installNudge';
import { renderNotificationNudge, removeNotificationNudge } from './components/notificationNudge';
import { registerSW } from 'virtual:pwa-register';
import { idbSet } from './idb';
import { isPwaInstalled, isPwaSubbed } from './state';
import { resubscribeAsPwa } from './notifications';

const app = document.getElementById('app')!;
type Screen = AppState | 'login' | 'capturing' | 'post_detail' | 'grid';
const BASE_SCREENS = new Set<Screen>(['feed', 'login']);
let activeScreen: Screen | null = null;
let tickId: number | null = null;

// Post count for the current trigger period. Fetched from the server on every
// page load so multi-device state is always up-to-date — no localStorage cache.
let periodPostCount = 0;

// Tracks the boundary of the last known trigger period so the tick loop can
// detect when a new period starts (trigger fires while the app is open) and
// reset the in-memory count without requiring a page reload.
let lastKnownTriggerMs = getLastTriggerTime().getTime();

const DEV_HOSTNAMES = new Set(['dev.meenow.de', 'localhost', '127.0.0.1']);
if (DEV_HOSTNAMES.has(window.location.hostname)) {
  const badge = document.createElement('div');
  badge.textContent = `dev ${__GIT_HASH__}`;
  badge.className = 'fixed bottom-3 right-3 bg-gold text-white text-xs font-semibold px-2 py-0.5 rounded-full z-50 opacity-75 pointer-events-none select-none';
  document.body.appendChild(badge);
}

function showUpdateBanner(updateSW: () => Promise<void>): void {
  if (document.getElementById('update-nudge')) return;
  const banner = document.createElement('div');
  banner.id = 'update-nudge';
  banner.className = [
    'fixed top-0 left-0 right-0 z-50',
    'bg-ink text-cream',
    'px-5 pt-4 pb-4',
    'flex items-start gap-4',
    'border-b border-white/10',
  ].join(' ');
  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium leading-snug">New version available</p>
      <p class="text-xs text-cream/55 mt-0.5 leading-snug">Refresh to get the latest update.</p>
    </div>
    <button id="btn-update" class="shrink-0 bg-gold text-ink rounded-full px-4 py-1.5 text-sm font-medium">Refresh</button>
    <button id="btn-dismiss-update" class="shrink-0 text-cream/40 text-xl leading-none" aria-label="Dismiss">&times;</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector('#btn-update')?.addEventListener('click', () => void updateSW());
  banner.querySelector('#btn-dismiss-update')?.addEventListener('click', () => banner.remove());
}

const updateSW = registerSW({
  onNeedRefresh() { showUpdateBanner(updateSW); },
});

function onPosted(): void {
  if (periodPostCount === 0) {
    void idbSet('posted-trigger-ms', getLastTriggerTime().getTime());
  }
  periodPostCount = Math.min(periodPostCount + 1, MAX_POSTS_PER_TRIGGER);
}

function mountCapture(): void {
  activeScreen = 'capturing';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'capturing' }, '');

  const onPopState = () => { activeScreen = null; tick(); };
  window.addEventListener('popstate', onPopState, { once: true });

  app.appendChild(renderCapture(periodPostCount, onPosted, () => {
    history.back();
  }));
}

function mountPostDetail(post: FeedPost, onClose?: () => void): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'post_detail';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'post_detail' }, '');

  const returnTo = onClose ?? tick;
  const onPopState = () => { activeScreen = null; returnTo(); };
  window.addEventListener('popstate', onPopState, { once: true });

  let el: HTMLElement;
  try {
    el = renderPostDetail(post, auth, () => {
      history.back();
    });
  } catch {
    window.removeEventListener('popstate', onPopState);
    history.back();
    activeScreen = null;
    return;
  }

  app.appendChild(el);
}

function mountGrid(): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'grid';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'grid' }, '');

  let popHandler: (() => void) | null = null;

  const installPop = (): void => {
    popHandler = () => { popHandler = null; activeScreen = null; tick(); };
    window.addEventListener('popstate', popHandler, { once: true });
  };

  const openPost = (post: FeedPost): void => {
    if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
    mountPostDetail(post, () => {
      activeScreen = 'grid';
      app.innerHTML = '';
      installPop();
      app.appendChild(renderGrid(auth, openPost, onBack));
    });
  };

  const onBack = (): void => {
    history.back();
  };

  installPop();
  app.appendChild(renderGrid(auth, openPost, onBack));
}

function mount(screen: AppState | 'login'): void {
  app.innerHTML = '';
  if (screen === 'login') {
    removeNotificationNudge();
    app.appendChild(renderLogin());
    renderInstallNudge();
  } else {
    app.appendChild(renderFeed(mountCapture, periodPostCount, mountPostDetail, mountGrid));
    void renderNotificationNudge();
    renderInstallNudge();
  }
}

function tick(): void {
  if (!BASE_SCREENS.has(activeScreen as Screen) && activeScreen !== null) return;

  // Detect when a new trigger period starts while the app is open (e.g. trigger
  // fires at 3 PM while the user is on the countdown after posting twice).
  const currentTriggerMs = getLastTriggerTime().getTime();
  if (currentTriggerMs !== lastKnownTriggerMs) {
    lastKnownTriggerMs = currentTriggerMs;
    periodPostCount = 0;
  }

  const auth = getAuthState();
  const screen: AppState | 'login' = auth ? 'feed' : 'login';

  if ((screen as Screen) !== activeScreen) {
    activeScreen = screen;
    mount(screen);
  }
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    history.replaceState({}, '', window.location.pathname);
    try {
      await handleOAuthCallback(code);
    } catch (err) {
      console.error('OAuth callback error:', err);
    }
  }

  // On first launch as an installed PWA, silently re-subscribe so notifications
  // are routed to the app instead of Chrome.
  if (isPwaInstalled() && Notification.permission === 'granted' && !isPwaSubbed()) {
    void resubscribeAsPwa();
  }

  // Fetch the authoritative post count for the current trigger period from the
  // server before starting the tick loop. This ensures multi-device state is
  // correct from the first render without any localStorage synchronisation logic.
  const auth = getAuthState();
  if (auth) {
    app.innerHTML = `
      <div class="flex items-center justify-center min-h-dvh">
        <div class="w-8 h-8 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
      </div>
    `;
    try {
      periodPostCount = Math.min(await fetchTodayPostCount(auth), MAX_POSTS_PER_TRIGGER);
      if (periodPostCount > 0) {
        void idbSet('posted-trigger-ms', getLastTriggerTime().getTime());
      }
    } catch {
      periodPostCount = 0;
    }
  }

  tick();
  tickId = window.setInterval(tick, 1000);
}

init();

if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (tickId !== null) clearInterval(tickId); });
}
