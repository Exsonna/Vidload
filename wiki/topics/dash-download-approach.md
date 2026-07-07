# DASH download approach

## Decision

v0.3.1 adds DASH (`.mpd`) download alongside HLS, sharing the offscreen-document download pipeline. Same "no FFmpeg, no Vite" stance as HLS — we concatenate raw bytes and let the resulting file play.

## What v0.3.1 supports

- **Static MPDs** with single `<Period>` (live/dynamic MPDs throw).
- **SegmentTemplate** with `$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$` substitutions (including zero-padding like `$Number%05d$`).
- **SegmentTimeline** for explicit segment timing.
- **SegmentList** with `<Initialization>` and `<SegmentURL>` children.
- **BaseURL chain** — MPD → Period → AdaptationSet → Representation resolution.
- **Audio + video muxing (v0.4.21):** the parser now extracts the **best audio AdaptationSet** alongside the best video Representation, plus single-file `SegmentBase`-style reps (Reddit `v.redd.it`). When audio is separate, the offscreen engine downloads both tracks whole and muxes them into one MP4 via **mp4box.js** (`muxAvToMp4`) — no FFmpeg. Fixes the silent-video problem on Reddit / Facebook / split-DASH. Muxed streams (audio inside the video rep) take the old single-track concat path unchanged.
  - mp4box muxing carries each input track's codec config (avcC for H.264, esds for AAC) into the output by passing the parsed `description` box to `addTrack` — the recipe was grounded by reading mp4box's actual `addTrack` source (the generic `e.description && s.addBox(e.description)` path).
  - This same `muxAvToMp4` is reused by [[youtube-capture-approach]] for adaptive YouTube formats.

## What is still NOT supported

- **Live/dynamic MPDs** — would require live-segment tracking + cutoff handling.
- **Codec edge cases in the muxer** — ≤1080p H.264 + AAC muxes cleanly; webm/VP9/AV1 + Opus pairings may not produce a valid MP4 (iteration-1 muxer).
- **DRM/CENC encryption** — Widevine et al. are protected by DMCA §1201 anyway.
- **Multi-period MPDs** — chained content (ad breaks, etc.); rare on social media.
- **SegmentBase + byte-range indexing** — older DASH style.

## Shared pipeline

The offscreen document now exposes one generic message: `fetch-stream` with a `format` field of `'hls'` or `'dash'`. The format-specific resolver (M3U8 parser or MPD parser) returns a normalized `{ initSegment, segments[] }` shape; `downloadSegments()` then fetches them in parallel (5 at a time), the HLS path applies AES-128 decryption inline, and `finalize()` builds the Blob and triggers the Chrome download.

Result: HLS and DASH share progress tracking, retry logic, blob creation, and download triggering. Format-specific code is only the parser plus a 10-line `runDashJob`/`runHlsJob` outer function.

## Message protocol changes from v0.3

Renamed to be format-agnostic:

| Old (v0.3) | New (v0.3.1) |
|---|---|
| `download-hls` | `download-stream` with `format` field |
| `fetch-hls` | `fetch-stream` with `format` field |
| `hls-progress` | `stream-progress` |
| `hls-done` | `stream-done` |
| `hls-error` | `stream-error` |

The `download` (direct file) and `media-found` (detector reports) messages are unchanged.

## See also

- [[hls-download-approach]] — the original HLS-only design and why we don't FFmpeg
- [[two-build-architecture]] — webstore/selfhost split
- `extension/lib/dash.js` — the parser
- `extension/offscreen/offscreen.js` — the shared engine
