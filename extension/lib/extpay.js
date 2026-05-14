// =============================================================================
// VidLoad ExtPay STUB — REPLACE BEFORE SHIPPING MONETIZATION
// =============================================================================
//
// This is a stub that mimics the ExtensionPay SDK's API surface so the
// monetization integration code compiles and runs. It always reports
// `paid: false` and `openPaymentPage()` just opens extensionpay.com in a
// new tab (no actual Stripe checkout).
//
// To enable real monetization:
//   1. Sign up at https://extensionpay.com/
//   2. Create your extension on their dashboard; copy your extension ID
//   3. Connect Stripe + set up your $4.99 one-time product
//   4. Download the real SDK from https://extensionpay.com/dist/ExtPay.js
//   5. REPLACE this file with the downloaded ExtPay.js (overwrite)
//   6. Edit extension/background/service-worker.js:
//        - MONETIZATION.extpayId = '<your-extension-id>'
//        - MONETIZATION.enabled = true
//   7. node build.mjs to regenerate dist/ artifacts
//
// See wiki/topics/monetization.md for the full design.
// =============================================================================

(function () {
  'use strict';

  function ExtPay(extensionId) {
    console.warn(
      '[VidLoad] ExtPay STUB active for extension "' + extensionId +
      '". Replace lib/extpay.js with the real SDK from extensionpay.com.'
    );

    const listeners = { paid: [], trialStarted: [] };

    return {
      getUser: async function () {
        return {
          paid: false,
          paidAt: null,
          installedAt: new Date(),
          subscriptionStatus: 'free',
          trialStartedAt: null,
        };
      },
      onPaid: {
        addListener: (cb) => { listeners.paid.push(cb); },
        removeListener: (cb) => {
          listeners.paid = listeners.paid.filter((x) => x !== cb);
        },
      },
      onTrialStarted: {
        addListener: (cb) => { listeners.trialStarted.push(cb); },
        removeListener: (cb) => {
          listeners.trialStarted = listeners.trialStarted.filter((x) => x !== cb);
        },
      },
      openPaymentPage: function () {
        const url = 'https://extensionpay.com/extension/' + encodeURIComponent(extensionId);
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url });
        } else if (typeof window !== 'undefined') {
          window.open(url, '_blank');
        }
      },
      openLoginPage: function () {
        const url = 'https://extensionpay.com/login';
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url });
        } else if (typeof window !== 'undefined') {
          window.open(url, '_blank');
        }
      },
      startBackground: function () { /* no-op in stub */ },
    };
  }

  if (typeof self !== 'undefined') self.ExtPay = ExtPay;
  if (typeof globalThis !== 'undefined') globalThis.ExtPay = ExtPay;
})();
