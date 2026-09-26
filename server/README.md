# meenow server

The meenow backend (PHP + MySQL + URL-cron), designed to run on any PHP+MySQL
shared host. It lives inside the app repo as `server/`. Two jobs:

1. **API proxy** — `/api/*` and `/oauth/token` are passed through to the home
   Pixelfed instance (`pixelfed.social`). The PWA is served from the same origin,
   so browser↔meenow is same-origin (no CORS) and meenow↔Pixelfed is
   server-to-server (no CORS either). This is what makes the app immune to
   instances rolling out restrictive CORS policies.
2. **Web Push** — subscription store in MySQL (`/push/subscribe`,
   `/push/unsubscribe`) and a timezone-gated daily tick sent from the URL-cron.

## Layout

One directory per instance; the domain points at its `public/` subdir, so
`config/`, `cache/` and `vendor/` are siblings of the docroot and not web-served.

```
<instance>/            one directory per deployment (e.g. meenow.de/, dev.meenow.de/)
  public/     ← domain docroot: PWA build (index.html…) + app.php router + .htaccess
  src/        PHP app (bootstrap, proxy, push, tick, trigger math, xkcd cache)
  scripts/    gen-vapid.php, smoke.php, parity-test.{php,mjs}, test-local.sh
  config/     config.php + vapid.json — SERVER-ONLY, never committed/overwritten
  cache/      xkcd cache — server-owned
  vendor/     composer install --no-dev output — server-owned
  schema.sql  MySQL tables (subscriptions, rate_hits, cron_slots)
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
5. **Schema**: `mysql -h localhost -u DBUSER -p DBNAME < schema.sql`.
6. **VAPID**: `php scripts/gen-vapid.php` → writes `config/vapid.json` (0600).
7. **Smoke**: `php scripts/smoke.php` — must print "All checks passed."
8. **Point the domain's docroot at `<instance>/public`** (hosting panel or vhost
   config; TLS as usual).
9. **Scheduled URL** (hosting cron / uptime pinger): one GET, every 30 min:
   `https://meenow.de/cron?action=tick&key=KEY`.
   (xkcd needs no cron — `/xkcd.json` refreshes its cache on request.)

## Deploying an update

From the instance dir: `./install.sh` (latest), `./install.sh v1.2.3`,
`./install.sh --pr 42` or `./install.sh --ref main` (preview builds), or
`./install.sh --rollback`. Each run re-runs composer + smoke and never touches
`config/`, `cache/` or `vendor/`. Builds are produced by `.github/workflows/release.yml`.

## Trigger-math parity

`src/Trigger.php` must match `meenow-dev/src/trigger-core.mjs` bit-for-bit or
every user's trigger time shifts. After touching either:

```
php scripts/parity-test.php > /tmp/php.txt
node scripts/parity-test.mjs > /tmp/js.txt   # run from the repo root
diff /tmp/php.txt /tmp/js.txt                # must be empty
```

## Proxy hardening

Target is hard-whitelisted to `home_instance` (no target parameter), paths
restricted to `/api/*` + `/oauth/token`, cookies/Origin/Referer stripped,
HTTPS-only. **Requests without an `Authorization` header get a 401 from us**
— the token itself is validated by Pixelfed, we only refuse to relay
anonymously, so abuse needs a real account and stays attributable. The two
bootstrap endpoints stay open (rate-limited per IP in MySQL): `POST /api/v1/apps`
(dynamic registration) and `POST /oauth/token` (PKCE exchange, useless without
the browser-held verifier). `/oauth/authorize` is deliberately NOT proxied:
it's a top-level browser navigation (CORS-exempt) and proxying a login form
would break.

## Cron endpoint

Many shared hosts only allow scheduled HTTP GETs, so the tick is a key-gated URL
(`/cron?action=tick&key=…`, timing-safe compare). MySQL slot dedupe makes
double-fires harmless; `?force=1` bypasses gating for manual tests.
