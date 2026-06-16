import webpush from 'web-push';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'fs';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const subsDir = process.env.SUBS_DIR ?? 'subscriptions';
mkdirSync(subsDir, { recursive: true });
const payload = JSON.stringify({ ts: Date.now() });
const expired = [];

for (const file of readdirSync(subsDir).filter(f => f.endsWith('.json'))) {
  const sub = JSON.parse(readFileSync(`${subsDir}/${file}`, 'utf8'));
  try {
    await webpush.sendNotification(sub, payload, { TTL: 45 * 60 });
    console.log(`Sent to ${file}`);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      rmSync(`${subsDir}/${file}`);
      expired.push(file);
    } else {
      console.error(`Failed ${file}: ${err.statusCode} ${err.message}`);
    }
  }
}

if (expired.length) console.log(`Removed ${expired.length} expired subscription(s).`);
