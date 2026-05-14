// VidLoad TikTok adapter
// Runs on tiktok.com pages, extracts video URLs and metadata from
// __UNIVERSAL_DATA_FOR_REHYDRATION__ (cover image, dimensions, duration,
// description, author).

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
    // Walk looking for objects that look like a TikTok video record:
    // typically { id, desc, video: {playAddr, cover, width, height, ...}, author }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.video && typeof node.video === 'object' && (node.video.playAddr || node.video.downloadAddr)) {
        const v = node.video;
        const author = node.author && (node.author.uniqueId || node.author.nickname);
        const desc = typeof node.desc === 'string' ? node.desc.replace(/\s+/g, ' ').slice(0, 200) : null;
        const baseLabel = author && node.id
          ? `tiktok-${author}-${node.id}`
          : (desc?.slice(0, 60) || `tiktok-${node.id || Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
        const common = {
          poster: typeof v.cover === 'string' ? v.cover : (typeof v.dynamicCover === 'string' ? v.dynamicCover : null),
          width: Number.isFinite(v.width) ? v.width : null,
          height: Number.isFinite(v.height) ? v.height : null,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          description: desc,
        };
        if (typeof v.playAddr === 'string' && /^https?:/i.test(v.playAddr)) {
          found.push({
            url: v.playAddr,
            label: baseLabel,
            kind: inferKind(v.playAddr),
            ...common,
          });
        }
        if (typeof v.downloadAddr === 'string' && /^https?:/i.test(v.downloadAddr) && v.downloadAddr !== v.playAddr) {
          found.push({
            url: v.downloadAddr,
            label: `${baseLabel} (hd)`,
            kind: inferKind(v.downloadAddr),
            ...common,
          });
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') walk(v);
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
        pageTitle: document.title,
      });
    } catch { /* extension reloaded mid-navigation */ }
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
