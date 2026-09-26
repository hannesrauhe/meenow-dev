// meenow's home Pixelfed instance. All users are expected to live here: the
// daily-vanish promise relies on Pixelfed's archive API, which is a local-only
// visibility change — copies already delivered to followers on other instances
// are never retracted, so cross-instance posts don't actually vanish. Within
// one instance the archive works perfectly (and the My Photos grid depends on
// it). Other instances remain reachable via the manual field on the login
// screen but are unsupported — some (e.g. gram.social, pixelfed.de) send no
// CORS headers at all, which makes browser-based access impossible.
export const HOME_INSTANCE = 'pixelfed.social';

// API base for an instance. The home instance is reached through our own
// same-origin PHP proxy (server/, deployed alongside the app), which sidesteps
// Pixelfed's CORS policy entirely: the browser only ever talks to meenow.de.
// Non-home instances still go direct, so the unsupported escape hatch keeps
// whatever works (and the CORS error card still fires where it does not).
export function apiBase(instance: string): string {
  return instance === HOME_INSTANCE ? '' : `https://${instance}`;
}

// Same-origin endpoints served by the PHP backend.
export const PUSH_SUBSCRIBE_URL = '/push/subscribe';
export const PUSH_UNSUBSCRIBE_URL = '/push/unsubscribe';
export const VAPID_KEY_URL = '/push/public-key';
export const XKCD_URL = '/xkcd.json';
