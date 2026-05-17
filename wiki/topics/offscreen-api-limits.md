# Offscreen document API surface — `chrome.downloads` is NOT available

## TL;DR

MV3 offscreen documents have a **restricted chrome.* API surface**. Code that runs there can use `chrome.runtime` and most of `chrome.storage`, but **cannot call `chrome.downloads.download()`** — the entire `chrome.downloads` namespace is undefined in offscreen contexts.

If you need to trigger a download from work that ran in offscreen (e.g., HLS/DASH segment concat), route it back through the **service worker** via a runtime message.

## How we found this

v0.4.8 fix. Reported error from offscreen DevTools:

```
offscreen.js:25 [VidLoad stream] job failed
TypeError: Cannot read properties of undefined (reading 'download')
    at offscreen.js:143:22 (finalize)
    at runHlsJob (offscreen.js:210:9)
```

The expression was `chrome.downloads.download({ ... })`. The undefined property was `'download'`, meaning `chrome.downloads` itself was `undefined`. We have `"downloads"` in `manifest.permissions`, so the permission is granted — but offscreen doesn't expose it.

This bug had been latent in the codebase since [[hls-download-approach]] (v0.2) but went unnoticed because earlier "download works" tests were for direct files (popup → SW → `chrome.downloads`, no offscreen involved). The first HLS download on x.com surfaced it.

## What works in offscreen

- `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`
- `chrome.runtime.getContexts`
- `chrome.storage.session` and `chrome.storage.local`
- `fetch`, `Blob`, `URL.createObjectURL`, `URL.revokeObjectURL`
- `crypto.subtle` (Web Crypto API)
- `DOMParser`
- `AbortController` / `AbortSignal`

## What doesn't

- `chrome.downloads` — entire namespace undefined
- `chrome.tabs` — undefined (offscreen has no tab context)
- `chrome.windows` — undefined
- `chrome.action`, `chrome.history`, `chrome.bookmarks`, etc.

For these, send a message to the service worker and have the SW perform the action.

## Pattern: SW-routed download

```js
// offscreen.js — after assembling the blob
const blob = new Blob(parts, { type: 'video/mp4' });
const blobUrl = URL.createObjectURL(blob);
const result = await chrome.runtime.sendMessage({
  type: 'commit-download',
  url: blobUrl,
  filename: finalName,
  saveAs: !!saveAs,
});
if (!result?.ok) throw new Error(result?.error || 'commit failed');
setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
```

```js
// service-worker.js — handler for the commit message
if (msg?.type === 'commit-download' && msg.url) {
  chrome.downloads.download(
    { url: msg.url, filename: msg.filename, saveAs: !!msg.saveAs },
    (downloadId) => {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse({ ok: true, downloadId });
    }
  );
  return true;
}
```

**Blob URLs are reachable across same-origin extension contexts**, so a `blob:chrome-extension://<id>/...` URL created in offscreen is fetchable by the SW. The offscreen document needs to stay alive at least until `chrome.downloads.download()` returns the `downloadId` — by then Chrome has captured the data internally and the blob URL can be revoked.

## Lifecycle implication

Offscreen documents normally stay alive while they have outstanding async work (fetches, timers). Our `await chrome.runtime.sendMessage(...)` keeps the document alive long enough for the SW to commit the download. The `setTimeout(URL.revokeObjectURL, 60s)` is belt-and-suspenders — by the 60s mark Chrome has long since ingested the blob.

## See also

- [[hls-download-approach]] — the broader HLS download design
- [[dash-download-approach]] — same pipeline shared with DASH
- `extension/offscreen/offscreen.js` — `finalize()` is the function in question
- `extension/background/service-worker.js` — `commit-download` handler
