# HLS download approach — why no FFmpeg

## Decision

VidLoad v0.2 downloads HLS streams by **concatenating raw segment bytes**, with no transmuxing step. Output extension is `.ts` for MPEG-TS segments or `.mp4` for fragmented MP4 (fMP4) segments. Both play in VLC, Windows Media Player, and modern browsers.

## Rationale

The "obvious" path is FFmpeg.wasm: download segments, transmux to a single MP4, save. We rejected it for v0.2 because:

- **30 MB bundle.** `@ffmpeg/core` adds ~30 MB to the extension. That's the whole budget several times over for a save-a-video tool.
- **Build complexity.** FFmpeg.wasm needs SharedArrayBuffer, which needs COOP/COEP headers, which in MV3 means a Vite/webpack config plus careful offscreen-document plumbing.
- **Not actually required.** HLS segments are already valid video containers:
  - `.ts` (MPEG-TS) segments — concatenating bytes yields a valid `.ts` file.
  - `.m4s`/`.mp4` (fragmented MP4) segments — prepending the init segment (`EXT-X-MAP`) yields a valid fMP4 `.mp4` file.

We trade nothing essential for a much leaner build. Power users who need pure-MP4 (non-fragmented) output can re-mux with VLC or `ffmpeg` locally.

## When to revisit

- If users report `.ts` files don't play in their preferred player.
- If we need to add audio/video track selection (some HLS streams ship audio as a separate variant; remuxing into a single MP4 is the standard fix).
- If we add DASH (`.mpd`) — DASH segments are more often fMP4, but the same concat-with-init logic applies.

If any of those land, the migration path is: introduce Vite + FFmpeg.wasm in a worker hosted by the offscreen document, replace `Blob` concatenation with an FFmpeg transmux call. The offscreen-document architecture stays the same.

## What v0.2 actually handles

- **Master playlists** — auto-picks the highest-bandwidth variant (no quality picker UI yet; deferred to v0.3).
- **Media playlists** — iterates `EXTINF` segments, fetches each.
- **AES-128 encryption** — `EXT-X-KEY:METHOD=AES-128` segments are decrypted via Web Crypto (`crypto.subtle.decrypt` with `AES-CBC`), IV from `IV=` attribute or sequence number per the HLS spec.
- **fMP4 init segment** — `EXT-X-MAP:URI=...` is fetched once and prepended to the output.
- **Parallel fetches** — 5 segments at a time, retried twice on failure.
- **Progress UI** — popup shows `N/M` while segments download.

## What v0.2 does NOT handle

- **SAMPLE-AES** (Apple FairPlay-style encryption) — different decryption pipeline, deferred.
- **DASH (.mpd)** — separate parser, deferred to v0.3.
- **Live streams** — we wait for `#EXT-X-ENDLIST` implicitly by treating the playlist as VOD; live streams without an endlist will download whatever the playlist currently lists, which may be a tiny sliver.
- **Resumable downloads** — close the popup or disable the extension mid-download, you lose progress. v0.2.1 candidate.
- **Quality selection UI** — auto-pick best for now.

## See also

- [[chrome-extension-policy]] — the broader two-build strategy
- [[INDEX]] — wiki entry point
- `extension/offscreen/offscreen.js` — the engine
- `extension/lib/hls.js` — parser + AES helpers
