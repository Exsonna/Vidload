// VidLoad Instagram adapter
// Targets reels and posts. Scrapes og:* meta tags and JSON script blocks
// for video URLs. Includes og:image as poster when present.
// Stories require auth — out of scope.

(() => {
  const log = (...args) => console.log('[VidLoad Instagram]', ...args);
  const reported = new Set();

  function inferKind(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    return 'direct';
  }

  function pageLabel() {
    const m = location.pathname.match(/^\/(?:p|reel|reels|tv)\/([^/]+)/);
    if (m) return `instagram-${m[1]}`;
    const t = document.title.replace(/\s*[|·]\s*Instagram.*$/i, '').trim();
    return t ? t.slice(0, 80) : `instagram-${Date.now()}`;
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
    return (
      getMeta('og:description') ||
      getMeta('description', 'name') ||
      null
    );
  }

  function unescapeJsonUrl(s) {
    return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
  }

  function fromMeta() {
    const items = [];
    const poster = getPoster();
    const description = getDescription();
    for (const prop of ['og:video', 'og:video:secure_url', 'og:video:url']) {
      const v = getMeta(prop);
      if (v) items.push({ url: v, label: pageLabel(), kind: inferKind(v), poster, description });
    }
    return items;
  }

  function fromJsonBlocks() {
    const items = [];
    const seen = new Set();
    const poster = getPoster();
    const description = getDescription();
    const patterns = [
      /"video_url"\s*:\s*"([^"]+)"/g,
      /"playback_url"\s*:\s*"([^"]+)"/g,
      /"url"\s*:\s*"(https:\/\/[^"]*\.(?:mp4|m3u8|mpd)(?:\?[^"]*)?)"/gi,
    ];
    document.querySelectorAll('script[type="application/json"]').forEach((el) => {
      const text = el.textContent || '';
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          const url = unescapeJsonUrl(m[1]);
          if (seen.has(url) || !/^https?:\/\//.test(url)) continue;
          seen.add(url);
          items.push({ url, label: pageLabel(), kind: inferKind(url), poster, description });
        }
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
        source: 'instagram',
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
