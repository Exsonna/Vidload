# VidLoad Wiki Index

Top-level map. Read this first to orient before any wiki work.

## Active topics

- [[chrome-extension-policy]] — why VidLoad ships as two builds (Web Store + self-hosted)
- [[hls-download-approach]] — why v0.2 ships HLS support without FFmpeg/Vite
- [[two-build-architecture]] — how `build.mjs` produces webstore + selfhost outputs, and the adapter contract
- [[dash-download-approach]] — v0.3.1 DASH support and the unified stream pipeline
- [[monetization]] — ExtensionPay $4.99 one-time unlock, free tier counter, paywall UI
- [[offscreen-api-limits]] — `chrome.downloads` isn't reachable in offscreen; SW-routed pattern for downloads

## Entities

_People, companies, products. Add as `- [[Name]] — one-line tag`._

## Open questions

- Final product name — "VidLoad" is a working title; revisit before Web Store submission.
- Free-tier daily limit — plan says 3/day; validate against actual usage once ExtensionPay is configured live.
- HLS variant picker UI — reference design had a "1080p ▾" dropdown; we render it as a static badge. Make it interactive when there's user demand.
- DASH audio+video muxing — current pipeline drops audio adaptation sets; silent files for streams with separate audio. Needs FFmpeg.wasm or an MP4 muxer.
- YouTube signature-cipher extraction — deferred; multi-session project of its own.
- Real icons, Web Store screenshots, Privacy Policy doc — prereqs for actual Web Store submission with paid features.

## Recently revised

- [[offscreen-api-limits]] — 2026-05-16 — new note from v0.4.8 chrome.downloads-in-offscreen fix
- [[hls-download-approach]] — 2026-05-16 — cross-linked the offscreen-API gotcha
- [[monetization]] — 2026-05-14 — v0.4 design note
- [[two-build-architecture]] — 2026-05-14 — IG + Twitter adapters added (v0.3.2)
- [[dash-download-approach]] — 2026-05-14 — v0.3.1 design note
