declare const __GIT_HASH__: string;

import './style.css';
import { getAuthState, handleOAuthCallback } from './api/auth';
import { getLastTriggerTime, computeState, type AppState } from './timer';
import { MAX_POSTS_PER_TRIGGER } from './state';
import { fetchTodayPostCount } from './api/pixelfed';
import { renderCapture } from './screens/capture';
import { renderFeed } from './screens/feed';
import { renderLogin } from './screens/login';
import { renderInstallNudge, removeInstallNudge } from './components/installNudge';

const app = document.getElementById('app')!;
type Screen = AppState | 'login' | 'capturing';
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

function onPosted(): void {
  periodPostCount = Math.min(periodPostCount + 1, MAX_POSTS_PER_TRIGGER);
}

function mountCapture(): void {
  activeScreen = 'capturing';
  app.innerHTML = '';
  removeInstallNudge();
  app.appendChild(renderCapture(periodPostCount, onPosted, () => { activeScreen = null; }));
}

function mount(screen: AppState | 'login'): void {
  app.innerHTML = '';
  if (screen === 'login') app.appendChild(renderLogin());
  else if (screen === 'awaiting_capture') {
    removeInstallNudge();
    app.appendChild(renderCapture(periodPostCount, onPosted, () => { activeScreen = null; }));
    return;
  } else {
    app.appendChild(renderFeed(mountCapture, periodPostCount));
  }
  renderInstallNudge();
}

function tick(): void {
  if (activeScreen === 'capturing') return;

  // Detect when a new trigger period starts while the app is open (e.g. trigger
  // fires at 3 PM while the user is on the countdown after posting twice).
  const currentTriggerMs = getLastTriggerTime().getTime();
  if (currentTriggerMs !== lastKnownTriggerMs) {
    lastKnownTriggerMs = currentTriggerMs;
    periodPostCount = 0;
  }

  const auth = getAuthState();
  const screen: AppState | 'login' = auth ? computeState(periodPostCount) : 'login';

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

  // Start the UI immediately so users see something on every load.
  // Fetch the authoritative post count from the server in the background.
  // If it differs from the initial 0, force a remount via the next tick.
  tick();
  tickId = window.setInterval(tick, 1000);

  const auth = getAuthState();
  if (auth) {
    fetchTodayPostCount(auth)
      .then(count => {
        const fresh = Math.min(count, MAX_POSTS_PER_TRIGGER);
        if (fresh !== periodPostCount) {
          periodPostCount = fresh;
          activeScreen = null;
          tick();
        }
      })
      .catch(() => {});
  }
}

init();

if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (tickId !== null) clearInterval(tickId); });
}
