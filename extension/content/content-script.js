// VidLoad content script
// Walks the DOM for <video> elements (and their <source> children) and
// reports any non-blob src URLs to the background service worker.

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
    for (const raw of candidates) {
      if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      items.push({ url: raw, label: filenameFromUrl(raw) });
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
    });
  } catch (_) { /* extension context invalidated mid-navigation */ }
}

report();

const observer = new MutationObserver(() => report());
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => observer.disconnect());
