# Two-build architecture & adapter pattern

## Source vs. release builds

`extension/` is the **dev source** — load it unpacked while iterating. It contains every adapter, including YouTube.

Release artifacts come from `node build.mjs` and land in `dist/`:

| Build | Output | Includes | Purpose |
|---|---|---|---|
| `webstore` | `dist/webstore/` | generic + TikTok + Instagram + Twitter | Chrome Web Store submission |
| `selfhost` | `dist/selfhost/` | webstore set + YouTube | `.crx` distribution from our own site |

The Web Store build contains **zero references to YouTube** — verified by grep after every build. This is the policy compliance line (see [[chrome-extension-policy]]).

## How the build script works

`build.mjs` at the repo root:

1. Deletes `dist/<target>` if it exists
2. Copies `extension/` → `dist/<target>` recursively, filtering out any adapter `.js` files not listed in the target's `adapters` array
3. Rewrites `manifest.json` for the target — overwrites `description` and rebuilds `content_scripts` from the target's enabled adapter list
4. Outputs adapter-aware `manifest.json` so each build only registers the content scripts it actually ships

Adapters and target configurations live in two `const` tables at the top of `build.mjs`. Adding a new adapter:

1. Drop the file in `extension/adapters/<name>.js`
2. Register it in `ADAPTERS` with its content-script match pattern
3. Add the adapter name to whichever `BUILDS[*].adapters` arrays should include it

No bundler, no `package.json`, no `node_modules`. Just `node build.mjs`.

## Adapter contract

A site adapter is a content script registered for a specific origin. It runs in the page context, extracts video URLs by whatever means the site exposes (hydration JSON, global variables, DOM scraping), and reports findings to the background service worker via:

```js
chrome.runtime.sendMessage({
  type: 'media-found',
  source: '<adapter-name>',         // e.g. 'tiktok', 'youtube'
  items: [
    { url: '<media-url>', label: '<filename suggestion>', kind: 'hls'|'direct'|'dash' },
    // ...
  ],
  pageUrl: location.href,
});
```

The SW dedupes by URL within a tab and surfaces the items in the popup just like network-observed or DOM-detected videos.

`kind` is optional — the SW infers from URL pattern (`.m3u8` → hls, `.mpd` → dash, `.mp4`/`.webm` → direct) if the adapter doesn't supply one.

## Current adapters

### TikTok (`adapters/tiktok.js`)
- Reads `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON embedded in the page
- Walks the tree for `playAddr` and `downloadAddr` fields
- Reports both standard and HD variants when present
- Ships in **both** webstore and selfhost builds

### Instagram (`adapters/instagram.js`)
- Targets reels and posts (stories require auth, out of scope)
- Scrapes `<meta property="og:video*">` tags
- Pulls media URLs from `<script type="application/json">` blocks via regex
  matching `video_url` / `playback_url` keys and any `url` field pointing
  at `.mp4`/`.m3u8`/`.mpd`
- Best-effort: Instagram aggressively rotates its JSON structure
- Ships in **both** webstore and selfhost builds

### Twitter / X (`adapters/twitter.js`)
- Matches both `twitter.com` and `x.com`
- Scrapes `<meta name="twitter:player:stream">` and `og:video*` tags
- Pulls Twimg URLs from `<script type="application/json"|"application/ld+json">` blocks
- Mostly augments the network observer (which already catches `video.twimg.com`
  HLS streams when the user plays the tweet) by providing a better filename
  label (e.g. `twitter-username-tweetid` vs the raw CDN URL)
- Ships in **both** webstore and selfhost builds

### YouTube (`adapters/youtube.js`) — minimal stub
- Reads `ytInitialPlayerResponse.streamingData`
- Reports only URLs without `signatureCipher` (most YouTube URLs ARE signed and need player-JS-derived signatures; that's a separate project)
- Ships in **selfhost only**
- Real signature-cipher support deferred to a focused future session

## See also

- [[chrome-extension-policy]] — the policy reasoning behind the split
- [[hls-download-approach]] — how downloads actually happen
- [[INDEX]] — wiki entry point
- `build.mjs` — the build script
- `extension/adapters/` — adapter source
