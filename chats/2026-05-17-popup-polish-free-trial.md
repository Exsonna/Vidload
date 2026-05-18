# Popup polish + free trial scaffolding — v0.4.10 through v0.4.13

**Date:** 2026-05-17
**Topic:** Persistence, HLS variant picker, 7-day free trial, Referer rule fix, Web Store submission asset drafts. Final commit cleanup.
**Outcome:** Shipped 4 micro-versions + first cut of Web Store assets. 3 atomic commits landed. Not browser-tested yet.

## Key decisions

- **Free trial design = 7-day full unlimited → drops to 3/day → $4.99 lifetime unlock.** Industry-standard "try free, then convert" pattern. Trial auto-starts on first install — no signup/credit card required. Trial scaffolding sits behind the same `MONETIZATION.enabled = false` switch as the rest of monetization; flipping the switch activates trial + free-tier + paywall together.
- **Trial timer starts on `onInstalled.reason === 'install'` only**, NOT on `update`. Existing users keep their remaining trial time across auto-updates. Wiped on uninstall + reinstall (matches the "paid status survives reinstall, trial doesn't" semantics of ExtPay).
- **Trial + paid downloads skip the daily counter** via a new `gate.metered === false` flag. So day-8 starts at 0 regardless of how much the user downloaded during trial. The pre-existing `bumpDownloadCount()` is now gated on `gate.metered`.
- **Missing `vidload_install_ts` → trial active** (generous fallback). Edge case: `onInstalled` race or wiped storage. Easier to err on the side of letting users in than locking them out on a missing key.
- **HLS variant picker plumbing — variant URL flows directly to offscreen.js.** Probe now returns `variants[]` sorted by bandwidth desc. Row UI `<select>` defaults to `[0]` (highest). When user picks a lower variant, the selected variant's URL goes straight to offscreen — `parseM3U8` sees no `#EXT-X-STREAM-INF`, treats it as a media playlist, downloads its segments. No new code in offscreen.js needed.
- **Persistence: single map under `chrome.storage.local.vidload:userdata`, unbounded.** Keyed by URL. No TTL. CDN URLs are unique-per-stream so the map won't blow up in practice; revisit if it does. Loaded at popup startup, applied to items before render.
- **v0.4.13 Referer rule fix = switch to session rules.** Chrome rejects `tabIds` / `excludedTabIds` on dynamic rules — they're a session-only condition. The v0.4.7 fix had been silently failing since it shipped (the try/catch just logged). Switched to `updateSessionRules` / `getSessionRules`. Session rules clear on browser restart, but we already re-register on `onStartup` so the trade-off is invisible.
- **Web Store assets at `webstore-assets/`** — 4 markdown files (README orienting the dir + listing.md + privacy-policy.md + screenshots.md). NOT used at runtime. README enforces hard rules (never name YouTube anywhere in copy; grep `dist/webstore/` before submission). Privacy policy has placeholder fields for support email + project URL.
- **3 commits, not 5.** Bundled v0.4.9–v0.4.13 into one commit because popup.js was touched in 0.4.9/10/11/12 and the files were too entangled to split per-version without `git apply` surgery. CLAUDE.md roadmap rows still describe each version individually if specific behavior needs pinning. Sacrificed per-version atomicity for execution safety.

## Files touched

- `extension/manifest.json` — version 0.4.9 → 0.4.13
- `extension/popup/popup.js` — userdata persistence (load/save/apply/rememberDismissed/rememberLabel), parseHlsMetadata returning variants[], variantLabel + populateVariantPicker helpers, renderRow picker wiring, startDownload uses selectedVariantUrl, renderTier handles trialActive
- `extension/popup/popup.html` — `<select class="variant-picker">` added between format-badge and title
- `extension/popup/popup.css` — `.variant-picker` styles, `#tier-badge.trial` blue gradient
- `extension/background/service-worker.js` — MONETIZATION.trialDays=7, onInstalled writes install_ts on install-only, getTrialStatus(), gateDownload returns metered flag, get-status payload adds trial fields, both download handlers gate bumpDownloadCount on gate.metered, setupRefererRules switched to session rules
- `wiki/topics/monetization.md` — trial sections (Decision, Free-tier counter, new Trial timer section, MONETIZATION config block)
- `CLAUDE.md` — roadmap rows for v0.4.10 / v0.4.11 / v0.4.12 / v0.4.13
- `webstore-assets/README.md` — new
- `webstore-assets/listing.md` — new (extension name, descriptions, single-purpose statement, permissions justifications)
- `webstore-assets/privacy-policy.md` — new (full policy ready to host)
- `webstore-assets/screenshots.md` — new (5-shot list, specs, clean-profile checklist)

## Open threads

- **None of v0.4.10–v0.4.13 has been browser-tested.** Reload at `chrome://extensions/`, sanity-check on x.com: SW console should show `Referer rewrite session rules registered: 3` with no error; HLS row should show a quality dropdown 1–2s after popup open; dismiss/rename should persist across close/reopen. The trial badge won't show because `MONETIZATION.enabled = false` is still the default.
- **Twitter title disambiguation.** User's last x.com screenshot showed 5+ rows all labeled "Video on twimg.com" — they can't tell which video is which. I told the user I'd start on this next while they test. Plan: more aggressive scraping in the Twitter adapter — pull tweet text from the DOM near each `<video>`, hook into the X GraphQL responses, or fall back to nearby `<article>` text. Brittle, durable while it lasts.
- **ExtensionPay activation** — gated on user signing up at extensionpay.com + Stripe-connecting + flipping `MONETIZATION.enabled = true`. Checklist in [[monetization]].
- **Real icons** — placeholder steel-blue PNGs still. Need actual design.
- **Real Web Store screenshots** — follow `webstore-assets/screenshots.md`. Need actual capture in a clean Chrome profile.
- **Privacy Policy hosting** — markdown ready, needs a public URL (GitHub Pages, marketing site). Fill in `[your support email]` + `[your marketing site or GitHub repo URL]` placeholders before publishing.
- **YouTube signature-cipher** — multi-session project, self-host only. Deferred.
- **DASH audio muxing** — needs FFmpeg.wasm, ~30MB bundle. Deferred until a user complains about silent DASH output.

## Transcript highlights

User pasted their post-v0.4.9 x.com screenshot — 15 visible items, 35 hidden, downloads working but "still hard to figure out which video is which" with multiple "Video on twimg.com" rows. Asked "what next?"

I laid out three options ranked by leverage — HLS variant picker, persistence, Web Store prep. User said **"lets do all, also we want to create some free trial mode that can bring user in to try before they pay"**, which expanded scope to four items.

I made the trial design call without asking (per the session's "no clarifying questions" reminder): 7-day full unlimited → 3/day free tier → $4.99 lifetime. Industry standard. Trial timer scaffolding lives behind the same `MONETIZATION.enabled` switch so it does nothing until ExtPay is activated.

Executed in order: persistence first (smallest), then variant picker, then free trial (touched the most files), then Web Store drafts (pure markdown). Bumped manifest version per task. Each version got a CLAUDE.md roadmap row.

Mid-task the user pasted the SW console error: `[VidLoad SW] Failed to set up Referer rules Error: Rule with id 1001 specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.` This was a v0.4.7 bug that had been silent since it shipped (the try/catch only logged). Fix: switch from `updateDynamicRules` to `updateSessionRules` — Chrome only honors `tabIds` on session rules. Bumped to v0.4.13.

User said "commit" → I executed 3 atomic commits: `7ff1136` (prior session save-context), `58b2b6a` (bundled v0.4.9–v0.4.13 code), `4f446ab` (webstore-assets/). Bundling 5 versions into one commit was the honest concession — files were too entangled to split per-version safely.

A side observation surfaced in passing: the user's "download is good now" on x.com worked even though v0.4.13's Referer fix hadn't shipped yet. Likely twimg.com accepts our offscreen `fetch({credentials:'include'})` requests without needing the Referer rewrite. The rewrite is belt-and-suspenders for CDNs that DO reject (some IG and TikTok cases). With v0.4.13 those should now actually take effect.
