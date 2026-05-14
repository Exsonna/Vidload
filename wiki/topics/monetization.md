# Monetization design — ExtensionPay $4.99 one-time

## Decision

VidLoad monetizes via **ExtensionPay** with a free tier and one-time unlock:

- **Free tier**: 3 downloads per day (counter resets at midnight local time)
- **Pro**: $4.99 one-time → lifetime unlimited downloads
- **Stripe** handles payments via ExtensionPay; we don't run our own backend

## Why ExtensionPay

| | ExtensionPay | DIY (Stripe + own backend) |
|---|---|---|
| Integration | ~30 LoC + SDK file | Hundreds of LoC + backend service |
| Backend ops | None | License server, webhook handler, DB |
| Fees | Stripe (~2.9% + $0.30) + ~5% to ExtPay | Stripe only |
| Fraud / chargebacks | Handled | DIY |
| Time to revenue | Hours | Weeks |

For a solo dev validating paid demand, ExtPay's overhead is well worth the ~5% on top of Stripe.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Popup (popup.js)                               │
│  - Calls 'get-status' → tier badge in header    │
│  - On Download click: handles 'paywall' error → │
│    shows #paywall view with Upgrade CTA         │
│  - Upgrade → 'open-payment-page' message        │
└─────────────────┬───────────────────────────────┘
                  │ chrome.runtime.sendMessage
                  ▼
┌─────────────────────────────────────────────────┐
│  Service Worker (background/service-worker.js)  │
│  - MONETIZATION { enabled, extpayId, limit, ... }│
│  - importScripts('lib/extpay.js')               │
│  - gateDownload() before every Download         │
│    → isPaid() ? proceed : check daily counter   │
│  - 'open-payment-page' → extpay.openPaymentPage()│
└─────────────────┬───────────────────────────────┘
                  │ extpay.getUser() / Stripe checkout
                  ▼
┌─────────────────────────────────────────────────┐
│  extensionpay.com (Stripe-backed)               │
│  - Hosted payment page                          │
│  - Webhook → updates ExtPay user record         │
│  - extpay.onPaid listener fires in SW           │
└─────────────────────────────────────────────────┘
```

## Free-tier counter

Stored in `chrome.storage.local` under `vidload_downloads`:

```js
{ date: '2026-05-14', count: 2 }
```

Counter increments after each successful `chrome.downloads.download()` call (or successful HLS/DASH job start). On midnight local time the date check triggers a reset to 0.

## Configuration toggle

`MONETIZATION` lives at the top of `extension/background/service-worker.js`:

```js
const MONETIZATION = {
  enabled: false,                    // master switch
  extpayId: 'vidload',               // from extensionpay.com dashboard
  freeDailyLimit: 3,
  priceLabel: '$4.99 one-time',
};
```

When `enabled: false` (the current default), `gateDownload()` short-circuits — everything is free, the tier badge in the popup header is hidden. The paywall UI still exists in the popup but only renders if a download is explicitly rejected.

## Setup steps (for the project owner)

1. **Sign up** at <https://extensionpay.com/>
2. **Create extension** on the dashboard. Note the extension ID slug (e.g. `vidload`).
3. **Set up product**: a single one-time charge labeled "Lifetime unlock", priced at $4.99.
4. **Connect Stripe**: ExtPay walks you through OAuth.
5. **Download `ExtPay.js`** from <https://extensionpay.com/dist/ExtPay.js>.
6. **Replace** `extension/lib/extpay.js` with the downloaded file. The stub mimics ExtPay's API but always returns `paid: false`; the real SDK actually talks to Stripe/ExtPay servers.
7. **Edit** `extension/background/service-worker.js` and set:
   - `MONETIZATION.enabled = true`
   - `MONETIZATION.extpayId = '<your-id>'`
8. **Rebuild**: `node build.mjs`
9. **Load** `dist/webstore/` or `dist/selfhost/` as an unpacked extension and verify:
   - Tier badge appears in popup header
   - Downloads are gated after 3 per day
   - Upgrade button opens the ExtPay payment page in a new tab
   - After a successful test charge, badge flips to "Pro" and gating disappears

## Manifest considerations

`externally_connectable.matches` is already set to `https://extensionpay.com/*` — required so the payment page can send the `paid` event back to our extension. Don't remove this when you ship.

## What if the user wipes storage?

The daily counter lives in `chrome.storage.local`, which persists across SW restarts but is wiped on extension uninstall. Reinstalling resets the counter — but the paid status on ExtPay's backend is tied to a per-extension user ID that persists, so a paid user remains paid after reinstall.

## What if ExtPay is down?

`isPaid()` fails closed — if `extpay.getUser()` throws, we report `paid: false`. The user falls back to the free tier. We don't break downloads entirely on an ExtPay outage; we just temporarily lose access to the "Pro" status until ExtPay recovers.

## See also

- [[chrome-extension-policy]] — why the dual-build strategy doesn't affect this (both builds use the same ExtPay config)
- `extension/background/service-worker.js` — the gating logic
- `extension/lib/extpay.js` — the stub (replace before shipping)
