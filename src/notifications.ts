const VAPID_PUBLIC_KEY = 'BB9x-5V5iQvI8gJNjw0dKzjWC5VC06xYT5VgW8_UKsz_Heh6_z1LWrsHJtI7Gw5ukxt9Lza_-gcDtJbOrLtCvfw';
// Fine-grained PAT: Contents:Write on meenow-de/meenow-push only.
// Risk if leaked: attacker can create/delete subscription files but cannot send
// push notifications (that requires the VAPID private key, stored as a server-side secret).
const PUSH_RELAY_TOKEN = 'REPLACE_WITH_FINE_GRAINED_PAT';
const PUSH_RELAY_REPO = 'meenow-de/meenow-push';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function isNotificationsEnabled(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

export async function enableNotifications(): Promise<'granted' | 'denied' | 'error'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const filename = `subscriptions/${crypto.randomUUID()}.json`;
  const content = btoa(JSON.stringify(sub.toJSON()));
  const res = await fetch(
    `https://api.github.com/repos/${PUSH_RELAY_REPO}/contents/${filename}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${PUSH_RELAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Add subscription', content }),
    }
  );
  return res.ok ? 'granted' : 'error';
}
