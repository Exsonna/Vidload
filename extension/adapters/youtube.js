// VidLoad YouTube adapter (self-host build only).
// Reads ytInitialPlayerResponse for stream URLs. Reports only unsigned
// URLs (most modern YouTube URLs need signature-cipher decoding — that
// is a separate, larger project). Includes the highest-resolution
// thumbnail and per-stream resolution/duration metadata.

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

  function bestThumbnail(thumbnails) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url || null;
  }

  function report() {
    const data = findPlayerResponse();
    if (!data?.streamingData) return;
    const videoId = data.videoDetails?.videoId || 'video';
    const title = (data.videoDetails?.title || videoId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const description = data.videoDetails?.shortDescription
      ? data.videoDetails.shortDescription.replace(/\s+/g, ' ').slice(0, 200)
      : null;
    const durationSeconds = parseInt(data.videoDetails?.lengthSeconds || '0', 10) || null;
    const poster = bestThumbnail(data.videoDetails?.thumbnail?.thumbnails);

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
        poster,
        description,
        width: fmt.width || null,
        height: fmt.height || null,
        duration: durationSeconds,
        bytes: fmt.contentLength ? parseInt(fmt.contentLength, 10) : null,
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
        pageTitle: document.title,
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
