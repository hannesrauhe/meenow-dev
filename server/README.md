# meenow server

The meenow backend (PHP + MySQL + URL-cron), designed to run on any PHP+MySQL
shared host. It lives inside the app repo as `server/`. Two jobs:

1. **API proxy** — `/api/*` and `/oauth/token` are passed through to the home
   Pixelfed instance (`pixelfed.social`); allowlisted second instances are reached
   under `/i/<instance>/…`. The PWA is served from the same origin, so
   browser↔meenow is same-origin (no CORS) and meenow↔Pixelfed is
   server-to-server (no CORS either). This is what makes the app immune to
   instances rolling out restrictive CORS policies.
2. **Web Push** — subscription store in MySQL (`/push/subscribe`,
   `/push/unsubscribe`, both behind the same Bearer-token gate as the proxy;
   `/push/public-key` stays open) and a timezone-gated daily tick sent from the
   URL-cron.
3. **Bootstrap groups** — `/groups/*` stores membership of small named circles
   so a new user can follow everyone in one tap (see *Bootstrap groups* below).
   Operator-created; no UI for creating them.

## Layout

One directory per instance; the domain points at its `public/` subdir, so
`config/`, `cache/` and `vendor/` are siblings of the docroot and not web-served.

```
<instance>/            one directory per deployment (e.g. meenow.de/, dev.meenow.de/)
  public/     ← domain docroot: PWA build (index.html…) + app.php router + .htaccess + .user.ini
  src/        PHP app (bootstrap, proxy, push, groups, tick, trigger math, xkcd cache,
              error capture, admin read endpoint)
  scripts/    gen-vapid.php, groups.php, errors.php, smoke.php, parity-test.{php,mjs}, test-local.sh
  config/     config.php + vapid.json — SERVER-ONLY, never committed/overwritten
  cache/      xkcd cache + php-error.log — server-owned
  vendor/     composer install --no-dev output — server-owned
  schema.sql  MySQL tables (subscriptions, rate_hits, cron_slots, groups, group_members,
              group_invites, group_events, group_bans, errors)
  VERSION     installed build id (written by install.sh)
  install.sh  the installer (self-updating: each release ships the current one)
  .install.conf  REPO=owner/name (+ optional GITHUB_TOKEN) — server-owned
  .releases/  downloaded tarballs kept for --rollback — server-owned
```

In the repo the same tree lives under `server/` (so `server/public/` is the
docroot source); the release step copies `server/` to the instance root and the
PWA build into its `public/`. `app.php` is deliberately NOT named `index.php` —
`index.html` is the PWA entry point and must win the directory index.

## One-time server setup

Per instance (repeat for dev). SSH into the host, work in the instance dir.

1. **DB**: create DB/user on the host (localhost-only access); remember the name
   for step 4.
2. **Bootstrap the installer** into an empty instance dir (`<owner>/<repo>` is
   the GitHub repo publishing the releases):
   ```
   cd /path/to/instance
   curl -fSLO https://github.com/<owner>/<repo>/releases/latest/download/install.sh
   echo 'REPO=<owner>/<repo>' > .install.conf
   ```
3. **Install**: `bash install.sh` (latest release) — downloads the build, runs
   `composer install --no-dev` here, and stops with next-step instructions
   because config is missing.
4. **Config**: `cp config.example.php config/config.php`, fill in DB creds +
   `cron_key` (`php -r 'echo bin2hex(random_bytes(32))'`).
5. **Schema**: `php scripts/migrate.php` — creates the tables from `schema.sql`
   (idempotent; later installs get this applied automatically by `install.sh`).
6. **VAPID**: `php scripts/gen-vapid.php` → writes `config/vapid.json` (0600).
7. **Smoke**: `php scripts/smoke.php` — must print "All checks passed."
8. **Point the domain's docroot at `<instance>/public`** (hosting panel or vhost
   config; TLS as usual).
9. **Scheduled URL** (hosting cron / uptime pinger): one GET at an
   operator-chosen interval, e.g. every 30 min:
   `https://meenow.de/cron?action=tick&key=KEY`.
   Firing more often is harmless — `cron_slots` dedupes per 30-minute bucket, so
   the effective send interval is `max(host interval, 30 min)` and a denser cron
   does not multiply pushes. (30 min is the suggested minimum.)
   (xkcd needs no cron — `/xkcd.json` refreshes its cache on request.)

## Deploying an update

From the instance dir: `./install.sh` (latest), `./install.sh v1.2.3`,
`./install.sh --pr 42` or `./install.sh --ref main` (preview builds), or
`./install.sh --rollback`. Each run applies the DB schema, re-runs composer +
smoke and never touches `config/`, `cache/` or `vendor/`. Builds are produced by
`.github/workflows/release.yml`.

**Schema is applied automatically.** Before the new build is swapped in,
`install.sh` runs `php scripts/migrate.php`, which loads `schema.sql` (its
`CREATE TABLE IF NOT EXISTS` creates any missing table) and then applies the
additive migrations listed in that script — guarded by `information_schema`
lookups, so every run is idempotent and a half-applied state repairs itself.
Because it runs *before* the rsync swap, a DB error aborts the install and the
previous build stays live. Migrations are additive-only, so `--rollback` to an
older build is safe (old code ignores new columns).

When you add a schema change: put the new shape in `schema.sql` (for fresh
installs) **and** append a guarded entry to the `$migrations` list in
`scripts/migrate.php` (for existing installs — `schema.sql` alone never alters
an existing table). Example, the `subscriptions.account` column:

```php
[
    'name' => 'subscriptions.account column',
    'needed' => fn(): bool => !$hasColumn('subscriptions', 'account'),
    'sql' => "ALTER TABLE subscriptions ADD COLUMN account VARCHAR(191) NOT NULL DEFAULT '' AFTER tz",
],
```

## Bootstrap groups

A group is a name plus a slug id, stored in `groups` / `group_members`, whose
only job is cold-starting a follower circle: a new user opens an invite link
(`/?group=<id>`), the app follows every member, and the user is added to the
roster for whoever joins next. Afterwards the group is inert — the circle lives
on the instances, and leaving a group never unfollows anyone.

Members are keyed on the self-asserted `"<instance>:<accountId>"` string (plus
their `user@instance` handle, which is what lets joiners resolve and follow
them). Same attribution posture as `subscriptions.account`: the Bearer token is
required but validated by the instance, not here, so a determined bad actor can
plant a member row. Accepted for a bootstrap device in a small community.

Creation is operator-only — there is deliberately no create UI or admin
endpoint:

```
php scripts/groups.php create crew "Weekend crew"
php scripts/groups.php add crew pixelfed.social:123 alice@pixelfed.social
php scripts/groups.php list            # members per group
php scripts/groups.php members crew
php scripts/groups.php remove crew pixelfed.social:123
php scripts/groups.php delete crew     # group + all members
```

Seeding the founding members with `add` is what makes a group useful before
anyone has joined it; everyone after that arrives through the app. Invite links
(`php scripts/groups.php invite crew`) are `https://<base_url>/?join=<token>`
— the origin comes from the `base_url` config key, the token is a random
128-bit capability that expires (see `invite_ttl_s` / `invite_max_uses` in
`config.example.php`).

## Testing

`bash scripts/test-local.sh` (Docker only — MariaDB + PHP 8.3, no local config
or DB needed) runs the full suite: endpoints, proxy routing and the auth gate,
JSON + multipart body relay, groups join/leave, cron, rate limiter, plus the
proxy body/header unit tests (`scripts/test-proxy-body.php`). The proxy checks
hit the live home instance, so it needs internet. Run it after touching
`public/app.php`, `src/proxy.php` or `src/groups.php`.

## Trigger-math parity

`src/Trigger.php` must match `meenow-dev/src/trigger-core.mjs` bit-for-bit or
every user's trigger time shifts. After touching either:

```
php scripts/parity-test.php > /tmp/php.txt
node scripts/parity-test.mjs > /tmp/js.txt   # run from the repo root
diff /tmp/php.txt /tmp/js.txt                # must be empty
```

## Proxy hardening

Targets are hard-whitelisted (no target parameter): `home_instance` is served at
`/api/*` + `/oauth/token`, and each entry of `proxied_instances` at
`/i/<instance>/api/*` + `/i/<instance>/oauth/token` — the host in the path must
match the allowlist exactly or the request 404s (never a redirect). Cookies and
Origin/Referer are stripped, HTTPS-only. **Requests without an `Authorization`
header get a 401 from us** — the token itself is validated by the instance, we
only refuse to relay anonymously, so abuse needs a real account and stays
attributable. The two bootstrap endpoints stay open (rate-limited per IP in
MySQL): `POST /api/v1/apps` (dynamic registration) and `POST /oauth/token` (PKCE
exchange, useless without the browser-held verifier) — at either path prefix.
`/oauth/authorize` is deliberately NOT proxied: it's a top-level browser
navigation (CORS-exempt) and proxying a login form would break.

**Bodies** (`src/proxy.php`): JSON and urlencoded bodies are forwarded verbatim,
with Content-Type re-added explicitly (Apache hides it from `HTTP_*`).
`multipart/form-data` — the media upload — cannot be: PHP consumes it into
`$_POST`/`$_FILES` and leaves `php://input` empty, so a raw-stream relay would
upload an empty file (upstream 422). The proxy rebuilds the form for curl
instead, which generates a fresh boundary; the inbound Content-Type is dropped
in that case. Files PHP itself refused (`upload_max_filesize`) or a body past
`post_max_size` produce a clear 413 rather than a confusing upstream 422 — the
limits come from `public/.user.ini` (20M/25M; on mod_php set them in php.ini
instead). Unit-tested in `scripts/test-proxy-body.php`.

## Cron endpoint

Many shared hosts only allow scheduled HTTP GETs, so the tick is a key-gated URL
(`/cron?action=tick&key=…`, timing-safe compare). MySQL slot dedupe makes
double-fires harmless; `?force=1` bypasses gating for manual tests. The 1800 s
slot bucket is also what bounds the effective tick cadence: whatever interval the
host's scheduled URL fires at, at most one run per 30-minute bucket reaches the
push layer.

## Monitoring

Unexpected failures are written to the `errors` table (`src/monitor.php`), so a
user's screenshot can be matched to a real cause instead of a guess. Captured:

- **Upstream statuses through the proxy** — every 5xx, plus the 4xx in
  `errors.log_statuses` (default 400/404/422). Those 4xx are the "Pixelfed
  changed" signal: an endpoint or field we rely on stops existing.
- **Our own uncaught throws and PHP fatals** — previously these landed only in
  `cache/php-error.log`, which all-inkl will not show us.
- **curl transport errors** (stored as status 0 — no answer at all).
- **A silent cron** — if the newest tick slot is older than
  `errors.cron_max_gap_s`, the next run records the gap. `/health` reports
  `last_cron_s`/`cron_stalled` for an external pinger, which is what catches a
  cron that stops and never comes back (the in-cron check needs two fires).

Deliberately **not** captured: our own 401/403/405/429 and the router's 404.
Those are expired tokens, abuse and scanner traffic (`/wp-admin`, `/.env`) —
noise, not bugs, and they would bury the real rows.

Every row is mirrored to `error_log()` first: a DB failure is exactly the case
that cannot be written to the DB. Rows are raw, capped per (kind, route, status)
by `errors.sample_cap_per_hour`, and pruned by the tick to `retention_days` /
`max_rows`. The Bearer token is never stored — only a truncated hash, so one
user's retries stay groupable. Bodies are truncated and scrubbed.

Reading it (CLI, like groups):

```
php scripts/errors.php list [--limit=N] [--kind=upstream|php|cron]
php scripts/errors.php show <id>
php scripts/errors.php stats [--days=N]     # grouped — the view you want
php scripts/errors.php liveness
php scripts/errors.php prune [--keep-days=N] [--max-rows=N]
```

Or key-gated over HTTP (same `cron_key` gate as `/cron`):

```
GET /admin/errors?key=…                 recent rows
GET /admin/errors?key=…&action=stats    grouped by kind/route/status
GET /admin/errors?key=…&action=liveness
GET /admin/errors?key=…&action=prune
```

`config.debug` still echoes the real error into the 500 body so the app can show
it — but recording happens whether or not that flag is on.
