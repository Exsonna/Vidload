# Screenshot production checklist

The Chrome Web Store requires **at least one screenshot**, up to five. They appear in the listing carousel and matter a lot for conversion. This doc lists what to shoot, the technical specs, and how to take them cleanly.

## Specs (hard requirements)

- **Dimensions:** 1280 × 800 OR 640 × 400. Use 1280 × 800 — it's sharper on modern displays.
- **Format:** PNG or JPEG. PNG preferred for UI shots (no compression artifacts on text).
- **Aspect ratio:** 16:10. The popup itself is 480px wide, so each screenshot needs to be composed (popup + page context) — not just a popup crop.
- **Count:** 1–5. We'll aim for 5.

## Shot list

Each shot should tell one clear story. Keep them in this order — the first one is what most people see before clicking through.

### 1. The hero shot — "VidLoad finds the video you want"

**Scene:** A real video page (e.g. a how-to video on a generic content site) with the VidLoad popup open showing the video detected, with a clear thumbnail, format pill, and the Download button visible.

**Composition:** Browser window with the page on the left, VidLoad popup overlaying the right side. Make sure the title in the popup is a real-looking video title, not "Video on cdn.host.com".

**Annotation:** Optional — a soft callout arrow pointing at the Download button labeled "One click to save."

**What to avoid:** Don't show YouTube. Don't show a logged-in social media account. Don't show personal identifiable info (other tabs, bookmark bar with personal names).

### 2. Quality picker — "Choose any resolution"

**Scene:** Popup with the variant dropdown open showing 4K / 1080p / 720p / 480p options for an HLS stream.

**Annotation:** "Pick the quality you want — VidLoad downloads the exact variant."

### 3. Stream support — "Works on streaming sites too"

**Scene:** Popup showing a mix of formats — a DIRECT MP4, an HLS stream with duration overlay, a DASH stream. The format pills (DIRECT / HLS / MPD) should all be visible.

**Annotation:** "Direct files, HLS, DASH — all from the same popup."

### 4. Smart filenames — "Saved files are named for you"

**Scene:** Either a split-shot (left: popup, right: Downloads folder showing meaningful filenames like `cooking-tutorial.mp4` instead of `abc123xyz.mp4`), OR the popup with the rename pencil button highlighted and an example renamed title.

**Annotation:** "VidLoad reads page context to name your downloads — no more abc123.mp4."

### 5. Free downloads + Pro upgrade — "Start free, unlock forever"

**Scene:** Popup with the "Free · 3/10" badge visible in the header and the free-quota banner ("✨ 7 free downloads left · $4.99 unlocks unlimited forever"), plus the paywall sheet open showing "$4.99 · One-time payment · lifetime unlimited downloads."

**Annotation:** "10 free downloads. Unlock forever for $4.99 — no subscription."

> Only include this shot if `MONETIZATION.enabled = true` in the build you submit. Skip if shipping with monetization disabled.
>
> ⚠ v0.4.29 model change: the existing generated `05-trial-upgrade.png` still shows the old "Trial · 5d" badge — re-shoot it against the new UI before uploading, or drop it from the carousel.

## How to take the shots

1. **Use a clean profile.** Either a fresh Chrome profile or Incognito with the extension force-enabled. No personal bookmarks, no other extensions visible in the toolbar, no logged-in accounts unless intentional.
2. **Resize the window** to 1280 wide (use a tool like Window Resizer or DevTools' device-mode at 1280 × 800).
3. **Pick a generic-looking video page** (your own marketing site demo page works well, or a creative-commons content host). Avoid logos of major platforms.
4. **Open the popup**, position the page content so the popup overlays a meaningful area.
5. **Use OS screenshot tools** (Snipping Tool on Windows, Cmd-Shift-4 on macOS) to capture the browser window. Don't include the OS taskbar/dock.
6. **Crop/compose** to 1280 × 800. The popup is 480 wide, so leave ~800px of page context to the left.
7. **Annotate sparingly.** Simple white text on a soft colored bar at the top or bottom — never overlap the popup.

## Promotional tile (separate from screenshots)

If you produce a 440 × 280 promo tile, use the same hero-shot composition as Screenshot 1 but tighter — the popup centered, page context blurred, "VidLoad" wordmark in the top-left corner.

## Final checklist before upload

- [x] No YouTube URL, logo, or watermark visible in generated shots.
- [x] No Instagram/TikTok/Twitter logos in the generated hero shot.
- [x] No personal info (bookmarks bar, profile photo, email, real names in tabs).
- [x] All annotations match the current generated screenshot composition.
- [x] Toolbar icon matches `extension/icons/icon-16.png` after reloading the extension.
- [x] All five generated shots are 1280 × 800 PNG.
- [ ] If you re-shot any screenshot, the build version (manifest.json `version`) matches across them — don't mix shots from v0.4 and v0.5.

Generated screenshots live in `webstore-assets/screenshots/`:

- `01-hero-detected-videos.png`
- `02-quality-picker.png`
- `03-stream-formats.png`
- `04-smart-filenames.png`
- `05-trial-upgrade.png`
