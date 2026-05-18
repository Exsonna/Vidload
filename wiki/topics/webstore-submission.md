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
- **Never use "downloader" framing for YouTube** — not even in the negative ("can't download from YouTube") or past tense. Don't mention the platform at all.
- **All user-facing copy must work for the generic value prop**: "save videos from any webpage." Specific social platforms can be named in *later* screenshots (e.g. format-badge demos) but never in the hero shot or short description.
- **Permissions justifications must match `manifest.json` exactly.** If you add/remove a permission, sync `listing.md` before submitting.

## Pre-submission sanity check

```cmd
node build.mjs
findstr /S /I /M "youtube" dist\webstore\*
```

Second command should return zero results. The build script already excludes the YouTube adapter, but the grep catches accidental leaks (a string in a comment, a wiki link in a JSDoc, etc.).

## What's still missing (blockers for actual submission)

- **Public hosting.** For GitHub Pages, publish repo branch `master` from `/docs`. Use `https://exsonna.github.io/Vidload/privacy.html` as the Privacy Policy URL and `https://exsonna.github.io/Vidload/support.html` as the Support URL. Support email is `150140419@qq.com`. Effective date is set to May 18, 2026.
- **ExtensionPay activation** (only if shipping with monetization on). See [[monetization]] checklist.

## Icon status

Polished blue play/download icon artwork is in place:

- Source artwork: `webstore-assets/vidload-icon-source.png`
- Runtime icons: `extension/icons/icon-16.png`, `extension/icons/icon-48.png`, `extension/icons/icon-128.png`

Run `node build.mjs` after icon changes so `dist/webstore/` and `dist/selfhost/` receive the updated PNGs.

## Package status

Web Store package is built at `dist/vidload-webstore-v0.4.13.zip`.

## See also

- [[chrome-extension-policy]] — why we maintain a generic-only listing
- [[two-build-architecture]] — how `build.mjs` produces a YouTube-free webstore build
- [[monetization]] — paywall activation if shipping with monetization enabled
- `webstore-assets/` — the actual asset directory
