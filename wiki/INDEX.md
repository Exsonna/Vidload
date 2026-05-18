# VidLoad Wiki Index

Top-level map. Read this first to orient before any wiki work.

## Active topics

- [[chrome-extension-policy]] — why VidLoad ships as two builds (Web Store + self-hosted)
- [[hls-download-approach]] — why v0.2 ships HLS support without FFmpeg/Vite
- [[two-build-architecture]] — how `build.mjs` produces webstore + selfhost outputs, and the adapter contract
- [[dash-download-approach]] — v0.3.1 DASH support and the unified stream pipeline
- [[monetization]] — ExtensionPay $4.99 one-time unlock + 7-day free trial, daily counter, paywall UI
- [[offscreen-api-limits]] — `chrome.downloads` isn't reachable in offscreen; SW-routed pattern for downloads
- [[webstore-submission]] — submission asset drafts at `webstore-assets/`, hard rules, pre-flight grep

## Entities

_People, companies, products. Add as `- [[Name]] — one-line tag`._

## Open questions

- Final product name — "VidLoad" is a working title; revisit before Web Store submission.
- Free-tier daily limit — plan says 3/day; validate against actual usage once ExtensionPay is configured live.
- ~~HLS variant picker UI — reference design had a "1080p ▾" dropdown; we render it as a static badge.~~ Shipped in v0.4.11.
- DASH audio+video muxing — current pipeline drops audio adaptation sets; silent files for streams with separate audio. Needs FFmpeg.wasm or an MP4 muxer.
- YouTube signature-cipher extraction — deferred; multi-session project of its own.
- Web Store screenshots, Privacy Policy hosting + email/URL fill-ins — prereqs for actual Web Store submission. App icon shipped; asset drafts ready at `webstore-assets/`.
- Twitter title disambiguation — v0.4.14 patch improves labels with `@handle - tweet excerpt` and backfills late network rows; needs live x.com confirmation.

## Recently revised

- [[webstore-submission]] — 2026-05-18 — icon done, privacy effective date filled, remaining owner-side checklist clarified
- [[monetization]] — 2026-05-17 — v0.4.12 free-trial design (7-day full access, `metered` flag for counter)
- [[offscreen-api-limits]] — 2026-05-16 — new note from v0.4.8 chrome.downloads-in-offscreen fix
- [[hls-download-approach]] — 2026-05-16 — cross-linked the offscreen-API gotcha
- [[two-build-architecture]] — 2026-05-14 — IG + Twitter adapters added (v0.3.2)
