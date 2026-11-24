# HLS download approach — why no FFmpeg

## Decision

VidLoad v0.2 downloads HLS streams by **concatenating raw segment bytes** in the offscreen document. fMP4 (`.m4s`/`.mp4`) segments are concatenated with their init segment → a valid `.mp4`.

**Update (v0.4.16): real MP4 for MPEG-TS too.** Concatenated MPEG-TS used to save as `.ts`, which confuses users (wrong icon, some players won't open it, and you can't just rename it — TS ≠ MP4 container). We now **transmux TS → fragmented MP4** with vendored **mux.js** (~115 KB, pure JS, no FFmpeg/WASM) so the output is a proper `.mp4`. Falls back to `.ts` only if mux.js can't handle the codec. Still no FFmpeg. (Separate audio/video muxing — DASH/YouTube — uses mp4box.js; see [[dash-download-approach]].)

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

## Split-track audio (v0.4.32–v0.4.38)

X/Twitter's fmp4 HLS is **split-track**: `#EXT-X-STREAM-INF` variants (`/pl/avc1/<WxH>/…`) are video-only, and sound lives in separate `#EXT-X-MEDIA:TYPE=AUDIO` renditions (`/pl/mp4a/<bitrate>/…`), linked by the variant's `AUDIO="audio-<bitrate>"` group id. Downloading just the variant therefore produced a **silent MP4**. Since v0.4.32: `parseM3U8` returns `audioRenditions` + per-variant `audioGroup`, `pickAudioRendition(master, variant)` resolves the matching rendition, `runHlsJob` downloads both tracks and muxes via the same `muxAvToMp4` used for split DASH (fail-soft to video-only with the "Saved ⚠ without audio" warning). Because the popup's picker default-selects a bare variant URL (offscreen never sees the master on that path), the popup resolves and threads `audioUrl` through `download-stream`; a master-less bare variant is paired with the `/mp4a/` sibling captured in the same per-video group, and `/mp4a/` rows are never shown as downloadable (v0.4.33/35).

**A healthy audio track is not enough — the container must be player-standard** (v0.4.34/36, found via Anson's field tests: ffprobe said the files were fine while VLC and Windows Media Foundation stayed silent). `muxAvToMp4` must write: `hdlr=soun` on the audio track (mp4box defaults EVERY track to `vide`); real `mvhd/tkhd/mdhd` durations (fragmented inputs report `t.duration = 0`, and WMF won't start its audio pipeline when it can't read the file length); audio track timescale normalized to the sample rate (X ships timescale 441000 = 10×44100 — rescale timestamps by the exact integer factor); and samples **interleaved in 1-second windows** (all-video-then-all-audio layout left VLC silent). Verified end-to-end on real X videos: ffprobe + full decode + volumedetect on the Mac mini, WMF probe (`HasAudio`, `NaturalDuration`), and Anson's own VLC CLI extracting PCM audio.

## What v0.2 does NOT handle

- **SAMPLE-AES** (Apple FairPlay-style encryption) — different decryption pipeline, deferred.
- **DASH (.mpd)** — separate parser, deferred to v0.3.
- **Live streams** — we wait for `#EXT-X-ENDLIST` implicitly by treating the playlist as VOD; live streams without an endlist will download whatever the playlist currently lists, which may be a tiny sliver.
- **Resumable downloads** — close the popup or disable the extension mid-download, you lose progress. v0.2.1 candidate.
- **Quality selection UI** — auto-pick best for now.

## See also

- [[chrome-extension-policy]] — the broader two-build strategy
- [[offscreen-api-limits]] — why `chrome.downloads` calls must be routed through the SW (v0.4.8 fix)
- [[ClaudeRoot/_brain/INDEX]] — wiki entry point
- `extension/offscreen/offscreen.js` — the engine
- `extension/lib/hls.js` — parser + AES helpers
