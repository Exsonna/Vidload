# YouTube downloads — player-URL capture, not cipher reimplementation

## Decision (v0.4.22, self-host build only)

VidLoad downloads YouTube by **capturing the already-deciphered `googlevideo` URLs the YouTube player itself fetches**, rather than reimplementing YouTube's signature / `n`-parameter cipher. This avoids the [yt-dlp](https://github.com/yt-dlp/yt-dlp) treadmill entirely.

## Why not the cipher

We confirmed the cost directly: the live player `base.js` is **~2.78 MB of heavily-obfuscated JS** that rotates every few weeks. The `n`-throttle transform looks like `CVy=function(P){…(new g.iE(P,!0)).get("n")…}` with mangled helpers — not interpretable, it must be *executed*. In MV3 that means a sandboxed page (CSP forbids `eval` elsewhere), plus the signature transform, plus extraction regexes that break on every rotation. That's a permanent maintenance project (exactly what yt-dlp is). Even itag-18 360p is now `n`-throttled, so the old "report unsigned formats" adapter just produced HTML error pages saved as `.txt`.

## How capture works

Two self-host-only content scripts (both stripped from the webstore build by `build.mjs`):

1. **`adapters/youtube-hook.js`** — runs in the page's **MAIN world** at `document_start` (`"world": "MAIN"` content script). Wraps `window.fetch` and `XMLHttpRequest.prototype.open`, and for every `googlevideo.com/videoplayback` request records the URL per `itag`, stripping range/streaming params (`range`, `rn`, `rbuf`, `ump`, `sq`…) but **keeping auth params** (`pot`, `sig`, `n`, `expire`, `ip`). `postMessage`s each to the page.
2. **`adapters/youtube.js`** — isolated world. Listens for those messages, cross-references each itag with `ytInitialPlayerResponse.streamingData` (resolution, mime, `contentLength`, progressive-vs-adaptive), and reports one synthesized **`kind:'mux'`** item: a quality-selectable `videoVariants[]` + the best **AAC** audio (`audioUrl`). Progressive itags (18/22) carry audio (`hasAudio`); adaptive video itags get muxed with the audio track at download time.

Download path: popup sends `download-av {videoUrl, audioUrl}` → SW → offscreen `runMuxJob` downloads both whole (`fetchFullWithProgress`) and muxes via `muxAvToMp4` (see [[dash-download-approach]] / mp4box.js). Progressive → no mux. Quality picker reuses the HLS variant `<select>`.

## Why it's self-host only

Chrome Web Store policy bans YouTube downloaders ([[chrome-extension-policy]]). The hook + adapter are excluded from the webstore build, and the shared code (SW/offscreen/popup `mux` handling) contains **no "youtube" strings** — verified by the pre-flight `grep youtube dist/webstore/`. The generic `mux` item kind is what keeps the shared code policy-clean while the YouTube adapter is the only thing that produces such items on YouTube.

## Known limits (accepted — "we update every few weeks")

- **Only played qualities are captured.** YouTube streams adaptively, so a quality appears in the picker only after the player has fetched it. Changing quality in YouTube's own gear menu makes it fetch (and us capture) that itag.
- **≤1080p muxes cleanly** (H.264 + AAC → MP4). 1440p/4K are VP9/AV1 + Opus and may not mux into MP4.
- **SABR / POST `videoplayback`** (newer YouTube streaming) isn't a simple GET URL → may not be captured.
- Maintenance treadmill is shallower than cipher extraction but non-zero (the hook is stable; the playerResponse shape can drift).

## See also

- [[chrome-extension-policy]] — why YouTube is self-host only
- [[dash-download-approach]] — the shared mp4box A/V muxer this reuses
- [[two-build-architecture]] — how `build.mjs` keeps both YouTube files out of the webstore build
- `extension/adapters/youtube-hook.js`, `extension/adapters/youtube.js`
