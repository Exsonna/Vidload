// VidLoad background service worker (MV3)
// - Receives <video> sightings from content scripts and site adapters
// - Observes network responses with video/HLS/DASH Content-Type or URL pattern
// - Captures Content-Length and Content-Range (total file size)
// - Dedupes byte-range chunks of the same media into one canonical item
// - Stores per-tab detected media in chrome.storage.session
// - Routes direct downloads to chrome.downloads, segmented downloads to offscreen
// - Gates downloads via ExtensionPay (free tier + $4.99 lifetime unlock)

importScripts('/lib/extpay.js');
importScripts('/lib/media-url.js'); // provides self.VidLoadUrl (shared with popup)

// =============================================================================
// Referer rewrite rules — learned per-site, not hardcoded
// =============================================================================
// Many video CDNs (twimg.com, *.fbcdn.net, *.cdninstagram.com, Hotmart,
// Wistia, Kajabi, Vimeo, and most course platforms) reject media requests
// when the Referer is the extension's chrome-extension:// origin — even
// though we hold host permissions. We rewrite the Referer to look like a
// normal in-page fetch.
//
// Instead of a hardcoded list, we LEARN the right Referer from webRequest:
// when we observe a media stream, details.initiator tells us which page
// origin requested it (e.g. https://cf-embed.play.hotmart.com). We register
// a rule mapping that media's registrable domain → that origin as Referer.
// This makes downloads + metadata probes work on arbitrary sites, not just
// the three we happened to hardcode.
//
// tabIds: [-1] scopes every rule to requests that don't originate from a
// browser tab — i.e. our SW, offscreen document, and popup. The user's
// normal tab-initiated browsing is unaffected because real tab requests have
// their own tabId and never match. NOTE: the extension's OWN credentialed
// fetches (metadata probe, offscreen download, direct pre-flight) DO match
// these rules and will carry the learned Referer with the Origin stripped —
// that is the whole point, but it means a learned Referer is attached to our
// fetches, not just to nothing. We only learn a Referer for a domain once
// (first-writer-wins, below) so a later unrelated page can't repoint it.
//
// Session rules (not dynamic) because Chrome only honors the tabIds key on
// session rules. They're cleared on browser restart; the learned map lives
// in chrome.storage.session (also session-lifetime) and we re-register from
// it on startup.

const REFERER_MAP_KEY = 'vidload_referer_map';
const REFERER_RULE_BASE_ID = 1100;
const REFERER_RULE_MAX_ID = 1899;

// Seed mappings for the big social CDNs, so they work on the very first
// request before we've necessarily seen an initiator for them.
const SEED_REFERERS = {
  'twimg.com': 'https://x.com/',
  'fbcdn.net': 'https://www.instagram.com/',
  'cdninstagram.com': 'https://www.instagram.com/',
  'tiktokcdn.com': 'https://www.tiktok.com/',
  'tiktokcdn-us.com': 'https://www.tiktok.com/',
};

// Reduce a hostname to its registrable domain (shared with the popup).
const { registrableDomain } = self.VidLoadUrl;

// Cap the learned map to the number of rules we can actually register.
const REFERER_RULE_CAP = REFERER_RULE_MAX_ID - REFERER_RULE_BASE_ID + 1;

async function loadRefererMap() {
  try {
    const stored = await chrome.storage.session.get(REFERER_MAP_KEY);
    return stored[REFERER_MAP_KEY] || {};
  } catch {
    return {};
  }
}

function refererRuleFor(domain, referer, id) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: referer },
        // Also drop the chrome-extension:// Origin. Some CDNs (Loom's
        // luna.loom.com, etc.) 403 a media request whose Origin is an
        // extension — a normal media fetch has no/origin-matching Origin.
        // Host permissions still let us read the response without CORS.
        { header: 'Origin', operation: 'remove' },
      ],
    },
    condition: { requestDomains: [domain], tabIds: [-1] },
  };
}

// Rebuild the entire session-rule set from a domain→referer map. Deterministic
// id assignment (sorted order) so repeated rebuilds are stable.
async function applyRefererMap(map) {
  const domains = Object.keys(map).sort();
  const addRules = domains.slice(0, REFERER_RULE_MAX_ID - REFERER_RULE_BASE_ID + 1)
    .map((domain, i) => refererRuleFor(domain, map[domain], REFERER_RULE_BASE_ID + i));
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    // Clear our whole reserved range (1001–1899), including the legacy
    // static rule ids 1001–1003 from versions ≤ 0.4.13, so stale rules
    // from a prior build don't linger after an update.
    const ourIds = existing
      .filter((r) => r.id >= 1001 && r.id <= REFERER_RULE_MAX_ID)
      .map((r) => r.id);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ourIds,
      addRules,
    });
  } catch (err) {
    console.error('[VidLoad SW] Failed to apply Referer rules', err);
  }
}

// In-memory canonical map (source of truth within one SW lifetime). We rebuild
// it from storage.session on wake. Mutating this map synchronously and flushing
// through a single-flight promise chain keeps concurrent learnReferer() calls
// (webRequest fires many at once) from clobbering each other's writes.
let refererMap = null;
let refererMapPromise = null;
let refererFlush = Promise.resolve();

async function ensureRefererMap() {
  if (refererMap) return refererMap;
  // Memoize the load so concurrent callers (startup setup + an early webRequest)
  // share one map object instead of each loading and reassigning it.
  if (!refererMapPromise) {
    refererMapPromise = loadRefererMap().then((m) => { refererMap = m; return m; });
  }
  return refererMapPromise;
}

// Record that requests to `domain` should carry `referer`. First-writer-wins:
// once a domain is mapped we don't let a later (possibly unrelated / cross-site)
// initiator repoint it, and seeds stay authoritative. Fire-and-forget — the
// write is serialized onto refererFlush so it can't race a concurrent call.
function learnReferer(domain, referer) {
  if (!domain || !referer) return;
  refererFlush = refererFlush
    .then(async () => {
      const map = await ensureRefererMap();
      if (map[domain]) return; // already known — don't overwrite
      map[domain] = referer;
      // Bound the map to the rule cap; evict the oldest non-seed entry when full
      // so a long session can't silently drop later domains past the 800 rules.
      const keys = Object.keys(map);
      if (keys.length > REFERER_RULE_CAP) {
        const evictable = keys.find((k) => !(k in SEED_REFERERS));
        if (evictable) delete map[evictable];
      }
      await chrome.storage.session.set({ [REFERER_MAP_KEY]: map });
      await applyRefererMap(map);
    })
    .catch((err) => console.debug('[VidLoad SW] learnReferer failed', err?.message || err));
}

async function setupRefererRules() {
  const map = await ensureRefererMap();
  // Ensure seeds are present without clobbering anything we've learned.
  let changed = false;
  for (const [domain, referer] of Object.entries(SEED_REFERERS)) {
    if (!map[domain]) { map[domain] = referer; changed = true; }
  }
  if (changed) await chrome.storage.session.set({ [REFERER_MAP_KEY]: map });
  await applyRefererMap(map);
  console.log('[VidLoad SW] Referer rules registered for', Object.keys(map).length, 'domains');
}

setupRefererRules();
chrome.runtime.onInstalled.addListener(() => setupRefererRules());
chrome.runtime.onStartup.addListener(() => setupRefererRules());

// =============================================================================
// Monetization configuration — see wiki/topics/monetization.md
// =============================================================================
// Model: everyone gets `freeLifetimeLimit` free downloads to prove the tool
// works, then a one-time $4.99 unlock for unlimited. The free counter is a
// LIFETIME accumulator — NO daily reset, NO timed trial — so every retained
// user reaches the paywall exactly once, at their moment of demonstrated value.
// (Previously a 7-day unlimited trial + 3/day daily-reset tier meant the paywall
// almost never fired; see the monetization audit in wiki/topics/monetization.md.)
const MONETIZATION = {
  enabled: true,                     // LIVE — ExtPay configured (extpayId below)
  extpayId: 'vidload',               // matches the Extension ID at extensionpay.com
  freeLifetimeLimit: 10,             // total free downloads before the paywall
  priceLabel: '$4.99 one-time',      // shown in the paywall UI
};

const DOWNLOAD_COUNTER_KEY = 'vidload_downloads';
const PAID_CACHE_KEY = 'vidload_paid_cache'; // last-known paid=true, for offline fail-open

let extpay = null;
if (MONETIZATION.enabled && typeof ExtPay === 'function') {
  extpay = ExtPay(MONETIZATION.extpayId);
  extpay.startBackground();
  extpay.onPaid.addListener((user) => {
    console.log('[VidLoad] payment received', user);
    // Cache the paid flag so an offline/unreachable ExtPay never re-gates a
    // confirmed payer, and tell any open popup to unlock immediately.
    chrome.storage.local.set({ [PAID_CACHE_KEY]: true }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'paid-status-changed', paid: true }).catch(() => {});
  });
}

// Lifetime free-download count (persisted; never reset on a new day).
async function getDownloadCount() {
  const stored = await chrome.storage.local.get(DOWNLOAD_COUNTER_KEY);
  return stored[DOWNLOAD_COUNTER_KEY]?.count || 0;
}

// Free-tier quota is a shared resource across concurrent downloads. Serialize
// every read-check-write through one promise chain so two downloads clicked in
// the same tick can't both read the same count and both pass the limit.
let quotaChain = Promise.resolve();
function withQuota(fn) {
  const next = quotaChain.then(() => fn());
  quotaChain = next.catch(() => {}); // keep the chain alive past a rejection
  return next;
}

// In-flight metered downloads that have reserved a slot but not yet committed.
// Counted toward the limit so concurrent reservations can't oversubscribe, then
// converted to a committed count on success or released on failure. In-memory
// only — if the SW suspends mid-download the reservation is forgiven (fails
// toward the user), while committed counts persist in storage.
let pendingMetered = 0;

// Commit a reserved slot as a real download (increments the persistent count).
function commitMeteredDownload() {
  return withQuota(async () => {
    if (pendingMetered > 0) pendingMetered -= 1;
    const count = await getDownloadCount();
    await chrome.storage.local.set({ [DOWNLOAD_COUNTER_KEY]: { count: count + 1 } });
  });
}

// Release a reserved slot without counting it (download failed / cancelled).
function releaseMeteredReservation() {
  return withQuota(() => { if (pendingMetered > 0) pendingMetered -= 1; });
}

async function isPaid() {
  if (!MONETIZATION.enabled) return true;
  if (!extpay) return false;
  try {
    const user = await extpay.getUser();
    const paid = !!user.paid;
    // Remember a confirmed payer so a later ExtPay outage can't re-gate them.
    if (paid) chrome.storage.local.set({ [PAID_CACHE_KEY]: true }).catch(() => {});
    return paid;
  } catch (err) {
    console.error('[VidLoad] paid check failed', err);
    // Fail OPEN for a previously-confirmed payer (ExtPay unreachable / offline /
    // the sync window right after purchase) so they never see "I paid but it's
    // still locked". A never-paid user has no cache and stays gated (fail closed).
    const cached = await chrome.storage.local.get(PAID_CACHE_KEY);
    return !!cached[PAID_CACHE_KEY];
  }
}

// Decide whether a download is allowed. For the metered free tier this also
// RESERVES a quota slot atomically (under withQuota) so concurrent downloads
// can't both slip past the limit. A reserved slot must later be committed
// (commitMeteredDownload) on success or released (releaseMeteredReservation)
// on failure. Paid downloads are unmetered and reserve nothing.
async function gateDownload() {
  if (await isPaid()) return { allowed: true, paid: true, metered: false };
  return withQuota(async () => {
    const count = await getDownloadCount();
    const used = count + pendingMetered;
    if (used >= MONETIZATION.freeLifetimeLimit) {
      return {
        allowed: false,
        paid: false,
        limit: MONETIZATION.freeLifetimeLimit,
        used,
        priceLabel: MONETIZATION.priceLabel,
        metered: false,
      };
    }
    pendingMetered += 1; // reserve this slot until commit/release
    return {
      allowed: true,
      paid: false,
      limit: MONETIZATION.freeLifetimeLimit,
      used,
      metered: true,
    };
  });
}

// =============================================================================
// Media detection + storage
// =============================================================================

const STORAGE_KEY = (tabId) => `tab:${tabId}`;
const OFFSCREEN_URL = 'offscreen/offscreen.html';

const RANGE_NOISE_PARAMS = [
  'bytestart', 'byteend',
  'range',
  'rn', 'rbuf',
  'fs', 'fe',
];

// The URL we actually download from: drop byte-range noise params (removing
// them yields the full-file URL) but KEEP auth tokens/signatures — stripping
// those would break the fetch.
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const p of RANGE_NOISE_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

// Matching identity only (never used as a download URL). For HLS/DASH
// playlists we also drop the entire query string so the same playlist fetched
// with different short-lived tokens collapses into a single item.
function dedupKey(url) {
  try {
    const u = new URL(url);
    for (const p of RANGE_NOISE_PARAMS) u.searchParams.delete(p);
    if (/\.(m3u8|mpd)$/i.test(u.pathname)) u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}

function classifyContentType(contentType) {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('video/')) return 'direct';
  if (ct.includes('mpegurl')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
  return null;
}

function classifyByUrl(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash';
  if (/\.(mp4|webm|mov|m4v|m4a)(\?|$)/i.test(url)) return 'direct';
  return null;
}

// .ts / .m4s are HLS/DASH sub-segments, not standalone videos. We still record
// them (so "show hidden" can surface them) but must NOT stamp them with the
// page's poster/duration/title — that would make them look like real videos
// and defeat the popup's segment filter.
const looksLikeSegmentUrl = self.VidLoadUrl.isStreamSegmentUrl;

// Before saving a "direct" file, confirm the URL actually returns video and not
// an HTML/text error page. Expired/forbidden links and throttled or anti-bot
// streams return an error body that chrome.downloads would otherwise save
// verbatim — that's the "video downloaded as a .txt file" bug.
async function preflightDirect(url) {
  // Only HARD-BLOCK on positive evidence the download is an error page: a
  // successful response whose body is HTML/text/JSON, not media. Everything
  // else — error statuses, opaque responses, CORS/network failures — fails
  // OPEN, because chrome.downloads runs with the full browser context (real
  // cookies, no CORS) and may succeed where this SW fetch can't.
  try {
    const ctrl = new AbortController();
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1' },
      credentials: 'include',
      signal: ctrl.signal,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const ok2xx = res.status === 200 || res.status === 206;
    ctrl.abort(); // headers are all we need — cancel the body stream
    if (ok2xx && ct && (ct.startsWith('text/') || ct.includes('html') || ct.includes('json') || ct.includes('xml'))) {
      return {
        ok: false,
        error: 'This link returned a web page, not a video — the source may require sign-in or block automated downloads.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: true }; // fail open — let chrome.downloads try
  }
}

function guessFilename(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && /\.(mp4|webm|mov|m4v|m3u8|mpd)(\?.*)?$/i.test(last)) {
      return last.split('?')[0];
    }
  } catch (_) { /* fall through */ }
  return `vidload-${Date.now()}.mp4`;
}

async function getTabItems(tabId) {
  const key = STORAGE_KEY(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || [];
}

async function setTabItems(tabId, items) {
  await chrome.storage.session.set({ [STORAGE_KEY(tabId)]: items });
}

async function upsertItem(tabId, item) {
  const items = await getTabItems(tabId);
  const key = dedupKey(item.url);
  const existing = items.find((it) => dedupKey(it.url) === key);
  if (existing) {
    for (const k of ['poster', 'width', 'height', 'duration', 'pageTitle', 'description', 'contextLabel']) {
      if (existing[k] == null && item[k] != null) existing[k] = item[k];
    }
    if (item.bytes && (!existing.bytes || item.bytes > existing.bytes)) {
      existing.bytes = item.bytes;
    }
    if (existing.source === 'network' && item.source && item.source !== 'network') {
      existing.source = item.source;
    }
    // Keep existing.url — the first-seen full URL (with a valid auth token).
    // Do NOT replace it with the tokenless dedup key, which would 403.
    await setTabItems(tabId, items);
    return;
  }
  items.push({ ...item, url: canonicalUrl(item.url) });
  if (items.length > 50) items.splice(0, items.length - 50);
  await setTabItems(tabId, items);
}

// Serialize creation behind a shared in-flight promise so two downloads clicked
// in the same tick share one createDocument call instead of racing (both seeing
// zero contexts and both creating → the second throws). The error-string swallow
// stays as a belt-and-suspenders fallback for a doc left over from a prior wake.
let offscreenCreating = null;
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Concatenate and decrypt HLS/DASH video segments into a downloadable file.',
    })
      .catch((err) => {
        if (!String(err.message || '').includes('Only a single offscreen')) throw err;
      })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

let jobCounter = 0;
function makeJobId() {
  jobCounter += 1;
  return `job-${Date.now()}-${jobCounter}`;
}

// =============================================================================
// Stream-download job tracking
// =============================================================================
// The offscreen document keeps downloading after the popup closes, but the
// popup's in-memory progress map dies with it. We mirror job state here (and
// into chrome.storage.session, which survives an SW suspend) so a reopened
// popup can restore the progress bar and final state.
const JOBS_KEY = 'vidload_jobs';
const JOB_DONE_TTL_MS = 120_000; // keep finished jobs around this long for the popup
const jobs = new Map(); // jobId -> { url, filename, status, current, total, phase, error }
let jobsPersistTimer = null;

function jobsSnapshot() {
  return Object.fromEntries(jobs);
}

// Toolbar-icon badge = number of in-flight downloads (like Chrome's own
// download counter). Deduped so the per-segment setJob calls don't spam the
// badge API — it only fires when the count actually changes.
let lastBadgeText = null;
function updateBadge() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'active') n++;
  const text = n > 0 ? String(n) : '';
  if (text === lastBadgeText) return;
  lastBadgeText = text;
  try {
    chrome.action.setBadgeText({ text });
    if (n > 0) chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
  } catch (err) {
    console.debug('[VidLoad SW] badge update failed', err?.message || err);
  }
}

function persistJobsNow() {
  jobsPersistTimer = null;
  chrome.storage.session.set({ [JOBS_KEY]: jobsSnapshot() }).catch(() => {});
}

function persistJobsThrottled() {
  if (jobsPersistTimer) return;
  jobsPersistTimer = setTimeout(persistJobsNow, 700);
}

function setJob(jobId, patch, { immediate } = {}) {
  if (!jobId) return;
  const prev = jobs.get(jobId) || {};
  jobs.set(jobId, { ...prev, ...patch });
  updateBadge();
  if (immediate) persistJobsNow();
  else persistJobsThrottled();
}

function scheduleJobCleanup(jobId) {
  setTimeout(() => { jobs.delete(jobId); persistJobsNow(); updateBadge(); }, JOB_DONE_TTL_MS);
}

async function getJobsMerged() {
  // Always merge storage into memory rather than short-circuiting on jobs.size:
  // after an SW wake the in-memory Map may hold only the one job whose progress
  // message woke us, so returning it alone would drop other still-running jobs.
  // In-memory wins on id collision (it's fresher); stored fills in the rest and
  // backfills static fields (url/filename) onto a progress-only in-memory entry.
  const stored = await chrome.storage.session.get(JOBS_KEY);
  const snap = stored[JOBS_KEY] || {};
  for (const [id, storedJob] of Object.entries(snap)) {
    const mem = jobs.get(id);
    jobs.set(id, mem ? { ...storedJob, ...mem } : storedJob);
  }
  return jobsSnapshot();
}

// Per-tab "page media context": the label, poster, duration, and dimensions
// of the video the user is currently looking at. Built up from possibly
// several frames (top frame supplies the page title; a player iframe supplies
// the poster/duration of an MSE <video> whose blob: src we can't otherwise
// tie to the network-observed stream).
const activeContexts = new Map(); // tabId -> { label, poster, duration, width, height }
const pageTitles = new Map();     // tabId -> document.title of the top frame

const CONTEXT_FIELDS = ['poster', 'duration', 'width', 'height'];

function mergeContext(tabId, patch, { allowLabel } = {}) {
  const prev = activeContexts.get(tabId) || {};
  const next = { ...prev };
  // Only the top frame may set OR clear the label — a subframe (embedded ad,
  // quote-tweet, player iframe) must not overwrite the top frame's real label
  // with its own DOM heading. Poster/duration/dims from any frame still merge.
  if ('label' in patch && allowLabel) {
    if (patch.label) next.label = patch.label;
    else delete next.label;
  }
  for (const f of CONTEXT_FIELDS) {
    if (patch[f] != null) next[f] = patch[f];
  }
  activeContexts.set(tabId, next);
  return next;
}

// Stamp recently-seen network items (which have no DOM tie) with whatever
// context fields they're still missing. Runs when fresh context arrives
// after the network request already landed.
async function backfillContext(tabId) {
  const ctx = activeContexts.get(tabId);
  const title = pageTitles.get(tabId);
  if (!ctx && !title) return;
  try {
    const items = await getTabItems(tabId);
    const cutoff = Date.now() - 60_000;
    let changed = false;
    for (const item of items) {
      if (item.source !== 'network') continue;
      if (item.ts && item.ts < cutoff) continue;
      if (looksLikeSegmentUrl(item.url)) continue; // never decorate sub-segments
      if (ctx?.label && !item.contextLabel) { item.contextLabel = ctx.label; changed = true; }
      if (title && !item.pageTitle) { item.pageTitle = title; changed = true; }
      for (const f of CONTEXT_FIELDS) {
        if (ctx?.[f] != null && item[f] == null) { item[f] = ctx[f]; changed = true; }
      }
    }
    if (changed) await setTabItems(tabId, items);
  } catch (err) {
    console.debug('[VidLoad SW] context backfill failed', err?.message || err);
  }
}

// =============================================================================
// Message router
// =============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target && msg.target !== 'sw') return false;

  if (msg?.type === 'active-context' && sender.tab?.id !== undefined) {
    // Only the top frame may set/clear the label; subframes contribute only
    // poster/duration/dims. Prevents an embedded iframe's heading from
    // overwriting the real page label (wrong download filename).
    mergeContext(sender.tab.id, msg, { allowLabel: !!msg.frameTop });
    backfillContext(sender.tab.id);
    return false;
  }

  if (msg?.type === 'page-title' && sender.tab?.id !== undefined) {
    if (msg.title) {
      pageTitles.set(sender.tab.id, msg.title);
      backfillContext(sender.tab.id);
    }
    return false;
  }

  // Offscreen stream events — mirror into the job table so a reopened popup
  // can restore progress. These messages are broadcast (no target); the popup
  // listens too for live updates.
  if (msg?.type === 'stream-progress' && msg.jobId) {
    setJob(msg.jobId, {
      status: 'active', phase: msg.phase, current: msg.current, total: msg.total,
    });
    return false;
  }
  if (msg?.type === 'stream-done' && msg.jobId) {
    // Meter segmented downloads on SUCCESS (not at dispatch): a job that fails
    // partway shouldn't consume a free-tier slot. Rehydrate first so the job's
    // `metered` flag survives an SW suspend between dispatch and completion.
    (async () => {
      await getJobsMerged();
      const job = jobs.get(msg.jobId);
      setJob(msg.jobId, { status: 'done', filename: msg.filename, warning: msg.warning || null }, { immediate: true });
      if (job?.metered) await commitMeteredDownload();
      scheduleJobCleanup(msg.jobId);
    })();
    return false;
  }
  if (msg?.type === 'stream-error' && msg.jobId) {
    (async () => {
      await getJobsMerged();
      const job = jobs.get(msg.jobId);
      setJob(msg.jobId, { status: 'error', error: msg.error }, { immediate: true });
      if (job?.metered) await releaseMeteredReservation();
      scheduleJobCleanup(msg.jobId);
    })();
    return false;
  }

  if (msg?.type === 'get-jobs') {
    getJobsMerged().then((j) => sendResponse({ jobs: j }));
    return true;
  }

  if (msg?.type === 'get-status') {
    (async () => {
      const count = await getDownloadCount();
      const paid = await isPaid();
      const limit = MONETIZATION.freeLifetimeLimit;
      sendResponse({
        monetizationEnabled: MONETIZATION.enabled,
        paid,
        limit,
        used: count,
        remaining: Math.max(0, limit - count),
        priceLabel: MONETIZATION.priceLabel,
      });
    })();
    return true;
  }

  if (msg?.type === 'open-payment-page') {
    // Await the checkout tab actually opening before reporting success, so the
    // popup doesn't close on a silent failure (a lost high-intent buyer).
    (async () => {
      if (!extpay) {
        sendResponse({
          ok: false,
          error: MONETIZATION.enabled ? 'ExtPay not initialized' : 'Monetization is disabled in this build',
        });
        return;
      }
      try {
        await extpay.openPaymentPage();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'media-found' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    const now = Date.now();
    const source = msg.source || 'dom';
    const pageTitle = msg.pageTitle || null;
    Promise.all(
      (msg.items || []).map((it) =>
        upsertItem(tabId, {
          source,
          url: it.url,
          label: it.label || guessFilename(it.url),
          kind: it.kind || classifyByUrl(it.url) || 'direct',
          pageUrl: msg.pageUrl,
          pageTitle,
          description: it.description || null,
          contextLabel: it.contextLabel || null,
          poster: it.poster || null,
          width: it.width || null,
          height: it.height || null,
          duration: it.duration || null,
          bytes: it.bytes || null,
          ts: now,
        })
      )
    ).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'list' && typeof msg.tabId === 'number') {
    getTabItems(msg.tabId).then((items) => sendResponse({ items }));
    return true;
  }

  if (msg?.type === 'download' && msg.url) {
    (async () => {
      const gate = await gateDownload();
      if (!gate.allowed) {
        sendResponse({ ok: false, error: 'paywall', ...gate });
        return;
      }
      // Guard against saving an HTML error page as a ".txt" video (throttled,
      // expired, or forbidden links).
      const pre = await preflightDirect(msg.url);
      if (!pre.ok) {
        if (gate.metered) await releaseMeteredReservation();
        sendResponse({ ok: false, error: pre.error });
        return;
      }
      chrome.downloads.download(
        { url: msg.url, filename: msg.filename, saveAs: !!msg.saveAs },
        async (downloadId) => {
          if (chrome.runtime.lastError) {
            if (gate.metered) await releaseMeteredReservation();
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            // Commit the reserved quota slot only on a real download. Trial and
            // paid downloads are unmetered (gate.metered === false).
            if (gate.metered) await commitMeteredDownload();
            sendResponse({ ok: true, downloadId });
          }
        }
      );
    })();
    return true;
  }

  if (msg?.type === 'commit-download' && msg.url) {
    // Offscreen document can't call chrome.downloads (Chrome restricts that
    // API inside offscreen contexts). It hands the blob URL here for the SW
    // to commit. Gating already happened when 'download-stream' was accepted,
    // so we don't re-gate — but restrict to a blob: URL from our own offscreen
    // document so a stray/compromised content script can't drive an arbitrary,
    // ungated download through this handler.
    const blobPrefix = 'blob:' + chrome.runtime.getURL('');
    const fromOffscreen = !!sender.url && sender.url.endsWith('/offscreen/offscreen.html');
    if (!fromOffscreen || !msg.url.startsWith(blobPrefix)) {
      sendResponse({ ok: false, error: 'rejected' });
      return false;
    }
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: !!msg.saveAs },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  if (msg?.type === 'download-av' && msg.videoUrl) {
    // Separate video + (optional) audio source to download whole and mux.
    (async () => {
      const gate = await gateDownload();
      if (!gate.allowed) {
        sendResponse({ ok: false, error: 'paywall', ...gate });
        return;
      }
      const jobId = makeJobId();
      try {
        await ensureOffscreenDocument();
        setJob(jobId, {
          url: msg.itemUrl || msg.videoUrl,
          filename: msg.filename,
          status: 'active',
          phase: 'manifest',
          current: 0,
          total: 100,
          metered: gate.metered, // committed on stream-done, released on stream-error
        }, { immediate: true });
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'fetch-av',
          jobId,
          videoUrl: msg.videoUrl,
          audioUrl: msg.audioUrl || null,
          filename: msg.filename,
          saveAs: !!msg.saveAs,
        });
        sendResponse({ ok: true, jobId });
      } catch (err) {
        if (gate.metered) await releaseMeteredReservation();
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'download-stream' && msg.url) {
    (async () => {
      const gate = await gateDownload();
      if (!gate.allowed) {
        sendResponse({ ok: false, error: 'paywall', ...gate });
        return;
      }
      const jobId = makeJobId();
      const format = msg.format === 'dash' ? 'dash' : 'hls';
      try {
        await ensureOffscreenDocument();
        // Record the job up front (url = the canonical item URL the popup row
        // is keyed by, not the variant stream URL) so a reopened popup can
        // re-attach to it.
        setJob(jobId, {
          url: msg.itemUrl || msg.url,
          filename: msg.filename,
          status: 'active',
          phase: 'manifest',
          current: 0,
          total: 1,
          metered: gate.metered, // committed on stream-done, released on stream-error
        }, { immediate: true });
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'fetch-stream',
          format,
          jobId,
          url: msg.url,
          filename: msg.filename,
          saveAs: !!msg.saveAs,
        });
        sendResponse({ ok: true, jobId });
      } catch (err) {
        if (gate.metered) await releaseMeteredReservation();
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return false;
});

function parseTotalBytes(headers) {
  const cr = headers.find((h) => h.name.toLowerCase() === 'content-range');
  if (cr?.value) {
    const m = cr.value.match(/\/(\d+)\s*$/);
    if (m) {
      const total = parseInt(m[1], 10);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }
  const cl = headers.find((h) => h.name.toLowerCase() === 'content-length');
  if (cl?.value) {
    const n = parseInt(cl.value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function refererFromDetails(details) {
  // details.initiator is the origin of the frame that requested the media —
  // i.e. the embed page (e.g. https://cf-embed.play.hotmart.com). That's the
  // Referer the CDN expects. Fall back to the media URL's own origin.
  if (details.initiator && /^https?:/i.test(details.initiator)) {
    return details.initiator.replace(/\/+$/, '') + '/';
  }
  try { return new URL(details.url).origin + '/'; } catch { return null; }
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const ctHeader = headers.find((h) => h.name.toLowerCase() === 'content-type');
    const kind = classifyContentType(ctHeader?.value) || classifyByUrl(details.url);
    if (!kind) return;

    // Learn the Referer for this media's registrable domain so the popup probe
    // and the offscreen download (both extension-originated) can fetch it.
    const referer = refererFromDetails(details);
    try {
      const host = new URL(details.url).hostname;
      const domain = registrableDomain(host);
      if (domain && referer) learnReferer(domain, referer);
    } catch { /* ignore malformed URLs */ }

    const ctx = activeContexts.get(details.tabId) || {};
    const seg = looksLikeSegmentUrl(details.url);
    upsertItem(details.tabId, {
      source: 'network',
      url: details.url,
      label: guessFilename(details.url),
      kind,
      bytes: parseTotalBytes(headers),
      // Don't decorate segment chunks — keep them metadata-free so they're filtered.
      contextLabel: seg ? null : (ctx.label || null),
      pageTitle: seg ? null : (pageTitles.get(details.tabId) || null),
      poster: seg ? null : (ctx.poster || null),
      duration: seg ? null : (ctx.duration || null),
      width: seg ? null : (ctx.width || null),
      height: seg ? null : (ctx.height || null),
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(STORAGE_KEY(tabId));
  activeContexts.delete(tabId);
  pageTitles.delete(tabId);
});
