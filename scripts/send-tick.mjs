import webpush from 'web-push';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'fs';

const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUBS_DIR } = process.env;
if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing required VAPID env vars');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const subsDir = SUBS_DIR ?? 'subscriptions';
mkdirSync(subsDir, { recursive: true });

const payload = JSON.stringify({ ts: Date.now(), ...(process.env.FORCE === 'true' && { force: true }) });
const expired = [];

for (const file of readdirSync(subsDir).filter(f => f.endsWith('.json'))) {
  const sub = JSON.parse(readFileSync(`${subsDir}/${file}`, 'utf8'));
  try {
    await webpush.sendNotification(sub, payload, { TTL: 45 * 60, urgency: 'high' });
    console.log(`Sent to ${file}`);
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

if (expired.length) console.log(`Removed ${expired.length} expired subscription(s).`);
