// =============================================================================
// Error surface — registered BEFORE any DOM access so even module-load
// failures show up as a red banner instead of dying silently.
// =============================================================================
function showError(message) {
  console.error('[VidLoad popup]', message);
  try {
    let banner = document.getElementById('vidload-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'vidload-error-banner';
      banner.style.cssText =
        'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:6px;' +
        'margin:8px;padding:8px 10px;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;';
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.textContent = String(message);
  } catch (e) {
    /* document not ready yet, console is our fallback */
  }
}
window.addEventListener('error', (ev) => {
  showError(
    `Uncaught: ${ev.message}\n` +
    `${ev.filename}:${ev.lineno}:${ev.colno}\n` +
    (ev.error?.stack || '')
  );
});
window.addEventListener('unhandledrejection', (ev) => {
  showError(
    `Unhandled rejection: ${ev.reason?.message || ev.reason}\n` +
    (ev.reason?.stack || '')
  );
});

// =============================================================================
// DOM references (returns null if missing — every use below is null-guarded)
// =============================================================================
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tierBadgeEl = document.getElementById('tier-badge');
const trialBannerEl = document.getElementById('trial-banner');
const tpl = document.getElementById('row-template');
const toggleEl = document.getElementById('toggle-hidden');
const paywallEl = document.getElementById('paywall');
const paywallDetailEl = document.getElementById('paywall-detail');
const paywallPriceEl = document.getElementById('paywall-price');
const paywallFootEl = document.getElementById('paywall-foot');
const upgradeBtn = document.getElementById('upgrade-btn');
const upgradeLinkEl = document.getElementById('upgrade-link');
const paywallBackBtn = document.getElementById('paywall-back');
const footerEl = document.querySelector('footer');
const menuEl = document.getElementById('row-menu');
let menuTarget = null; // { item, rowEl }

// Surface missing elements early so we know what's wrong.
{
  const required = { listEl, statusEl, tpl };
  const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) showError(`Missing DOM element(s) in popup.html: ${missing.join(', ')}`);
}

const MIN_DIRECT_BYTES = 100 * 1024;
// Items loaded much earlier than the newest capture are almost never what the
// user wants (feed scrolling accumulates every autoplayed video) — fold them
// behind the "Show hidden" toggle instead of listing them up front.
const STALE_WINDOW_MS = 120_000;

const activeJobs = new Map();   // jobId -> item url (routes live stream messages)
const jobByUrl = new Map();      // item url -> { status, phase, current, total, error }
const rowsByUrl = new Map();     // item url -> { dlBtn, progressEl, fillEl, textEl }

// HLS dedup: a master playlist references variant + audio media playlists. Once
// a probe reveals those child URLs, we hide any detected item that IS one of
// them — collapsing master + variants + audio into the single master row.
const hlsChildKeys = new Set();  // playlistKey(url) of known child playlists
function playlistKey(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}
let rerenderTimer = null;
function scheduleRerender() {
  if (rerenderTimer) return;
  rerenderTimer = setTimeout(() => { rerenderTimer = null; render(); }, 150);
}
let allItems = [];
let showHidden = false;
const dismissed = new Set();
let tierStatus = { monetizationEnabled: false, paid: true };

// Generic player chrome ("Video Player" etc.) is not a real title — ignore it
// so the page title / filename heuristics take over.
function isGenericLabel(s) {
  if (!s) return true;
  return /^(video ?player|video|player|media ?player|html5 ?video|jw ?player|videojs|untitled|loading)$/i.test(s.trim());
}

// =============================================================================
// User-data persistence (dismissed + renames). Single map in chrome.storage.local
// keyed by URL. Survives popup close/reopen. Unbounded growth for now — CDN URLs
// are unique-per-stream so duplicates are rare; revisit if storage gets noisy.
// =============================================================================
const USERDATA_KEY = 'vidload:userdata';
let userdata = {}; // { [url]: { dismissed?: true, label?: string } }

async function loadUserdata() {
  try {
    const stored = await chrome.storage.local.get(USERDATA_KEY);
    userdata = stored?.[USERDATA_KEY] || {};
  } catch (err) {
    console.debug('VidLoad: userdata load failed', err?.message || err);
    userdata = {};
  }
}

function saveUserdata() {
  chrome.storage.local.set({ [USERDATA_KEY]: userdata }).catch((err) =>
    console.debug('VidLoad: userdata save failed', err?.message || err)
  );
}

function rememberDismissed(url) {
  if (!url) return;
  userdata[url] = userdata[url] || {};
  userdata[url].dismissed = true;
  dismissed.add(url);
  saveUserdata();
}

function rememberLabel(url, label) {
  if (!url || !label) return;
  userdata[url] = userdata[url] || {};
  userdata[url].label = label;
  saveUserdata();
}

function applyUserdata(items) {
  for (const item of items || []) {
    const ud = userdata[item?.url];
    if (!ud) continue;
    if (ud.dismissed) dismissed.add(item.url);
    if (ud.label) {
      item.userLabel = ud.label;
      item.label = ud.label;
    }
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setDownloadButton(btn, text, opts = {}) {
  if (!btn) return;
  const label = btn.querySelector('.dl-label');
  if (label) label.textContent = text;
  btn.disabled = !!opts.disabled;
}

// =============================================================================
// Per-row download progress UI (0–100% bar). Driven by stream-* messages and
// restored from the SW job table when the popup reopens mid-download.
// =============================================================================
function showRowProgress(refs, job) {
  if (!refs?.progressEl) return;
  refs.progressEl.hidden = false;
  const indeterminate = job.phase === 'manifest' || job.phase === 'save' || job.phase === 'remux';
  refs.progressEl.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    if (refs.fillEl) refs.fillEl.style.width = '';
    if (refs.textEl) {
      refs.textEl.textContent =
        job.phase === 'remux' ? 'Converting…' : job.phase === 'save' ? 'Finalizing…' : 'Reading…';
    }
  } else {
    const pct = job.total > 0 ? Math.min(100, Math.round((job.current / job.total) * 100)) : 0;
    if (refs.fillEl) refs.fillEl.style.width = `${pct}%`;
    if (refs.textEl) refs.textEl.textContent = `${pct}%`;
  }
  setDownloadButton(refs.dlBtn, 'Downloading', { disabled: true });
  if (refs.dlBtn) refs.dlBtn.title = '';
}

function hideRowProgress(refs) {
  if (!refs?.progressEl) return;
  refs.progressEl.hidden = true;
  refs.progressEl.classList.remove('indeterminate');
}

// Apply a job's state to its row (if currently rendered). Also keeps jobByUrl
// in sync so re-renders (dismiss/toggle) preserve the visible state.
function applyJob(url, job) {
  if (!url || !job) return;
  jobByUrl.set(url, job);
  const refs = rowsByUrl.get(url);
  if (!refs) return;
  if (job.status === 'active') {
    showRowProgress(refs, job);
  } else if (job.status === 'done') {
    hideRowProgress(refs);
    setDownloadButton(refs.dlBtn, job.warning ? 'Saved ⚠' : 'Saved', { disabled: true });
    if (refs.dlBtn) refs.dlBtn.title = job.warning || '';
  } else if (job.status === 'error') {
    hideRowProgress(refs);
    setDownloadButton(refs.dlBtn, 'Retry');
    if (refs.dlBtn) refs.dlBtn.title = `Download failed: ${job.error || 'unknown error'}`;
  }
}

function formatBytes(n) {
  if (!n || !Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(s) {
  if (!s || !Number.isFinite(s) || s <= 0) return null;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function qualityLabel(width, height) {
  if (!height || !Number.isFinite(height)) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return `${height}p`;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function shortHost(url) {
  const h = hostFromUrl(url);
  if (!h) return '';
  // Registrable domain (shared with the SW) — correctly keeps multi-part public
  // suffixes intact, e.g. hotmart.com.br instead of com.br.
  return self.VidLoadUrl.registrableDomain(h) || h;
}

function looksLikeGibberish(s) {
  if (!s) return true;
  const cleaned = s.replace(/\.\w{1,5}$/, '').replace(/[-_]/g, '');
  if (cleaned.length < 12) return false;
  return /^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length >= 16;
}

function hasMetadata(item) {
  return !!(item?.poster || item?.description || item?.duration || (item?.width && item?.height));
}

function looksLikeStreamSegment(item) {
  if (!item?.url) return false;
  return self.VidLoadUrl.isStreamSegmentUrl(item.url); // shared with the SW
}

// Collapse several detected URLs that are the SAME source video into one row.
// Twitter/X serves one clip as multiple sibling master playlists (different
// tokens/paths) plus tiny probe responses, so the master→child collapse alone
// leaves 4–5 duplicate rows. Group by a stable per-video id and keep the single
// best row (a probed master with a quality picker wins). Recomputed each render.
let collapsedUrls = new Set();

function videoGroupKey(item) {
  try {
    const u = new URL(item.url);
    // Every playlist + mp4 for one tweet video shares this path prefix.
    if (/(^|\.)twimg\.com$/i.test(u.hostname)) {
      const m = u.pathname.match(/\/(amplify_video|ext_tw_video|tweet_video)\/(\d+)\//);
      if (m) return `twimg:${m[2]}`;
    }
  } catch {}
  return null; // only group hosts we can identify confidently — never over-collapse
}

// A row worth keeping as a group's representative (excludes probes/segments so a
// real playlist always wins the group and it never collapses to nothing).
function collapsibleCandidate(it) {
  if (!it) return false;
  if (looksLikeStreamSegment(it)) return false;
  if (it.kind === 'direct' && it.source === 'network' && it.bytes != null && it.bytes < MIN_DIRECT_BYTES) return false;
  return true;
}

// Higher = keep. Prefer a probed master with a real quality picker, then any
// playlist over a progressive mp4, then a master-looking URL (no WxH in path),
// then the larger file.
function keepScore(item) {
  let s = 0;
  if (item.variants && item.variants.length > 1) s += 1000;
  if (item.kind === 'hls' || item.kind === 'dash') s += 100;
  try {
    const p = new URL(item.url).pathname;
    if (!/\/\d{2,4}x\d{2,4}\//.test(p)) s += 40;
    // An audio-only rendition playlist (twimg /mp4a/) must never become the
    // group's visible row — it has no WxH in its path, so without this it can
    // outscore the real video variants when the master was never captured.
    if (/\/mp4a\//.test(p)) s -= 500;
  } catch {}
  s += Math.min(30, Math.round((item.estimatedBytes || item.bytes || 0) / 1e6));
  return s;
}

// Master-less pairing: when a bare video-variant row has no probe-derived audio
// info (its master playlist was never captured), the matching /mp4a/ audio
// rendition usually WAS captured — it sits collapsed in the same per-video
// group. Dig it out so the download can still be muxed with sound.
function findGroupAudioUrl(item) {
  const key = videoGroupKey(item);
  if (!key) return null;
  for (const it of allItems) {
    if (!it || it.url === item.url) continue;
    if (videoGroupKey(it) !== key) continue;
    try { if (/\/mp4a\//.test(new URL(it.url).pathname)) return it.url; } catch {}
  }
  return null;
}

// What we can honestly say about a row's sound BEFORE downloading. Only
// split-track hosts (the twimg group) can produce silent files, so only those
// rows get a verdict; everywhere else audio travels inside the stream and we
// say nothing rather than guess.
function audioStatusFor(item) {
  if (item?.kind !== 'hls' || !videoGroupKey(item)) return null;
  if (item.audioByGroup && Object.keys(item.audioByGroup).length) return 'yes';
  if (findGroupAudioUrl(item)) return 'yes';
  return 'no';
}

function computeCollapsedUrls(items) {
  const groups = new Map();
  for (const it of items) {
    if (!collapsibleCandidate(it)) continue;
    const key = videoGroupKey(it);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const hide = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let winner = group[0];
    for (const it of group) if (keepScore(it) > keepScore(winner)) winner = it;
    for (const it of group) if (it.url !== winner.url) hide.add(it.url);
  }
  return hide;
}

function isFilteredOut(item) {
  if (!item) return true;
  // A duplicate URL for a video we're already showing (see computeCollapsedUrls).
  if (collapsedUrls.has(item.url)) return true;
  // A twimg /mp4a/ playlist is the AUDIO rendition of some video, never a video
  // itself — hide it unconditionally (group collapse only catches it when its
  // video siblings were captured too; alone it surfaced as a clickable row and
  // downloaded a bare audio file). The mux pipeline fetches it internally.
  if (item.kind === 'hls' && videoGroupKey(item)) {
    try { if (/\/mp4a\//.test(new URL(item.url).pathname)) return true; } catch {}
  }
  // An HLS playlist that is a child (variant/audio) of a master we're already
  // showing — collapse it into the master row.
  if (item.kind === 'hls' && hlsChildKeys.has(playlistKey(item.url))) return true;
  if (item.kind !== 'direct') return false;
  // A known-tiny direct file is never a real video, whichever source reported
  // it — the ~16 KB preview mp4 scraped by site adapters, probe responses, the
  // 786 B audio-init case — even when context stamped a poster/duration on it.
  if (item.bytes != null && item.bytes < MIN_DIRECT_BYTES) return true;
  if (item.source !== 'network') return false;
  // .m4s / .ts are HLS/DASH sub-segments, never standalone videos.
  if (looksLikeStreamSegment(item)) return true;
  if (hasMetadata(item)) return false;
  return false;
}

const VIDEO_EXT_RE = /\.(mp4|m4s|m4v|m4a|mov|webm|ts|mkv|avi)(?:$|\?)/i;

function formatFromKind(item) {
  if (!item) return 'MP4';
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'MPD';
  try {
    const m = new URL(item.url).pathname.match(VIDEO_EXT_RE);
    if (m) return m[1].toUpperCase();
  } catch {}
  return 'MP4';
}

function sanitizeFilename(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60);
}

function extensionForItem(item) {
  if (!item) return '.mp4';
  if (item.kind === 'hls' || item.kind === 'dash' || item.kind === 'mux') return '';
  try {
    const m = new URL(item.url).pathname.match(VIDEO_EXT_RE);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return '.mp4';
}

function chooseTitle(item) {
  if (!item) return 'Unknown';
  if (item.userLabel) return item.userLabel;
  if (item.contextLabel && !isGenericLabel(item.contextLabel)) return item.contextLabel;
  if (item.description) return item.description;
  // For network-detected streams (HLS/DASH from course/video sites) the page
  // title is usually the real video name — far better than "Video on host".
  if (item.pageTitle && (item.source !== 'network' || item.kind === 'hls' || item.kind === 'dash')) {
    return item.pageTitle;
  }
  if (looksLikeGibberish(item.label)) {
    const host = shortHost(item.url);
    return host ? `Video on ${host}` : `${(item.kind || 'video').toUpperCase()} stream`;
  }
  return item.label || 'Video';
}

function chooseFilename(item) {
  if (!item) return `vidload-${Date.now()}.mp4`;
  if (item.userLabel) return ensureExtension(sanitizeFilename(item.userLabel), item);
  let base;
  if (item.contextLabel && !isGenericLabel(item.contextLabel)) base = item.contextLabel;
  else if (item.description) base = item.description.slice(0, 40);
  else if (item.pageTitle && (item.source !== 'network' || item.kind === 'hls' || item.kind === 'dash')) base = item.pageTitle;
  else {
    const host = shortHost(item.url).split('.')[0];
    base = `${host || 'video'}-${Date.now().toString(36).slice(-5)}`;
  }
  return ensureExtension(sanitizeFilename(base), item);
}

function ensureExtension(base, item) {
  const ext = extensionForItem(item);
  if (!ext) return base;
  return new RegExp(`${ext.replace('.', '\\.')}$`, 'i').test(base) ? base : `${base}${ext}`;
}

function makeTitleEditable(titleEl, item) {
  if (!titleEl) return;
  const original = (titleEl.textContent || '').trim();
  titleEl.contentEditable = 'true';
  titleEl.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {}

  const finish = (commit) => {
    titleEl.contentEditable = 'false';
    titleEl.removeEventListener('blur', onBlur);
    titleEl.removeEventListener('keydown', onKey);
    // Only persist a genuine change. Blur fires on click-away / popup close too,
    // so committing an unchanged value would overwrite the label with whatever
    // partial text happened to be there.
    const next = (titleEl.textContent || '').trim();
    if (commit && next && next !== original) {
      item.userLabel = next;
      item.label = next;
      rememberLabel(item.url, next);
    }
    titleEl.textContent = chooseTitle(item);
  };

  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  };

  titleEl.addEventListener('blur', onBlur);
  titleEl.addEventListener('keydown', onKey);
}

async function copyUrl(item, btn) {
  try {
    await navigator.clipboard.writeText(item.url);
    btn?.classList.add('copied');
    setTimeout(() => btn?.classList.remove('copied'), 1200);
  } catch (e) {
    console.error('VidLoad: clipboard write failed', e);
  }
}

function showRowMenu(item, anchorBtn, rowEl) {
  if (!menuEl || !anchorBtn) return;
  menuTarget = { item, rowEl, anchorBtn };
  // Make menu visible first (so we can measure its size) but offscreen.
  menuEl.style.visibility = 'hidden';
  menuEl.hidden = false;
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = menuEl.offsetWidth || 200;
  const menuH = menuEl.offsetHeight || 180;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 4) top = Math.max(4, rect.top - menuH - 4);
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${left}px`;
  menuEl.style.visibility = '';
  anchorBtn.setAttribute('aria-expanded', 'true');
  // Move focus into the menu so keyboard/AT users can act on it.
  menuEl.querySelector('.menu-item')?.focus();
}

function hideRowMenu({ restoreFocus = false } = {}) {
  if (!menuEl) return;
  const anchor = menuTarget?.anchorBtn;
  menuEl.hidden = true;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor.focus(); // return focus to the kebab on keyboard close
  }
  menuTarget = null;
}

// Roving-focus keyboard navigation for the shared row menu.
menuEl?.addEventListener('keydown', (e) => {
  if (menuEl.hidden) return;
  const items = [...menuEl.querySelectorAll('.menu-item')];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideRowMenu({ restoreFocus: true }); }
  else if (e.key === 'Tab') { hideRowMenu({ restoreFocus: true }); }
  // Enter/Space activate the focused .menu-item via its native button click.
});

menuEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !menuTarget) return;
  const action = btn.dataset.action;
  const { item, rowEl } = menuTarget;
  hideRowMenu();
  try {
    if (action === 'copy-url') {
      const moreBtn = rowEl?.querySelector('.more');
      copyUrl(item, moreBtn);
    } else if (action === 'open-tab') {
      chrome.tabs.create({ url: item.url });
    } else if (action === 'save-as') {
      const dlBtn = rowEl?.querySelector('.dl');
      if (dlBtn) startDownload(item, dlBtn, { saveAs: true });
    } else if (action === 'dismiss') {
      rememberDismissed(item.url);
      render();
    }
  } catch (err) {
    showError(`Menu action "${action}" failed: ${err?.message || err}`);
  }
});

// Outside-click and Escape dismiss the menu. Re-clicking another kebab
// doesn't trigger this branch — the kebab's own handler reopens it on the
// new row.
document.addEventListener('click', (e) => {
  if (!menuEl || menuEl.hidden) return;
  if (menuEl.contains(e.target)) return;
  if (e.target.closest('.more')) return;
  hideRowMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideRowMenu();
});
// Scrolling the list moves the kebab but the fixed menu stays put — easier
// to dismiss than to track.
listEl?.addEventListener('scroll', () => hideRowMenu(), { passive: true });

// Probe HLS/DASH manifests for duration + bandwidth + resolution. We don't get
// any of these from webRequest headers — the playlist content is the only
// source. Results enrich the item: duration -> overlay, bandwidth*duration/8 ->
// estimated size pill, resolution -> quality badge.
async function probeStreamMetadata(item) {
  try {
    const res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) return null;
    const text = await res.text();
    if (item.kind === 'hls') return await parseHlsMetadata(text, item.url);
    if (item.kind === 'dash') return parseDashMetadata(text);
  } catch (err) {
    console.debug('VidLoad: metadata probe failed for', item?.url, err?.message || err);
  }
  return null;
}

async function parseHlsMetadata(text, baseUrl) {
  let bandwidth = null;
  let width = null;
  let height = null;
  let variants = [];
  const childUrls = []; // media/audio playlists referenced by a master
  // Split-track HLS (X/Twitter fmp4): audio lives in #EXT-X-MEDIA renditions,
  // keyed by GROUP-ID; each variant names its group via AUDIO="...". A variant
  // downloaded without its rendition is SILENT, so capture the mapping here —
  // the download path sends a bare variant URL that carries no audio info.
  const audioByGroup = {}; // GROUP-ID -> absolute rendition playlist URL
  let audioDefault = null; // first/DEFAULT rendition, as a fallback

  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Audio/subtitle renditions referenced by the master are children too.
      if (lines[i].startsWith('#EXT-X-MEDIA')) {
        const m = lines[i].match(/URI="([^"]+)"/);
        if (m) {
          try {
            const abs = new URL(m[1], baseUrl).href;
            childUrls.push(abs);
            if (/TYPE=AUDIO/i.test(lines[i])) {
              const g = lines[i].match(/GROUP-ID="([^"]+)"/);
              if (g) audioByGroup[g[1]] = abs;
              if (!audioDefault || /DEFAULT=YES/i.test(lines[i])) audioDefault = abs;
            }
          } catch {}
        }
        continue;
      }
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
      const audioMatch = lines[i].match(/AUDIO="([^"]+)"/);
      const bwVal = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith('#')) j++;
      const next = lines[j]?.trim();
      if (!next) continue;
      let url;
      try { url = new URL(next, baseUrl).href; } catch { continue; }
      variants.push({
        url,
        bandwidth: bwVal || null,
        width: resMatch ? parseInt(resMatch[1], 10) : null,
        height: resMatch ? parseInt(resMatch[2], 10) : null,
        audioGroup: audioMatch ? audioMatch[1] : null,
      });
      childUrls.push(url);
    }
    if (variants.length === 0) return null;
    // Sort highest-quality first so [0] is the default pick.
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = variants[0];
    bandwidth = best.bandwidth;
    width = best.width;
    height = best.height;
    const res = await fetch(best.url, { credentials: 'include' });
    if (!res.ok) return { duration: null, bandwidth, width, height, variants, childUrls, audioByGroup, audioDefault, isMaster: true };
    text = await res.text();
  }

  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) total += parseFloat(m[1]);
  }
  const duration = total > 0 ? Math.round(total) : null;
  return { duration, bandwidth, width, height, variants, childUrls, audioByGroup, audioDefault, isMaster: variants.length > 0 };
}

function parseDashMetadata(mpdText) {
  let duration = null;
  const dm = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
  if (dm) {
    const d = dm[1].match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
    if (d) {
      const seconds =
        parseFloat(d[1] || 0) * 86400 +
        parseFloat(d[2] || 0) * 3600 +
        parseFloat(d[3] || 0) * 60 +
        parseFloat(d[4] || 0);
      if (seconds > 0) duration = Math.round(seconds);
    }
  }

  let bandwidth = 0;
  let width = null;
  let height = null;
  const reps = mpdText.match(/<Representation[^>]*>/gi) || [];
  for (const rep of reps) {
    const bw = parseInt(rep.match(/bandwidth="(\d+)"/i)?.[1] || '0', 10);
    if (bw <= bandwidth) continue;
    bandwidth = bw;
    const w = parseInt(rep.match(/width="(\d+)"/i)?.[1] || '0', 10);
    const h = parseInt(rep.match(/height="(\d+)"/i)?.[1] || '0', 10);
    width = w || null;
    height = h || null;
  }
  return { duration, bandwidth: bandwidth || null, width, height };
}

function variantLabel(v) {
  if (v?.label) return v.label;
  if (v?.height) return qualityLabel(v.width, v.height) || `${v.height}p`;
  if (v?.bandwidth) return `${Math.round(v.bandwidth / 1000)}kbps`;
  return 'auto';
}

function populateVariantPicker(item, pickerEl) {
  if (!pickerEl || !item?.variants || item.variants.length < 2) return;
  pickerEl.replaceChildren();
  item.variants.forEach((v, idx) => {
    const opt = document.createElement('option');
    opt.value = v.url;
    opt.textContent = variantLabel(v);
    if (idx === 0) opt.selected = true;
    pickerEl.appendChild(opt);
  });
  item.selectedVariantUrl = item.variants[0].url;
  pickerEl.hidden = false;
}

function maybeProbeMetadata(item, refs) {
  if (!item || item._probed) return;
  if (item.kind !== 'hls' && item.kind !== 'dash') return;
  item._probed = true;
  probeStreamMetadata(item)
    .then((meta) => {
      if (!meta) return;
      if (meta.duration && !item.duration) {
        item.duration = meta.duration;
        if (refs.durEl?.isConnected) refs.durEl.textContent = formatDuration(meta.duration);
      }
      if (meta.width && meta.height && !item.width) {
        item.width = meta.width;
        item.height = meta.height;
        const q = qualityLabel(meta.width, meta.height);
        if (q && refs.qualityEl?.isConnected) refs.qualityEl.textContent = q;
      }
      if (meta.bandwidth && (meta.duration || item.duration)) {
        const dur = meta.duration || item.duration;
        item.estimatedBytes = Math.round((meta.bandwidth * dur) / 8);
        if (refs.sizePill?.isConnected) {
          refs.sizePill.textContent = '~' + formatBytes(item.estimatedBytes);
        }
      }
      if (meta.variants && meta.variants.length) {
        item.variants = meta.variants;
        if (refs.pickerEl?.isConnected) populateVariantPicker(item, refs.pickerEl);
      }
      // Remember the master's audio renditions so the download can pass the
      // matching audio playlist along with a bare variant URL (split-track HLS).
      if (meta.audioByGroup && Object.keys(meta.audioByGroup).length) {
        item.audioByGroup = meta.audioByGroup;
        item.audioDefault = meta.audioDefault || null;
      }
      // Record this master's child playlists and collapse them out of the list.
      if (meta.childUrls && meta.childUrls.length) {
        let added = false;
        for (const child of meta.childUrls) {
          const key = playlistKey(child);
          if (!hlsChildKeys.has(key)) { hlsChildKeys.add(key); added = true; }
        }
        if (added) scheduleRerender();
      }
    })
    .catch((err) => console.debug('VidLoad: probe rejected', err?.message || err));
}

// =============================================================================
// Free-quota banner (top of popup). Shows how many free downloads remain and
// nudges toward the one-time upgrade; becomes a tap-to-upgrade prompt at zero.
// =============================================================================
function remainingFree(status) {
  if (status?.remaining != null) return status.remaining;
  return Math.max(0, (status?.limit || 0) - (status?.used || 0));
}

function renderQuotaBanner(status) {
  if (!trialBannerEl) return;
  const textEl = trialBannerEl.querySelector('.trial-banner-text');

  // Nothing to show when monetization is off or the user has already paid.
  if (!status?.monetizationEnabled || status.paid) {
    trialBannerEl.hidden = true;
    return;
  }

  const remaining = remainingFree(status);
  const price = (status.priceLabel || '$4.99').replace(/\s+one-time.*$/i, '');
  trialBannerEl.hidden = false;
  if (remaining <= 0) {
    trialBannerEl.className = 'ended';
    if (textEl) textEl.textContent = `🔒 Free downloads used up — tap to unlock unlimited for ${price}`;
  } else if (remaining <= 3) {
    trialBannerEl.className = 'ended';
    if (textEl) textEl.textContent = `⏳ Only ${remaining} free download${remaining === 1 ? '' : 's'} left — unlock unlimited for ${price}`;
  } else {
    trialBannerEl.className = 'trial';
    if (textEl) textEl.textContent = `✨ ${remaining} free downloads left · ${price} unlocks unlimited forever`;
  }
}

trialBannerEl?.addEventListener('click', () => {
  if (!tierStatus?.paid) showPaywall(tierStatus); // any state → open the upgrade sheet
});

function renderTier(status) {
  if (!tierBadgeEl) return;
  tierStatus = status || tierStatus;
  // Upgrade link: visible whenever monetization is on and the user hasn't paid,
  // with a concrete benefit line so the CTA isn't a bare word.
  if (upgradeLinkEl) {
    upgradeLinkEl.hidden = !(status?.monetizationEnabled && !status.paid);
    upgradeLinkEl.title = 'No limits · one-time $4.99 · no subscription';
  }
  if (!status?.monetizationEnabled) {
    tierBadgeEl.hidden = true;
    return;
  }
  tierBadgeEl.hidden = false;
  if (status.paid) {
    tierBadgeEl.textContent = 'Pro';
    tierBadgeEl.className = 'pro';
    tierBadgeEl.title = 'Unlimited downloads';
  } else {
    const remaining = remainingFree(status);
    tierBadgeEl.textContent = `Free · ${status.used}/${status.limit}`;
    tierBadgeEl.className = 'free';
    tierBadgeEl.title = `${remaining} of ${status.limit} free downloads left. Unlock unlimited for $4.99 (one-time).`;
  }
}

function showPaywall(detail) {
  if (!paywallEl) return;
  paywallEl.hidden = false;
  if (listEl) listEl.hidden = true;
  if (footerEl) footerEl.hidden = true;
  if (detail && paywallDetailEl) {
    const limit = detail.limit != null ? detail.limit : (tierStatus?.limit ?? 0);
    const used = detail.used != null ? detail.used : (tierStatus?.used ?? 0);
    const remaining = Math.max(0, limit - used);
    paywallDetailEl.textContent = remaining > 0
      ? `You have ${remaining} free download${remaining === 1 ? '' : 's'} left — unlock now so you never hit a limit.`
      : `You've used all ${limit} free downloads. Unlock unlimited to keep going.`;
  }
  if ((detail?.priceLabel || tierStatus?.priceLabel) && paywallPriceEl) {
    paywallPriceEl.textContent = (detail?.priceLabel || tierStatus?.priceLabel).replace(/\s+one-time.*$/i, '') || '$4.99';
  }
  if (paywallFootEl) {
    paywallFootEl.textContent = tierStatus?.monetizationEnabled
      ? 'One-time payment · unlimited forever · no subscription.'
      : 'Monetization is disabled in this build — this is a preview of the paywall UI.';
  }
}

function hidePaywall() {
  if (paywallEl) paywallEl.hidden = true;
  if (listEl) listEl.hidden = false;
  if (footerEl) footerEl.hidden = false;
}

async function openPaymentPage() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'open-payment-page' });
    if (!res?.ok) {
      const msg = res?.error || 'Could not open the checkout page. Please try again.';
      // Surface the failure visibly no matter which CTA was clicked — the paywall
      // footer is hidden when the header "Upgrade" link is the trigger.
      if (paywallFootEl && paywallEl && !paywallEl.hidden) paywallFootEl.textContent = msg;
      else showError(`Upgrade: ${msg}`);
      return;
    }
    window.close(); // checkout confirmed open in its own tab
  } catch (err) {
    showError(`Upgrade click failed: ${err?.message || err}`);
  }
}

upgradeBtn?.addEventListener('click', openPaymentPage);
upgradeLinkEl?.addEventListener('click', openPaymentPage);

paywallBackBtn?.addEventListener('click', () => hidePaywall());

// When set, the popup shows this reason instead of any downloadable items —
// used for pages this build must not serve. Set via window.vidloadDisableDownloads
// (below); kept generic so no site-specific names live in this file.
let downloadsDisabledReason = null;

function render() {
  if (!listEl || !statusEl) {
    showError('Cannot render — list or status element missing.');
    return;
  }
  rowsByUrl.clear(); // rebuilt as rows are created below
  if (downloadsDisabledReason) {
    listEl.replaceChildren();
    statusEl.textContent = downloadsDisabledReason;
    if (toggleEl) toggleEl.hidden = true;
    // Drop the monetization chrome too — no downloads here, so no quota/upgrade.
    if (trialBannerEl) trialBannerEl.hidden = true;
    if (tierBadgeEl) tierBadgeEl.hidden = true;
    if (upgradeLinkEl) upgradeLinkEl.hidden = true;
    return;
  }
  try {
    const filtered = allItems.filter((it) => it && !dismissed.has(it.url));
    collapsedUrls = computeCollapsedUrls(filtered); // group same-video duplicates
    const passing = filtered.filter((it) => !isFilteredOut(it));
    // Fold stale items (loaded ≥2 min before the newest capture) behind the
    // toggle; the video the user wants is almost always the freshest. The
    // newest item itself is never folded, so single-video pages are unaffected.
    const maxTs = passing.reduce((m, it) => Math.max(m, it.ts || 0), 0);
    const fresh = passing.filter((it) => !it.ts || maxTs - it.ts <= STALE_WINDOW_MS);
    // Newest first — the row for the video being watched sits on top.
    const visible = (showHidden ? filtered.slice() : fresh).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const hiddenCount = filtered.length - visible.length;

    listEl.replaceChildren();
    if (allItems.length === 0) {
      statusEl.textContent = 'No videos detected on this page yet. Try scrolling or hitting play.';
      if (toggleEl) toggleEl.hidden = true;
      return;
    }
    if (filtered.length === 0) {
      statusEl.textContent = 'All items dismissed.';
      if (toggleEl) toggleEl.hidden = true;
      return;
    }
    if (visible.length === 0) {
      statusEl.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'} detected — all filtered as probes/segments.`;
    } else if (hiddenCount > 0) {
      statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} · ${hiddenCount} hidden.`;
    } else {
      statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} detected.`;
    }

    if (toggleEl) {
      toggleEl.hidden = hiddenCount === 0 && !showHidden;
      toggleEl.textContent = showHidden
        ? 'Hide extra items'
        : `Show ${hiddenCount} hidden item${hiddenCount === 1 ? '' : 's'} (earlier / small)`;
    }

    visible.forEach((item) => {
      try { renderRow(item); } catch (err) {
        console.error('VidLoad: row render failed for', item, err);
        showError(`Row render failed: ${err?.message || err}\n${err?.stack || ''}`);
      }
    });
  } catch (err) {
    showError(`Render failed: ${err?.message || err}\n${err?.stack || ''}`);
  }
}

// Generic hook: a sibling popup script (e.g. the build-aware notice) can disable
// the download list on a page this build can't serve, passing a reason to show.
window.vidloadDisableDownloads = (reason) => {
  downloadsDisabledReason = reason || 'Downloads are not available on this page.';
  try { render(); } catch (_) { /* render guards its own errors */ }
};

function renderRow(item) {
  if (!tpl || !listEl) return;
  const node = tpl.content.firstElementChild?.cloneNode(true);
  if (!node) return;

  const titleEl = node.querySelector('.title');
  if (titleEl) titleEl.textContent = chooseTitle(item);

  const formatBadge = node.querySelector('.format-badge');
  if (formatBadge) {
    formatBadge.textContent = formatFromKind(item);
    if (item.kind) formatBadge.classList.add(item.kind);
  }

  // Audio verdict (split-track hosts only): tells the user BEFORE downloading
  // whether this row will have sound. A master row flips to ♪ as soon as its
  // probe resolves the audio renditions (the probe triggers a re-render).
  const audioStatus = audioStatusFor(item);
  if (formatBadge && audioStatus) {
    const audioPill = document.createElement('span');
    audioPill.className = `audio-pill ${audioStatus}`;
    audioPill.textContent = audioStatus === 'yes' ? '♪ audio' : 'no audio';
    audioPill.title = audioStatus === 'yes'
      ? 'Audio track found — the download will include sound.'
      : 'No audio source detected for this item — the download would be silent.';
    formatBadge.after(audioPill);
  }

  // Split-source (mux) items carry their qualities in videoVariants — reuse the
  // variant picker for them.
  if (item.kind === 'mux' && item.videoVariants && !item.variants) {
    item.variants = item.videoVariants;
  }

  const variantPicker = node.querySelector('.variant-picker');
  if (variantPicker) {
    if (item.variants && item.variants.length > 1) {
      populateVariantPicker(item, variantPicker);
    }
    variantPicker.addEventListener('change', () => {
      item.selectedVariantUrl = variantPicker.value || null;
    });
    variantPicker.addEventListener('click', (e) => e.stopPropagation());
  }

  const quality = node.querySelector('.thumb-quality');
  if (quality) quality.textContent = qualityLabel(item.width, item.height) || '';

  const durEl = node.querySelector('.thumb-duration');
  if (durEl) durEl.textContent = formatDuration(item.duration) || '';

  const kindEl = node.querySelector('.thumb-kind');
  if (kindEl) kindEl.textContent = item.kind || '';

  const sizePill = node.querySelector('.size-pill');
  let keepSizePill = false;
  if (sizePill) {
    const isStream = item.kind === 'hls' || item.kind === 'dash';
    if (item.estimatedBytes) {
      sizePill.textContent = '~' + formatBytes(item.estimatedBytes);
      keepSizePill = true;
    } else if (isStream) {
      // Manifest-size bytes are misleading; leave the pill empty and let
      // maybeProbeMetadata fill it with the bandwidth*duration estimate.
      sizePill.textContent = '';
      keepSizePill = true;
    } else {
      const sizeStr = formatBytes(item.bytes);
      if (sizeStr) {
        sizePill.textContent = sizeStr;
        keepSizePill = true;
      }
    }
    if (!keepSizePill) sizePill.remove();
  }

  // Kick off the manifest probe — fills in duration overlay, resolution
  // badge, estimated size pill, and variant picker as they resolve.
  maybeProbeMetadata(item, {
    durEl,
    qualityEl: quality,
    sizePill: keepSizePill ? sizePill : null,
    pickerEl: variantPicker,
  });

  const sourcePill = node.querySelector('.source-pill');
  if (sourcePill) {
    const sourceText = item.source && item.source !== 'dom' && item.source !== 'network'
      ? item.source
      : shortHost(item.url);
    if (sourceText) {
      sourcePill.textContent = sourceText;
      sourcePill.title = hostFromUrl(item.url);
    } else {
      sourcePill.remove();
    }
  }

  const thumbImg = node.querySelector('.thumb-img');
  if (thumbImg) {
    // A context-stamped poster is a guess (whatever video sat at viewport
    // center when this stream was captured). On grouped multi-video hosts
    // (twimg) that guess is wrong often enough to mislead — show the neutral
    // play placeholder there instead. Real posters (adapter/DOM) still show.
    const posterTrusted = item.poster && !(item.posterCtx && videoGroupKey(item));
    if (posterTrusted) {
      thumbImg.src = item.poster;
      thumbImg.addEventListener('error', () => thumbImg.classList.add('broken'), { once: true });
    } else {
      thumbImg.classList.add('broken');
    }
  }

  node.querySelector('.edit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (titleEl) makeTitleEditable(titleEl, item);
  });

  node.querySelector('.dismiss')?.addEventListener('click', () => {
    rememberDismissed(item.url);
    render();
  });

  const moreBtn = node.querySelector('.more');
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showRowMenu(item, moreBtn, node);
  });

  const dlBtn = node.querySelector('.dl');
  dlBtn?.addEventListener('click', () => startDownload(item, dlBtn));

  // Register this row's download-progress refs so live + restored job state
  // can drive its progress bar.
  const progressEl = node.querySelector('.progress');
  rowsByUrl.set(item.url, {
    dlBtn,
    progressEl,
    fillEl: progressEl?.querySelector('.progress-fill'),
    textEl: progressEl?.querySelector('.progress-text'),
  });
  const known = jobByUrl.get(item.url);
  if (known) applyJob(item.url, known);

  listEl.appendChild(node);
}

toggleEl?.addEventListener('click', () => {
  showHidden = !showHidden;
  render();
});

async function refreshTier() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (status) { renderTier(status); renderQuotaBanner(status); }
    return status;
  } catch (err) {
    console.debug('VidLoad: get-status failed', err?.message || err);
    return null;
  }
}

async function startDownload(item, btn, opts = {}) {
  const saveAs = !!opts.saveAs;
  setDownloadButton(btn, 'Saving…', { disabled: true });
  const filename = chooseFilename(item);
  try {
    if (item.kind === 'mux') {
      // Split video + audio sources (captured adaptive streams). Send the chosen
      // video quality + its matching audio to be downloaded whole and muxed.
      const variants = item.videoVariants || [];
      const chosenUrl = item.selectedVariantUrl || variants[0]?.url;
      const chosen = variants.find((v) => v.url === chosenUrl) || variants[0];
      if (!chosen) {
        setDownloadButton(btn, 'Retry');
        if (btn) btn.title = 'No downloadable video stream captured yet — play the video first.';
        return;
      }
      const audioUrl = chosen.hasAudio ? null : (item.audioUrl || null);
      const res = await chrome.runtime.sendMessage({
        type: 'download-av',
        videoUrl: chosen.url,
        audioUrl,
        itemUrl: item.url,
        filename,
        saveAs,
      });
      if (res?.error === 'paywall') { setDownloadButton(btn, 'Download'); showPaywall(res); return; }
      if (!res?.ok) {
        setDownloadButton(btn, 'Retry');
        if (btn) btn.title = `Download failed: ${res?.error || 'unknown error'}`;
        return;
      }
      activeJobs.set(res.jobId, item.url);
      applyJob(item.url, { status: 'active', phase: 'manifest', current: 0, total: 100 });
      refreshTier();
      return;
    }
    if (item.kind === 'hls' || item.kind === 'dash') {
      // HLS variant picker: if the user chose a specific quality, pass that
      // variant's URL directly. offscreen.js will see a media playlist (no
      // STREAM-INF lines) and skip the master-pick branch.
      const streamUrl = (item.kind === 'hls' && item.selectedVariantUrl) || item.url;
      // Split-track HLS: a bare variant URL carries no audio info, so resolve
      // the matching audio rendition (by the variant's AUDIO group, else the
      // master's default) here. When we send the master itself, offscreen
      // derives the audio from it directly and this stays null.
      let audioUrl = null;
      if (item.kind === 'hls' && streamUrl !== item.url && item.audioByGroup) {
        const chosen = (item.variants || []).find((v) => v.url === streamUrl);
        audioUrl = (chosen?.audioGroup && item.audioByGroup[chosen.audioGroup]) || item.audioDefault || null;
      }
      // Master-less bare variant: pair with the /mp4a/ rendition captured in
      // the same per-video group (safe as a hint — when the sent URL turns out
      // to be a master, offscreen's own derivation takes precedence).
      if (item.kind === 'hls' && !audioUrl && !item.audioByGroup) {
        audioUrl = findGroupAudioUrl(item);
      }
      const res = await chrome.runtime.sendMessage({
        type: 'download-stream',
        format: item.kind,
        url: streamUrl,
        audioUrl,
        itemUrl: item.url, // canonical row key (variant URL may differ)
        filename,
        saveAs,
      });
      if (res?.error === 'paywall') {
        setDownloadButton(btn, 'Download');
        showPaywall(res);
        return;
      }
      if (!res?.ok) {
        setDownloadButton(btn, 'Retry');
        if (btn) btn.title = `Download failed: ${res?.error || 'unknown error'}`;
        console.error('VidLoad stream start failed:', res?.error);
        return;
      }
      activeJobs.set(res.jobId, item.url);
      applyJob(item.url, { status: 'active', phase: 'manifest', current: 0, total: 1 });
      refreshTier();
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      url: item.url,
      filename,
      saveAs,
    });
    if (res?.error === 'paywall') {
      setDownloadButton(btn, 'Download');
      showPaywall(res);
      return;
    }
    if (res?.ok) {
      setDownloadButton(btn, 'Saved', { disabled: true });
      if (btn) btn.title = '';
      refreshTier();
    } else {
      setDownloadButton(btn, 'Retry');
      if (btn) btn.title = `Download failed: ${res?.error || 'unknown error'}`;
      console.error('VidLoad download failed:', res?.error);
    }
  } catch (err) {
    setDownloadButton(btn, 'Retry');
    if (btn) btn.title = `Download failed: ${err?.message || err}`;
    showError(`Download click failed: ${err?.message || err}`);
  }
}

// Live unlock: when the SW confirms payment (onPaid), drop the paywall and
// refresh the tier immediately instead of waiting for the next popup open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'paid-status-changed' && msg.paid) {
    hidePaywall();
    refreshTier();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.jobId) return;
  const url = activeJobs.get(msg.jobId);
  if (!url) return; // not a job this popup is tracking
  if (msg.type === 'stream-progress') {
    applyJob(url, { status: 'active', phase: msg.phase, current: msg.current, total: msg.total });
  } else if (msg.type === 'stream-done') {
    applyJob(url, { status: 'done', filename: msg.filename, warning: msg.warning || null });
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'stream-error') {
    applyJob(url, { status: 'error', error: msg.error });
    console.error('VidLoad stream error:', msg.error);
    activeJobs.delete(msg.jobId);
  }
});

async function restoreJobs() {
  // Re-attach to downloads that are still running (or just finished) in the
  // background so reopening the popup shows live progress, not a fresh button.
  try {
    const res = await chrome.runtime.sendMessage({ type: 'get-jobs' });
    const jobs = res?.jobs || {};
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!job?.url) continue;
      jobByUrl.set(job.url, job);
      if (job.status === 'active') activeJobs.set(jobId, job.url);
    }
  } catch (err) {
    console.debug('VidLoad: get-jobs failed', err?.message || err);
  }
}

(async () => {
  try {
    await loadUserdata();
    await refreshTier();
    await restoreJobs();
    const tabId = await getActiveTabId();
    if (tabId === undefined) {
      if (statusEl) statusEl.textContent = 'No active tab.';
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'list', tabId });
    allItems = res?.items || [];
    applyUserdata(allItems);
    render();
  } catch (err) {
    showError(`Startup failed: ${err?.message || err}\n${err?.stack || ''}`);
  }
})();
