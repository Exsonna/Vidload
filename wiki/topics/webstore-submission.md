# Web Store submission — assets + hard rules

## Where the assets live

`webstore-assets/` (project root) holds everything needed to file the Chrome Web Store listing for the **webstore build** (`dist/webstore/`). Not used at runtime — pure marketing/compliance material.

Files:

- `README.md` — orients the directory + the hard rules
- `listing.md` — extension name, short + detailed description, single-purpose statement, permissions justifications table, "no remote code" answer, pricing setting
- `privacy-policy.md` — full Privacy Policy ready to host at a public URL. Placeholder fields for support email + project URL — fill before publishing.
- `screenshots.md` — 5-shot list with composition guidance, 1280×800 specs, clean-profile checklist
- `vidload-icon-source.png` — polished blue play/download source artwork used for `extension/icons/icon-{16,48,128}.png`
- `screenshots/` — generated 1280 × 800 PNGs ready to review/upload
- `site/` — generic static Privacy Policy / Support / homepage files ready to publish
- `docs/` — GitHub Pages-ready public site copy

## Hard rules (don't break these)

These exist because they're what gets the listing rejected — see [[chrome-extension-policy]] for the deeper rationale:

- **Never name YouTube** anywhere in the listing copy. The webstore build ships without YouTube adapter code (see [[two-build-architecture]]); the listing must match.
- **Never ship YouTube *capability* code in the webstore build.** No adapter, no hook, no extraction. The webstore build IS allowed exactly one YouTube mention: the **non-support disclaimer** (v0.4.27) in `popup/youtube-notice.js` (+ its banner markup in `popup.html`/`popup.css`), which tells users on YouTube that this build can't download it. A "we don't do YouTube" disclaimer is compliance-positive (the published reference extensions do the same); capability is what gets you rejected.
- **All user-facing copy must work for the generic value prop**: "save videos from any webpage." Specific social platforms can be named in *later* screenshots (e.g. format-badge demos) but never in the hero shot or short description.
- **Permissions justifications must match `manifest.json` exactly.** If you add/remove a permission, sync `listing.md` before submitting.

## Pre-submission sanity check

```bash
node build.mjs
# "youtube" must appear ONLY in the disclaimer files — nowhere else:
grep -rIil youtube dist/webstore/ | grep -vE 'popup/(youtube-notice\.js|popup\.html|popup\.css)$'
```

The grep must return **zero** results. The three allowed files are the v0.4.27 non-support disclaimer (banner logic + markup + style). Any other hit — especially in `adapters/`, `background/`, `offscreen/`, `lib/`, `manifest.json`, or `popup/popup.js` — is a real capability leak and must be fixed before submitting.

## What's still missing (blockers for actual submission)

- **Public hosting.** For GitHub Pages, publish repo branch `master` from `/docs`. Use `https://exsonna.github.io/Vidload/privacy.html` as the Privacy Policy URL and `https://exsonna.github.io/Vidload/support.html` as the Support URL. Support email is `150140419@qq.com`. Effective date is set to May 18, 2026.
- **ExtensionPay activation** (only if shipping with monetization on). See [[monetization]] checklist.

## Icon status

Polished blue play/download icon artwork is in place:

- Source artwork: `webstore-assets/vidload-icon-source.png`
- Runtime icons: `extension/icons/icon-16.png`, `extension/icons/icon-48.png`, `extension/icons/icon-128.png`

Run `node build.mjs` after icon changes so `dist/webstore/` and `dist/selfhost/` receive the updated PNGs.

## Package status

- **v0.4.22** (`dist/vidload-webstore-v0.4.22.zip`) — reliability overhaul, no monetization. Submitted to the store for review on the first ship.
- **v0.4.25** (`dist/vidload-webstore-v0.4.25.zip`) — **monetization LIVE** (real ExtPay, $4.99). Built + verified (manifest valid, no YouTube, real ExtPay SDK, `extensionpay.com` content script). Supersedes the pending v0.4.22 — owner uploads it via the dashboard. Adds no new permissions.
- **v0.4.30** (`dist/vidload-webstore-v0.4.30.zip`) — **YouTube truly disabled on YouTube tabs** (banner + empty list via the generic `vidloadDisableDownloads` hook; closes the "reviewer opens popup on YouTube and sees downloadable googlevideo streams" risk that existed in v0.4.29-and-earlier). Validation 45/45, leak gate clean. **Current shippable package — supersedes v0.4.29.** If v0.4.29 is still pending review, prefer cancelling that review and submitting this instead (one review cycle, includes the compliance fix).
- **v0.4.28** (`dist/vidload-webstore-v0.4.28.zip`) — **audit-fix pass** (23 verified findings fixed, adversarially re-verified, no regressions). Pre-submission validation passed 45/45 (manifest valid MV3, all refs present, all JS syntax-checked, import/script resolution, no YouTube leak — now enforced by a `build.mjs` gate, icons 16/48/128 valid). 136.9 KB, 24 entries, `manifest.json` at zip root. Adds no new permissions → existing users auto-update with no re-prompt.
- **v0.4.29** (`dist/vidload-webstore-v0.4.29.zip`) — **monetization funnel overhaul** (10 lifetime free downloads → $4.99 unlimited; trial removed; payment-flow fixes). Verified (adversarial pass, 0 issues) + validated 45/45. 136.8 KB. Adds no new permissions. Listing "Detailed description" (two pricing bullets) + `storage` permission justification updated; privacy page (`docs/privacy.html`, effective July 14 2026) updated + republished via Pages. Screenshot 5 (old "Trial · 5d") dropped from the carousel. **Current shippable package — uploaded to the store.**

Note: the Chrome Web Store dashboard lives in `chrome.google.com/webstore`, the extensions gallery, which Chrome **blocks any extension from scripting** — so the browser tool can't drive the upload; it's a manual click-through by the owner.

## Auto-update behavior

- **Webstore build: auto-updates.** Chrome polls the store every few hours and silently installs **published** versions in the background — existing users land on the new version within hours to ~a day (Chrome may stagger rollout). Because our updates add **no new permissions**, there's no re-prompt or disable. This is what makes the "fix → publish → users get it" maintenance loop work.
- **Self-host `.crx` build: does NOT auto-update.** No `update_url` is set, so those users must reinstall to get fixes. Since YouTube (the most breakage-prone platform) ships **only** in the self-host build, add an `update_url` + update-manifest XML if that build is distributed to real users. **Open gap.**

Health is monitored by the weekly [[platform-health-canary]].

## See also

- [[chrome-extension-policy]] — why we maintain a generic-only listing
- [[two-build-architecture]] — how `build.mjs` produces a YouTube-free webstore build
- [[monetization]] — paywall activation if shipping with monetization enabled
- `webstore-assets/` — the actual asset directory
