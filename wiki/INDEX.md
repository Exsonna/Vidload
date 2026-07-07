# VidLoad Wiki Index

Top-level map. Read this first to orient before any wiki work.

## Active topics

- [[chrome-extension-policy]] — why VidLoad ships as two builds (Web Store + self-hosted)
- [[hls-download-approach]] — why v0.2 ships HLS support without FFmpeg/Vite
- [[two-build-architecture]] — how `build.mjs` produces webstore + selfhost outputs, and the adapter contract
- [[dash-download-approach]] — DASH support + v0.4.21 audio+video muxing (mp4box.js)
- [[youtube-capture-approach]] — YouTube via MAIN-world player-URL capture, not the base.js cipher (self-host only)
- [[monetization]] — **LIVE** (v0.4.24): ExtensionPay $4.99, 7-day trial w/ countdown + re-grant, Upgrade link
- [[offscreen-api-limits]] — `chrome.downloads` isn't reachable in offscreen; SW-routed pattern for downloads
- [[webstore-submission]] — assets, hard rules, pre-flight grep; v0.4.25 package; auto-update behavior
- [[platform-health-canary]] — weekly scheduled structural checkup (`vidload-platform-health-check`)

## Entities

_People, companies, products. Add as `- [[Name]] — one-line tag`._

## Open questions

- Final product name — "VidLoad" is a working title.
- Free-tier daily limit — 3/day; validate against actual conversion now that ExtensionPay is live.
- YouTube capture limits — only played qualities captured; 1440p/4K (VP9/AV1+Opus) may not mux; SABR videos may not be captured. See [[youtube-capture-approach]].
- git proxy — `~/.gitconfig` http.proxy is stale (`:26433`); live proxy is `:7898`. Push needs the 7898 override until fixed.
- Twitter title disambiguation — improved labels; still wants live x.com confirmation.

## Recently revised

- 2026-06-11: [[platform-health-canary]] — new (weekly checkup scheduled); [[webstore-submission]] — auto-update behavior added; [[monetization]] — **LIVE**; [[youtube-capture-approach]] — new; [[dash-download-approach]]/[[hls-download-approach]] — muxing/transmux (see `chats/2026-06-11-monetization-golive.md`)
- [[offscreen-api-limits]] — 2026-05-16 — new note from v0.4.8 chrome.downloads-in-offscreen fix
- [[two-build-architecture]] — 2026-05-14 — IG + Twitter adapters added (v0.3.2)
