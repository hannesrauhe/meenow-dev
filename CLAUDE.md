# meenow — project notes for Claude Code

## What this is

A minimal PWA that prompts users once a day to take a dual-camera photo (back + selfie stitched together) and post it to a Pixelfed instance via the Mastodon-compatible API. No backend — everything runs in the browser. Auth is OAuth PKCE stored in localStorage.

## Local development

```
npm install
npm run dev      # Vite dev server on localhost:5173
npm run build    # production build to dist/ (push config env vars not required locally)
npx tsc --noEmit # type-check without building
```

Push notification env vars (`VITE_VAPID_PUBLIC_KEY`, `VITE_PUSH_RELAY_TOKEN`, `VITE_PUSH_SUBS_PATH`) are only enforced during CI builds (`CI=true`). Local builds succeed without them; push features degrade gracefully.

## Tech stack

- Vanilla TypeScript, no framework
- Vite + vite-plugin-pwa (workbox service worker)
- Tailwind CSS v3
- GitHub Pages for hosting

## Two-repo deployment setup

There are two separate GitHub repositories, each deploying to its own domain via GitHub Pages:

| Repo | Domain | Deploy trigger |
|------|--------|---------------|
| `hannesrauhe/meenow-dev` | `dev.meenow.de` | every push to any branch, deploys immediately |
| `meenow-de/meenow` | `meenow.de` | every push to any branch, but requires manual approval |

The workflow file `.github/workflows/deploy.yml` is **identical in both repos**. The difference in behaviour comes entirely from the `github-pages` environment protection rule configured in `meenow-de/meenow` (Settings → Environments → github-pages → Required reviewers). The `deploy` job pauses there until a reviewer approves; on the dev repo there is no such rule so it deploys immediately.

Custom domains are configured in each repo's GitHub Pages settings (Settings → Pages → Custom domain). No `CNAME` file is needed in the source tree because both repos use the artifact-based Pages deployment (`actions/upload-pages-artifact` + `actions/deploy-pages`), which preserves the custom domain setting stored in GitHub's backend across deployments.

DNS for both domains points to GitHub Pages IPs (185.199.108–111.153 / 2606:50c0::/32).

To ship to production: open a PR from `hannesrauhe/meenow:main` into `meenow-de/meenow:main` and approve the deployment in the `github-pages` environment.

## Dev instance indicator

`src/main.ts` appends a small fixed `dev` badge to `<body>` when `window.location.hostname` is `dev.meenow.de` or `localhost`. The same code runs in production where it is a no-op. No build-time configuration needed.

## Key architecture notes

- **Trigger time terminology**: A *trigger time* is the pseudo-random daily moment when users are prompted to post. The *last trigger time* is the most recent trigger that has fired; the *next trigger time* is the upcoming one. The interval between them is the *trigger period*. A period can span two calendar days.
- **State machine** lives in `src/timer.ts` (`computeState`) and is driven by a 1-second `setInterval` tick in `src/main.ts`. States: `awaiting_capture` (0 posts) → `feed` (≥1 post). Users with 0 posts go directly to capture regardless of time of day; there is no trigger-time gate. After posting twice the feed header shows a live "next post in X" countdown (via `setInterval` / `isConnected` self-cleanup) instead of the "+ Post" button — the feed is always the resting state. The tick detects when a new period starts in-session (via `getLastTriggerTime()` changing) and resets `periodPostCount` to 0 without requiring a page reload. Post count is fetched from the server on every page load (`fetchTodayPostCount`, anchored to `getLastTriggerTime()`) and held in the module-level `periodPostCount` variable in `main.ts`; no localStorage cache is used for the count.
- **`activeScreen`** in `main.ts` tracks what is currently mounted. The special values `'capturing'`, `'post_detail'`, and `'grid'` pause the tick loop so the setInterval does not unmount those screens mid-flow.
- **Screen mounting** is done by `mount()`, `mountCapture()`, `mountPostDetail()`, and `mountGrid()` in `main.ts`. Screens must not manipulate `#app` directly — use the provided callbacks instead. `mountCapture`, `mountPostDetail`, and `mountGrid` all push a `history` entry on mount and register a `popstate` listener so the hardware back button returns to the previous screen instead of closing the PWA.
- **Auth** is read from localStorage via `getAuthState()`. The app auto-registers itself as an OAuth client on first login per Pixelfed instance, so each domain (`dev.meenow.de`, `meenow.de`) registers independently.
- **Service worker** caches aggressively in production. The update strategy is user-prompted: when `vite-plugin-pwa` detects a new service worker, `registerSW`'s `onNeedRefresh` callback fires and `showUpdateBanner` (in `main.ts`) injects a dismissible top banner with a "Refresh" button that calls `updateSW()`. No automatic reload. The service worker is a custom `injectManifest` file (`src/sw.ts`) — excluded from the main `tsconfig.json` because it requires webworker types.
- **Push notifications** use standard Web Push (VAPID). The server side lives in `scripts/send-tick.mjs` + `.github/workflows/send-tick.yml`: a cron job runs every 30 minutes, checks out `meenow-de/meenow-push` (a separate private-or-public storage repo), sends a generic `{ts}` tick to every subscription file, and deletes expired ones (410/404). The service worker receives the tick and shows a notification on every tick **until the user has posted in the current trigger period** — scheduling logic stays entirely client-side. The post state is shared via IndexedDB (`src/idb.ts`, key `posted-trigger-ms`): the app writes the current `triggerMs` on the first post of each period (and on page load when `fetchTodayPostCount > 0`); the SW reads it and suppresses the notification when it matches or exceeds the current trigger time. Each deployed instance uses its own VAPID key pair and subscription subdirectory (`subscriptions/dev` vs `subscriptions/prod`) so dev and prod are fully isolated.
- **PWA re-subscription**: when a push subscription is created in a browser tab, Chrome routes its notifications to Chrome rather than to the installed PWA. On the first launch in standalone mode (`isPwaInstalled()` true) where notifications are already granted but `meenow:pwa-subbed` is not set, `resubscribeAsPwa()` in `src/notifications.ts` silently unsubscribes the old endpoint, creates a new subscription in the PWA context, writes it to the relay repo, and sets the flag. Subsequent launches skip this. Silent failures retry on the next launch.
- **localStorage keys** follow the `meenow:*` namespace (see `src/state.ts`): `meenow:install-dismiss`, `meenow:notif-dismiss`, `meenow:push-sub-file`, `meenow:pwa-subbed`, `meenow:vapid-key`. The push-sub-file key stores the subscription filename written to the relay repo, preventing duplicate registrations from the same device. The pwa-subbed key records that the active subscription was created in standalone mode (so Chrome routes notifications to the PWA, not to Chrome). The vapid-key key stores the VAPID public key used when the active subscription was created; a mismatch on app load (after key rotation) triggers `resubscribeIfNeeded()` which silently unsubscribes and re-subscribes with the new key.

## Post annotations: caption and location

The preview step of the capture screen offers two optional annotations before posting:

- **Caption** — a free-text textarea. Text persists across retakes within the same session and is cleared after a successful post.
- **Location** — a button that calls `navigator.geolocation.getCurrentPosition` and reverse-geocodes the result to city level via the [Nominatim](https://nominatim.openstreetmap.org) OpenStreetMap API (`zoom=10`, `Accept-Language: en`). The resolved city and country are shown on the button as a gold pill; tapping it again clears the selection.

**Why plain text, not a dedicated field**: the Mastodon-compatible API (`POST /api/v1/statuses`) has no location field. The annotation is stored as plain text in the status body, ahead of the `#meenowApp` tag:

```
<caption>
📍 <City, Country>

#meenowApp
```

Any combination is valid (caption only, location only, both, or neither). The `#meenowApp` tag is always appended to keep feed filtering working.

**Parsing back**: `parseStatusParts` in `src/api/pixelfed.ts` strips the `#meenowApp` anchor from the Mastodon HTML `content` field, then detects any line starting with `📍` as the location. It returns `{ caption, location }` (location without the emoji prefix) which are stored as separate fields on `FeedPost`.

**Display**: caption appears as plain text below the photo; location appears as the same gold rounded-pill (`text-gold border border-gold/30 rounded-full`) used in the capture preview. Both are rendered in the feed card and in the post detail screen.

## Grid screen: My Photos

`src/screens/grid.ts` renders a personal photo archive reachable via the grid icon button in the feed header.

- **Entry point**: `renderGrid(auth, onOpenPost, onBack)` — mounted via `mountGrid()` in `main.ts`, which follows the same history-push / popstate pattern as `mountPostDetail`.
- **Data**: fetches the authenticated user's own meenow posts via `fetchMyAllPosts` in `src/api/pixelfed.ts`. This calls two endpoints in parallel: `GET /api/v1/accounts/:id/statuses?only_media=true` (active posts) and the Pixelfed-specific `GET /api/v1.1/archive/list` (archived posts). Results are merged and deduplicated by ID. On non-Pixelfed instances the archive endpoint returns a non-2xx response and is silently ignored. Posts are filtered client-side for the `#meenowApp` tag and sorted newest-first.
- **Layout**: sticky header with back button, posts grouped by month with headings, and a 3-column `grid-cols-3` thumbnail grid. Tapping a thumbnail calls `onOpenPost(post)` to open the existing post detail view. Empty state, loading, and error states mirror the feed screen's patterns.
- **Navigation**: `mountGrid` removes its own `popstate` listener before delegating to `mountPostDetail` (to avoid double-firing on browser back), then re-registers it when detail closes and restores the grid UI in-place without an extra `pushState`.

## Automatic archiving of old posts

Posts older than the last trigger time are automatically archived on Pixelfed (hidden from other users) via the Pixelfed-specific `POST /api/v1.1/archive/add/:id` endpoint. Archiving is fire-and-forget: failures are silently swallowed, and on non-Pixelfed instances the calls are no-ops.

The logic lives in the private `triggerArchive(auth, statuses)` helper in `src/api/pixelfed.ts`. It filters for the authenticated user's own meenow posts (`s.account.id === auth.accountId`) that have media and predate `getLastTriggerTime()`, then fires `Promise.allSettled` over the archive calls without blocking the caller.

`triggerArchive` is called as a side-effect from two places:
- `fetchMeenowFeed` — fires when the feed screen loads (the most common path).
- `fetchMyAllPosts` — fires when the grid screen opens.

Archived posts remain visible to the owner in the grid because `fetchMyAllPosts` merges the active-statuses response with the archive-list response.
