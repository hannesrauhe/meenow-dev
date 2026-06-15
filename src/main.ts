declare const __GIT_HASH__: string;

import './style.css';
import { getAuthState, handleOAuthCallback } from './api/auth';
import { getTodayTrigger, computeState, type AppState } from './timer';
import { MAX_POSTS_PER_TRIGGER } from './state';
import { fetchTodayPostCount } from './api/pixelfed';
import { renderCountdown, updateCountdownDisplay } from './screens/countdown';
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
  else if (screen === 'before_trigger') app.appendChild(renderCountdown());
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

  const trigger = getTodayTrigger();
  const auth = getAuthState();
  const screen: AppState | 'login' = auth
    ? computeState(trigger, periodPostCount)
    : 'login';

  if ((screen as Screen) !== activeScreen) {
    activeScreen = screen;
    mount(screen);
  }

  if (screen === 'before_trigger') {
    updateCountdownDisplay(trigger);
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
