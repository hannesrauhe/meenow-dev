// Deterministic daily trigger time using djb2 hash + xorshift32 PRNG seeded by local date.
//
// Terminology used throughout this codebase:
//   trigger time      – the pseudo-random moment within a day when users are prompted to post.
//   last trigger time – the most recent trigger time that has already fired.
//   next trigger time – the upcoming trigger time that has not yet fired.
//   trigger period    – the interval [last trigger time, next trigger time).
//                       Users may post up to MAX_POSTS_PER_TRIGGER times within this period
//                       and see friends' posts from this period in the feed.
//
// The trigger time for a given calendar day is deterministic: the same date always yields
// the same wall-clock moment, so it is stable across app restarts without any server
// coordination.

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

function localDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getTriggerForDate(d: Date): Date {
  const seed = djb2(localDateString(d));
  // Three xorshift rounds are needed for adequate mixing: date strings for
  // consecutive days in the same month differ only in the last character,
  // giving djb2 hashes that are too close for a single round to spread across
  // the 720-minute window (every day in June 2026 lands at ~16:50 with one round).
  let x = xorshift32(seed);
  x = xorshift32(x);
  x = xorshift32(x);
  const rand = x / 0x100000000; // uniform [0, 1)
  const offsetMinutes = Math.floor(rand * WINDOW_MINUTES);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), WINDOW_START_HOUR, offsetMinutes, 0, 0);
}

function getTodayTrigger(): Date {
  return getTriggerForDate(new Date());
}

// Returns the trigger time of the current trigger period (the most recent trigger that has fired).
// If the current wall-clock time is before today's trigger, the last trigger time is from yesterday.
export function getLastTriggerTime(): Date {
  const todayTrigger = getTodayTrigger();
  if (Date.now() >= todayTrigger.getTime()) {
    return todayTrigger;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return getTriggerForDate(yesterday);
}

// Returns the trigger time of the next trigger period (the next trigger that has not yet fired).
// If the current wall-clock time is before today's trigger, the next trigger time is today's.
// Otherwise it is tomorrow's.
export function getNextTriggerTime(): Date {
  const todayTrigger = getTodayTrigger();
  if (Date.now() < todayTrigger.getTime()) {
    return todayTrigger;
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getTriggerForDate(tomorrow);
}

export type AppState = 'awaiting_capture' | 'feed';

// postCount: number of posts made in the current trigger period (fetched from server on load).
//            0 posts → awaiting_capture regardless of time of day (no trigger gate).
export function computeState(postCount: number): AppState {
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

// Compact date+time string for displaying the trigger period in the UI, e.g. "Jun 14, 2:30 PM".
export function formatShortDateTime(d: Date): string {
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
