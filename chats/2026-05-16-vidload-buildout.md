# VidLoad buildout — from scaffold to v0.4.8 monetization-ready

**Date:** 2026-05-16
**Topic:** Full project arc — initial scaffolding, HLS/DASH support, site adapters, UX polish, ExtensionPay scaffolding, and a deep download bug fix
**Outcome:** Shipped 22 commits from `17ea3d9` (initial scaffolding) to `d50cc5e` (v0.4.8 chrome.downloads routing fix). Monetization is wired but disabled by default; actual ExtPay activation is gated on the user signing up at extensionpay.com.

## Key decisions

- **Two-build distribution** — Web Store build (TikTok + IG + Twitter adapters, no YouTube) + self-hosted build (adds YouTube) via `build.mjs` flag. YouTube alone in self-host because Google removes YouTube downloaders aggressively. See [[chrome-extension-policy]] and [[two-build-architecture]].
- **No FFmpeg, no Vite** — HLS and DASH segments are already valid containers; concatenating raw bytes yields playable `.mp4` (fMP4 with init segment) or `.ts` (MPEG-TS) output. Saves ~30 MB bundle weight. See [[hls-download-approach]] and [[dash-download-approach]].
- **Offscreen document for streaming downloads** — service workers can suspend after 30s idle; offscreen survives long fetches. Critical caveat: `chrome.downloads` is NOT available in offscreen — must route final download through SW. This bit us in v0.4.8.
- **ExtensionPay over DIY monetization** — Stripe-backed, ~30 LoC, no backend to maintain. ~5% fee on top of Stripe. See [[monetization]].
- **Monetization disabled by default in v0.4** — ships the gating logic + paywall UI + status bar + daily counter, but `MONETIZATION.enabled = false` so all downloads are free until the project owner configures real ExtPay and flips the switch.
- **Declarative Net Request for Referer** — `chrome-extension://` Referer is rejected by twimg.com / fbcdn.net / tiktokcdn.com. Dynamic rules scoped to `tabIds: [-1]` rewrite Referer only for our SW/offscreen/popup fetches, never the user's tabs.
- **Context-aware filenames** — content script walks the DOM near each `<video>` looking for the nearest Instagram handle / Twitter handle / generic heading. Active-context tracker reports the video closest to viewport center so even network-observed URLs get a meaningful filename.
- **In-popup error banner** — `window.error` + `unhandledrejection` handlers, registered as the first thing in popup.js, render a red banner with the full stack. Replaces "open DevTools to debug" for casual users.

## Files touched

Source `extension/`:
- `manifest.json` (version 0.1.0 → 0.4.8, permissions evolved)
- `background/service-worker.js` (gating, dedup, Referer rules, commit-download)
- `offscreen/offscreen.{html,js}` (HLS+DASH engine, lazy probe, blob handoff)
- `content/content-script.js` (DOM walker, viewport tracker, URL inference)
- `popup/popup.{html,js,css}` (full UX evolution; card layout; menu)
- `lib/hls.js`, `lib/dash.js`, `lib/extpay.js` (helpers + stubs)
- `adapters/tiktok.js`, `adapters/instagram.js`, `adapters/twitter.js`, `adapters/youtube.js`
- `icons/icon-{16,48,128}.png` (placeholder steel-blue play triangles)

Build + meta:
- `build.mjs`, `.gitignore`, `CLAUDE.md`

Wiki additions (this session and prior):
- `wiki/INDEX.md`, `wiki/README.md`
- `wiki/topics/chrome-extension-policy.md`
- `wiki/topics/hls-download-approach.md`
- `wiki/topics/two-build-architecture.md`
- `wiki/topics/dash-download-approach.md`
- `wiki/topics/monetization.md`
- `wiki/topics/offscreen-api-limits.md` (new in this save)

## Open threads

- **YouTube signature-cipher extraction** — deferred. yt-dlp ships hundreds of lines just for this; ongoing maintenance treadmill. Self-host build only.
- **HLS variant picker UI** — the popup shows the auto-picked best quality. Reference UI from user had a "1080p ▾" dropdown; we render it as a static badge for now.
- **DASH audio+video muxing** — current code picks the highest-bandwidth video Representation and ignores audio adaptation sets. Streams that ship them separately produce silent files. Needs FFmpeg.wasm or an MP4 muxer.
- **Real ExtensionPay activation** — user needs to (1) sign up at extensionpay.com, (2) create their extension + Stripe-connected product, (3) replace `extension/lib/extpay.js` with the real SDK, (4) set `MONETIZATION.enabled = true` + correct `extpayId` in service-worker.js, (5) rebuild. See [[monetization]] for the full checklist.
- **Real icons + Web Store assets** — current icons are placeholder steel-blue PNGs. Web Store submission also needs screenshots + Privacy Policy doc.
- **Twitter `og:image` is sometimes the author's avatar, not the video poster** — accepting this for now; would need to hook X's GraphQL responses to get the real thumb URL.
- **Instagram adapter is brittle** — Meta rotates their JSON structure often. Current code uses regex matchers for `video_url` / `playback_url` / any media-URL `url` fields, plus og:* meta. Expect breakage; pattern updates are routine maintenance.

## Transcript highlights

User started with "I want to create a chrome extension to download video from any website. especially social media. Eventually I would like to charge a 1 time feed of 4.99 for permanent usage." From there:

1. **Plan-mode conversation** surfaced the Chrome Web Store policy risk for YouTube downloaders. User picked the dual-build strategy: Web Store version (no YouTube) + self-hosted version (YouTube). Plus ExtensionPay for the $4.99 unlock.

2. **v0.1** shipped: scaffolding, MV3 manifest, DOM `<video>` detection, direct-file download path. User tested and confirmed it worked on direct HTML5 videos.

3. **v0.2** added HLS via offscreen document. First attempts got "stuck on Reading…" — added per-fetch AbortController timeouts and verbose `[VidLoad stream]` logging. Then worked.

4. **v0.3 → v0.3.2** introduced the two-build flag, TikTok adapter, Instagram and Twitter adapters.

5. **v0.3.3 → v0.3.6** was UI polish — user posted a Video DownloadHelper screenshot showing 20 garbage Instagram items with empty thumbnails and "Video on fbcdn.net" titles. Added size filter (`<100KB direct items hidden`), card layout, gibberish-URL collapser, byte-range dedup, format pill honesty.

6. **v0.3.7** added context-aware filenames — DOM walker per video + viewport-center active-context tracker so network-observed URLs inherit the active video's label.

7. **v0.4** wired ExtensionPay scaffolding (disabled by default) — gating, paywall, status bar, daily counter, stub SDK.

8. **v0.4.1 → v0.4.6** were a series of polish fixes: duration probe for HLS/DASH (sum `#EXTINF` or parse `mediaPresentationDuration`); format pill regex unified with file extension regex; layout overflow fix when Twitter's long CDN hostnames pushed the Download button off-screen; null-safety pass; kebab dropdown menu with Copy URL / Open URL / Download as… / Dismiss.

9. **v0.4.7** added the Referer rewrite rules.

10. **v0.4.8** was the real x.com fix. User shared offscreen console output: `TypeError: Cannot read properties of undefined (reading 'download')` at finalize. Root cause: `chrome.downloads` isn't exposed inside offscreen documents (Chrome restricts the API surface). Fix routes the final `chrome.downloads.download()` call back to the SW via a new `commit-download` message; SW has the API and can use the blob URL created in offscreen since they share the same extension origin.

A persistent thread through the session: an unrelated `core.js:297:66041` "Cannot read properties of undefined (reading 'payload')" kept appearing in the user's DevTools, leading them to think VidLoad was failing. Proved it was from another extension (no `core.js` in VidLoad; longest line is 157 chars vs the error's column 66041) — likely a crypto wallet given the accompanying `lockdown-install.js` SES line.
