# Chrome Web Store listing copy

Copy/paste into the corresponding fields on the Web Store Developer Dashboard. All copy avoids platform-specific framing (no YouTube, no Instagram-by-name in the short description) so it survives review.

---

## Extension name

```
VidLoad — Video Downloader
```

(Web Store allows up to 50 chars. "VidLoad" alone is fine if you'd rather skip the suffix.)

---

## Short description (max 132 chars)

```
Save videos from any webpage. Detects HTML5, HLS, and DASH streams automatically. One-click download, no extra software.
```

---

## Detailed description (max 16,000 chars)

```
VidLoad finds videos on the pages you visit and lets you download them with one click.

WHAT IT DETECTS

- Direct video files (MP4, WebM, MOV)
- HLS streams (M3U8 playlists with TS or fragmented MP4 segments)
- DASH streams (MPD playlists)
- AES-128 encrypted HLS (auto-decrypted before saving)

HOW IT WORKS

1. Open any page with a video.
2. Click the VidLoad toolbar icon.
3. Pick the video you want. Choose a quality if multiple are offered.
4. Click Download.

For streamed videos (HLS / DASH), VidLoad downloads every segment in the background and saves the result as a single playable file. No FFmpeg, no extra software, no command line.

WHAT MAKES IT DIFFERENT

- Quality picker. When a site offers multiple resolutions, VidLoad shows them in a dropdown so you can pick 1080p, 720p, or any other variant.
- Smart filenames. VidLoad reads the surrounding page (titles, captions, author handles) to give your saved file a meaningful name instead of an opaque ID.
- Clean popup. Sub-segments and probe responses are filtered out so you only see real videos. Items you dismiss or rename stay that way.
- Free trial. Every new install gets 7 days of unlimited downloads — no credit card, no signup.
- One-time purchase. After the trial, free tier allows 3 downloads per day. Unlock unlimited downloads forever for a single $4.99 payment. No subscription.

PRIVACY

VidLoad runs entirely in your browser. We do not collect, log, or transmit information about which pages you visit, which videos you download, or anything else about your browsing. Files save directly to your computer. The only outbound network calls are (a) requests to actually download the video you click on, and (b) when you choose to upgrade, the payment provider's checkout page. See our Privacy Policy for full details.

LIMITATIONS

- VidLoad cannot save content that is protected by DRM (Widevine, FairPlay, PlayReady).
- Some sites change their internal video URLs frequently. If a site stops working, please report it — we maintain compatibility for the popular platforms VidLoad supports.
- Live streams without an explicit end marker may save only a partial clip.

KEYBOARD / WORKFLOW

- Click the toolbar icon to open the detected-video list.
- Use the pencil button on any row to rename before downloading.
- Use the three-dot menu to copy the source URL, open it in a new tab, or save with a custom filename.

SUPPORT

Questions, broken sites, feature requests: https://exsonna.github.io/Vidload/support.html
```

---

## Single-purpose description

Chrome Web Store policy requires extensions to declare a single purpose. Paste this in the "Single purpose" field:

```
VidLoad has a single purpose: detect videos embedded in the webpages a user visits and let the user download those videos to their computer.
```

---

## Category

```
Tools  →  Browser tools  (or)  Productivity  →  Workflow & planning
```

---

## Language

```
English (en)
```

(Add localized listings later if there's demand.)

---

## Permissions justifications

Each permission in `manifest.json` needs a one-sentence reason. Paste these into the corresponding fields:

| Permission | Justification |
|---|---|
| `downloads` | Required to save the user's chosen video file to their computer via `chrome.downloads.download()`. |
| `storage` | Required to remember the user's renamed labels, dismissed items, and (if monetization is active) trial timer and daily download count across browser sessions. |
| `webRequest` | Required to detect video stream URLs as they load on the page, so the user can save streams the page doesn't expose via a `<video>` element. We only observe response headers — we never modify or block requests via webRequest. |
| `offscreen` | Required because HLS and DASH downloads require many sequential `fetch` calls that outlive the service worker's 30-second idle timeout. The offscreen document keeps the download job alive until completion. |
| `declarativeNetRequestWithHostAccess` | Required to rewrite the `Referer` header for video CDN requests originating from the extension. Many video CDNs reject requests where the Referer is a `chrome-extension://` URL. The rewrite is scoped to extension-originated requests only (`tabIds: [-1]`); the user's normal browsing is unaffected. |
| Host permission: `<all_urls>` | Required because videos can appear on any website — we cannot know in advance which sites the user will visit. The extension only reads media URLs and never sees the contents of pages outside of `<video>` element attributes. |

---

## "Why are you using remote code?"

VidLoad does **not** load remote code. All JavaScript ships in the package. The ExtensionPay SDK (when monetization is active) is bundled, not fetched at runtime. Answer "No remote code" on the dashboard.

---

## Promotional images

These are optional but recommended:

| Asset | Size | Required? |
|---|---|---|
| Small promo tile | 440 × 280 | Recommended |
| Large promo tile | 920 × 680 | Optional |
| Marquee promo tile | 1400 × 560 | Optional (for featured placement) |

See `screenshots.md` for screenshot guidelines (those are separate from promo tiles and *are* required).

Support URL: https://exsonna.github.io/Vidload/support.html

---

## Pricing & distribution

- **Free with in-app purchase** — set this if monetization is active.
- **Free** — set this if `MONETIZATION.enabled = false` in the build you're submitting.
- **Visibility**: Public.
- **Regions**: All regions unless you have a specific reason to exclude one.
