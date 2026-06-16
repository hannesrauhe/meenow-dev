// These are injected at build time from GitHub repo secrets (VITE_* prefix).
// Each deployed instance (dev.meenow.de, meenow.de) has its own secret values,
// which keeps their VAPID keys and subscription sets isolated.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;
const PUSH_RELAY_TOKEN = import.meta.env.VITE_PUSH_RELAY_TOKEN as string;
const PUSH_RELAY_REPO = 'meenow-de/meenow-push';
// e.g. 'subscriptions/dev' or 'subscriptions/prod'
const PUSH_SUBS_PATH = import.meta.env.VITE_PUSH_SUBS_PATH as string;

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

  const filename = `${PUSH_SUBS_PATH}/${crypto.randomUUID()}.json`;
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
