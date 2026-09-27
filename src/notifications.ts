// Push notifications: VAPID subscription registration against the meenow PHP
// backend (/push/*), permission request, and PWA-context re-subscription.
import { isPwaInstalled, isPwaSubbed, setPwaSubbed, clearPwaSubbed, getStoredVapidKey, setStoredVapidKey, clearStoredVapidKey, getSyncedTz, setSyncedTz, clearSyncedTz } from './state';
import { PUSH_SUBSCRIBE_URL, PUSH_UNSUBSCRIBE_URL, VAPID_KEY_URL } from './config';
import { getAuthState } from './api/auth';

function deviceTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The VAPID public key is served by the backend (not baked into the bundle), so
// key rotation needs no rebuild. Cached for the session after the first fetch.
let _vapidKey: string | null | undefined;
export async function getVapidPublicKey(): Promise<string | null> {
  if (_vapidKey !== undefined) return _vapidKey;
  try {
    const res = await fetch(VAPID_KEY_URL);
    if (!res.ok) { _vapidKey = null; return null; }
    const { publicKey } = await res.json() as { publicKey?: string };
    _vapidKey = typeof publicKey === 'string' && publicKey ? publicKey : null;
  } catch {
    _vapidKey = null;
  }
  return _vapidKey;
}

async function registerSubscription(sub: PushSubscription): Promise<boolean> {
  try {
    // `account` names the owning meenow account so the backend can attribute the
    // row (logout cleanup, per-account tick gating later). The endpoint URL is
    // the capability; this is metadata, not a credential.
    const acct = getAuthState();
    const res = await fetch(PUSH_SUBSCRIBE_URL, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({
        ...sub.toJSON(),
        tz: deviceTz(),
        account: acct ? `${acct.instance}:${acct.accountId}` : '',
      }),
    });
    if (res.ok) setSyncedTz(deviceTz());
    return res.ok;
  } catch {
    return false;
  }
}

async function unregisterSubscription(sub: PushSubscription): Promise<void> {
  try {
    await fetch(PUSH_UNSUBSCRIBE_URL, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* best-effort; the cron prunes dead endpoints anyway */ }
}

// The push endpoints require a Bearer token like the proxy does — subscriptions
// belong to a logged-in account. Empty when logged out (the request then 401s,
// which every caller here treats as a silent no-op).
function authHeader(): Record<string, string> {
  const token = getAuthState()?.accessToken ?? '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function isPushSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

// Clears the app-icon badge set by the SW's daily reminder. No-op where unsupported.
export function clearAppBadge(): void {
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  void nav.clearAppBadge?.().catch(() => {});
}

export async function isNotificationsEnabled(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

export async function enableNotifications(): Promise<'granted' | 'denied' | 'error'> {
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) {
    console.error('[notifications] VAPID public key unavailable');
    return 'error';
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (err) {
      console.error('[notifications] pushManager.subscribe failed', err);
      return 'error';
    }
  }

  if (!(await registerSubscription(sub))) return 'error';

  isPwaInstalled() ? setPwaSubbed() : clearPwaSubbed();
  setStoredVapidKey(vapidKey);
  return 'granted';
}

// Logout: drop the browser push subscription AND its server row, so a
// disconnected account stops receiving ticks. Best-effort — a failed server
// delete leaves a row that 410-pruning or the next login's upsert removes.
// Call before clearAuth(), which erases the token this request needs.
export async function disableNotifications(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await unregisterSubscription(sub);
    await sub.unsubscribe();
  } catch { /* best-effort */ }
  clearStoredVapidKey();
  clearSyncedTz();
  clearPwaSubbed();
}

// On first launch as an installed PWA, the existing push subscription was
// created in a browser tab — Chrome routes its notifications to Chrome rather
// than to the PWA. Unsubscribe and re-subscribe so the new subscription is
// associated with the standalone context, which makes Android attribute
// notifications to the installed app instead.
export async function resubscribeAsPwa(): Promise<void> {
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      await unregisterSubscription(existing);
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    if (await registerSubscription(sub)) {
      isPwaInstalled() ? setPwaSubbed() : clearPwaSubbed();
      setStoredVapidKey(vapidKey);
    }
  } catch {
    // Silent failure — will retry on the next launch.
  }
}

// Re-registers the current subscription when the device timezone differs from
// the one last written (travel), so the backend gates ticks to the correct local
// trigger window. The backend upserts by endpoint, so this just refreshes tz.
// Failures are silent and retried on the next launch.
export async function syncSubscriptionTz(): Promise<void> {
  if (Notification.permission !== 'granted') return;
  if (getSyncedTz() === deviceTz()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await registerSubscription(sub);
  } catch {
    // Silent failure — will retry on the next launch.
  }
}

// Returns true if the push subscription needs to be recreated — either because
// the VAPID key was rotated or because the subscription was created in a browser
// tab and needs to be re-created in the installed PWA context.
// Also bootstraps meenow:vapid-key on first call so future rotations are detectable.
async function shouldResubscribe(vapidKey: string): Promise<boolean> {
  if (Notification.permission !== 'granted') return false;
  const stored = getStoredVapidKey();
  if (!stored) return true;               // can't verify — re-subscribe to record the key
  if (stored !== vapidKey) return true;   // key rotated
  if (isPwaInstalled() && !isPwaSubbed()) return true; // PWA routing mismatch
  return false;
}

export async function resubscribeIfNeeded(): Promise<void> {
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return;
  if (await shouldResubscribe(vapidKey)) await resubscribeAsPwa();
}
