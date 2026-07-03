import webpush from 'web-push';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { triggerEpochInZone, zonedEpochMs, dateStringInZone } from '../src/trigger-core.mjs';

const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUBS_DIR } = process.env;
const FORCE = process.env.FORCE === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!DRY_RUN && (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)) {
  console.error('Missing required VAPID env vars');
  process.exit(1);
}

// Fallback for legacy subscription files written before the tz field existed.
// Clients self-migrate (rewrite their file with tz) on their next app open.
const DEFAULT_TZ = process.env.DEFAULT_TZ ?? 'Europe/Berlin';
// Ticks are sent while now is in [trigger, trigger + TICK_WINDOW_MIN), plus one
// late-evening "last call" so users who missed the window still get a reminder
// (and users who posted get an engagement/friends digest).
const TICK_WINDOW_MIN = 120;
const LAST_CALL = { hour: 20, minute: 30 }; // local time
const LAST_CALL_ACCEPT_MIN = 30;            // one cron slot

if (!DRY_RUN) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const subsDir = SUBS_DIR ?? 'subscriptions';
mkdirSync(subsDir, { recursive: true });

// NOW override enables deterministic boundary testing of the gating logic.
const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
if (Number.isNaN(now)) {
  console.error(`Invalid NOW: ${process.env.NOW}`);
  process.exit(1);
}

function tickDecision(tz) {
  const trigger = triggerEpochInZone(now, tz);
  const windowEnd = trigger + TICK_WINDOW_MIN * 60_000;
  if (now >= trigger && now < windowEnd) return { send: true, late: false, trigger };
  // Last call only fires when today's trigger window has already closed — this
  // both dedupes against late triggers whose window covers the evening and
  // prevents a pre-trigger last call when the trigger lands after 20:30.
  const lastCall = zonedEpochMs(dateStringInZone(now, tz), LAST_CALL.hour, LAST_CALL.minute, tz);
  if (windowEnd <= lastCall && now >= lastCall && now < lastCall + LAST_CALL_ACCEPT_MIN * 60_000) {
    return { send: true, late: true, trigger };
  }
  return { send: false, late: false, trigger };
}

const iso = ms => new Date(ms).toISOString();
const expired = [];
let sent = 0, skipped = 0;

for (const file of readdirSync(subsDir).filter(f => f.endsWith('.json'))) {
  try {
    const sub = JSON.parse(readFileSync(`${subsDir}/${file}`, 'utf8'));
    const tz = typeof sub.tz === 'string' ? sub.tz : DEFAULT_TZ;
    const { send, late, trigger } = FORCE ? { send: true, late: false, trigger: 0 } : tickDecision(tz);

    if (!send) {
      console.log(`Skipped ${file} (tz=${tz}, trigger=${iso(trigger)}, now=${iso(now)})`);
      skipped++;
      continue;
    }

    const payload = JSON.stringify({ ts: now, ...(late && { late: true }), ...(FORCE && { force: true }) });
    if (DRY_RUN) {
      console.log(`[dry-run] Would send to ${file} (tz=${tz}, late=${late}, now=${iso(now)})`);
      sent++;
      continue;
    }
    await webpush.sendNotification(sub, payload, { TTL: 45 * 60, urgency: 'high' });
    console.log(`Sent to ${file} (tz=${tz}, late=${late})`);
    sent++;
  } catch (err) {
    // 404/410 = expired/unregistered. 400 is not reliable expiry, so keep it.
    if (err instanceof Error && 'statusCode' in err &&
        (err.statusCode === 410 || err.statusCode === 404)) {
      rmSync(`${subsDir}/${file}`);
      expired.push(file);
    } else {
      console.error(`Failed ${file}:`, err);
    }
  }
}

console.log(`Done: ${sent} sent, ${skipped} skipped outside window.`);
if (expired.length) console.log(`Removed ${expired.length} expired subscription(s).`);
