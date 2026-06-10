// VidLoad YouTube adapter (self-host build only).
//
// Strategy: we do NOT re-implement YouTube's base.js signature / n-parameter
// cipher (a constantly-rotating obfuscated target). Instead the MAIN-world hook
// (youtube-hook.js) captures the *already-deciphered* googlevideo URLs the
// player itself fetches. This adapter cross-references those captured itags
// with the player's published format metadata (resolution, mime, size) and
// reports one downloadable item whose qualities are the captured video itags.
// Adaptive (video-only) qualities are muxed with the best audio itag at
// download time; progressive itags (18/22) already carry audio.

(() => {
  const log = (...args) => console.log('[VidLoad YouTube]', ...args);

  // Captured itag -> { url, mime, clen, dur } from the MAIN-world hook.
  const captured = new Map();
  let reportTimer = null;
  let lastSig = '';

  // Fallback metadata for common itags when the player response is unavailable.
  const ITAG_INFO = {
    18: { height: 360, audio: true, kind: 'video' },
    22: { height: 720, audio: true, kind: 'video' },
    59: { height: 480, audio: true, kind: 'video' },
    37: { height: 1080, audio: true, kind: 'video' },
    133: { height: 240, kind: 'video' }, 134: { height: 360, kind: 'video' },
    135: { height: 480, kind: 'video' }, 136: { height: 720, kind: 'video' },
    137: { height: 1080, kind: 'video' }, 264: { height: 1440, kind: 'video' },
    266: { height: 2160, kind: 'video' },
    160: { height: 144, kind: 'video' },
    242: { height: 240, kind: 'video' }, 243: { height: 360, kind: 'video' },
    244: { height: 480, kind: 'video' }, 247: { height: 720, kind: 'video' },
    248: { height: 1080, kind: 'video' }, 271: { height: 1440, kind: 'video' },
    313: { height: 2160, kind: 'video' }, 315: { height: 2160, kind: 'video' },
    140: { kind: 'audio' }, 139: { kind: 'audio' }, 141: { kind: 'audio' },
    251: { kind: 'audio' }, 250: { kind: 'audio' }, 249: { kind: 'audio' },
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__vidload !== 'yt-media' || !d.itag) return;
    if (!captured.has(d.itag)) {
      captured.set(d.itag, d);
      scheduleReport();
    }
  });

  function scheduleReport() {
    clearTimeout(reportTimer);
    // Debounce — several itags arrive in a burst as the player buffers.
    reportTimer = setTimeout(buildAndReport, 900);
  }

  function findPlayerResponse() {
    if (typeof window.ytInitialPlayerResponse === 'object' && window.ytInitialPlayerResponse) {
      return window.ytInitialPlayerResponse;
    }
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      if (text && text.includes('ytInitialPlayerResponse')) {
        const m = text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;/);
        if (m) { try { return JSON.parse(m[1]); } catch { /* next */ } }
      }
    }
    return null;
  }

  function bestThumbnail(thumbnails) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    return [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
  }

  function buildAndReport() {
    const pr = findPlayerResponse();
    const meta = {}; // itag -> { qualityLabel, mimeType, width, height, contentLength, isAudio, hasAudio }
    if (pr && pr.streamingData) {
      const progressive = pr.streamingData.formats || [];
      const adaptive = pr.streamingData.adaptiveFormats || [];
      for (const f of [...progressive, ...adaptive]) {
        const mt = f.mimeType || '';
        meta[f.itag] = {
          qualityLabel: f.qualityLabel || f.audioQuality || '',
          mimeType: mt,
          width: f.width || null,
          height: f.height || null,
          contentLength: f.contentLength ? parseInt(f.contentLength, 10) : null,
          isAudio: mt.startsWith('audio/'),
          hasAudio: false,
        };
      }
      for (const f of progressive) { if (meta[f.itag]) meta[f.itag].hasAudio = true; } // muxed
    }

    const videoVariants = [];
    let bestAudio = null;
    for (const [itag, cap] of captured) {
      const m = meta[itag] || {};
      const fallback = ITAG_INFO[Number(itag)] || {};
      const mime = (cap.mime || m.mimeType || '').toLowerCase();
      const isAudio = m.isAudio || fallback.kind === 'audio' || mime.includes('audio');
      const clen = parseInt(cap.clen || '0', 10) || m.contentLength || 0;
      if (isAudio) {
        // Prefer AAC (mp4a, itag 139/140/141) — it muxes cleanly into MP4 with
        // H.264 video. Fall back to whatever audio we captured (e.g. Opus).
        const isAac = /mp4a/i.test(mime) || [139, 140, 141].includes(Number(itag));
        const better = !bestAudio
          || (isAac && !bestAudio.isAac)
          || (isAac === bestAudio.isAac && clen > bestAudio.clen);
        if (better) bestAudio = { url: cap.url, clen, isAac };
        continue;
      }
      const height = m.height || fallback.height || 0;
      const hasAudio = m.hasAudio || !!fallback.audio;
      videoVariants.push({
        url: cap.url,
        height,
        label: m.qualityLabel || (height ? `${height}p` : `itag ${itag}`),
        bytes: clen || null,
        hasAudio,
      });
    }

    if (videoVariants.length === 0) return;
    videoVariants.sort((a, b) => (b.height || 0) - (a.height || 0));

    const vd = pr && pr.videoDetails;
    const title = (vd && vd.title ? vd.title : (document.title || 'youtube-video'))
      .replace(/\s*-\s*YouTube\s*$/i, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

    const sig = videoVariants.map((v) => v.url).join('|') + '::' + (bestAudio ? bestAudio.url : '');
    if (sig === lastSig) return;
    lastSig = sig;

    log(`reporting ${videoVariants.length} video qualities, audio: ${bestAudio ? 'yes' : 'no'}`);
    try {
      chrome.runtime.sendMessage({
        type: 'media-found',
        source: 'youtube',
        items: [{
          url: location.href.split('&')[0],
          kind: 'mux',
          label: title,
          poster: vd ? bestThumbnail(vd.thumbnail && vd.thumbnail.thumbnails) : null,
          duration: vd && vd.lengthSeconds ? parseInt(vd.lengthSeconds, 10) : null,
          description: vd && vd.shortDescription ? vd.shortDescription.replace(/\s+/g, ' ').slice(0, 200) : null,
          width: videoVariants[0].height ? Math.round(videoVariants[0].height * 16 / 9) : null,
          height: videoVariants[0].height || null,
          videoVariants,
          audioUrl: bestAudio ? bestAudio.url : null,
        }],
        pageUrl: location.href,
        pageTitle: document.title,
      });
    } catch { /* extension reloaded */ }
  }

  // Re-evaluate on SPA navigation (captured set is per-video; reset it).
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      captured.clear();
      lastSig = '';
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
