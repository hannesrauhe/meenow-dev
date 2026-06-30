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

## Code style

- Keep inline comments minimal. Only comment non-obvious intent or rationale (e.g. why a workaround exists); do not narrate what the code already states. Prefer a single concise line over multi-line explanations.

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
- **Routing** is driven by a 1-second `setInterval` tick (`tick()` in `src/main.ts`); there is no separate state-machine function. `timer.ts` exports a single `AppState` value, `'feed'`. The resting screen is always `feed` (or `login` when unauthenticated); `capture`, `post_detail`, `grid`, `circle`, `peer`, and `connect` are overlays mounted on top that pause the tick. The feed header shows the "+ Post" button while `periodPostCount < MAX_POSTS_PER_TRIGGER`; once the quota is reached it shows a live "next post in X" countdown instead (via `setInterval` / `isConnected` self-cleanup). The tick detects when a new period starts in-session (via `getLastTriggerTime()` changing) and resets `periodPostCount` to 0 without requiring a page reload. Post count is fetched from the server on every page load (`fetchTodayPostCount`, anchored to `getLastTriggerTime()`) and held in the module-level `periodPostCount` variable in `main.ts`; no localStorage cache is used for the count.
- **`activeScreen`** in `main.ts` tracks what is currently mounted. The special values `'capturing'`, `'post_detail'`, `'grid'`, `'circle'`, `'peer'`, and `'connect'` pause the tick loop so the setInterval does not unmount those screens mid-flow.
- **Screen mounting** is done by `mount()`, `mountCapture()`, `mountPostDetail()`, `mountGrid()`, `mountCircle()`, `mountPeerConnections()`, and `mountConnectLanding()` in `main.ts`. Screens must not manipulate `#app` directly — use the provided callbacks instead. Each overlay mounter pushes a `history` entry on mount and registers a `popstate` listener so the hardware back button returns to the previous screen instead of closing the PWA. `mountGrid` and `mountCircle` both use the nested-navigation variant (de/re-installing their own `popstate` listener) so hardware back from a drilled-in screen returns to the list, not the feed.
- **Auth** is read from localStorage via `getAuthState()`. The app auto-registers itself as an OAuth client on first login per Pixelfed instance, so each domain (`dev.meenow.de`, `meenow.de`) registers independently.
- **Service worker** caches aggressively in production. The update strategy is user-prompted: when `vite-plugin-pwa` detects a new service worker, `registerSW`'s `onNeedRefresh` callback fires and `showUpdateBanner` (in `main.ts`) injects a dismissible top banner with a "Refresh" button that calls `updateSW()`. No automatic reload. The service worker is a custom `injectManifest` file (`src/sw.ts`) — excluded from the main `tsconfig.json` because it requires webworker types, and type-checked separately via `tsconfig.sw.json` (wired into `npm run build`, since `vite-plugin-pwa` compiles the SW with esbuild and would not otherwise catch type errors).
- **Push notifications** use standard Web Push (VAPID). The server side lives in `scripts/send-tick.mjs` + `.github/workflows/send-tick.yml`: a cron job runs every 30 minutes during a daytime UTC window (`*/30 7-19 * * *`, i.e. 07:00–19:59 UTC), checks out `meenow-de/meenow-push` (a separate private-or-public storage repo), sends a generic `{ts}` tick to every subscription file, and deletes expired ones (410/404). The service worker receives the tick and shows a notification on every tick **until the user has posted in the current trigger period** — scheduling logic stays entirely client-side. The post state is shared via IndexedDB (`src/idb.ts`, key `posted-trigger-ms`): the app writes the current `triggerMs` on the first post of each period (and on page load when `fetchTodayPostCount > 0`); the SW reads it and suppresses the notification when it matches or exceeds the current trigger time. Each deployed instance uses its own VAPID key pair and subscription subdirectory (`subscriptions/dev` vs `subscriptions/prod`) so dev and prod are fully isolated. A separate manual workflow, `.github/workflows/force-notification.yml`, runs the same script with `FORCE=true`, which adds `force: true` to the payload; the SW then bypasses both the clock-skew guard and the "already posted" suppression and always shows the notification (used for testing on dev).
- **Post-posting digests**: after the user has posted, every remaining cron tick would otherwise be a *silent* push. Chrome (which requires `userVisibleOnly`) drains a per-origin push budget on silent pushes and eventually substitutes its own generic "site updated" notification. To prevent this and provide value, the SW's `showPostPostedDigest` (in `src/sw.ts`) turns would-be-silent ticks into useful notifications. It needs authenticated API access, so the app mirrors `{instance, accessToken, accountId}` into IndexedDB (key `auth`) on load; the SW reads it and calls SW-safe helpers in `src/api/engagement.ts` (pure `fetch`, no DOM/localStorage — do **not** import `src/api/pixelfed.ts` into the SW). `fetchNewEngagement` reads `GET /api/v1/notifications` (filtered to favourite/reblog/mention on `#meenowApp` posts, deduped via the stored `last-seen-notif-id`) and, when there is new engagement, shows a digest (e.g. "3 likes · 1 reply on your meenow", tag `meenow-digest`). As a budget-safety fallback, once per period on a late tick (≥ 19:00 UTC, the final hour of the cron window) it shows a friends-posted summary from `fetchFriendsPostedCount` (tag `meenow-friends`). The `digest-shown-trigger-ms` IDB key caps the fallback to once per trigger period. All fetches degrade silently (non-2xx → no notification) so the worst case is the prior silent behaviour. **Token-in-IDB rationale**: the access token already lives in localStorage and is therefore readable by any script on the origin, so mirroring it to IndexedDB does not widen the XSS surface; it is necessary only because the SW cannot read localStorage. `clearAuth()` deletes the IDB `auth`, `last-seen-notif-id`, and `digest-shown-trigger-ms` keys on logout.
- **PWA re-subscription**: when a push subscription is created in a browser tab, Chrome routes its notifications to Chrome rather than to the installed PWA. On the first launch in standalone mode (`isPwaInstalled()` true) where notifications are already granted but `meenow:pwa-subbed` is not set, `resubscribeAsPwa()` in `src/notifications.ts` silently unsubscribes the old endpoint, creates a new subscription in the PWA context, writes it to the relay repo, and sets the flag. Subsequent launches skip this. Silent failures retry on the next launch.
- **Push relay token exposure**: `VITE_PUSH_RELAY_TOKEN` is baked into the client bundle at build time and used by `src/notifications.ts` to `PUT` subscription files into `meenow-de/meenow-push` via the GitHub contents API. Because it ships to every client, it is readable by anyone who loads the app. This is an accepted consequence of the no-backend design; the token must therefore be a fine-grained PAT scoped to **only** the contents of that single relay repository, so the worst case of leakage is unwanted writes to the subscription store (which the cron job prunes) rather than broader account access.
- **localStorage keys** follow the `meenow:*` namespace (see `src/state.ts`): `meenow:install-dismiss`, `meenow:notif-dismiss`, `meenow:push-sub-file`, `meenow:pwa-subbed`, `meenow:vapid-key`, `meenow:locked-applied:<instance>`, `meenow:pending-add`. The push-sub-file key stores the subscription filename written to the relay repo, preventing duplicate registrations from the same device. The pwa-subbed key records that the active subscription was created in standalone mode (so Chrome routes notifications to the PWA, not to Chrome). The vapid-key key stores the VAPID public key used when the active subscription was created; a mismatch on app load (after key rotation) triggers `resubscribeIfNeeded()` which silently unsubscribes and re-subscribes with the new key. The locked-applied key (instance-scoped) records that the account has been auto-locked once, so the Circle screen does not re-PATCH on every open; the pending-add key carries an invite handle across the OAuth redirect (see *Follower network* below). OAuth state uses a separate `meenow:auth:*` namespace (see `src/api/auth.ts`): per-instance keys `meenow:auth:<instance>:creds` (registered app client id/secret), `:token` (access token) and `:accountId`, plus the global keys `meenow:auth:instance` (active instance), `meenow:auth:pending-instance` and `meenow:auth:verifier` (transient PKCE flow state). `clearAuth()` removes all of these for the active instance on logout, plus `meenow:locked-applied:<instance>` and `meenow:pending-add`.

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

## Follower network: circle, invites, approvals

meenow posts are `visibility: "private"` (followers-only), so a user only sees a friend's photos once they follow that friend and are approved. The social-graph layer that builds and manages this circle is **deliberately scoped for small, stable rounds (<20 people)** — there are intentionally no algorithmic suggestions, no global account search, no follower counts, and no trending. The whole layer maps to standard Mastodon v1 / Pixelfed endpoints; the registered OAuth scope (`read write`) already covers follow operations, so no re-login is needed.

- **API module**: `src/api/social.ts` (kept separate from `pixelfed.ts`, which owns the post/feed lifecycle and its home-timeline cache). Bare `fetch` + `Authorization: Bearer`, same convention as `pixelfed.ts`. Exports `resolveHandle` (`GET /accounts/search?resolve=true`, fallback `lookup`), `follow`/`unfollow`, `fetchRelationships` (`/accounts/relationships`, chunked ≤40), `fetchFollowRequests`/`authorizeFollowRequest`/`rejectFollowRequest` (`/follow_requests*`), `fetchConnections` (`/accounts/:id/followers|following`), `fetchMyAccount`/`setAccountLocked` (`verify_credentials` / `update_credentials`), and the pending-request count (`fetchPendingRequestCount`, 30s module cache, `invalidatePendingRequestCache`). Two public types, `Connection` and `Relationship`, normalise the API's snake_case shapes.
- **One-tap mutual model**: because the circle is bidirectional, connecting always aims for a mutual follow. `connectTo` is the outgoing half (just `follow`); `acceptAndBackFollow` authorizes an incoming request **and** auto-follows the requester back so the circle becomes mutual in one tap. If the back-follow fails (e.g. the requester is also locked, or a rate limit), the authorize has already succeeded — callers surface a non-fatal state rather than rolling back.
- **State→label mapping** lives in one place: `src/components/connectButton.ts` maps a `Relationship` to a pill label/action (Connect · Connect back · Requested · Waiting for them · Connected · Unavailable), including a two-tap disconnect. `src/components/accountRow.ts` is the shared avatar+name+handle row used by every social screen.
- **Circle screen** (`src/screens/circle.ts`, `renderCircle(auth, onBack, onOpenPeer)`): the hub, reached via the people-icon button in the feed header. Shows a follow-request inbox (one-tap mutual Accept / Reject), the mutual circle (and a "Waiting for them" group for one-way follows), an "Invite a friend" share button, and a reversible "approve new followers" lock toggle. Tapping a member calls `onOpenPeer`.
- **Account auto-lock + migration**: for follow requests to queue, the account must be `locked` (manually approve followers). `loadCircle` ensures this the first time the Circle screen is opened — it reads `verify_credentials.locked`, PATCHes `locked=true` if needed, and records `meenow:locked-applied:<instance>` so it never re-PATCHes. Existing (unlocked) users are migrated automatically on their next Circle open. The lock toggle reflects and reverses the setting; once the applied-flag is set the app never re-locks, so turning it off stays off.
- **Peer browsing** (`src/screens/peerConnections.ts`, `renderPeerConnections(auth, peer, onBack)`): a plain Following/Followers list of a circle member's connections, with a per-row connect button (state from a batched `fetchRelationships`). Strictly pull — no ranking or suggestions. `hide_collections` and any non-2xx degrade to a neutral "No connections to show" empty state; the user's own row is filtered out.
- **Invite links** are `<origin>/?add=user@instance` deep links (no backend, no expiry/single-use — the link only carries a handle, and following still requires approval). The handle is built federation-safe (bare local `acct` gets `@<instance>` appended). `init()` in `main.ts` parses `?add=` alongside the OAuth `code`, strips it with `replaceState`, and persists it to `meenow:pending-add` **before** any redirect — necessary because `redirect_uri` is `origin + pathname` with no query, so the handle would otherwise be lost across the OAuth round-trip when the recipient is logged out. After authentication the pending handle is consumed and `mountConnectLanding` opens `src/screens/connectLanding.ts`, which resolves the handle and offers a one-tap connect (with self-add and not-found states).
- **Pending-request badge**: the feed header's circle icon gets a small gold dot when `fetchPendingRequestCount(auth) > 0` (checked on feed mount; the count cache is invalidated on accept/reject so the badge refreshes when the user returns to the feed). The source of truth is `/follow_requests`, not notification parsing, because Pixelfed's `follow_request` notification emission is version-dependent. (The push-notification digest in `src/api/engagement.ts` does **not** yet count `follow`/`follow_request` — that is a deliberate phase-2 follow-up.)

## Automatic archiving of old posts

Posts older than the last trigger time are automatically archived on Pixelfed (hidden from other users) via the Pixelfed-specific `POST /api/v1.1/archive/add/:id` endpoint. Archiving is fire-and-forget: failures are silently swallowed, and on non-Pixelfed instances the calls are no-ops.

The logic lives in the private `triggerArchive(auth, statuses)` helper in `src/api/pixelfed.ts`. It filters for the authenticated user's own meenow posts (`s.account.id === auth.accountId`) that have media and predate `getLastTriggerTime()`, then fires `Promise.allSettled` over the archive calls without blocking the caller.

`triggerArchive` is called as a side-effect from two places:
- `fetchMeenowFeed` — fires when the feed screen loads (the most common path).
- `fetchMyAllPosts` — fires when the grid screen opens.

Archived posts remain visible to the owner in the grid because `fetchMyAllPosts` merges the active-statuses response with the archive-list response.
