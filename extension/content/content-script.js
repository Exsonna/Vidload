// VidLoad content script
// Walks the DOM for <video> elements and reports any non-blob src URLs
// along with poster, dimensions, and duration when available.

const seen = new Set();

function filenameFromUrl(raw) {
  try {
    const u = new URL(raw, location.href);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || raw;
  } catch (_) {
    return raw;
  }
}

function collect() {
  const items = [];
  document.querySelectorAll('video').forEach((vid) => {
    const candidates = new Set();
    if (vid.currentSrc) candidates.add(vid.currentSrc);
    if (vid.src) candidates.add(vid.src);
    vid.querySelectorAll('source').forEach((s) => { if (s.src) candidates.add(s.src); });

    const poster = vid.poster && /^https?:/i.test(vid.poster) ? vid.poster : null;
    const width = vid.videoWidth || (vid.width > 0 ? vid.width : null);
    const height = vid.videoHeight || (vid.height > 0 ? vid.height : null);
    const duration = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : null;

    for (const raw of candidates) {
      if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      items.push({
        url: raw,
        label: filenameFromUrl(raw),
        poster,
        width,
        height,
        duration,
      });
    }
  });
  return items;
}

function report() {
  const items = collect();
  if (items.length === 0) return;
  try {
    chrome.runtime.sendMessage({
      type: 'media-found',
      items,
      pageUrl: location.href,
      pageTitle: document.title,
    });
  } catch (_) { /* extension context invalidated mid-navigation */ }
}

report();

const observer = new MutationObserver(() => report());
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => observer.disconnect());
