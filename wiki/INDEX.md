# VidLoad Wiki Index

Top-level map. Read this first to orient before any wiki work.

## Active topics

- [[chrome-extension-policy]] — why VidLoad ships as two builds (Web Store + self-hosted)
- [[hls-download-approach]] — why v0.2 ships HLS support without FFmpeg/Vite
- [[two-build-architecture]] — how `build.mjs` produces webstore + selfhost outputs, and the adapter contract
- [[dash-download-approach]] — DASH support + v0.4.21 audio+video muxing (mp4box.js)
- [[youtube-capture-approach]] — YouTube via MAIN-world player-URL capture, not the base.js cipher (self-host only)
- [[monetization]] — **LIVE**, lifetime-cap model (v0.4.29): ExtensionPay $4.99 one-time, **10 free downloads then paywall** (trial removed), pay-flow hardened (fail-open for payers, live unlock)
- [[offscreen-api-limits]] — `chrome.downloads` isn't reachable in offscreen; SW-routed pattern for downloads
- [[webstore-submission]] — assets, hard rules, pre-flight grep; v0.4.25 package; auto-update behavior
- [[platform-health-canary]] — weekly scheduled structural checkup (`vidload-platform-health-check`)

## Entities

_People, companies, products. Add as `- [[Name]] — one-line tag`._

## Open questions

- Final product name — "VidLoad" is a working title.
- Conversion — v0.4.29 switched to a 10-download lifetime free cap (from 3/day + 7-day trial) because the paywall almost never fired. Watch whether paid conversions start; tune `freeLifetimeLimit` if needed. Also confirm a **real** end-to-end purchase works (extpayId `vidload` must match the dashboard).
- Reinstall/clear-storage resets the free-download count (client-side metering is unwinnable) — accepted; a future server-side meter would need a backend we don't run. See [[monetization]].
- YouTube capture limits — only played qualities captured; 1440p/4K (VP9/AV1+Opus) may not mux; SABR videos may not be captured. See [[youtube-capture-approach]].
- git proxy — **fixed**: `git config --global http.proxy socks5h://127.0.0.1:7898` (7898 is SOCKS5, not HTTP). Tunnel is occasionally flaky (proxy up but upstream can't reach github) — retry or switch node.
- Twitter title disambiguation — improved labels; still wants live x.com confirmation.

## Recently revised

- 2026-07-14: [[monetization]] — **funnel overhaul** (v0.4.29): 7-day trial + 3/day → 10 lifetime free → $4.99; pay-flow fixes. [[webstore-submission]] — v0.4.28 + v0.4.29 packages, submitted for review. Preceded by a full Fable audit (v0.4.28, 23 verified findings fixed) + a "why no paid users" monetization audit. See `chats/2026-07-14-audit-monetization-overhaul.md`.
- 2026-06-11: [[platform-health-canary]] — new (weekly checkup scheduled); [[webstore-submission]] — auto-update behavior added; [[monetization]] — **LIVE**; [[youtube-capture-approach]] — new; [[dash-download-approach]]/[[hls-download-approach]] — muxing/transmux (see `chats/2026-06-11-monetization-golive.md`)
- [[offscreen-api-limits]] — 2026-05-16 — new note from v0.4.8 chrome.downloads-in-offscreen fix
- [[two-build-architecture]] — 2026-05-14 — IG + Twitter adapters added (v0.3.2)
