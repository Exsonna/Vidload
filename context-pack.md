# Context pack — VidLoad

Generated: 2026-07-14

## What this project is

VidLoad is a Chrome MV3 extension that detects and downloads videos from arbitrary webpages (social media, course platforms, generic HTML5/HLS/DASH). **Two builds from one source tree** via `build.mjs`:

- **Web Store build** (`dist/webstore/`) — generic HTML5 + HLS + DASH + TikTok/Instagram/Twitter adapters. **No YouTube** capability; the only allowed YouTube mention is the non-support banner (`popup/youtube-notice.js`). Enforced by an **automated leak gate in `build.mjs`** (v0.4.28) that hard-fails the webstore build on any `youtube|googlevideo|ytcfg` hit outside the 3 disclaimer files.
- **Self-hosted build** (`dist/selfhost/`) — everything + YouTube (player-URL capture). Distributed as `.crx`.

**Monetization is LIVE, lifetime-cap model** (v0.4.29): ExtensionPay, **10 free lifetime downloads → $4.99 one-time** Pro. No trial, no daily reset. Head: **v0.4.29** (`f216af8`) on `origin/master`; one trivial screenshot commit (`acc2abb`) pending push.

## Active topics

- [[chrome-extension-policy]] — dual-build split (Google bans YouTube downloaders).
- [[hls-download-approach]] — concat segments; TS→MP4 transmux via mux.js; **v0.4.28 fixed byte-range HLS** (real `Range` requests) + AES IV validation.
- [[dash-download-approach]] — audio+video muxing via mp4box.js (Reddit/FB/split-DASH).
- [[youtube-capture-approach]] — capture the player's deciphered googlevideo URLs; self-host only.
- [[two-build-architecture]] — `build.mjs` rewrites manifest per target; now with the enforced YouTube-leak gate.
- [[monetization]] — **LIVE, lifetime-cap** (v0.4.29): 10 free → $4.99; trial removed; pay-flow hardened.
- [[offscreen-api-limits]] — `chrome.downloads` unreachable in offscreen → SW-routed `commit-download` (now restricted to offscreen blob: URLs).
- [[webstore-submission]] — assets + hard rules; v0.4.29 package; submitted for review.
- [[platform-health-canary]] — weekly structural checkup (`vidload-platform-health-check`).

## Recent decisions (this session, 2026-07-14)

- **Full Fable audit → v0.4.28 (23 fixes).** 8-dimension multi-agent Workflow with adversarial verification (each finding refuted by an independent skeptic). 35 raw → **23 real / 12 rejected**. Fixed: atomic free-tier quota reservation (concurrent downloads can't exceed the limit), local-midnight counter reset, meter-on-success (failed segmented jobs don't burn a slot), enforced YouTube-leak build gate, byte-range HLS (`#EXT-X-BYTERANGE` was parsed but never applied → corrupt output), job-wide abort on failure, 2 GB memory ceiling, AES IV validation, `getJobsMerged` always-merge (restores all in-flight jobs), race-safe learned-Referer (first-writer-wins + bounded map), offscreen-create TOCTOU, `commit-download` origin restriction, subframe filename clobber, keyboard menu + aria, rename-on-blur guard, "Saved ⚠ (no audio)" warning, and a new shared `lib/media-url.js` dedup helper. Second verification workflow: **0 regressions**.
- **"Why no paid users" monetization audit.** 3-angle Workflow (gating-bypass / payment-integrity / funnel-design) converged: the paywall almost never fired. A 7-day unlimited trial + a 3/day daily-reset tier (~90 free/month) + `trialResetId` re-grants meant the median downloader was never asked to pay. **Zero paid was the predictable output of the funnel**, not a broken checkout (payment plumbing verified intact).
- **v0.4.29 — funnel redesign (chosen: lifetime cap).** Replaced trial + daily tier with **10 lifetime free downloads → $4.99 unlimited forever** (single accumulating counter). Removed `trialDays`/`trialResetId`/`getTrialStatus` entirely. Storage migration seamless (old `{date,count}` preserved). Pay-flow fixes: `isPaid()` caches a confirmed payer (`vidload_paid_cache`) and **fails OPEN** on ExtPay outage; `onPaid` caches + broadcasts `paid-status-changed` (live unlock); `open-payment-page` awaits the checkout tab + surfaces failures. Popup: trial countdown → **free-quota banner**, `Free · used/10` badge, benefit tooltip. Verified: 0 issues.
- **Store update + submitted.** v0.4.29 uploaded (owner); listing pricing bullets + `storage` justification rewritten; privacy page (`docs/privacy.html`, effective 2026-07-14) updated for the new data model + republished via Pages; **screenshot 5 regenerated** (`05-free-upgrade.png`, a 1280×800 composite rendered with headless Chrome), stale `05-trial-upgrade.png` deleted. Owner clicked Submit for review.
- **git proxy fixed** — `http.proxy socks5h://127.0.0.1:7898` (7898 is **SOCKS5**, not HTTP; old `:26433` was dead). Persistent config change. Tunnel occasionally flaky (port up but upstream can't reach github → retry / switch node).

## Open questions

- **Conversion** — will the lifetime-cap change actually produce paid users? Tune `freeLifetimeLimit` (10) if needed. Judge as paid ÷ paywall-impressions, not ÷ installs.
- **Confirm a real end-to-end purchase** — `extpayId: 'vidload'` must match the extensionpay.com dashboard exactly, else every checkout dead-ends. Highest-value check.
- **Which version is the *published* store build** — if a pre-monetization build was ever live, that alone explains prior zero conversions.
- Reinstall/clear-storage resets the free-download count (client-side metering unwinnable) — accepted; server-side meter = future backend.
- YouTube capture limits — only *played* qualities captured; 1440p/4K (VP9/AV1+Opus) may not mux; SABR videos may not be captured.
- Self-host `.crx` has no `update_url` → those users don't auto-update (open gap).

## Entity quick-ref

| Name | Role |
|---|---|
| ExtensionPay | Monetization SaaS; Stripe-backed. Real SDK at `lib/extpay.js`. extension id `vidload`. |
| Stripe | Payment processor under ExtPay. $4.99 one-time. |
| mux.js / mp4box.js | TS→fMP4 transmuxer / A/V muxer (`lib/*.min.js`). |
| Chrome Web Store | Distribution for webstore build; bans YouTube downloaders; **dashboard is unscriptable by extensions** (upload is manual). |
| GitHub Pages | Serves the privacy/support site from **`/docs` on `Exsonna/Vidload`** (this repo's origin). |

## Outputs this session

- Commits: `65f5d12` (v0.4.28 audit fixes) + `f216af8` (v0.4.29 monetization overhaul) pushed to `origin/master`; `acc2abb` (screenshot swap) committed, **push pending** (proxy).
- Packages: `dist/vidload-webstore-v0.4.28.zip`, `…-v0.4.29.zip` (both validated 45/45, no YouTube leak).
- New file `extension/lib/media-url.js` (shared SW+popup URL/domain helpers). New screenshot `webstore-assets/screenshots/05-free-upgrade.png`.
- A reusable pre-submission validator lives in scratchpad (`validate-build.mjs`) — checks manifest, file refs, JS syntax, import/script resolution, leak, icons.
- Wiki: [[monetization]] rewritten to the lifetime-cap model + audit rationale; [[webstore-submission]] package status; INDEX updated; `chats/2026-07-14-audit-monetization-overhaul.md`.

## Latest session delta

v0.4.27 (prior) → **v0.4.28** full audit-fix pass (23 findings, adversarially verified) → **v0.4.29** monetization funnel overhaul (10 free → $4.99, trial removed, pay-flow hardened) → store package uploaded + listing/privacy/screenshot updated + submitted for review.

## To pick up next session

1. **Push `acc2abb`** (screenshot commit) once the proxy tunnel is stable — `git push`. Non-blocking.
2. **Confirm v0.4.29 passed review** and is the published store version.
3. **Verify a real end-to-end purchase** unlocks Pro (extpayId `vidload`).
4. **Watch first conversions** after the lifetime-cap change; tune `freeLifetimeLimit`.
5. Check the Monday [[platform-health-canary]] report.
6. Longer tail: self-host `.crx` `update_url`; YouTube webm/Opus muxing (1440p/4K) + SABR detection.
