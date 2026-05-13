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
| v0.3.1 | planned | Real YouTube extraction (signature-cipher decoding from player JS). DASH (`.mpd`) parser. IG/Twitter blob URL extraction |
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
