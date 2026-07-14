# Full Fable audit → 23 fixes (v0.4.28) → monetization funnel overhaul (v0.4.29) → store submission

**Date:** 2026-07-14
**Topic:** Multi-agent code audit + adversarial verification; "why no paid users" monetization audit + redesign; Chrome Web Store update.
**Outcome:** Done. v0.4.28 + v0.4.29 committed + pushed (`f216af8`); package uploaded + submitted for review. One trivial commit (`acc2abb`, screenshot swap) pending push (proxy tunnel flaky).

## Key decisions

- **Audit method** — multi-agent Workflow with adversarial verification (each finding refuted by an independent skeptic before it counts). Full-app audit surfaced 35 raw → **23 real, 12 rejected**.
- **v0.4.28 — 23 fixes** across money/policy (atomic quota reservation, local-midnight reset, meter-on-success, enforced YouTube-leak build gate in `build.mjs`), engine (`#EXT-X-BYTERANGE` real Range requests, job-wide abort, 2 GB memory ceiling, AES IV validation), lifecycle/referer (getJobsMerged always-merge, race-safe learnReferer first-writer-wins + bounded map, offscreen TOCTOU, commit-download restricted to offscreen blob:), UX (subframe filename clobber, keyboard menu, rename-on-blur, "no audio" warning, shared `lib/media-url.js`). Verification pass: 0 regressions.
- **"Why no paid users" audit** — the paywall almost never fired: 7-day unlimited trial + 3/day daily-reset (~90 free/month) + `trialResetId` re-grants. Zero paid was the *predictable output of the funnel*, not a broken checkout. Payment plumbing verified intact.
- **v0.4.29 — funnel redesign (chosen: lifetime cap):** replaced trial + daily tier with **10 lifetime free downloads → $4.99 unlimited forever** (single accumulating counter, no reset, no trial). Removed trial logic entirely. Payment-flow fixes: `isPaid()` caches a payer + **fails open** on ExtPay outage; `onPaid` broadcasts live unlock; `open-payment-page` awaits the tab + surfaces errors. Popup: trial countdown → free-quota banner, `Free · used/10` badge. Storage migration seamless. Verified: 0 issues.
- **Store update** — v0.4.29 package uploaded (user); listing pricing bullets + `storage` justification rewritten; privacy page (`docs/privacy.html`, effective 2026-07-14) updated for the new data model + republished via Pages; screenshot 5 regenerated (`05-free-upgrade.png`, headless-Chrome render of a 1280×800 composite) and stale `05-trial-upgrade.png` deleted. User submitted for review.
- **git proxy fixed** — `http.proxy socks5h://127.0.0.1:7898` (7898 is SOCKS5, not HTTP; old `:26433` was dead). Tunnel intermittently flaky.

## Files touched

- Engine/UI: `extension/background/service-worker.js`, `offscreen/offscreen.js`, `lib/hls.js`, `lib/media-url.js` (new), `popup/popup.js`/`.html`/`.css`, `manifest.json`, `build.mjs`
- Store/site: `webstore-assets/listing.md`, `privacy-policy.md`, `screenshots.md`, `site/privacy.html`, `docs/privacy.html`, `webstore-assets/screenshots/05-free-upgrade.png` (new, `05-trial-upgrade.png` deleted)
- Docs: `CLAUDE.md` (roadmap v0.4.28/26-27/29), `wiki/topics/monetization.md`, `wiki/topics/webstore-submission.md`, `wiki/INDEX.md`

## Open threads

- **Push `acc2abb`** (screenshot commit) once the proxy tunnel is stable — non-blocking. `git push`.
- **Confirm a real end-to-end purchase** works (`extpayId: 'vidload'` must match the extensionpay.com dashboard) — the single highest-value check.
- **Watch conversions** after the lifetime-cap change; tune `freeLifetimeLimit` (10) if needed. Judge as paid ÷ paywall-impressions, not ÷ installs.
- **Confirm v0.4.29 passes review** and is the *published* store version (a pre-monetization live build would explain prior zero conversions).
- Reinstall-loop free-download reset accepted (client-side limit); server-side meter is a future backend.

## Transcript highlights

User asked Fable to audit the whole app → ran an 8-dimension workflow with adversarial verify (a first run mis-aggregated results; fixed the collector and resumed from cache). 23 findings implemented across 6 files + verified with a second workflow (0 regressions), committed v0.4.28, packaged + validated (45/45). User then reported users-but-no-payers; a 3-angle monetization audit (gating-bypass, payment-integrity, funnel-design) converged: the funnel gives away the high-intent moment and the paywall rarely fires. Implemented the lifetime-cap model + pay-flow fixes (v0.4.29), re-verified, rewrote store/privacy copy, regenerated screenshot 5, committed + pushed. Proxy required repointing git to SOCKS5.
