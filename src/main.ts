// App entry point: screen mounting/routing, tick loop, overlay navigation (capture, post-detail, grid).
declare const __GIT_HASH__: string;

import './style.css';
import { getAuthState, handleOAuthCallback } from './api/auth';
import { getLastTriggerTime, type AppState } from './timer';
import { MAX_POSTS_PER_TRIGGER } from './state';
import { fetchTodayPostCount, deletePost, removePostFromCache } from './api/pixelfed';
import { renderCapture } from './screens/capture';
import { renderFeed } from './screens/feed';
import { renderGrid } from './screens/grid';
import { renderLogin } from './screens/login';
import { renderPostDetail } from './screens/postDetail';
import type { FeedPost } from './api/pixelfed';
import { renderInstallNudge, removeInstallNudge } from './components/installNudge';
import { renderNotificationNudge, removeNotificationNudge } from './components/notificationNudge';
import { registerSW } from 'virtual:pwa-register';
import { idbSet, IDB_KEYS } from './idb';
import { resubscribeIfNeeded } from './notifications';

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

function showUpdateBanner(updateSW: (reloadPage?: boolean) => Promise<void>): void {
  if (document.getElementById('update-nudge')) return;
  const banner = document.createElement('div');
  banner.id = 'update-nudge';
  banner.className = [
    'fixed top-0 left-0 right-0 z-50',
    'bg-ink text-cream',
    'px-5 pb-4',
    'flex items-start gap-4',
    'border-b border-white/10',
  ].join(' ');
  // Clear the standalone status-bar / display-cutout inset (index.html sets
  // viewport-fit=cover) so the Refresh button is never under the status bar.
  banner.style.paddingTop = 'calc(env(safe-area-inset-top, 0px) + 1rem)';
  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium leading-snug">New version available</p>
      <p id="update-status" class="text-xs text-cream/55 mt-0.5 leading-snug">Refresh to get the latest update.</p>
    </div>
    <button id="btn-update" class="shrink-0 bg-gold text-ink rounded-full px-4 py-1.5 text-sm font-medium">Refresh</button>
    <button id="btn-dismiss-update" class="shrink-0 text-cream/40 text-xl leading-none" aria-label="Dismiss">&times;</button>
  `;
  document.body.appendChild(banner);

  const btn = banner.querySelector<HTMLButtonElement>('#btn-update')!;
  const status = banner.querySelector<HTMLParagraphElement>('#update-status')!;
  btn.addEventListener('click', () => void applyUpdate(btn, status, updateSW));
  banner.querySelector('#btn-dismiss-update')?.addEventListener('click', () => banner.remove());
}

// Drive the reload ourselves rather than relying on vite-plugin-pwa's
// isUpdate-gated reload, which does not fire reliably in an installed PWA.
// Reload on the new worker reaching 'activated' OR on controllerchange; a long
// safety timeout is the last resort. The reloaded guard prevents a double
// reload. The NavigationRoute in sw.ts ensures the reloaded document is the
// fresh precached index.html (not the stale HTTP-cached one). On dev hostnames
// the banner subtitle shows a live lifecycle trace (no debugger on the phone).
async function applyUpdate(
  btn: HTMLButtonElement,
  status: HTMLParagraphElement,
  updateSW: (reloadPage?: boolean) => Promise<void>,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Updating…';

  const isDev = DEV_HOSTNAMES.has(window.location.hostname);
  const trace = (msg: string): void => {
    if (!isDev) return;
    status.textContent = status.textContent ? `${status.textContent} → ${msg}` : msg;
  };
  if (isDev) status.textContent = '';
  trace('start');

  let reloaded = false;
  const reloadOnce = (reason: string): void => {
    if (reloaded) return;
    reloaded = true;
    trace(`reloading (${reason})`);
    window.location.reload();
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener(
      'controllerchange', () => reloadOnce('controllerchange'), { once: true });
  }
  // Last resort only — real progress comes from activation / controllerchange.
  window.setTimeout(() => reloadOnce('timeout fallback'), 10000);

  try {
    await updateSW(true);
  } catch { /* the signals below still guarantee progress */ }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const waiting = reg?.waiting;
      if (waiting) {
        trace(`waiting (${waiting.state})`);
        waiting.addEventListener('statechange', () => {
          trace(waiting.state);
          if (waiting.state === 'activated') reloadOnce('activated');
        });
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        trace('no waiting worker found');
      }
    } catch { trace('getRegistration failed'); }
  }
}

const updateSW = registerSW({
  onNeedRefresh() { showUpdateBanner(updateSW); },
});

function onPosted(): void {
  if (periodPostCount === 0) {
    void idbSet(IDB_KEYS.postedTriggerMs, getLastTriggerTime().getTime());
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

  const onDeletePost = async (): Promise<void> => {
    await deletePost(auth, post.id);
    removePostFromCache(post.id);
    history.back();
  };

  let el: HTMLElement;
  try {
    el = renderPostDetail(post, auth, () => {
      history.back();
    }, onDeletePost);
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
    // Show only one bottom banner — both are fixed bottom-0 and would overlap.
    const installShown = renderInstallNudge();
    if (!installShown) void renderNotificationNudge();
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

  // Re-subscribe if the VAPID key was rotated or if the subscription was created
  // in a browser tab and needs to be re-created in the installed PWA context.
  void resubscribeIfNeeded();

  // Fetch the authoritative post count for the current trigger period from the
  // server before starting the tick loop. This ensures multi-device state is
  // correct from the first render without any localStorage synchronisation logic.
  const auth = getAuthState();
  if (auth) {
    // Mirror auth into IndexedDB so the service worker can fetch engagement on
    // wake (it cannot read localStorage).
    void idbSet(IDB_KEYS.auth, { instance: auth.instance, accessToken: auth.accessToken, accountId: auth.accountId });
    app.innerHTML = `
      <div class="flex items-center justify-center min-h-dvh">
        <div class="w-8 h-8 spinner"></div>
      </div>
    `;
    try {
      periodPostCount = Math.min(await fetchTodayPostCount(auth), MAX_POSTS_PER_TRIGGER);
      if (periodPostCount > 0) {
        void idbSet(IDB_KEYS.postedTriggerMs, getLastTriggerTime().getTime());
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
