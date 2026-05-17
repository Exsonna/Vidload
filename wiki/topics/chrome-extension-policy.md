# Chrome Web Store policy & the two-build strategy

## TL;DR

VidLoad ships as **two builds from one codebase**:

- **Web Store build** (`extension/`) — generic HTML5 `<video>` + HLS/DASH detection + adapters for Instagram / TikTok / Twitter. **Excludes** any YouTube-specific code and any YouTube mention in manifest, description, or screenshots.
- **Self-hosted build** (`extension-pro/`, distributed as `.crx` from a separate marketing site, sideload via Developer Mode) — everything in the Web Store build **plus** a YouTube adapter.

This split exists because the Chrome Web Store will almost certainly reject or remove a YouTube-supporting extension.

## Why the Web Store path closes for YouTube

- Google's [Webstore developer policy](https://developer.chrome.com/docs/webstore/program-policies/use) bans extensions whose primary purpose is to "facilitate the unauthorized download of streaming content."
- YouTube's own [Terms of Service](https://www.youtube.com/static?template=terms) prohibit downloading except via YouTube Premium offline.
- Historical enforcement: 2020–2023 saw a wave of YouTube-downloader removals from the Web Store. Surviving generic downloaders (e.g. Video DownloadHelper) explicitly avoid YouTube-specific code and don't mention YouTube in their store listing.
- Even when an extension is approved, YouTube rotates its player JS frequently — yt-dlp ships several releases a month just to keep up. YouTube support is a permanent maintenance treadmill.

## Why we still want YouTube in the product

It is by far the most-requested capability for a "download videos from any site" tool. Excluding it entirely materially weakens the value prop. The two-build approach lets us keep both Web Store distribution and YouTube support — at the cost of maintaining two artifacts.

## Implementation note (deferred to v0.3)

Build flag pattern (Vite-based, introduced when v0.2 needs a bundler for FFmpeg.wasm):

```
npm run build:webstore    # bundles shared/ + adapters/{generic,hls,ig,tiktok,twitter}
npm run build:selfhost    # bundles all of the above + adapters/youtube
```

The two builds also differ in `manifest.json` description, screenshots, and store metadata. The codebase keeps a `shared/` core and one adapter per supported site.

## See also

- [[ClaudeRoot/_brain/INDEX]] — wiki entry point
- `extension/manifest.json` — current MV3 manifest (no YouTube)
- Roadmap: v0.3 introduces site adapters; v0.4 introduces ExtensionPay monetization at $4.99 one-time
