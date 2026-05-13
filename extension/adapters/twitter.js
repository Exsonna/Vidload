// VidLoad Twitter / X adapter
// Tweet videos are served via blob: URLs to <video> elements; the real
// network URLs (typically video.twimg.com .m3u8 or .mp4) get caught by the
// service worker's webRequest observer. This adapter's job is to:
//   - Surface og:video / twitter:player:stream meta tags when present
//   - Scrape any media URLs that leak into JSON script blocks
//   - Provide a better filename label (tweet author + id) for items
//     network-observed on the same page

(() => {
  const log = (...args) => console.log('[VidLoad Twitter]', ...args);
  const reported = new Set();

  function inferKind(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    return 'direct';
  }

  function pageLabel() {
    const m = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (m) return `twitter-${m[1]}-${m[2]}`;
    const t = document.title.replace(/\s*\/?\s*(X|Twitter)\s*$/i, '').trim();
    return t ? t.slice(0, 80) : `twitter-${Date.now()}`;
  }

  function unescapeJsonUrl(s) {
    return s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\"/g, '"');
  }

  function fromMeta() {
    const items = [];
    const selectors = [
      'meta[name="twitter:player:stream"]',
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const v = el?.getAttribute('content');
      if (v && /^https?:/i.test(v)) {
        items.push({ url: v, label: pageLabel(), kind: inferKind(v) });
      }
    }
    return items;
  }

  function fromJsonBlocks() {
    const items = [];
    const seen = new Set();
    const mediaUrl = /"url"\s*:\s*"(https:\/\/(?:video\.twimg\.com|[^"]*\.twimg\.com)[^"]*\.(?:mp4|m3u8|mpd)(?:\?[^"]*)?)"/gi;
    document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach((el) => {
      const text = el.textContent || '';
      for (const m of text.matchAll(mediaUrl)) {
        const url = unescapeJsonUrl(m[1]);
        if (seen.has(url)) continue;
        seen.add(url);
        items.push({ url, label: pageLabel(), kind: inferKind(url) });
      }
    });
    return items;
  }

  function report() {
    const items = [...fromMeta(), ...fromJsonBlocks()].filter((it) => {
      if (reported.has(it.url)) return false;
      reported.add(it.url);
      return true;
    });
    if (items.length === 0) return;
    log(`found ${items.length} item(s)`);
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        source: 'twitter',
        items,
        pageUrl: location.href,
      });
    } catch { /* extension reloaded */ }
  }

  report();

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reported.clear();
      report();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
