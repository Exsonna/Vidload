# Platform-health canary — weekly structural checkup

## What it is

A **scheduled assistant routine** (not CI) that runs every **Monday 09:01 AM local** and does a server-side structural check of the platforms VidLoad downloads from, so adapter/parser drift is caught before too many users hit a broken download. Set up 2026-06-11 via the `schedule` skill at the user's request ("a chronic prompt that does the checks").

- **Task id:** `vidload-platform-health-check`
- **Cron:** `0 9 * * 1`
- **Stored:** `C:\Users\anson\.claude\scheduled-tasks\vidload-platform-health-check\SKILL.md`
- **Manage:** the "Scheduled" sidebar section, or ask Claude to `update_scheduled_task` (reschedule / pause / edit prompt) / `list_scheduled_tasks`.

## What it checks each run

1. **YouTube** — fetch `youtube.com/iframe_api` (player hash) + a stable CC watch page (`aqz-KE-bpKQ`); assert `ytInitialPlayerResponse.streamingData.adaptiveFormats` still carries `itag`+`qualityLabel`. Guards [[youtube-capture-approach]].
2. **HLS** — fetch a stable `.m3u8` (mux.dev test stream); parse via `extension/lib/hls.js`.
3. **DASH** — fetch a stable `.mpd` (akamai bbb); parse via `extension/lib/dash.js`, confirm it returns a video **and** a separate audio rep (the muxing path).
4. **Twitter/IG/TikTok** — best-effort; marks ⚠️ "bot wall" (not ❌) when datacenter-IP blocked.
5. **Referer seeds** — sanity-check `SEED_REFERERS` in the SW vs current CDN hostnames.

Output: a `Platform | Status | Note` table; on ⚠️/❌ it names the exact file/regex/Referer and **drafts the fix**.

## Hard limits (don't over-trust it)

- **Structural early-warning only.** A cron run has **no browser with the extension loaded, no login, can't validate the muxed output file or a Referer-gated CDN fetch**. It can't prove a download completes — a real in-browser download spot-check stays the source of truth.
- **Datacenter-IP bot walls** make the social-trio checks unreliable; YouTube + generic HLS/DASH are the trustworthy signals.
- **Never auto-ships.** The prompt explicitly forbids commit/build/push — it only reports + drafts. Applying a fix is a human step: `node build.mjs` → bump `manifest.json` → upload `dist/vidload-webstore-v<ver>.zip`.

## The maintenance loop it serves

canary warns → fix adapter/Referer/parser → build + bump + upload → **webstore users auto-update within ~a day** (Chrome polls the store; no new permissions → no re-prompt). **Self-host `.crx` users do NOT auto-update** (no `update_url`) — open gap if that build ships to real users.

## See also

- [[youtube-capture-approach]], [[hls-download-approach]], [[dash-download-approach]] — what the canary guards
- [[webstore-submission]] — auto-update behavior + shipping
