# VidLoad — Claude Code notes

This project uses the **LLM Wiki** pattern (see `wiki/README.md`) and the **save-context** / **load-context** skills for cross-session memory. The vault is at `C:\Users\anson\home-nas\dev\Myvault`; this project's wiki/chats are junctioned in at `_projects\VidLoad\` and `_chats\VidLoad\`. Global Karpathy guidelines load from `~/.claude/CLAUDE.md`.

No external knowledge store is configured. The wiki and `chats/` directory are the only memory stores.

## What this project is

VidLoad is a Chrome extension (Manifest V3) for downloading videos from arbitrary web pages, especially social media. **Two-build distribution strategy**:

- **Web Store build** (`extension/`) — generic HTML5 + HLS/DASH + adapters for Instagram / TikTok / Twitter. No YouTube code or mentions.
- **Self-hosted build** (`extension-pro/`, planned for v0.3) — everything in the Web Store build plus a YouTube adapter, distributed as a `.crx` from a separate marketing site.

Eventual monetization via **ExtensionPay** — $4.99 one-time unlock above a 3-downloads-per-day free tier. See `wiki/topics/chrome-extension-policy.md` for the full rationale.

## Roadmap

| Version | Status | Scope |
|---|---|---|
| v0.1 | shipped | Direct `<video src="...mp4">` detection + download; popup UI; webRequest observation |
| v0.2 | shipped | HLS (`.m3u8`) download via offscreen document — playlist parsing, AES-128 decryption, segment concatenation. **No FFmpeg, no bundler** — see [[hls-download-approach]] |
| v0.3 | shipped | **Two-build flag** via `build.mjs` (no bundler) — webstore + selfhost outputs. TikTok adapter (both builds). YouTube adapter stub (selfhost only). URL-pattern matching fallback in webRequest. See [[two-build-architecture]] |
| v0.3.1 | shipped | DASH (`.mpd`) download via shared offscreen pipeline. Unified `stream-*` message protocol replaces `hls-*`. See [[dash-download-approach]] |
| v0.3.2 | shipped | Instagram + Twitter/X site adapters (best-effort meta-tag + JSON-block scrapers). Both ship in webstore build alongside TikTok. See [[two-build-architecture]] |
| v0.3.3 | shipped | Popup UX overhaul — thumbnails, descriptions, file size, resolution, duration. Adapters now extract richer metadata (cover image, dimensions, duration); webRequest captures Content-Length; items deduped via upsert merge |
| v0.3.4 | shipped | Popup polish v2 — VideoHelper-style card layout. **Size filter** hides direct/network items <100KB (probe responses / sub-segments). Quality badge (1080p / 4K / etc.) overlaid on thumbnail. Play-icon placeholder for missing posters. Gibberish-URL labels collapse to "Video on <host>". "Show N hidden" toggle for power users |
| v0.3.5 | shipped | Card row redesign matching reference UI — bigger thumb (128×72), three thumb overlays (quality top-left, duration bottom-left, kind bottom-right), color-coded format badge inline with title, **rename** (inline contenteditable), **dismiss** (X), **copy URL** (kebab), larger Download button with download icon |
| v0.3.6 | shipped | Layout overflow fix (Download button was clipped on long hostnames) + byte-range chunk dedup. SW now strips `bytestart/byteend/range` query params for dedup, captures `Content-Range` total size, and merges chunks of the same media into one canonical item. Source pill collapses subdomains (`instagram.fhkg4-2.fna.fbcdn.net` → `fbcdn.net`) and truncates with ellipsis |
| v0.3.7 | shipped | **Context-aware filenames.** Content script walks the DOM near each `<video>` to find the nearest on-page name (Instagram handle, Twitter handle, generic heading). Also tracks the video closest to viewport center as the "active context" and broadcasts it to the SW so network-observed URLs get tagged with a meaningful filename. Saved files become `zara.040110.mp4` / `1000x_stocks.mp4` instead of `abc123.mp4` |
| v0.4 | shipped | **ExtensionPay monetization scaffolding** — gating logic + paywall UI + status badge + daily counter. Currently **disabled by default** (MONETIZATION.enabled = false). Flip to true and replace `lib/extpay.js` with the real SDK to activate. See [[monetization]] |
| v0.4.1 | shipped | Lazy duration probe for HLS/DASH items — popup fetches the manifest, sums `#EXTINF` or parses `mediaPresentationDuration`, updates the thumbnail overlay. Format pill regex now recognizes `m4s`/`m4v`/`mkv`/`avi` so the pill matches the saved file extension |
| v0.4.2 | shipped | Better context detection on Twitter-style feeds (which don't render `<video>` until played) — tracker now falls back to `<article>` in viewport, then to URL-pattern inference. Manifest-size bytes pill hidden for HLS/DASH items <50KB (was confusingly showing "449 B" when the actual video is MB). Retry button now exposes the underlying error as a tooltip |
| v0.4.7 | shipped | **Referer rewrite** via `declarativeNetRequestWithHostAccess` so x.com/Instagram/TikTok CDNs accept our extension-originated fetches. Dynamic rules scoped to `tabIds: [-1]` rewrite `Referer` to a plausible in-page value for `twimg.com` → `https://x.com/`, `fbcdn.net`/`cdninstagram.com` → `https://www.instagram.com/`, `tiktokcdn.com` → `https://www.tiktok.com/`. User's normal browsing is unaffected (tab-initiated requests have a real tabId and bypass the rules). |
| v0.4.8 | shipped | **chrome.downloads-in-offscreen fix.** `chrome.downloads` is undefined inside offscreen documents (latent since v0.2 — only surfaced when x.com HLS hit `finalize()`). Final download is now routed back to the SW via a `commit-download` message; SW calls `chrome.downloads.download()` with the offscreen-created blob URL (same extension origin → fetchable across contexts). See [[offscreen-api-limits]] |
| v0.4.9 | shipped | **Segment-chunk filter.** Network-captured `.m4s` / `.ts` direct items are HLS/DASH sub-segments, not standalone videos — they were polluting the popup on x.com (15 visible + 35 hidden). Now hidden by default regardless of size unless they carry metadata (poster/duration/dims). "Show N hidden" toggle still surfaces them. |
| v0.4.10 | shipped | **Persistence.** Dismissed items and renames now survive popup close — kept in `chrome.storage.local` under `vidload:userdata` keyed by URL. Loaded at popup startup, applied before render, written on each dismiss/rename. |
| v0.4.11 | shipped | **HLS variant picker.** Probe now returns the full `variants[]` array (all bandwidths/resolutions). Row UI gains a compact `<select>` next to the format pill — defaults to highest quality, switches the download URL when user picks a lower quality. Variant URL flows straight to `offscreen.js` (which treats it as a media playlist and skips the master-pick branch). |
| v0.4.12 | shipped | **Free trial mode.** 7-day full-access trial auto-starts on first install (`chrome.storage.local.vidload_install_ts`). Trial downloads bypass the daily counter entirely. After trial expires, drops to the existing 3/day free tier with the paywall available. Tier badge shows "Trial · 5d" with a blue gradient during trial. All scaffolding behind the existing `MONETIZATION.enabled = false` switch — no live gating until the project owner activates ExtPay. See [[monetization]] |
| v0.4.13 | shipped | **Referer rule fix.** Chrome rejects `tabIds`/`excludedTabIds` on dynamic rules — only session-scoped rules support them. The v0.4.7 Referer rewrite had been silently failing since it shipped (the try/catch only logged). Switched to `updateSessionRules`/`getSessionRules`. Already re-registered on `onStartup` so the session-lifetime trade-off is invisible. |
| v0.4.14 | shipped | **Generalized Referer + iframe detection (the Teachable/Hotmart fix).** Referer rewrite is now *learned* per registrable domain from `webRequest`'s `details.initiator` (the embed origin), not hardcoded to 3 CDNs — fixes downloads + the metadata probe on arbitrary CDN-gated sites. Content script runs in `all_frames` so player iframes are detected. Page-title + poster/duration broadcast onto MSE (`blob:`) network streams via the active-context channel. |
| v0.4.15 | shipped | **Popup reliability pass.** Real titles for network streams (page title, generic "Video Player" labels suppressed); poster-overlay thumbnail scan; **0–100% progress bar** replacing the `N/M` counter; **background-download persistence** — SW owns a job table (mirrored to `storage.session`) so reopening the popup restores in-flight progress. |
| v0.4.16 | shipped | **Real MP4 output via transmux.** MPEG-TS HLS segments are rewrapped into a fragmented `.mp4` using **mux.js** (vendored, ~115 KB, no FFmpeg/WASM) instead of saving a `.ts`. Falls back to `.ts` if the codec is unsupported. Also fixed a `build.mjs` bug that hardcoded `all_frames:false` in dist — the published build never actually had the iframe fix. See [[hls-download-approach]] |
| v0.4.17 | shipped | **Collapse duplicate HLS rows.** `dedupKey` now strips the query for `.m3u8`/`.mpd` so the same playlist fetched with different tokens merges (download URL keeps its token via separate `canonicalUrl`). Popup hides child variant/audio playlists once a master's probe reveals them — master + variants + audio → one row. |
| v0.4.18 | shipped | **Download-count badge** on the toolbar icon (active stream jobs), deduped so it only updates on count change. |
| v0.4.19 | shipped | **Direct-download pre-flight.** Before saving a "direct" file, a 2-byte ranged request checks the Content-Type; an HTML/text error body is refused instead of saved as a garbage `.txt` (the throttled/expired/forbidden-link case). |
| v0.4.20 | shipped | **Broader long-tail coverage + pre-flight fail-open.** Generic `og:video` + JSON-LD `VideoObject` scraper covers sites without a dedicated adapter. Pre-flight now only hard-blocks on *positive* evidence of an HTML body (fails open on CORS/network errors) so it never regresses sites `chrome.downloads` could handle. |
| v0.4.21 | shipped | **DASH audio+video muxing.** Vendored mp4box.js (~147 KB, pure JS, no FFmpeg). DASH parser extracts the best audio AdaptationSet + single-file `SegmentBase` representations (Reddit `v.redd.it`). Separate audio → download both tracks, mux into one MP4 via mp4box (codec config carried over through the sample-entry `description` box). Fixes silent video on Reddit / Facebook / split-DASH. Both builds. |
| v0.4.23 | shipped | **Monetization go-live prep.** Trial timer rewritten: starts the first time monetization is active and **re-grants every user a fresh `trialDays` trial whenever `MONETIZATION.trialResetId` changes** (set to `reliability-2026-06` to give everyone another 7 days after the bug-fix overhaul). `get-status` returns `trialEndsAt`; popup shows a **live countdown header** at the top ("✨ Free trial — 6d 23h 41m 12s left") that ticks every second, switching to a tap-to-upgrade banner when the trial ends. Gating verified end-to-end (paid → trial → 3/day → paywall). Still behind `MONETIZATION.enabled=false` — flip after ExtPay activation. See [[monetization]] |
| v0.4.22 | shipped (self-host only) | **YouTube downloads via player-URL capture.** Rather than reimplement YouTube's rotating `base.js` signature/n cipher, a MAIN-world hook captures the already-deciphered `googlevideo` URLs the player fetches, cross-referenced with player format metadata into a quality-selectable `mux` item. Chosen video + best AAC audio are downloaded whole and muxed → MP4. Quality picker reuses the variant dropdown. **Webstore build excludes all of it** (hook + adapter stripped by `build.mjs`; no "youtube" strings in shared files). |
| v0.4.3 | planned | YouTube signature-cipher extraction. DASH audio+video muxing. HLS variant picker. Real icons + Web Store screenshots + Privacy Policy doc |
| v0.4 | planned | ExtensionPay integration — $4.99 lifetime unlock |
| v0.5+ | future | Web Store submission, marketing site, polish |

## Building release artifacts

```
node build.mjs
```

Produces `dist/webstore/` (load this for Web Store submission) and `dist/selfhost/` (zip and host on our own site for sideload). The source `extension/` keeps every adapter for local development — load it unpacked when iterating.

## When you (Claude) start a new conversation here

1. Read `wiki/INDEX.md` first (or `Myvault\ClaudeRoot\_projects\VidLoad\INDEX.md` via the vault junction).
2. Skim the 3 most recent files in `chats/` to recover context.
3. The wiki + chats are authoritative for session memory.

## When the user adds new source material

Drop into `wiki/sources/`, integrate per `wiki/README.md` rules. Use `[[wikilinks]]`.

## At the end of a substantive session

Offer to run the `save-context` skill to:
1. Append a transcript to `chats/YYYY-MM-DD-<slug>.md`.
2. Integrate updates into the Obsidian wiki (in-place; `[[wikilinks]]`).
3. Regenerate `context-pack.md` (kept locally).

## Development reminders

- Manifest V3 only. Service worker can suspend — never assume in-memory state across messages; use `chrome.storage.session` for short-lived per-tab data.
- Do **not** add YouTube-specific code, asset, or string to the `extension/` (Web Store) build. YouTube logic lives only in the `extension-pro/` self-host build introduced in v0.3.
- Keep `manifest.json` description and store-listing language generic ("save videos from webpages"). Never name specific platforms in user-facing copy for the Web Store build.
