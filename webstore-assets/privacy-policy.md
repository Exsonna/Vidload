# VidLoad Privacy Policy

**Effective date:** July 14, 2026

VidLoad is a browser extension that detects and downloads videos from webpages you visit. This document describes exactly what data the extension handles and what it does not.

## What VidLoad does NOT collect

We want to be explicit upfront. VidLoad does **not**:

- Send your browsing history to any server.
- Send the URLs of videos you detect or download to any server.
- Send your renamed labels, dismissed items, or settings to any server.
- Use analytics, telemetry, or third-party tracking SDKs of any kind.
- Sell, share, or transfer any user data — because we don't have any to share.

## What VidLoad processes locally

To do its job, VidLoad needs to read certain information **inside your browser**, on your computer. This information never leaves your machine.

| Data | Purpose | Stored where |
|---|---|---|
| URLs of videos detected on the active tab | To display the list of downloadable videos in the popup. | `chrome.storage.session` — wiped when the tab closes or the browser restarts. |
| Title, dimensions, poster image (when available) of detected videos | To help you identify which video is which. | Same as above. |
| Renamed labels and dismissed items | To remember your preferences so the popup looks the same next time. | `chrome.storage.local` — persists until you uninstall or clear extension data. |
| Free-download count (if monetization is active) | To track how many of the free downloads you've used. | `chrome.storage.local`. |
| Purchase-status flag (only if you buy Pro) | To keep your Pro unlock working even when the payment service is briefly unreachable. | `chrome.storage.local`. |

That's the complete list. Nothing else is captured.

## Network requests VidLoad makes

VidLoad makes outbound network requests only for these specific reasons:

1. **Downloading the video you asked for.** When you click Download, VidLoad fetches the video data from the source site (the same site that served the page you were viewing). For streamed video (HLS / DASH), this means fetching every segment of the chosen stream.
2. **Reading manifest files for metadata.** When you open the popup and a detected video is a streamed format, VidLoad fetches the manifest (`.m3u8` or `.mpd` file) one time to read its duration and quality options. The fetched content is parsed locally and discarded.
3. **Verifying payment status (if monetization is active).** If you purchase the Pro unlock, the ExtensionPay service is queried to confirm your purchase. This goes to `extensionpay.com`, which uses Stripe to process payment. See "Third-party services" below.

VidLoad never sends information to a server we operate. We do not operate a backend.

## Third-party services

VidLoad's payment flow uses **ExtensionPay** (extensionpay.com), which in turn uses **Stripe** to process payments. If — and only if — you choose to purchase the Pro unlock:

- ExtensionPay receives a per-extension user identifier.
- Stripe receives your payment information (card details, billing email).

Neither ExtensionPay nor Stripe receives information about which videos you download or which sites you visit.

ExtensionPay's privacy policy: https://extensionpay.com/privacy
Stripe's privacy policy: https://stripe.com/privacy

If you never purchase the Pro unlock, VidLoad does not contact either service.

## Permissions and what they're used for

VidLoad's `manifest.json` requests these permissions. Here's why each one is needed:

- **`downloads`** — to save the video file you click on to your computer.
- **`storage`** — to remember your renamed labels and dismissed items between popup openings.
- **`webRequest`** — to detect video streams loaded by webpages, so you can save streams not exposed via a `<video>` element. We only observe response headers; we never modify or block traffic via this API.
- **`offscreen`** — to keep long-running stream-download jobs alive past the service worker's 30-second idle timeout.
- **`declarativeNetRequestWithHostAccess`** — to rewrite the Referer header on extension-originated requests to video CDNs that reject `chrome-extension://` origins. The rewrite is scoped via `tabIds: [-1]` so it never affects your normal browsing — only requests VidLoad itself initiates.
- **Host permission `<all_urls>`** — to detect videos on any website you visit. We never read page contents outside of `<video>` element attributes.

## Data retention

Local data is retained until you uninstall the extension or manually clear extension storage from `chrome://extensions/`. There is no remote retention because there is no remote storage.

## Children

VidLoad is a general-purpose tool and is not directed at children under 13. We do not knowingly collect information from anyone, including children. If you believe a child has used the extension, no action is required — there is nothing to delete on our end.

## Your rights

Because VidLoad does not collect or store data outside your browser, there is no central database from which to delete information. To remove all VidLoad-related data from your machine:

1. Visit `chrome://extensions/`
2. Click "Remove" on the VidLoad card.

This deletes all local storage tied to the extension.

If you purchased Pro and want a refund or your ExtensionPay account information deleted, contact us at the address below.

## Changes to this policy

If we change this policy, we will update the "Effective date" at the top and post the new version at the same URL. Material changes will be noted in the extension's update notes.

## Contact

For questions about this policy or about VidLoad:

**Email:** 150140419@qq.com
**Project:** https://exsonna.github.io/Vidload/
