# meenow
Webapp pixelfed client to share daily selfies with friends

# Implementation Blueprint: **meeow**

**A Decentralized, Serverless, Cat-Themed Spontaneous Photo-Sharing Client for Pixelfed**

---

## 1. Project Overview & Architecture

**meeow** is a serverless, client-side-only Progressive Web App (PWA) designed for mobile browsers. It introduces a spontaneous daily photo-sharing mechanic to the decentralized **Pixelfed/Mastodon API**, utilizing the Fediverse as its entire backend.

* **Hosting:** Static hosting only (GitHub Pages / Nginx). No custom backend or database allowed.
* **Authentication:** Client-side OAuth directly with the user's chosen Pixelfed instance.
* **Theme:** Subtle, clean cat aesthetics (e.g., whiskers on the camera shutter button, "Purr-fectly on time" indicators, warm cream/tabby color palette).

```
   ┌────────────────────────────────────────────────────────┐
   │                     Meeow PWA                          │
   │   (React / Vue / or Vanilla JS + Tailwind)             │
   └───────────┬────────────────────────────────┬───────────┘
               │                                │
               ▼                                ▼
   [ LocalStorage / Crypto ]            [ Pixelfed API Engine ]
   • Deterministic Time Calc            • OAuth Auth & Token management
   • Sequential Dual Camera             • Post with #meeowApp
   • 24h & Tag Feed Filtering           • Feed Lockout State Logic

```

---

## 2. Core Functional Requirements

### A. Pseudo-Random Daily Trigger (Deterministic Consensus)

To ensure all global users receive the same "meeow time" simultaneously without a central notification server:

* Implement a client-side pseudo-random number generator (PRNG) using a daily seed string format (`YYYY-MM-DD`).
* The math must scale the daily random fraction to a window between **9:00 AM** and **9:00 PM** local time.
* **State Locking:** If the current time is *past* today's calculated time, the app locks the timeline screen until the user uploads their daily photo.

### B. Mobile Browser "Dual-Camera" Emulation

Mobile browsers (especially iOS Safari) do not natively allow concurrent active streaming of front and back cameras.

* **Sequential Capture Flow:**
1. Activate back camera stream (`facingMode: "environment"`), take an immediate capture, and freeze the frame.
2. Instantly switch to the front camera stream (`facingMode: "user"`), display a 2-second countdown/preview inside a small corner thumbnail overlay, and capture the selfie.


* **Canvas Stitching:** Stitch both captures into a single canvas context. The selfie frame should sit as a rounded picture-in-picture box over the top-left quadrant of the back-camera frame. Export the composite image as a high-quality JPEG blob.

### C. Pixelfed API Integration (Serverless)

* **Dynamic Instance OAuth:** Allow users to type in their home Pixelfed instance domain (e.g., `pixelfed.social`). Authenticate via client-side OAuth 2.0 (Authorization Code Flow with PKCE, or Implicit Flow). Store the resulting bearer token securely in `localStorage`.
* **Media Pipeline:** Use `POST /api/v1/media` to upload the stitched image blob, then create a status update via `POST /api/v1/statuses`.
* **App Tagging:** Append a hidden/explicit unique marker hashtag to the status metadata or caption (e.g., `#meeowApp2026`).

### D. The 24-Hour Feed Filtering Logic

When pulling the user's home timeline (`GET /api/v1/timelines/home`):

* Iterate through statuses and filter out posts older than 24 hours (`Date.now() - created_at > 86400000`).
* Filter out posts that do not contain the tag `#meeowApp2026` to keep the feed hyper-focused on daily check-ins.
* **Blur Overlays:** If the user hasn't completed today's camera capture yet, display a blurred placeholder container with a cat-scratch pattern and text: *"Curiosity killed the cat! Post yours to unblur your friends' timeline."*

---

## 3. UI/UX & Theming Specifications

* **Design System:** Modern minimalist with clean typography, using a warm sand/cream background (`#FDFBF7`) and sharp dark slate accents.
* **Cat Motifs (Subtle):**
* Shutter Button: Custom circular button with minimalist cat ears or subtle whiskers.
* Countdown Timer: Displayed as fish bones or a playful loading spinner that resembles a rolling ball of yarn.
* Feed States: A "No posts yet" empty state displaying a clean line-art graphic of a sleeping cat.



---

## 4. Technical Constraints & Deployment Checklist

* **PWA Manifest:** Must include a valid `manifest.json` setting `display: "standalone"` and a functional Service Worker. This prompts iOS/Android users to "Add to Home Screen," which ensures the browser layout hides native URL bars for an app-like viewport.
* **Zero Backend Operations:** Ensure absolute security—no client secrets or server configuration environmental variables are required by the static assets. Everything must resolve within browser memory.
* **Permissions Handling:** Gracefully catch and display clear, stylized errors when a user denies Camera permissions, prompting them with instructions on how to reset site permissions in mobile settings.

---

## 5. Implementation Roadmap for the LLM Agent

1. **Phase 1: Project Setup & Deterministic Timer Engine** — Build the static site architecture, seed-based PRNG math, and visual countdown state logic.
2. **Phase 2: Camera Prototype** — Build the sequential stream switcher and HTML5 Canvas stitching engine. Test extensively against mobile viewport dimensions.
3. **Phase 3: Pixelfed Authentication Bridge** — Set up instance-independent OAuth redirect workflows and store state locally.
4. **Phase 4: Timeline Processing** — Write the filtering logic for the timeline API, including the unblur layer and 24-hour expiration threshold.
5. **Phase 5: Cat Theme Polish & PWA Deployment** — Style the app according to the *meeow* theme specifications, finalize the PWA manifest, and deploy to GitHub Pages.
