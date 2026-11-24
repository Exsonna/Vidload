# DECISIONS — VidLoad

Append-only. Newest at top. One entry per meaningful decision (architecture, library, scope cut, approach rejected).
Captures *why*, so a future agent doesn't re-litigate it. Never edit old entries; add a new one that supersedes.

---

## 2026-11-24 — Don't upload to the Chrome store; self-use for now
**Context:** v0.4.38 fixed the entire X-audio pipeline; store users still run the old silent-X version.
**Decision:** Anson: "不传, 我先继续自己用" — no store submission until he says otherwise.
**Alternatives rejected:** Upload v0.4.38 (ready, leak-gate clean) — declined by owner.
**Consequences:** Store listing stays stale; any future upload needs his explicit go-ahead first (see HANDOFF §10).

---

## 2026-11-24 — Standardize mux output inside mp4box, not via ffmpeg.wasm
**Context:** Muxed MP4s had a healthy AAC track but VLC (Anson's default player) and Windows Media Foundation wouldn't render audio. Root causes found iteratively: hdlr=vide on audio, 0 durations in mvhd/tkhd/mdhd, audio timescale 441000 (X's raw value), and all-video-then-all-audio fragment layout.
**Decision:** Fix all four inside `muxAvToMp4` (mp4box): hdlr=soun, duration backfill from summed sample durations, audio timestamps rescaled by the exact integer factor to timescale = sample rate, samples buffered and written interleaved in 1-second windows.
**Alternatives rejected:** Bundling ffmpeg.wasm (~30 MB, against the project's no-WASM stance); post-processing downloads externally (breaks the "one click → playable file" product).
**Consequences:** Output is fragmented MP4 with one moof per sample (chunky but plays in VLC/WMF/ffmpeg); non-integer timescale/sample-rate ratios are left untouched by design.

---

## 2026-11-24 — Popup shows only the current post's videos
**Context:** x.com is an SPA; per-tab items accumulated across every post viewed, so the popup listed stale videos (often ahead of the current one) with guessed, wrong thumbnails.
**Decision:** Top-frame URL-change detection → `page-navigated` wipes the tab's items; within one page, items ≥2 min older than the newest capture fold behind "Show hidden" (newest never folds); list sorts newest-first; context-guessed posters are suppressed on twimg-grouped rows (`posterCtx` flag).
**Alternatives rejected:** Absolute-age cutoffs (breaks single-video course pages left open); matching items to the active context label (labels collide on profile feeds); deriving real X thumbnails per video id (needs the API).
**Consequences:** Downloading an older item from the same page requires one "Show hidden" click; wiped items re-capture when the user plays the video again.

---

## YYYY-MM-DD — <short title>
**Context:** what situation forced a choice
**Decision:** what was chosen
**Alternatives rejected:** A (why not), B (why not)
**Consequences:** what this commits us to / trade-offs accepted
**Supersedes:** (optional) earlier entry

---
