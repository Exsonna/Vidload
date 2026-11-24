# HANDOFF - VidLoad

**Last updated:** 2026-11-24 (save-context, session "X 无声修复马拉松")
**Agent:** Claude Code (Fable 5)
**Branch / commit:** master @ `ff0a807` (= origin/master, pushed)
**Status:** X/Twitter download pipeline fully working (audio muxed, plays in VLC/Windows); v0.4.38 built; **Anson decided 2026-11-24 NOT to upload to the Chrome store — self-use only for now.**

## 1. Goal
Chrome MV3 video-downloader extension, two builds (webstore = no YouTube; selfhost = +YouTube). Monetized $4.99 via ExtensionPay (10 lifetime free downloads). Anson currently uses it himself from the unpacked source dir.

## 2. Current milestone
v0.4.32–v0.4.38 (all shipped & pushed, 2026-11-19 → 11-24): X split-track audio muxing, Windows/VLC playback compatibility, popup shows only the current post with honest thumbnails. Store listing still runs the OLD pre-audio version **by Anson's choice**.

## 3. Next actions
- [ ] Nothing queued. Next likely triggers: (a) Anson reports a new broken site → reproduce with real captured playlists (curl via `--proxy socks5h://127.0.0.1:7898`, Referer `https://x.com/`), fix, verify with the Node harnesses in the session scratchpad pattern (extract shipped source, run against real segments, ffprobe on `ssh macmini`); (b) Anson says "传商店" → `node build.mjs`, zip `dist/webstore/*` as `dist/vidload-webstore-v<ver>.zip` (manifest.json at zip root), he uploads manually (dashboard is unscriptable).
- [ ] If a weekly [[platform-health-canary]] report flags X again, re-check twimg playlist shapes first (master `/pl/<hash>.m3u8`, video `/pl/avc1/<WxH>/`, audio `/pl/mp4a/<bitrate>/`).

## 4. In-progress / half-done
None — tree is clean at `ff0a807`, local == origin.

## 5. Blockers & questions for Anson
- Store upload: **declined 2026-11-24** ("不传, 我先继续自己用"). Revisit only when he raises it. Store users remain on the old silent-X version meanwhile.

## 6. How to run / test (copy-paste)
- Build both dists + YouTube-leak gate: `node build.mjs` (webstore build HARD-FAILS on any youtube/googlevideo string outside the 3 whitelisted disclaimer files).
- Anson's Chrome loads `C:\Users\anson\home-nas\dev\VidLoad\extension` unpacked (found via Chrome `Secure Preferences`); after edits he must click ⟳ in chrome://extensions.
- Syntax: `node --check <classic .js>`; ES modules (`offscreen/offscreen.js`, `lib/hls.js`, `lib/dash.js`): `node --check --input-type=module < file`.
- Media verification: ffmpeg/ffprobe live on the Mac mini (`ssh macmini`, `/opt/homebrew/bin/ffprobe`); local WMF check via PowerShell `System.Windows.Media.MediaPlayer` (HasAudio + NaturalDuration); his VLC CLI can extract audio as proof (`--sout "#transcode{acodec=s16l}:std{...mux=wav,dst='C:/...'}"` — forward slashes in dst!).
- git push goes to github `origin` (Exsonna/Vidload) through the proxy: config already `http.proxy socks5h://127.0.0.1:7898` (7898 is SOCKS5; occasionally the tunnel is up but can't reach github — retry later, don't loop).

## 7. Architecture in 10 lines
1. `background/service-worker.js`: webRequest observes media → per-tab items (storage.session); learned-Referer DNR session rules (first-writer-wins, seeded for twimg/fbcdn/tiktokcdn); monetization gate (10 lifetime free, atomic reservation); job table.
2. `content/content-script.js` (all_frames): <video> + og/JSON-LD scraping, active-context (label/poster) broadcast, **SPA-navigation detection → `page-navigated` wipes tab items**.
3. `offscreen/offscreen.js`: HLS/DASH segment engine; `runHlsJob` downloads video variant + matching `#EXT-X-MEDIA` audio rendition and muxes via `muxAvToMp4` (mp4box): **hdlr=soun, real mvhd/tkhd/mdhd durations, audio timescale normalized to sample rate, samples interleaved in 1 s windows** — all four were required before VLC+WMF played the audio.
4. `lib/hls.js`: parser + `pickAudioRendition()` (AUDIO group matching); `lib/dash.js`; `lib/media-url.js` shared SW+popup helpers.
5. `popup/popup.js`: per-video grouping on twimg ids (one row per video, `/mp4a/` rows never shown), audio verdict pill (♪ audio / no audio), stale fold (≥2 min older than newest → hidden), newest-first sort, context-guessed posters suppressed on twimg (`posterCtx`).
6. `build.mjs`: webstore/selfhost dists + enforced YouTube-leak gate.
7. Monetization lives (ExtPay id `vidload`); webstore build blocks YouTube downloads entirely (`youtube-notice.js` → `window.vidloadDisableDownloads`).

## 8. Recent decisions (last 3)
- 2026-11-24 **Don't upload to store; self-use** (Anson). → DECISIONS.md
- 2026-11-24 **Standardize mux inside mp4box** (timescale/interleave/durations) instead of bundling ffmpeg.wasm. → DECISIONS.md
- 2026-11-24 **Popup = current post only** (SPA wipe + 2-min stale fold + newest first). → DECISIONS.md

## 9. Known bugs / debt
- Reinstall/clear-storage resets the 10-free counter (client-side metering accepted).
- Self-host `.crx` has no `update_url` (those users don't auto-update).
- mp4box writes one moof per sample (438 fragments for 25 s) — plays fine everywhere tested, but chunky; revisit only if a player complains.
- YouTube capture (selfhost) limits: only played qualities; 1440p/4K VP9/Opus may not mux.

## 10. Do NOT
- Do NOT put any youtube/googlevideo string in shared files — the build gate hard-fails the webstore dist (whitelist: `popup/youtube-notice.js`, `popup/popup.html`, `popup/popup.css` only).
- Do NOT upload anything to the Chrome store or submit for review — Anson explicitly declined (2026-11-24); ask him first.
- Do NOT "fix" the learned-Referer engine to last-writer-wins or per-fetch rules — first-writer-wins + session rules is deliberate (Teachable/Hotmart depend on it).
- Do NOT assume `t.duration`/timescales from fragmented inputs are usable — they're 0/raw; the mux normalizes them on purpose.
- Do NOT push to gitee or the macmini bare repo for THIS project — its origin is github `Exsonna/Vidload` (established before the macmini scheme).
