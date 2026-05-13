# DASH download approach

## Decision

v0.3.1 adds DASH (`.mpd`) download alongside HLS, sharing the offscreen-document download pipeline. Same "no FFmpeg, no Vite" stance as HLS — we concatenate raw bytes and let the resulting file play.

## What v0.3.1 supports

- **Static MPDs** with single `<Period>` (live/dynamic MPDs throw).
- **SegmentTemplate** with `$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$` substitutions (including zero-padding like `$Number%05d$`).
- **SegmentTimeline** for explicit segment timing.
- **SegmentList** with `<Initialization>` and `<SegmentURL>` children.
- **BaseURL chain** — MPD → Period → AdaptationSet → Representation resolution.
- **Video-only**: we pick the highest-bandwidth video Representation and ignore audio AdaptationSets. Most muxed DASH streams (smaller news sites, many CDNs) include audio in the video Representation. Streams that ship video and audio separately will produce a silent file — that's a v0.3.2 candidate.

## What v0.3.1 does NOT support

- **Live/dynamic MPDs** — would require live-segment tracking + cutoff handling.
- **Separate audio muxing** — needs FFmpeg.wasm (or an MP4 muxer library).
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
