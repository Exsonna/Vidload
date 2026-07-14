# Monetization design — ExtensionPay $4.99 one-time

## Status: LIVE — lifetime-cap model (v0.4.29)

`MONETIZATION.enabled = true`. The real ExtensionPay SDK (Glench/ExtPay, ISC) is vendored at `lib/extpay.js` (replaced the stub), the required `extensionpay.com` content script is registered in both builds, `extpayId='vidload'` matches the registered extension, and a Stripe-test-card payment was verified end-to-end (checkout → `extensionpay.com` content script → Pro unlock). Test mode auto-disables once installed from the store (not unpacked).

## Decision (v0.4.29 — replaced the trial/daily model)

VidLoad monetizes via **ExtensionPay** with an accumulating free cap and a one-time unlock:

- **Free tier**: **10 lifetime free downloads** — a single accumulating counter, **no daily reset and no timed trial**. Every download (direct/HLS/DASH/AV) counts, metered on *success*.
- **Pro**: $4.99 one-time → unlimited downloads forever, no subscription. An always-visible **"Upgrade ✨"** link (with a "no limits · one-time $4.99 · no subscription" tooltip) and a top **free-quota banner** ("N free downloads left …" → "used up — tap to unlock") drive conversion.
- **Stripe** handles payments via ExtensionPay; we don't run our own backend.

**Why this shape** (see the monetization audit, 2026-07): the old *7-day unlimited trial + 3/day daily-reset* model meant the paywall almost never fired — a daily-resetting 3/day is ~90 free/month, the median downloader never hit it, and each `trialResetId` bump re-granted everyone another free week. Zero paid conversions was the predictable output. A lifetime cap makes **every retained user reach the paywall exactly once**, at their moment of demonstrated value. To roll back monetization, set `enabled = false`. To tune, change `freeLifetimeLimit`.

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
│    → isPaid() ? proceed : check lifetime counter │
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

## Free-tier counter (lifetime, v0.4.29)

Stored in `chrome.storage.local` under `vidload_downloads`:

```js
{ count: 7 }   // lifetime free downloads used — never reset on a new day
```

`getDownloadCount()` reads `.count`; `commitMeteredDownload()` writes `{ count: count + 1 }`. The counter increments **only on a successful download** and **only when `gate.metered === true`** (a non-paid user under the cap). Concurrent downloads are serialized through `withQuota` + a `pendingMetered` reservation so they can't oversubscribe the cap. Pro downloads bypass the counter entirely.

`gateDownload()` blocks (`allowed:false → 'paywall'`) once `count + pendingMetered >= freeLifetimeLimit` (10).

**Migration from the old daily model:** old installs stored `{ date, count }`; `getDownloadCount()` reads `.count` from either shape and the next commit drops the `date` field. An existing user's prior count carries over (generously — their small daily count becomes part of the 10 lifetime). The old `vidload_trial_start` / `vidload_trial_reset` keys are simply ignored (harmless orphans).

## No timed trial (removed v0.4.29)

The 7-day unlimited trial and the `trialResetId` re-grant mechanism were **removed** — they gave away the highest-intent first-use for free and repeatedly pushed the paywall out of reach (see the audit rationale under Decision). The 10 free lifetime downloads *are* the trial now: enough to prove the tool works, finite enough that a retained user hits the wall once. `#trial-banner` was repurposed from a countdown into the free-quota nudge.

## Configuration toggle

`MONETIZATION` lives at the top of `extension/background/service-worker.js`:

```js
const MONETIZATION = {
  enabled: true,                     // master switch
  extpayId: 'vidload',               // from extensionpay.com dashboard
  freeLifetimeLimit: 10,             // total free downloads before the paywall
  priceLabel: '$4.99 one-time',
};
```

When `enabled: false`, `isPaid()` returns `true` for everyone — `gateDownload()` short-circuits, everything is free, and the tier badge in the popup header is hidden. The paywall UI still exists in the popup but only renders if a download is explicitly rejected.

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
   - Downloads are gated after 10 lifetime free downloads
   - Upgrade button opens the ExtPay payment page in a new tab
   - After a successful test charge, badge flips to "Pro" and gating disappears

## Manifest considerations

`externally_connectable.matches` is already set to `https://extensionpay.com/*` — required so the payment page can send the `paid` event back to our extension. Don't remove this when you ship.

## What if the user wipes storage?

The lifetime counter lives in `chrome.storage.local`, wiped on uninstall — so uninstall+reinstall (or a manual "Clear data") resets the 10-download allowance. This is the inherent limit of client-side gating: the download *count* isn't stored server-side, so a determined user can reset it. The monetization audit accepted this (fully client-side metering is unwinnable); the funnel *shape* is the lever, and most users won't bother. Paid status, by contrast, is tied to a per-extension ExtPay user ID that persists server-side, so **a paid user stays paid after reinstall**. (A future hardening could meter against ExtPay's server-side `installedAt`, but that needs a backend we don't run.)

## What if ExtPay is down?

`isPaid()` **fails open for a previously-confirmed payer** and closed for everyone else (v0.4.29). We cache `vidload_paid_cache = true` the moment `getUser().paid` is true (and in the `onPaid` listener); if a later `getUser()` throws (offline / ExtPay outage / the sync window right after purchase), a cached payer stays Pro instead of being re-gated with "I paid but it's still locked". A never-paid user has no cache and correctly falls back to the free tier.

## See also

- [[chrome-extension-policy]] — why the dual-build strategy doesn't affect this (both builds use the same ExtPay config)
- `extension/background/service-worker.js` — the gating logic
- `extension/lib/extpay.js` — the stub (replace before shipping)
