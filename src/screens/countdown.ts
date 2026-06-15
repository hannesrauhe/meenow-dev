import { getLastTriggerTime, getNextTriggerTime, formatCountdown, formatWallTime, formatShortDateTime } from '../timer';

const RADIUS = 88;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function renderCountdown(): HTMLElement {
  const nextTrigger = getNextTriggerTime();
  const lastTrigger = getLastTriggerTime();
  const el = document.createElement('div');
  el.className = 'screen gap-10';
  el.id = 'screen-countdown';

  el.innerHTML = `
    <div class="text-center">
      <h1 class="text-3xl font-semibold tracking-tight text-ink">meenow</h1>
      <p class="text-sm text-ink/40 mt-1">today's moment</p>
    </div>

    <div class="relative flex items-center justify-center" style="width:220px;height:220px">
      <svg width="220" height="220" viewBox="0 0 220 220"
           class="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="110" cy="110" r="${RADIUS}"
          fill="none" stroke="#C9A96E" stroke-opacity="0.18" stroke-width="7"/>
        <circle id="countdown-arc" cx="110" cy="110" r="${RADIUS}"
          fill="none" stroke="#C9A96E" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${CIRCUMFERENCE.toFixed(2)}"
          stroke-dashoffset="${CIRCUMFERENCE.toFixed(2)}"/>
      </svg>

      <div class="relative flex flex-col items-center gap-1 text-center">
        <span id="countdown-remaining"
              class="text-4xl font-bold tracking-tighter text-ink tabular-nums"
              aria-live="polite" aria-label="time remaining"></span>
        <span class="text-xs text-ink/40 uppercase tracking-widest">remaining</span>
      </div>
    </div>

    <div class="text-center space-y-1">
      <p class="text-sm text-ink/70">
        Purr-fectly on time at
        <strong class="text-ink">${formatWallTime(nextTrigger)}</strong>
      </p>
      <p class="text-xs text-ink/40">Come back then to take your daily photo</p>
    </div>

    <p class="text-xs text-ink/25 text-center mt-8">
      Meenow is an experimental side project by
      <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>
    </p>
    <p class="text-xs text-ink/20 text-center">
      Trigger period: ${formatShortDateTime(lastTrigger)} → ${formatShortDateTime(nextTrigger)}
    </p>
  `;

  return el;
}

export function updateCountdownDisplay(nextTrigger: Date): void {
  const lastTrigger = getLastTriggerTime();
  const now = Date.now();
  const remaining = nextTrigger.getTime() - now;
  const totalMs = nextTrigger.getTime() - lastTrigger.getTime();
  const elapsed = now - lastTrigger.getTime();
  const progress = Math.min(1, Math.max(0, elapsed / totalMs));

  const remainingEl = document.getElementById('countdown-remaining');
  if (remainingEl) remainingEl.textContent = formatCountdown(remaining);

  const arc = document.getElementById('countdown-arc');
  if (arc) {
    const offset = CIRCUMFERENCE * (1 - progress);
    arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
  }
}
