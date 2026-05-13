// VidLoad Instagram adapter
// Targets reels and posts. Scrapes:
//   - <meta property="og:video" / og:video:url / og:video:secure_url>
//   - <script type="application/json"> blocks for "video_url" / "playback_url"
//     keys and any "url" fields pointing at .mp4/.m3u8/.mpd
// Stories require auth and aren't in the public DOM — out of scope.
// Modern IG rotates its JSON structure often; expect this to need updates.

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

  function unescapeJsonUrl(s) {
    return s
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');
  }

  function fromMeta() {
    const items = [];
    for (const prop of ['og:video', 'og:video:secure_url', 'og:video:url']) {
      const el = document.querySelector(`meta[property="${prop}"]`);
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
          if (seen.has(url)) continue;
          if (!/^https?:\/\//.test(url)) continue;
          seen.add(url);
          items.push({ url, label: pageLabel(), kind: inferKind(url) });
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
