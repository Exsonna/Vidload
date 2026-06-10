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
let lastContextSig = null;
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

// Generic player chrome that isn't a real video name. Players like Hotmart's
// set aria-label="Video Player" on the <video>, which is useless as a title.
function isGenericLabel(s) {
  if (!s) return true;
  const t = s.trim().toLowerCase();
  return /^(video ?player|video|player|media ?player|html5 ?video|jw ?player|videojs|video element|untitled|loading|advertisement|ad)$/.test(t);
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

    const poster = posterForVideo(vid);
    const width = vid.videoWidth || (vid.width > 0 ? vid.width : null);
    const height = vid.videoHeight || (vid.height > 0 ? vid.height : null);
    const duration = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : null;
    const rawContext = findContextForVideo(vid);
    const contextLabel = isGenericLabel(rawContext) ? null : rawContext;

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

// Generic metadata scraper (top frame only): og:video tags and JSON-LD
// VideoObject.contentUrl. Platform adapters handle the big social sites; this
// is the long-tail fallback for news / blog / course pages that expose a clean
// media URL in page metadata even before any <video> network request fires.
function collectPageMeta() {
  if (window !== window.top) return [];
  const items = [];
  const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  const poster = ogImg && /^https?:/i.test(ogImg) ? ogImg : null;
  const kindOf = (u) => (/\.m3u8(\?|$)/i.test(u) ? 'hls' : /\.mpd(\?|$)/i.test(u) ? 'dash' : 'direct');
  const looksMedia = (u) => /\.(mp4|m3u8|mpd|webm|mov|m4v)(\?|$)/i.test(u);
  const add = (url, label) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (url.startsWith('blob:') || seen.has(url)) return;
    seen.add(url);
    items.push({ url, label: label || filenameFromUrl(url), kind: kindOf(url), poster });
  };

  // og:video* — explicitly declared video, accept as-is.
  for (const p of ['og:video', 'og:video:secure_url', 'og:video:url']) {
    const v = document.querySelector(`meta[property="${p}"]`)?.getAttribute('content');
    if (v) add(v, cleanContextText(document.title, 80));
  }

  // JSON-LD VideoObject — contentUrl can also be an image/page, so require it
  // to look like a media file.
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    let data;
    try { data = JSON.parse(el.textContent || 'null'); } catch { return; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.contentUrl === 'string' && looksMedia(node.contentUrl)) {
        add(node.contentUrl, typeof node.name === 'string' ? node.name : null);
      }
      Object.values(node).forEach(walk);
    };
    walk(data);
  });

  return items;
}

function report() {
  const items = [...collect(), ...collectPageMeta()];
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

const IS_TOP_FRAME = window === window.top;

// Best still-image we can find for a video. In priority order:
//   1. the <video poster> attribute
//   2. a large <img> poster-overlay inside the player container (most custom
//      players, incl. Hotmart, paint the thumb as an <img> over the video)
//   3. the page's og:image / twitter:image (in a bare player iframe this is
//      usually the video thumbnail)
function posterForVideo(videoEl) {
  if (videoEl?.poster && /^https?:/i.test(videoEl.poster)) return videoEl.poster;

  if (videoEl) {
    const box = videoEl.getBoundingClientRect();
    if (box.width > 40 && box.height > 40) {
      const container =
        videoEl.closest('[class*="player"], [class*="video"], figure, div') ||
        videoEl.parentElement;
      let best = null;
      let bestArea = 0;
      container?.querySelectorAll('img').forEach((img) => {
        const src = img.currentSrc || img.src;
        if (!src || !/^https?:/i.test(src)) return;
        const r = img.getBoundingClientRect();
        // Must cover most of the video box (a real poster), not a tiny icon.
        if (r.width < box.width * 0.5 || r.height < box.height * 0.5) return;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = src; }
      });
      if (best) return best;
    }
  }

  const og =
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="twitter:image"]')?.content;
  if (og && /^https?:/i.test(og)) return og;
  return null;
}

function videoMetadata(videoEl) {
  if (!videoEl) return {};
  const width = videoEl.videoWidth || null;
  const height = videoEl.videoHeight || null;
  const duration =
    Number.isFinite(videoEl.duration) && videoEl.duration > 0
      ? Math.round(videoEl.duration)
      : null;
  return { poster: posterForVideo(videoEl), duration, width, height };
}

let lastTitle = null;
function broadcastPageTitle() {
  // Only the top frame knows the real page/lecture title. Player iframes have
  // a generic or empty title, so we don't broadcast theirs.
  if (!IS_TOP_FRAME) return;
  // Strip a trailing " | SiteName" / " · SiteName" suffix (common on course
  // pages), but leave dashes alone — real titles often contain " - ".
  const raw = document.title.replace(/\s*[|·]\s*[^|·]{1,40}$/, '');
  const title = cleanContextText(raw, 100);
  if (!title || title === lastTitle) return;
  lastTitle = title;
  try {
    chrome.runtime.sendMessage({ type: 'page-title', title });
  } catch (_) { /* extension context invalidated mid-navigation */ }
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
  if (isGenericLabel(next)) next = null; // e.g. "Video Player" — fall through

  // Tier 2: <article> closest to viewport center (Twitter renders these
  // even when their video isn't mounted yet)
  if (!next) next = findCenterArticle();

  // Tier 3: URL-pattern inference (handle/status/id, /reel/id, /@user, ...)
  if (!next) next = inferFromUrl();

  if (isGenericLabel(next)) next = null;

  // The poster/duration of the player video — even when we have no label —
  // lets network-observed (MSE blob:) streams inherit a thumbnail + duration.
  const meta = videoMetadata(bestVideo);

  // Skip the message if nothing meaningful changed (scroll fires this often).
  const sig = `${next}|${meta.poster}|${meta.duration}|${meta.width}x${meta.height}`;
  if (sig === lastContextSig) return;
  lastContextSig = sig;
  activeContext = next;
  try {
    chrome.runtime.sendMessage({
      type: 'active-context',
      label: activeContext,
      frameTop: IS_TOP_FRAME,
      ...meta,
    });
  } catch (_) { /* extension context invalidated mid-navigation */ }
}

function scheduleUpdate(delay = 200) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateActiveContext();
    report();
    broadcastPageTitle();
  }, delay);
}

report();
updateActiveContext();
broadcastPageTitle();

window.addEventListener('scroll', () => scheduleUpdate(200), { passive: true, capture: true });

const observer = new MutationObserver(() => scheduleUpdate(400));
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  clearTimeout(updateTimer);
});
