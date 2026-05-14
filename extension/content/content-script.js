// VidLoad content script
// - Walks the DOM for <video> elements and reports any non-blob src URLs
//   with poster, dimensions, duration, and a contextLabel (the nearest
//   on-page name: Instagram handle, Twitter handle, heading, etc.)
// - Tracks an "active context" — the contextLabel of the <video> currently
//   closest to viewport center. Updated on scroll and DOM mutation, and
//   broadcast to the SW so network-observed items (which have no DOM tie)
//   can inherit a sensible filename.

const seen = new Set();
let activeContext = null;
let updateTimer = null;

function filenameFromUrl(raw) {
  try {
    const u = new URL(raw, location.href);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || raw;
  } catch (_) {
    return raw;
  }
}

// Reject "5h", "2d", "•", "Suggested for you", and similar non-name strings
// that often appear alongside profile links.
function looksLikeTimestamp(s) {
  return /^\s*\d+\s*[smhdwy]\s*$/i.test(s) || /^\s*[·•]\s*$/.test(s);
}

function findContextForVideo(videoEl) {
  // Tier 1: enclosing <article> or role="article" — Instagram, Twitter,
  // and most social patterns wrap each post in one.
  let container = videoEl.closest('article, [role="article"]');
  if (container) {
    // First profile-style link that isn't a post permalink.
    const links = container.querySelectorAll('header a[href^="/"], a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // Skip post/reel/status/photo permalinks — those don't carry the author name.
      if (/\/(p|reel|reels|tv|status|photo|video)\//.test(href)) continue;
      const text = (link.textContent || '').trim().split('\n')[0].trim();
      if (text && text.length > 0 && text.length < 60 && !looksLikeTimestamp(text)) {
        return text;
      }
    }
  }

  // Tier 2: figcaption near video.
  const fig = videoEl.closest('figure');
  if (fig) {
    const cap = fig.querySelector('figcaption');
    if (cap) {
      const text = (cap.textContent || '').trim().slice(0, 80);
      if (text) return text;
    }
  }

  // Tier 3: aria-label on video or labeled ancestor.
  const aria =
    videoEl.getAttribute('aria-label') ||
    videoEl.closest('[aria-label]')?.getAttribute('aria-label');
  if (aria && aria.length < 100) return aria.trim();

  // Tier 4: nearest heading walking up.
  let el = videoEl.parentElement;
  let hops = 0;
  while (el && el !== document.body && hops < 8) {
    const heading = el.querySelector('h1, h2, h3');
    if (heading) {
      const text = (heading.textContent || '').trim().split('\n')[0].slice(0, 80);
      if (text) return text;
    }
    el = el.parentElement;
    hops += 1;
  }

  return null;
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
    const contextLabel = findContextForVideo(vid);

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
        contextLabel,
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

function updateActiveContext() {
  // Find video closest to viewport center.
  const center = window.innerHeight / 2;
  let bestVideo = null;
  let bestDist = Infinity;
  document.querySelectorAll('video').forEach((v) => {
    const r = v.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if (r.width === 0 && r.height === 0) return;
    const videoCenter = (r.top + r.bottom) / 2;
    const dist = Math.abs(videoCenter - center);
    if (dist < bestDist) {
      bestDist = dist;
      bestVideo = v;
    }
  });

  const next = bestVideo ? findContextForVideo(bestVideo) : null;
  if (next === activeContext) return;
  activeContext = next;
  try {
    chrome.runtime.sendMessage({
      type: 'active-context',
      label: activeContext,
    });
  } catch (_) { /* extension context invalidated mid-navigation */ }
}

function scheduleUpdate(delay = 200) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateActiveContext();
    report();
  }, delay);
}

report();
updateActiveContext();

window.addEventListener('scroll', () => scheduleUpdate(200), { passive: true, capture: true });

const observer = new MutationObserver(() => scheduleUpdate(400));
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  clearTimeout(updateTimer);
});
