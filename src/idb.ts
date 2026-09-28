const DB_NAME = 'meenow';
const STORE = 'kv';
const DB_VERSION = 1;

// Keys shared between the app and the service worker.
export const IDB_KEYS = {
  postedTriggerMs: 'posted-trigger-ms',
  auth: 'auth',
  lastSeenNotifId: 'last-seen-notif-id',
  digestShownTriggerMs: 'digest-shown-trigger-ms',
  silentPushCount: 'silent-push-count',
  // Daily-reminder ladder: which trigger period it belongs to and how many
  // reminders of that period have been shown. Keyed by trigger so it self-resets
  // every period with no cleanup, like digestShownTriggerMs.
  dailyShownTriggerMs: 'daily-shown-trigger-ms',
  dailyShownCount: 'daily-shown-count',
  // Highest group_events id this device has already acted on. Both the push
  // handler and the app's catch-up poll write it, and both read it first, so a
  // join delivered twice is approved once.
  groupEventSeen: 'group-event-seen',
  // Accounts banned from a group this device belongs to, as ["<groupId>",
  // "<account>"] pairs. Needed because a banned person's follow request outlives
  // their membership, so auto-approve must consult it — otherwise the next
  // request would be approved and quietly undo the kick.
  groupBans: 'group-bans',
} as const;

export interface StoredAuth {
  instance: string;
  accessToken: string;
  accountId: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
