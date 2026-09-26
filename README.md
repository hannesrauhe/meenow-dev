# meenow

A decentralized, cat-themed spontaneous photo-sharing PWA for Pixelfed - hosted on meenow.de.

Users receive a daily prompt at a pseudo-random local time (between 9 AM and 9 PM) to take a dual-camera photo — back camera for surroundings, front camera for a selfie — stitched into one composite image and shared with friends via the Fediverse. The Pixelfed/Mastodon API is the entire data backend; a thin PHP component (`server/`) proxies it same-origin (CORS) and sends Web Push notifications.

---

## Privacy & Visibility

**Who can see your photos?** meenow posts with followers-only visibility. Your followers on Pixelfed (or any connected Mastodon-compatible instance) will be able to see each photo in their home feed.

**Home instance:** meenow's community lives on **pixelfed.social** — the login screen connects there with one tap. This is a deliberate design choice: the daily-vanish behaviour below relies on posts being *local* to the instance, so keeping the whole meenow circle on one instance is what makes it work.

**Automatic archiving on Pixelfed:** After the next daily trigger fires, meenow automatically archives your older posts using the Pixelfed archive API. Archived posts are hidden from your followers but remain visible to you in your Pixelfed archive and in meenow's own grid view (My Photos). Archiving is a **local** visibility change: copies already delivered to followers on *other* instances are not retracted and stay visible there. Keeping your meenow circle on pixelfed.social is what makes photos truly vanish.

**Recommendation:** Use a Pixelfed account with restricted followers (i.e. approve follower requests) so that you control who can see your daily photos before they are archived.

---

## Architecture

```
   ┌────────────────────────────────────────────────────────┐
   │                     meenow PWA                         │
   │           Vite + Vanilla TypeScript + Tailwind         │
   └───────────┬────────────────────────┬───────────┘
               │                                │
               ▼                                ▼
   [ LocalStorage ]                   [ PHP backend (server/) ]
   • OAuth credentials + tokens       • same-origin /api proxy → Pixelfed
   • Install-nudge dismiss flag       • /push/* subscription store (MySQL)
                                      • /xkcd.json cached mirror
                                      • URL-cron: daily tick
                                                │
                                                ▼
                                      [ pixelfed.social ]
                                      • Dynamic OAuth registration
                                      • Post with #meenowApp
                                      • Feed filter + blur logic
```

**Hosting:** any PHP + MySQL shared host — the PWA build and the PHP backend share one origin (meenow.de), so the browser never makes cross-origin Pixelfed calls. Deploys are pull-based: GitHub Actions builds a release tarball, `install.sh` on the server installs it.
**Platform targets:** Android and iOS mobile browsers are first-class. Desktop browsers are supported but deprioritized in UX design.
**Tech stack:** Vite + Vanilla TypeScript + Tailwind CSS. No framework runtime.

---

## How It Works

### Pseudo-Random Daily Trigger

Each user gets a **trigger time** derived from their local date using a deterministic xorshift PRNG, placing the moment somewhere in the 9 AM–9 PM window. Friends in different timezones trigger at different moments — intentionally spontaneous rather than globally simultaneous.

The interval between two consecutive trigger times is called a **trigger period**. The **last trigger time** is the most recent trigger that has fired; the **next trigger time** is the upcoming one. A trigger period can span two calendar days (e.g., last trigger at 8 PM, next trigger the following day at 11 AM = 15 h apart).

**State machine:**
- 0 posts in current period: prompt the user to capture immediately (no trigger-time gate).
- 1 post: show the filtered feed with a "+ Post" button for the second shot.
- 2 posts: show the feed with a live "next post in X" countdown to the next trigger time.

On every app load the post count for the current trigger period is fetched unconditionally from the server (`/api/v1/accounts/{id}/statuses`, filtered to posts since the last trigger time tagged `#meenowApp`). This keeps multi-device state consistent without any localStorage synchronisation.

### Dual-Camera Capture

Mobile browsers cannot stream two cameras simultaneously. The sequential flow:

1. Open back camera (`facingMode: "environment"`). Wait for `loadedmetadata` before capturing.
2. Stop the back-camera stream and open front camera (`facingMode: "user"`). Display a 3-second fullscreen countdown, then auto-capture the selfie.
3. **Canvas stitching:** Back frame as full background; selfie as a rounded rectangle inset (≈35% width, white border, top-left corner). Exported as JPEG at quality 0.92.

Photos are grabbed directly from the live preview frame (canvas `drawImage`), so the captured image matches the viewfinder exactly — no still-pipeline shutter lag or white-balance shift. Capture resolution therefore equals the video stream resolution (up to 4K where supported).

**Permission handling:** `NotAllowedError` and `NotFoundError` from `getUserMedia` surface a platform-aware error card with instructions for Android and iOS.

### Pixelfed OAuth — Dynamic App Registration

No hardcoded `client_id` or `client_secret`. On first use with a given instance:

1. `POST /api/v1/apps` to register the app at runtime.
2. Authorization Code Flow with PKCE: random `code_verifier`, SHA-256 derived `code_challenge`.
3. Tokens stored in `localStorage`, never sent anywhere other than the user’s own instance.

### Posting

1. Upload composite image via `POST /api/v1/media` (sequential first to guarantee gallery ordering), then back and front photos in parallel.
2. `POST /api/v1/statuses` with `visibility: "private"` (Mastodon API terminology for followers-only). The status body is an optional free-text caption and an optional location pill (reverse-geocoded to city level via Nominatim), followed by the `#meenowApp` tag, which is always appended so feed filtering keeps working.
3. Increment the in-memory `periodPostCount` (no localStorage write; the server is the source of truth).

### Feed

- Home timeline and own statuses merged and deduplicated.
- Filtered to the current trigger period (posts since the last trigger time); only statuses tagged `#meenowApp` are shown.
- If the user has not posted in the current trigger period: images are blurred with a “Post yours to unblur” prompt.
- Every successful feed load reconciles the in-memory post count against the fetched timeline, so a stale count (e.g. from a failed page-load fetch) corrects itself on pull-to-refresh.
- Empty state: sleeping cat illustration.

### Push Notifications

Standard Web Push (VAPID). The PHP backend stores subscriptions in MySQL (`POST /push/subscribe` from the client) and a key-gated URL-cron (every 30 min) sends a generic tick to every subscription, gated per device to its local trigger window, pruning expired endpoints. All scheduling logic stays client-side: the service worker shows a notification on each tick until the user has posted in the current trigger period (state shared with the SW via IndexedDB). Once the user has posted, otherwise-silent ticks are turned into engagement digests ("3 likes · 1 reply on your meenow"). See `CLAUDE.md` for the full push architecture and `server/README.md` for the backend.

---

## Known Limitations

- **Push notifications on iOS:** Web Push requires the PWA to be installed to the home screen (iOS 16.4+). The install nudge directly addresses this.
- **Camera resolution:** Controlled by the browser, typically lower than the native camera app.
- **Instance compatibility:** meenow is designed for its home instance, pixelfed.social, which the backend proxies. Other instances can be connected via the manual field on the login screen but are unsupported: archiving cannot retract posts from followers on other instances, and some public instances send no CORS headers at all, which makes direct browser access impossible. Standard Mastodon instances expose the same API surface but have no archive feature, so photos never vanish.

---

## Development

```bash
npm install
npm run dev
```

The dev server proxies `/api`, `/push`, `/xkcd.json` to a local PHP backend: run `php -S localhost:8080 server/scripts/router.php` alongside (setup in `server/README.md`).

Deployment is pull-based: `.github/workflows/release.yml` builds the PWA and packages a tarball (tags → releases; `main` and PRs → a rolling `preview` prerelease). On the hosting machine, `./install.sh` (or `--pr N`, `--ref main`, `--rollback`) downloads it, merges into the instance dir, runs `composer install --no-dev` and the smoke test. `meenow.de` and `dev.meenow.de` are two such instance dirs; see `server/README.md`.
