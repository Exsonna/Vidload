# Context pack — VidLoad

Generated: 2026-05-18

## What this project is

VidLoad is a Chrome MV3 extension that detects and downloads videos from arbitrary webpages, with special attention to social media (TikTok, Instagram, Twitter/X, eventually YouTube). It ships in **two builds from one source tree**:

- **Web Store build** (`dist/webstore/`) — generic HTML5 + HLS + DASH + adapters for TikTok / Instagram / Twitter. No YouTube code or references. Submission target.
- **Self-hosted build** (`dist/selfhost/`) — everything in webstore plus a YouTube adapter stub. Distributed as `.crx` from a separate marketing site.

Monetization scaffolding (free 7-day trial, then 3 downloads/day, then $4.99 lifetime via ExtensionPay) is wired but **disabled by default**. Real activation needs the project owner to sign up at extensionpay.com and replace the stub SDK at `extension/lib/extpay.js`.

Current working version: v0.4.13 plus uncommitted Codex handoff changes.

## Active topics

- [[chrome-extension-policy]] — why the dual-build split exists (Google rejects YouTube downloaders).
- [[hls-download-approach]] — concat raw segments + init segment, no FFmpeg.
- [[dash-download-approach]] — same shared offscreen pipeline; picks best-bandwidth video Representation; ignores audio sets.
- [[two-build-architecture]] — `build.mjs` rewrites manifest fields per target; adapters opt in via `BUILDS[target].adapters`.
- [[monetization]] — ExtensionPay + 7-day free trial + 3/day post-trial + paywall UI; all behind `MONETIZATION.enabled` switch.
- [[offscreen-api-limits]] — `chrome.downloads` isn't exposed inside offscreen; SW-routed `commit-download` pattern (v0.4.8).
- [[webstore-submission]] — submission asset drafts at `webstore-assets/`, hard rules (no YouTube anywhere in copy), pre-flight grep.

## Recent decisions (this session, 2026-05-18)

- **Toolbar icon redesigned** away from pixel art into a polished blue play/download app-tile style. Runtime icons live in `extension/icons/icon-{16,48,128}.png`; source artwork is `webstore-assets/vidload-icon-source.png`.
- **Twitter/X row labels improved.** `content-script.js` now extracts `@handle - tweet excerpt` from nearby `<article>` / `[data-testid="tweetText"]` / `div[lang]` context. `service-worker.js` backfills recently captured network rows if active context arrives after the network response. `adapters/twitter.js` also attaches the richer context label to adapter-reported URLs.
- **Browser verification via Playwright + bundled Chromium**: unpacked `dist/webstore` loaded, session DNR rules registered (`1001`, `1002`, `1003`), fixture video detected with rich context label, popup persistence wrote `vidload:userdata`, HLS probe found two variants and picked 1080p, popup error banner count was 0.
- **Web Store prep tightened**: privacy effective date set to May 18, 2026; support email set to `150140419@qq.com`; GitHub Pages URLs target `https://exsonna.github.io/Vidload/`.

## Recent decisions (prior session, 2026-05-17)

- **Free trial = 7 days unlimited → 3/day free → $4.99 lifetime.** Standard SaaS "try free, then convert" arc. Auto-starts on first install, no signup. Trial+paid downloads skip the daily counter via a new `gate.metered === false` flag, so day-8 starts at 0 regardless of trial-day activity.
- **Trial timer starts on `onInstalled.reason === 'install'` only**, not on update. Existing users keep remaining time across auto-updates. Missing `vidload_install_ts` = generous fallback (trial active).
- **HLS variant picker plumbed directly via variant URL** — no protocol changes to offscreen.js. The chosen variant's URL is sent as the stream URL; `parseM3U8` sees no `STREAM-INF`, treats it as a media playlist, downloads segments. Probe stores `variants[]` sorted by bandwidth desc; default selection is `[0]`.
- **Persistence as a single map** under `chrome.storage.local.vidload:userdata`. Keyed by URL. No TTL — CDN URLs are unique-per-stream so won't blow up. Loaded at popup startup, applied before render.
- **v0.4.13 Referer rule fix — session rules instead of dynamic.** Chrome rejects `tabIds`/`excludedTabIds` on dynamic rules; only session rules honor them. v0.4.7's rules had been silently failing since shipped (try/catch only logged). Session rules clear on browser restart but we already re-register on `onStartup`.
- **Web Store assets at `webstore-assets/`** — 4 markdown files (README + listing + privacy-policy + screenshots). Hard rule enforced in README: never name YouTube in any copy; grep `dist/webstore/` before submission.
- **Bundled v0.4.9–v0.4.13 into one commit** instead of per-version. popup.js was touched in 0.4.9/10/11/12 and the files were too entangled to split cleanly without `git apply` surgery. CLAUDE.md roadmap rows still describe each version individually.

## Recent decisions (carryover from prior session, 2026-05-16)

- Dual-build strategy chosen over single Web Store with YouTube risk.
- No FFmpeg, no Vite — concatenate raw segments. Saves ~30 MB.
- Offscreen document hosts the segment-fetch loop.
- `chrome.downloads` called from SW only — `commit-download` message bridges offscreen → SW.
- Active-context tracking in content script (viewport-center video, broadcast label).
- Site adapters as separate files in `extension/adapters/`, included per build.
- ExtensionPay over DIY — ~5% fee acceptable for zero backend ops.
- ExtPay `enabled = false` by default — ships infrastructure without charging until activation.
- Card-style row layout with corner overlays + inline rename + kebab menu + dismiss X.
- Aggressive segment + size filter — `.m4s`/`.ts` chunks and <100KB direct items hidden unless they carry metadata.
- Lazy duration + size + resolution probe — fills in HLS/DASH item details after first render.
- In-popup error banner for casual debug.

## Open questions

- Twitter title disambiguation — patched in local working tree; needs live x.com confirmation.
- Final product name — "VidLoad" working title.
- Free-tier limit (3/day) — calibrate after live ExtensionPay.
- DASH audio muxing — needs FFmpeg.wasm. Deferred until silent-output complaint.
- YouTube signature-cipher — multi-session, self-host only. Deferred.
- Real screenshots + Privacy Policy hosting + email/URL fill-ins — prereqs for actual Web Store submission. App icon is in place; asset drafts ready at `webstore-assets/`.

## Entity quick-ref

| Name | Role |
|---|---|
| ExtensionPay | Monetization SaaS; Stripe-backed; ~5% on top of Stripe. Stub at `extension/lib/extpay.js`. |
| Stripe | Payment processor under ExtensionPay. Not directly integrated. |
| Chrome Web Store | Primary distribution channel for webstore build. Policy: bans YouTube downloaders. |
| Video DownloadHelper | Reference UI (the screenshot user pasted as design target). |
| yt-dlp | Reference implementation for YouTube signature decoding. |

## Outputs this session

- 3 commits: `7ff1136` (prior session save-context), `58b2b6a` (v0.4.9–v0.4.13 code bundle), `4f446ab` (webstore-assets/).
- `extension/popup/popup.{js,html,css}` — userdata persistence + variant picker + trial badge.
- `extension/background/service-worker.js` — trial logic + session-rules Referer fix.
- `wiki/topics/monetization.md` — trial sections added.
- `wiki/topics/webstore-submission.md` — new note.
- `wiki/INDEX.md` — added webstore-submission to active topics; updated open questions and recently revised.
- `webstore-assets/` — README + listing.md + privacy-policy.md + screenshots.md.
- `webstore-assets/vidload-icon-source.png` + `extension/icons/icon-{16,48,128}.png` — polished app icon source and generated runtime sizes.
- `extension/content/content-script.js`, `extension/background/service-worker.js`, `extension/adapters/twitter.js` — Twitter/X rich-label extraction and active-context backfill.
- This context pack + `chats/2026-05-17-popup-polish-free-trial.md`.

## Latest session delta

- **v0.4.9** (committed retroactively) — filter network-captured `.m4s`/`.ts` segment chunks from popup. Hidden by default regardless of size unless they carry metadata.
- **v0.4.10** — persist dismissed + renamed items to `chrome.storage.local.vidload:userdata`. Survives popup close/reopen.
- **v0.4.11** — HLS variant picker. `<select>` next to format pill, populated by probe, defaults to highest quality. Variant URL flows straight to offscreen.js.
- **v0.4.12** — 7-day free trial. Auto-starts on install. Trial + paid downloads skip the daily counter. Tier badge shows "Trial · Nd" with blue gradient. All behind `MONETIZATION.enabled = false`.
- **v0.4.13** — Referer rule fix. Switched from `updateDynamicRules` to `updateSessionRules` because `tabIds` is session-only. Re-registered on `onStartup` so trade-off is invisible.
- **Web Store asset drafts** — `webstore-assets/{README,listing,privacy-policy,screenshots}.md`. Hard rules enforced. Placeholders for email + project URL.
- **Codex handoff pass** — browser-tested recent features, patched Twitter/X label disambiguation, updated Web Store prep docs.

## To pick up next session

Most likely next moves (in order of leverage):

1. **Live x.com confirmation.** Verify rows now show labels like `@handle - tweet excerpt` instead of repeated `Video on twimg.com`.
2. **Web Store screenshots + Privacy Policy hosting** — user-driven. App icon is done; asset drafts ready at `webstore-assets/`.
3. **Publish GitHub Pages** — support email and URLs are filled in. Push the repo, then enable GitHub Pages from `/docs` on `master`.
4. **ExtensionPay activation** — when project owner is ready to charge, follow [[monetization]] checklist.
5. **YouTube signature-cipher** — biggest unshipped feature; self-host only.
6. **DASH audio muxing** — first-class missing feature, needs FFmpeg.wasm. Wait for actual user demand.
