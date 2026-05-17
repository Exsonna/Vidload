# Context pack — VidLoad

Generated: 2026-05-16

## What this project is

VidLoad is a Chrome MV3 extension that detects and downloads videos from arbitrary webpages, with special attention to social media (TikTok, Instagram, Twitter/X, eventually YouTube). It ships in **two builds from one source tree**:

- **Web Store build** (`dist/webstore/`) — generic HTML5 + HLS + DASH + adapters for TikTok / Instagram / Twitter. No YouTube code or references. Submission target.
- **Self-hosted build** (`dist/selfhost/`) — everything in webstore plus a YouTube adapter stub. Distributed as `.crx` from a separate marketing site.

Monetization scaffolding (free tier 3 downloads/day, $4.99 lifetime via ExtensionPay) is wired but **disabled by default**. Real activation needs the project owner to sign up at extensionpay.com and replace the stub SDK at `extension/lib/extpay.js`.

Current head: v0.4.8 (commit `d50cc5e`).

## Active topics

- [[chrome-extension-policy]] — why the dual-build split exists (Google rejects YouTube downloaders).
- [[hls-download-approach]] — concat raw segments + init segment, no FFmpeg. Outputs `.mp4` (fMP4) or `.ts` (MPEG-TS) — both play in VLC.
- [[dash-download-approach]] — same shared offscreen pipeline; picks best-bandwidth video Representation; ignores audio sets.
- [[two-build-architecture]] — `build.mjs` rewrites `manifest.content_scripts` and `manifest.description` per target; adapters opt in via `BUILDS[target].adapters`.
- [[monetization]] — ExtensionPay, gating, paywall UI, daily counter; all behind `MONETIZATION.enabled` switch.
- [[offscreen-api-limits]] — `chrome.downloads` isn't exposed inside offscreen; SW-routed `commit-download` pattern (v0.4.8).

## Recent decisions (this session)

- **Dual-build strategy** chosen over single Web Store submission with YouTube risk, or single self-hosted product.
- **No FFmpeg, no Vite** for HLS/DASH — concatenate raw segments. Saves ~30 MB of bundle weight and a build toolchain.
- **Offscreen document** hosts the segment-fetch loop (survives SW's 30s idle suspension).
- **chrome.downloads called from SW only** — `commit-download` message bridges offscreen → SW.
- **Active-context tracking** in content script — find the `<video>` (or `<article>` fallback) closest to viewport center, broadcast its label so network-observed URLs inherit it for filename derivation.
- **Site adapters as separate files** in `extension/adapters/`, included per build by `build.mjs`. Each adapter scrapes meta tags + JSON script blocks for media URLs; best-effort, expected to need maintenance as sites rotate.
- **declarativeNetRequestWithHostAccess** for Referer rewriting on twimg.com / fbcdn.net / tiktokcdn.com. Scoped to `tabIds: [-1]` so user's normal browsing is unaffected.
- **ExtensionPay over DIY** — accepted ~5% fee for zero backend ops.
- **ExtPay enabled = false by default** in v0.4 — ships infrastructure without charging anyone until project owner runs the activation checklist.
- **Card-style row layout** (v0.3.5) matching reference UI: 128×72 thumb with three corner overlays, format badge inline with title, inline rename, kebab dropdown, dismiss X.
- **Aggressive size filter** (v0.3.4) — direct/network items <100KB are probes/sub-segments, not real videos. Hidden by default; "Show N hidden" toggle for power users.
- **Lazy duration + size + resolution probe** (v0.4.1, v0.4.5) — when popup renders an HLS/DASH item with no metadata, fetch the manifest in the background and fill in duration overlay, quality badge, and estimated size pill (`bandwidth × duration ÷ 8`).
- **Error banner in popup** (v0.4.3+) — registered before any DOM access; surfaces uncaught errors as a red bar instead of dying silently. Helped narrow the v0.4.8 root cause to offscreen.js:143.

## Open questions

- Real product name (still "VidLoad" working title).
- Free-tier limit (3/day is a guess — calibrate after live ExtensionPay).
- Should the popup re-probe metadata on every open, or cache? Currently re-probes each open; minor wasted traffic.
- For Twitter `og:image` being the avatar instead of video thumb — accept it, or hook GraphQL for accuracy?
- HLS variant picker affordance — the reference UI had it; we render static pills.
- Persistence of dismissed items + user-renamed labels (currently in-memory only; resets when popup closes).

## Entity quick-ref

| Name | Role |
|---|---|
| ExtensionPay | Monetization SaaS; Stripe-backed; ~5% on top of Stripe. Stub at `extension/lib/extpay.js`. |
| Stripe | Payment processor under ExtensionPay. Not directly integrated. |
| Chrome Web Store | Primary distribution channel for webstore build. Policy: bans YouTube downloaders. |
| Video DownloadHelper | Reference UI (the screenshot user pasted as design target). |
| yt-dlp | Reference implementation for YouTube signature decoding (~hundreds of lines, ships several releases/month). |

## Outputs this session

- 22 commits between `17ea3d9` and `d50cc5e`.
- `extension/` source tree (manifest, SW, offscreen, content script, popup, adapters, libs).
- `dist/webstore/` and `dist/selfhost/` built artifacts.
- Wiki: chrome-extension-policy, hls-download-approach, two-build-architecture, dash-download-approach, monetization, offscreen-api-limits.
- This context pack + `chats/2026-05-16-vidload-buildout.md`.

## Latest session delta

- **v0.1** → scaffolding, MV3 manifest, direct-file download via popup → SW.
- **v0.2** → HLS support, offscreen document, AES-128 decryption, parallel segment fetch.
- **v0.3** → two-build flag, TikTok adapter, YouTube stub (selfhost-only).
- **v0.3.1** → DASH support + unified stream pipeline.
- **v0.3.2** → Instagram + Twitter/X adapters.
- **v0.3.3–v0.3.6** → popup UX iterations (cards, thumbs, sizes, dedup, format pill).
- **v0.3.7** → context-aware filenames (DOM walker + viewport active-context).
- **v0.4** → ExtensionPay monetization scaffolding (disabled by default).
- **v0.4.1–v0.4.5** → metadata probe (duration/bandwidth/resolution), null-safety, error banner.
- **v0.4.6** → kebab dropdown (Copy URL / Open URL / Download as… / Dismiss).
- **v0.4.7** → Referer rewrite via declarativeNetRequestWithHostAccess.
- **v0.4.8** → **the real x.com fix**: route `chrome.downloads.download()` through SW because offscreen contexts don't expose that API. Bug had been latent since v0.2.

## To pick up next session

Most likely next moves (in order of leverage):

1. **Confirm v0.4.8 unblocks x.com downloads** end-to-end. User reported the v0.4.7 Referer fix didn't help; v0.4.8 was the real cause. Need confirmation.
2. **Real icons + Web Store assets** — the placeholder steel-blue icons aren't shippable. Plus screenshots, listing copy, Privacy Policy.
3. **ExtensionPay activation** — when project owner is ready to charge, follow the [[monetization]] checklist.
4. **YouTube signature-cipher** — biggest unshipped feature; ongoing maintenance burden. Self-host build only.
5. **HLS variant picker** — surface the bandwidth options from the master playlist as a real selectable dropdown.
6. **DASH audio muxing** — needs FFmpeg.wasm. First-class blocker for non-muxed DASH streams.
