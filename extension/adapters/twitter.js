// VidLoad Twitter / X adapter
// Most tweet videos arrive via webRequest observation (video.twimg.com HLS).
// This adapter augments those items with a better filename label and a
// poster image scraped from og:image / twitter:image.

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

  function getMeta(prop, attr = 'property') {
    const el = document.querySelector(`meta[${attr}="${prop}"]`);
    const v = el?.getAttribute('content');
    return v && /^https?:/i.test(v) ? v : null;
  }

  function getPoster() {
    return getMeta('og:image') || getMeta('twitter:image', 'name');
  }

  function getDescription() {
    return getMeta('og:description') || getMeta('description', 'name') || null;
  }

  function unescapeJsonUrl(s) {
    return s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\"/g, '"');
  }

  function fromMeta() {
    const items = [];
    const poster = getPoster();
    const description = getDescription();
    const selectors = [
      ['twitter:player:stream', 'name'],
      ['og:video', 'property'],
      ['og:video:url', 'property'],
      ['og:video:secure_url', 'property'],
    ];
    for (const [name, attr] of selectors) {
      const v = getMeta(name, attr);
      if (v) items.push({ url: v, label: pageLabel(), kind: inferKind(v), poster, description });
    }
    return items;
  }

  function fromJsonBlocks() {
    const items = [];
    const seen = new Set();
    const poster = getPoster();
    const description = getDescription();
    const mediaUrl = /"url"\s*:\s*"(https:\/\/(?:video\.twimg\.com|[^"]*\.twimg\.com)[^"]*\.(?:mp4|m3u8|mpd)(?:\?[^"]*)?)"/gi;
    document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach((el) => {
      const text = el.textContent || '';
      for (const m of text.matchAll(mediaUrl)) {
        const url = unescapeJsonUrl(m[1]);
        if (seen.has(url)) continue;
        seen.add(url);
        items.push({ url, label: pageLabel(), kind: inferKind(url), poster, description });
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
        pageTitle: document.title,
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
