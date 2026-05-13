// VidLoad TikTok adapter
// Runs on tiktok.com pages, extracts video URLs from TikTok's hydration data
// (__UNIVERSAL_DATA_FOR_REHYDRATION__) and reports them to the background SW.

(() => {
  const log = (...args) => console.log('[VidLoad TikTok]', ...args);
  const reported = new Set();

  function inferKind(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    return 'direct';
  }

  function extractFromUniversalData() {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return [];
    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch {
      return [];
    }
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const desc = typeof node.desc === 'string' ? node.desc : null;
      const id = typeof node.id === 'string' ? node.id : null;
      const baseLabel = (desc || id || `tiktok-${Date.now()}`).replace(/\s+/g, ' ').slice(0, 80);
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && /^https?:/i.test(v) && (k === 'playAddr' || k === 'downloadAddr')) {
          found.push({
            url: v,
            label: k === 'downloadAddr' ? `${baseLabel} (hd)` : baseLabel,
            kind: inferKind(v),
          });
        } else if (v && typeof v === 'object') {
          walk(v);
        }
      }
    };
    walk(data);
    return found;
  }

  function report() {
    const items = extractFromUniversalData().filter((it) => {
      if (reported.has(it.url)) return false;
      reported.add(it.url);
      return true;
    });
    if (items.length === 0) return;
    log(`found ${items.length} item(s)`);
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        source: 'tiktok',
        items,
        pageUrl: location.href,
      });
    } catch {
      /* extension reloaded mid-navigation */
    }
  }

  report();

  // TikTok is an SPA — re-scan on URL change.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      report();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
