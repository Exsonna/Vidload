# Context pack — VidLoad

Generated: 2026-11-24

## Cold start
Read HANDOFF.md first — it is authoritative for *what to do next*. This file is background.

## What this project is
Chrome MV3 video-downloader extension. **Two builds from one tree** via `node build.mjs`: webstore (`dist/webstore/`, NO YouTube — enforced by a hard leak gate) and selfhost (`dist/selfhost/`, +YouTube via player-URL capture). Monetization LIVE: ExtensionPay `vidload`, **10 lifetime free downloads → $4.99 one-time** (since v0.4.29). **Current reality (2026-11-24): Anson self-uses the unpacked `extension/` dir in his Windows Chrome; the store listing runs an old pre-audio version and he explicitly chose NOT to update it.**

## Active topics
- [[hls-download-approach]] — HLS engine; **X split-track audio** (v0.4.32–38): download `mp4a/` rendition + mux, AND make the container player-standard (hdlr=soun, real durations, timescale=sample-rate, 1 s interleave). ffprobe-passing ≠ player-playing.
- [[dash-download-approach]] — mp4box A/V mux (Reddit split-DASH); shares `muxAvToMp4` so the v0.4.32–36 fixes apply there too.
- [[two-build-architecture]] / [[chrome-extension-policy]] — build gate hard-fails webstore dist on youtube/googlevideo strings outside 3 whitelisted disclaimer files.
- [[monetization]] — lifetime-cap model; `isPaid()` caches payers (fail-open on ExtPay outage).
- [[webstore-submission]] — v0.4.38 **not uploaded by owner decision**.
- [[youtube-capture-approach]] (selfhost only), [[offscreen-api-limits]], [[platform-health-canary]] (weekly).

## Recent decisions (last 30 days — all 2026-11-19 → 11-24, see DECISIONS.md)
- **Don't upload to store; self-use** (Anson). Any future submission needs his explicit go-ahead.
- **Standardize mux inside mp4box**, not ffmpeg.wasm: hdlr=soun + duration backfill + audio timescale→sample rate (integer rescale) + 1 s interleaving. Output is fMP4, one moof per sample (chunky but plays in VLC/WMF/ffmpeg).
- **Popup = current post only**: SPA-navigation wipe (`page-navigated`), ≥2 min stale fold (newest never folds), newest-first sort, twimg guessed posters suppressed (`posterCtx`), `/mp4a/` rows never shown, ♪ audio / no audio verdict pill.

## Key twimg facts (hard-won, reuse)
- Master `/amplify_video/<id>/pl/<hash>.m3u8`; video `/pl/avc1/<WxH>/…`; audio `/pl/mp4a/<bitrate>/…` linked by `AUDIO="audio-<bitrate>"`; init segs under `/vid/…/0/0/…mp4` and `/aud/…`; audio init ≈ 786 B (the old "mystery item").
- X audio track timescale = 441000 (10× 44100) — must rescale.
- Playlists fetch fine via curl `--proxy socks5h://127.0.0.1:7898` + `Referer: https://x.com/`.
- Per-video group key: `/(amplify_video|ext_tw_video|tweet_video)/<id>/` — grouping, pairing, poster trust, and audio-row hiding all key off it.

## Verification toolkit (reuse the pattern)
Extract shipped source into Node harnesses (26/12/4-check suites lived in session scratchpad); real segments via curl; `ssh macmini /opt/homebrew/bin/ffprobe|ffmpeg` (decode, volumedetect); local WMF probe (PowerShell `System.Windows.Media.MediaPlayer` → HasAudio/NaturalDuration); VLC CLI `--sout …mux=wav` with forward-slash dst extracts audio as proof; Chrome `Secure Preferences` reveals unpacked-extension path+version; `tfhd` track_id at offset +8 for fragment-interleave checks.

## Entity quick-ref
| Name | Role |
|---|---|
| ExtensionPay/Stripe | $4.99 one-time; id `vidload`; real SDK vendored. |
| mux.js / mp4box.js | TS→fMP4 transmux / A-V muxer, `lib/*.min.js`. |
| github `Exsonna/Vidload` | origin (NOT gitee/macmini for this repo); push via socks5h 127.0.0.1:7898. |
| Mac mini (`ssh macmini`) | ffmpeg/ffprobe verification + heavy work. |

## Outputs this session (2026-11-19 → 11-24)
Commits `882320b…ff0a807` (v0.4.32–38), all pushed. Repaired Anson's files in place (ffmpeg): `sunnyfinance1 (1).mp4`, `@punchbagstudios…(1).mp4`, `UziObi-有声版.mp4`; trimmed `punchbagstudios (8)-前23秒.mp4` (first 23 s). HANDOFF.md written from stub; DECISIONS.md ×3; `chats/2026-11-24-x-audio-marathon.md`.

## Latest session delta
H01 relayed "X 下载没声音" → four root-cause layers fixed across v0.4.32–38 (split-track mux → durations for WMF → timescale+interleave for VLC → UX: current-post-only popup, honest thumbnails, no audio-only rows) → Anson confirmed sound ("可以了") → store upload declined → session archived.
