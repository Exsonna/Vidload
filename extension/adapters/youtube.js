// VidLoad YouTube adapter (self-host build only — not bundled into Web Store build).
//
// Status: minimal. Extracts URLs from `ytInitialPlayerResponse.streamingData`
// that are usable as-is (rare these days — most are signed and require
// running YouTube's player JS to compute the signature). Full
// signature-cipher support is its own project and lands in v0.3.1.

(() => {
  const log = (...args) => console.log('[VidLoad YouTube]', ...args);
  const reported = new Set();

  function findPlayerResponse() {
    if (typeof window.ytInitialPlayerResponse === 'object' && window.ytInitialPlayerResponse) {
      return window.ytInitialPlayerResponse;
    }
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      if (text && text.includes('ytInitialPlayerResponse')) {
        const m = text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;/);
        if (m) {
          try { return JSON.parse(m[1]); } catch { /* try next */ }
        }
      }
    }
    return null;
  }

  function report() {
    const data = findPlayerResponse();
    if (!data?.streamingData) return;
    const videoId = data.videoDetails?.videoId || 'video';
    const title = (data.videoDetails?.title || videoId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const all = [
      ...(data.streamingData.formats || []),
      ...(data.streamingData.adaptiveFormats || []),
    ];
    const items = [];
    let skippedSigned = 0;
    for (const fmt of all) {
      if (fmt.signatureCipher || fmt.cipher) { skippedSigned++; continue; }
      if (!fmt.url) continue;
      const quality = fmt.qualityLabel || fmt.audioQuality || `itag${fmt.itag}`;
      const mimeType = fmt.mimeType || '';
      const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'bin';
      items.push({
        url: fmt.url,
        label: `${title}-${quality}.${ext}`,
        kind: 'direct',
      });
    }
    log(`unsigned: ${items.length}, signed (skipped): ${skippedSigned}`);
    const fresh = items.filter((it) => {
      if (reported.has(it.url)) return false;
      reported.add(it.url);
      return true;
    });
    if (fresh.length === 0) return;
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        source: 'youtube',
        items: fresh,
        pageUrl: location.href,
      });
    } catch { /* extension reloaded */ }
  }

  report();

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      report();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
