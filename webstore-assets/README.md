# Web Store submission assets

Drafts of everything you need to file the Web Store listing for the **webstore build** (`dist/webstore/`). The selfhost build ships outside the Web Store and doesn't need this material.

Files in this directory:

- `listing.md` — short description, detailed description, single-purpose statement, permission justifications. Copy/paste into the Chrome Web Store Developer Dashboard.
- `privacy-policy.md` — Privacy Policy document. Host this at a public URL (GitHub Pages, your marketing site, etc.) and link it from the dashboard.
- `screenshots.md` — shot list + production checklist (sizes, what to capture, what to crop).
- `vidload-icon-source.png` — source artwork used to generate `extension/icons/icon-{16,48,128}.png`.
- `screenshots/` — generated 1280 × 800 Chrome Web Store screenshots.
- `site/` — generic static public pages for Privacy Policy and Support URLs.
- `../docs/` — GitHub Pages-ready copy of the public site.

## Current submission status

- Done: runtime icon files and source artwork.
- Done: listing copy, permission justifications, screenshot plan, generated screenshots, and Privacy Policy draft.
- Still needed from project owner: push this repo to GitHub, then enable GitHub Pages from `/docs`.

After publishing `docs/` via GitHub Pages, use these dashboard URLs:

- Privacy Policy URL: `https://exsonna.github.io/Vidload/privacy.html`
- Support URL: `https://exsonna.github.io/Vidload/support.html`
- Website URL, if requested: `https://exsonna.github.io/Vidload/`

Packaged Web Store build:

- `dist/vidload-webstore-v0.4.13.zip`

**Hard rules** for the webstore build that the listing must respect:

- Never name YouTube. The webstore build ships without YouTube adapter code; the listing must match.
- Never use "downloader" framing for YouTube (e.g. "save YouTube videos") — even in past tense or as a denied capability.
- All user-facing copy must work for the **generic** value prop: "save videos from any webpage."
- Permissions justifications must match what the manifest actually requests. If you change the manifest, sync this directory.

**Before you submit**, run `node build.mjs` and verify `dist/webstore/` contains no string matching `youtube` (case-insensitive). The build script already excludes the YouTube adapter, but a grep is the cheap sanity check.
