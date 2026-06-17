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
- **`activeScreen`** in `main.ts` tracks what is currently mounted. The special `'capturing'` value pauses the tick loop during the second-post flow so it does not unmount the in-progress capture screen.
- **Screen mounting** is done by `mount()` and `mountCapture()` in `main.ts`. Screens must not manipulate `#app` directly — use the `onRequestCapture` / `onDone` callbacks instead.
- **Auth** is read from localStorage via `getAuthState()`. The app auto-registers itself as an OAuth client on first login per Pixelfed instance, so each domain (`dev.meenow.de`, `meenow.de`) registers independently.
- **Service worker** caches aggressively in production. On the dev domain, users may need a hard refresh after a new deployment. The service worker is a custom `injectManifest` file (`src/sw.ts`) — excluded from the main `tsconfig.json` because it requires webworker types.
- **Push notifications** use standard Web Push (VAPID). The server side lives in `scripts/send-tick.mjs` + `.github/workflows/send-tick.yml`: a cron job runs every 30 minutes, checks out `meenow-de/meenow-push` (a separate private-or-public storage repo), sends a generic `{ts}` tick to every subscription file, and deletes expired ones (410/404). The service worker receives the tick and only shows a notification if `Date.now()` falls within 30 minutes of `getLastTriggerTime()` — all scheduling logic stays client-side. Each deployed instance uses its own VAPID key pair and subscription subdirectory (`subscriptions/dev` vs `subscriptions/prod`) so dev and prod are fully isolated.
- **localStorage keys** follow the `meenow:*` namespace (see `src/state.ts`): `meenow:install-dismiss`, `meenow:notif-dismiss`, `meenow:push-sub-file`. The push-sub-file key stores the subscription filename written to the relay repo, preventing duplicate registrations from the same device.
