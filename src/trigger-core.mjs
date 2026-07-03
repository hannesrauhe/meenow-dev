// Pure trigger-time math shared between the app (src/timer.ts, via Vite) and the
// push relay script (scripts/send-tick.mjs, via Node). Plain ESM + JSDoc so both
// sides consume the same implementation — no environment-specific APIs beyond Intl.

export const WINDOW_START_HOUR = 9;      // 9:00 AM local
export const WINDOW_MINUTES = 12 * 60;   // 9:00 AM – 9:00 PM = 720 min

/** @param {string} s @returns {number} */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** @param {number} seed @returns {number} */
function xorshift32(seed) {
  // Non-zero seed guard: xorshift32 has a fixed point at 0.
  let x = seed === 0 ? 2463534242 : seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/**
 * Minutes past WINDOW_START_HOUR of the trigger for a calendar day.
 * @param {string} dateStr - zero-padded 'YYYY-MM-DD'
 * @returns {number}
 */
export function triggerOffsetMinutes(dateStr) {
  const seed = djb2(dateStr);
  // Three xorshift rounds are needed for adequate mixing: date strings for
  // consecutive days in the same month differ only in the last character,
  // giving djb2 hashes that are too close for a single round to spread across
  // the 720-minute window (every day in June 2026 lands at ~16:50 with one round).
  let x = xorshift32(seed);
  x = xorshift32(x);
  x = xorshift32(x);
  const rand = x / 0x100000000; // uniform [0, 1)
  return Math.floor(rand * WINDOW_MINUTES);
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const dtfCache = new Map();

/** @param {string} tz @returns {Intl.DateTimeFormat} */
function getDtf(tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    // hourCycle 'h23' avoids the hour12:false quirk that formats midnight as "24".
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

/** @param {number} epochMs @param {string} tz @returns {Record<string, string>} */
function partsInZone(epochMs, tz) {
  return Object.fromEntries(getDtf(tz).formatToParts(epochMs).map(p => [p.type, p.value]));
}

/**
 * Zero-padded 'YYYY-MM-DD' for the instant epochMs as seen in IANA zone tz.
 * Padding must match timer.ts's localDateString exactly — djb2 is seeded by it.
 * @param {number} epochMs @param {string} tz @returns {string}
 */
export function dateStringInZone(epochMs, tz) {
  const p = partsInZone(epochMs, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Wall-clock time in tz at instant epochMs, re-encoded as a UTC ms value.
 * @param {number} epochMs @param {string} tz @returns {number}
 */
function wallMsInZone(epochMs, tz) {
  const p = partsInZone(epochMs, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/**
 * Epoch ms of wall-clock dateStr + hour:minute in IANA zone tz.
 * Fixed-point iteration on epoch = desired - offset(epoch); two rounds converge
 * everywhere except inside a DST gap, where the result lands deterministically
 * within ±1h of the (nonexistent) wall time. Irrelevant in practice: the trigger
 * window is 9:00–23:00 local and DST transitions occur at night.
 * @param {string} dateStr @param {number} hour @param {number} minute @param {string} tz
 * @returns {number}
 */
export function zonedEpochMs(dateStr, hour, minute, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const desired = Date.UTC(y, mo - 1, d, hour, minute, 0);
  let epoch = desired;
  for (let i = 0; i < 2; i++) epoch = desired - (wallMsInZone(epoch, tz) - epoch);
  return epoch;
}

/**
 * Today's (in tz) trigger time as epoch ms.
 * @param {number} nowMs @param {string} tz @returns {number}
 */
export function triggerEpochInZone(nowMs, tz) {
  const dateStr = dateStringInZone(nowMs, tz);
  const off = triggerOffsetMinutes(dateStr);
  return zonedEpochMs(dateStr, WINDOW_START_HOUR + Math.floor(off / 60), off % 60, tz);
}
