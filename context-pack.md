# Context pack — VidLoad

Generated: 2026-06-11

## What this project is

VidLoad is a Chrome MV3 extension that detects and downloads videos from arbitrary webpages (social media, course platforms, generic HTML5/HLS/DASH). **Two builds from one source tree** via `build.mjs`:

- **Web Store build** (`dist/webstore/`) — generic HTML5 + HLS + DASH + TikTok/Instagram/Twitter adapters. **No YouTube** code or strings (enforced by a pre-flight `grep youtube dist/webstore/`).
- **Self-hosted build** (`dist/selfhost/`) — everything + YouTube (player-URL capture). Distributed as `.crx`.

**Monetization is LIVE** (v0.4.24): ExtensionPay, 7-day trial → 3/day free → **$4.99 one-time** Pro. Head: **v0.4.25**, pushed to `origin/master`.

## Active topics

- [[chrome-extension-policy]] — dual-build split (Google bans YouTube downloaders).
- [[hls-download-approach]] — concat segments; **v0.4.16 TS→MP4 transmux via mux.js** (no FFmpeg).
- [[dash-download-approach]] — **v0.4.21 audio+video muxing via mp4box.js** (Reddit/FB/split-DASH).
- [[youtube-capture-approach]] — capture the player's deciphered googlevideo URLs (no base.js cipher); self-host only.
- [[two-build-architecture]] — `build.mjs` rewrites manifest per target; adapters/files opt in per build.
- [[monetization]] — LIVE; ExtPay real SDK, trial re-grant via `trialResetId`, countdown header, Upgrade link.
- [[offscreen-api-limits]] — `chrome.downloads` unreachable in offscreen → SW-routed `commit-download`.
- [[webstore-submission]] — assets + hard rules; v0.4.25 package built.

## Recent decisions (this session, 2026-06-11)

- **Generalized Referer (v0.4.14):** learned per registrable domain from `webRequest` `details.initiator`; `all_frames:true`; fixed a `build.mjs` bug that forced `all_frames:false` in dist (published build had lacked the iframe fix).
- **Real MP4 (v0.4.16):** transmux MPEG-TS HLS → fMP4 with **mux.js** (vendored ~115 KB). Falls back to `.ts` on unsupported codec.
- **Popup reliability (v0.4.15):** real titles (page title, generic "Video Player" suppressed), poster scan, **0–100% progress bar**, **background-download persistence** (SW job table mirrored to `storage.session`).
- **HLS dedup (v0.4.17):** `dedupKey` strips query for `.m3u8`/`.mpd` (download URL keeps token via `canonicalUrl`); popup hides child variant/audio playlists under their master.
- **Download badge (v0.4.18); direct pre-flight (v0.4.19→v0.4.20):** refuse to save an HTML error page as `.txt`, but **fail-open** on CORS/network errors. Generic `og:video`/JSON-LD scraper for long-tail sites.
- **A/V muxing (v0.4.21):** **mp4box.js** (~147 KB). DASH parser extracts best audio + single-file `SegmentBase`; `muxAvToMp4` carries codec config via the sample-entry `description` box.
- **YouTube via capture (v0.4.22, self-host):** MAIN-world hook captures the player's already-deciphered `googlevideo` URLs; adapter builds a quality-selectable `mux` item; reuses `muxAvToMp4`. Avoids the cipher treadmill (confirmed by reading the live 2.78 MB obfuscated base.js).
- **Monetization go-live (v0.4.23–v0.4.25):** trial re-grant via bumpable `trialResetId` (`reliability-2026-06`), live countdown header, real ExtPay SDK + required `extensionpay.com` content script, always-visible Upgrade link. **Stripe-test-card payment → Pro verified.**
- **Process:** committed verified work continuously; pushed 7 commits (needed the `127.0.0.1:7898` proxy override — gitconfig's `:26433` is stale). Store dashboard can't be browser-automated (extensions gallery is unscriptable) → owner uploads manually.

## Open questions

- YouTube capture limits — only *played* qualities captured; 1440p/4K (VP9/AV1+Opus) may not mux; SABR/POST videos may not be captured.
- git proxy port mismatch (`:26433` gitconfig vs `:7898` live) — offered to fix the global config; awaiting yes.
- Free-tier limit (3/day) — calibrate against real conversion now that ExtPay is live.
- Final product name; Twitter title disambiguation live-confirm.
- DASH/Reddit muxer codec-pairing edge cases (iteration-1).
- **Self-host `.crx` has no `update_url`** → those users don't auto-update (YouTube fixes won't reach them). Open gap; offered to add an update manifest.
- Monitoring: a weekly [[platform-health-canary]] now runs (structural early-warning only); a real in-browser download spot-check is still the source of truth.

## Entity quick-ref

| Name | Role |
|---|---|
| ExtensionPay | Monetization SaaS; Stripe-backed. **Real SDK now vendored** at `lib/extpay.js`. extension id `vidload`. |
| Stripe | Payment processor under ExtPay. Statement descriptor `VIDLOAD`, $4.99 one-time. |
| mux.js | TS→fMP4 transmuxer (Apache-2.0), `lib/mux.min.js`. |
| mp4box.js | A/V muxer (BSD/LGPL), `lib/mp4box.min.js`. |
| Chrome Web Store | Distribution for webstore build; bans YouTube downloaders; dashboard unscriptable by extensions. |

## Outputs this session

- 7 commits (`0e00a3f` mux.js, `87216e8` v0.4.14–0.4.20, `fefbe30` mp4box.js, `010dc86` v0.4.21–0.4.22, `525aa4c` v0.4.23, `5b5cbf2` v0.4.24, `230cfdb` v0.4.25), pushed to `origin/master`.
- Vendored libs: mux.js, mp4box.js, real ExtPay SDK (+ NOTICEs).
- New: `adapters/youtube-hook.js`. Packages: `dist/vidload-webstore-v0.4.22.zip`, `…-v0.4.25.zip`.
- Wiki: new [[youtube-capture-approach]] + [[platform-health-canary]]; updated [[monetization]] (LIVE), [[dash-download-approach]] (muxing), [[hls-download-approach]] (transmux), [[webstore-submission]] (v0.4.25 + auto-update behavior), INDEX.
- **Scheduled task `vidload-platform-health-check`** (cron `0 9 * * 1`) — weekly structural canary; reports + drafts fixes only, never auto-ships.
- `chats/2026-06-11-monetization-golive.md` + this pack.

## Latest session delta

v0.4.14 Referer+iframes → v0.4.15 popup reliability → v0.4.16 transmux → v0.4.17 HLS dedup → v0.4.18 badge → v0.4.19/20 pre-flight + scraper → v0.4.21 DASH muxing → v0.4.22 YouTube capture → v0.4.23 trial re-grant + countdown → v0.4.24 ExtPay activated → v0.4.25 Upgrade link.

## To pick up next session

1. **Confirm the v0.4.25 store upload went through** + passed review (owner-side; supersedes pending v0.4.22).
2. **Check the Monday [[platform-health-canary]] report** (`vidload-platform-health-check`); recommend the owner clicks "Run now" once to pre-approve its tools + get a baseline.
3. Two standing offers awaiting yes: fix the **git proxy** (`git config --global http.proxy http://127.0.0.1:7898`) and add the **self-host `.crx` `update_url`** so those users auto-update.
4. Watch for ExtPay live-payment reports / first real conversions; calibrate the 3/day free limit.
5. YouTube robustness: handle webm/Opus muxing (1440p/4K) and detect SABR gracefully. Self-host `.crx` distribution + marketing site.
