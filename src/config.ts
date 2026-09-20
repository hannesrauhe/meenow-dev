// meenow's home Pixelfed instance. All users are expected to live here: the
// daily-vanish promise relies on Pixelfed's archive API, which is a local-only
// visibility change — copies already delivered to followers on other instances
// are never retracted, so cross-instance posts don't actually vanish. Within
// one instance the archive works perfectly (and the My Photos grid depends on
// it). Other instances remain reachable via the manual field on the login
// screen but are unsupported — some (e.g. gram.social, pixelfed.de) send no
// CORS headers at all, which makes browser-based access impossible.
export const HOME_INSTANCE = 'pixelfed.social';
