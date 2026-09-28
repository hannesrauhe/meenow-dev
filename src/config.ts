// meenow's home Pixelfed instance: the default, the one-tap option, and where
// the community (and the Reachy bot) lives. All users are expected to live here:
// the daily-vanish promise relies on Pixelfed's archive API, which is a local-only
// visibility change — copies already delivered to followers on other instances
// are never retracted, so cross-instance posts don't actually vanish. Within
// one instance the archive works perfectly (and the My Photos grid depends on
// it), which is why the proxied second-level instances below still vanish for
// a circle that lives entirely on the same instance.
export const HOME_INSTANCE = 'pixelfed.social';

// Second-level instances the backend proxy also relays to, so they get the same
// CORS immunity as the home instance (several public instances send no CORS
// headers at all, which makes direct browser access impossible). Must mirror
// the backend's `proxied_instances` config. Caveats vs. home: no bot, and
// archiving/vanishing only holds within a single-instance circle.
export const PROXIED_INSTANCES = ['pixelfed.de', 'gram.social'] as const;

// API base for an instance. The home instance is reached through our own
// same-origin PHP proxy (server/, deployed alongside the app) at bare /api/*;
// the other allowlisted instances go through the same proxy under /i/<host>.
// The browser therefore only ever talks to meenow.de. Anything not in the list
// goes direct, so the unsupported escape hatch keeps whatever works (and the
// CORS error card still fires where it does not).
export function apiBase(instance: string): string {
  if (instance === HOME_INSTANCE) return '';
  if ((PROXIED_INSTANCES as readonly string[]).includes(instance)) return `/i/${instance}`;
  return `https://${instance}`;
}

// Profile link on the user's own instance: the /@user@domain webfinger route
// renders remote accounts as their local shadow profile, so a tap never lands
// on the foreign instance. Navigation, not an API call — no proxy needed.
// A handle qualified with our own instance must be stripped: that route only
// matches remote shadow profiles, so a fully-qualified local one would 404.
export function profileUrl(instance: string, acct: string): string {
  let a = acct.replace(/^@/, '');
  const at = a.lastIndexOf('@');
  if (at > 0 && a.slice(at + 1).toLowerCase() === instance.toLowerCase()) a = a.slice(0, at);
  return `https://${instance}/@${a}`;
}

// Same-origin endpoints served by the PHP backend.
export const GROUPS_URL = '/groups';
export const PUSH_SUBSCRIBE_URL = '/push/subscribe';
export const PUSH_UNSUBSCRIBE_URL = '/push/unsubscribe';
export const VAPID_KEY_URL = '/push/public-key';
export const XKCD_URL = '/xkcd.json';
