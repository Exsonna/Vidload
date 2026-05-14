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
| v0.3.8 | planned | YouTube signature-cipher extraction. DASH audio+video muxing. HLS variant picker |
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
