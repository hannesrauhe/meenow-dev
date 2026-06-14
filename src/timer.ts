// Deterministic daily trigger using djb2 hash + xorshift32 PRNG seeded by local date.
// Same calendar day always yields the same trigger time, so re-opening the app
// shows a consistent countdown without any server coordination.

const WINDOW_START_HOUR = 9;      // 9:00 AM local
const WINDOW_MINUTES = 12 * 60;   // 9:00 AM – 9:00 PM = 720 min

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function xorshift32(seed: number): number {
  // Non-zero seed guard: xorshift32 has a fixed point at 0.
  let x = seed === 0 ? 2463534242 : seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export function localDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getTodayTrigger(): Date {
  const seed = djb2(localDateString());
  const rand = xorshift32(seed) / 0x100000000; // uniform [0, 1)
  const offsetMinutes = Math.floor(rand * WINDOW_MINUTES);

  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    WINDOW_START_HOUR,
    offsetMinutes,
    0,
    0,
  );
}

export function getWindowStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), WINDOW_START_HOUR, 0, 0, 0);
}

export type AppState = 'before_trigger' | 'awaiting_capture' | 'feed';

export function computeState(trigger: Date, postCount: number, isNewUser: boolean): AppState {
  if (!isNewUser && postCount === 0 && Date.now() < trigger.getTime()) return 'before_trigger';
  if (postCount === 0) return 'awaiting_capture';
  return 'feed';
}

export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatWallTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
