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

function cleanContextText(s, max = 80) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, max);
}

function twitterHandleFromHref(href) {
  const m = (href || '').match(/^\/([^/?#]+)\/?$/);
  if (!m) return null;
  if (/^(home|explore|notifications|messages|i|search|settings|compose|tos|privacy)$/i.test(m[1])) {
    return null;
  }
  return `@${m[1]}`;
}

function findArticleContext(container) {
  if (!container) return null;

  let author = null;
  const links = container.querySelectorAll('header a[href^="/"], a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (/\/(p|reel|reels|tv|status|photo|video)\//.test(href)) continue;
    const handle = twitterHandleFromHref(href);
    const text = cleanContextText((link.textContent || '').split('\n')[0], 48);
    const candidate = handle || text;
    if (candidate && !looksLikeTimestamp(candidate)) {
      author = candidate;
      break;
    }
  }

  const tweetText =
    container.querySelector('[data-testid="tweetText"]') ||
    container.querySelector('div[lang]');
  const excerpt = cleanContextText(tweetText?.textContent, 90);

  if (author && excerpt) return `${author} - ${excerpt}`;
  if (excerpt) return excerpt;
  if (author) return author;
  return null;
}

function findContextForVideo(videoEl) {
  // Tier 1: enclosing <article> or role="article" — Instagram, Twitter,
  // and most social patterns wrap each post in one.
  let container = videoEl.closest('article, [role="article"]');
  if (container) {
    const articleContext = findArticleContext(container);
    if (articleContext) return articleContext;

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

function findCenterArticle() {
  // Pages like Twitter don't render <video> elements until the user plays a
  // tweet's video — so video-based viewport tracking finds nothing. Walk
  // <article> containers instead so we still know which post is in view.
  const center = window.innerHeight / 2;
  let best = null;
  let bestDist = Infinity;
  document.querySelectorAll('article, [role="article"]').forEach((a) => {
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if (r.width === 0 && r.height === 0) return;
    const c = (r.top + r.bottom) / 2;
    const d = Math.abs(c - center);
    if (d < bestDist) { bestDist = d; best = a; }
  });
  if (!best) return null;
  return findArticleContext(best);
}

function inferFromUrl() {
  const host = location.hostname;
  const path = location.pathname;

  // Twitter/X status: /handle/status/id
  let m = path.match(/^\/([^/]+)\/status\/(\d+)/);
  if (m) return m[1];

  // Twitter/X profile: /handle (excluding reserved routes)
  if (/(?:twitter|x)\.com$/i.test(host)) {
    m = path.match(/^\/([^/]+)\/?$/);
    if (m && !/^(home|explore|notifications|messages|i|search|settings|compose|tos|privacy)$/i.test(m[1])) {
      return m[1];
    }
  }

  // Instagram reel/post/tv: /(p|reel|reels|tv)/id
  m = path.match(/^\/(?:p|reel|reels|tv)\/([^/]+)/);
  if (m) return `instagram-${m[1]}`;

  // Instagram profile: /username (excluding reserved routes)
  if (/instagram\.com$/i.test(host)) {
    m = path.match(/^\/([^/]+)\/?$/);
    if (m && !/^(direct|explore|reels|stories|p|accounts|about)$/i.test(m[1])) {
      return m[1];
    }
  }

  // TikTok: /@user/video/id or /@user
  m = path.match(/^\/(@[^/]+)/);
  if (m) return m[1];

  return null;
}

function updateActiveContext() {
  // Tier 1: <video> closest to viewport center
  const center = window.innerHeight / 2;
  let bestVideo = null;
  let bestDist = Infinity;
  document.querySelectorAll('video').forEach((v) => {
    const r = v.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if (r.width === 0 && r.height === 0) return;
    const c = (r.top + r.bottom) / 2;
    const d = Math.abs(c - center);
    if (d < bestDist) { bestDist = d; bestVideo = v; }
  });

  let next = bestVideo ? findContextForVideo(bestVideo) : null;

  // Tier 2: <article> closest to viewport center (Twitter renders these
  // even when their video isn't mounted yet)
  if (!next) next = findCenterArticle();

  // Tier 3: URL-pattern inference (handle/status/id, /reel/id, /@user, ...)
  if (!next) next = inferFromUrl();

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
