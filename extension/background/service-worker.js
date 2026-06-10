// VidLoad background service worker (MV3)
// - Receives <video> sightings from content scripts and site adapters
// - Observes network responses with video/HLS/DASH Content-Type or URL pattern
// - Captures Content-Length and Content-Range (total file size)
// - Dedupes byte-range chunks of the same media into one canonical item
// - Stores per-tab detected media in chrome.storage.session
// - Routes direct downloads to chrome.downloads, segmented downloads to offscreen
// - Gates downloads via ExtensionPay (free tier + $4.99 lifetime unlock)

importScripts('/lib/extpay.js');

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
// normal browsing is unaffected because real tab requests have their own
// tabId and never match.
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

// Multi-part public suffixes we must keep intact when reducing a hostname to
// its registrable domain (so play.hotmart.com.br → hotmart.com.br, not com.br).
const MULTI_PART_TLDS = new Set([
  'com.br', 'com.au', 'co.uk', 'co.jp', 'co.kr', 'co.in', 'com.cn',
  'com.mx', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'net.au', 'org.uk',
]);

function registrableDomain(host) {
  if (!host) return null;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

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
      requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
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

// Record that requests to `domain` should carry `referer`. No-op if unchanged.
async function learnReferer(domain, referer) {
  if (!domain || !referer) return;
  const map = await loadRefererMap();
  if (map[domain] === referer) return;
  map[domain] = referer;
  await chrome.storage.session.set({ [REFERER_MAP_KEY]: map });
  await applyRefererMap(map);
}

async function setupRefererRules() {
  const map = await loadRefererMap();
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
const MONETIZATION = {
  enabled: false,                    // flip to true once ExtPay is configured
  extpayId: 'vidload',               // replace with your extensionpay.com id
  trialDays: 7,                      // free-trial length
  // Bump this string to grant EVERY user a fresh `trialDays` trial — e.g. after
  // shipping major fixes ("here's another week on us"). Each user re-grants
  // once per new id, on their next status check. Current value re-grants for
  // the v0.4.14–v0.4.22 reliability overhaul.
  trialResetId: 'reliability-2026-06',
  freeDailyLimit: 3,                 // downloads/day after the trial expires
  priceLabel: '$4.99 one-time',      // shown in the paywall UI
};

let extpay = null;
if (MONETIZATION.enabled && typeof ExtPay === 'function') {
  extpay = ExtPay(MONETIZATION.extpayId);
  extpay.startBackground();
  extpay.onPaid.addListener((user) => {
    console.log('[VidLoad] payment received', user);
  });
}

const DOWNLOAD_COUNTER_KEY = 'vidload_downloads';
const TRIAL_START_KEY = 'vidload_trial_start';
const TRIAL_RESET_KEY = 'vidload_trial_reset';
const DAY_MS = 86_400_000;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getDownloadStats() {
  const today = todayKey();
  const stored = await chrome.storage.local.get(DOWNLOAD_COUNTER_KEY);
  const data = stored[DOWNLOAD_COUNTER_KEY] || { date: today, count: 0 };
  if (data.date !== today) {
    data.date = today;
    data.count = 0;
  }
  return data;
}

async function bumpDownloadCount() {
  const data = await getDownloadStats();
  data.count += 1;
  await chrome.storage.local.set({ [DOWNLOAD_COUNTER_KEY]: data });
  return data.count;
}

async function isPaid() {
  if (!MONETIZATION.enabled) return true;
  if (!extpay) return false;
  try {
    const user = await extpay.getUser();
    return !!user.paid;
  } catch (err) {
    console.error('[VidLoad] paid check failed', err);
    return false;
  }
}

// The trial clock starts the first time monetization is active for a user, and
// re-starts whenever MONETIZATION.trialResetId changes (a "free trial for
// everyone" grant after major fixes). Stored in chrome.storage.local so it
// survives SW restarts. Paid users never reach this — isPaid() short-circuits.
async function getTrialStatus() {
  if (!MONETIZATION.enabled) return { active: false, daysLeft: 0, endsAt: 0, msLeft: 0 };
  const stored = await chrome.storage.local.get([TRIAL_START_KEY, TRIAL_RESET_KEY]);
  let start = stored[TRIAL_START_KEY];
  if (!start || stored[TRIAL_RESET_KEY] !== MONETIZATION.trialResetId) {
    start = Date.now();
    try {
      await chrome.storage.local.set({
        [TRIAL_START_KEY]: start,
        [TRIAL_RESET_KEY]: MONETIZATION.trialResetId,
      });
      console.log(`[VidLoad] Free trial granted (${MONETIZATION.trialDays}d, id=${MONETIZATION.trialResetId})`);
    } catch (err) {
      console.error('[VidLoad] trial start write failed', err);
    }
  }
  const endsAt = start + MONETIZATION.trialDays * DAY_MS;
  const msLeft = endsAt - Date.now();
  if (msLeft <= 0) return { active: false, daysLeft: 0, endsAt, msLeft: 0 };
  return { active: true, daysLeft: Math.max(1, Math.ceil(msLeft / DAY_MS)), endsAt, msLeft };
}

async function gateDownload() {
  if (await isPaid()) return { allowed: true, paid: true, metered: false };
  const trial = await getTrialStatus();
  if (trial.active) {
    return {
      allowed: true,
      paid: false,
      trialActive: true,
      trialDaysLeft: trial.daysLeft,
      metered: false,
    };
  }
  const data = await getDownloadStats();
  if (data.count >= MONETIZATION.freeDailyLimit) {
    return {
      allowed: false,
      paid: false,
      limit: MONETIZATION.freeDailyLimit,
      used: data.count,
      priceLabel: MONETIZATION.priceLabel,
      metered: false,
    };
  }
  return {
    allowed: true,
    paid: false,
    limit: MONETIZATION.freeDailyLimit,
    used: data.count,
    metered: true,
  };
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
function looksLikeSegmentUrl(url) {
  try { return /\.(m4s|ts)(?:$|\?)/i.test(new URL(url).pathname); } catch { return false; }
}

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
    for (const k of ['poster', 'width', 'height', 'duration', 'pageTitle', 'description', 'contextLabel', 'referer']) {
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

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Concatenate and decrypt HLS/DASH video segments into a downloadable file.',
    });
  } catch (err) {
    if (!String(err.message || '').includes('Only a single offscreen')) throw err;
  }
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
  if (jobs.size > 0) return jobsSnapshot();
  // SW may have suspended since the download started — rehydrate from storage.
  const stored = await chrome.storage.session.get(JOBS_KEY);
  const snap = stored[JOBS_KEY] || {};
  for (const [id, j] of Object.entries(snap)) jobs.set(id, j);
  return snap;
}

// Per-tab "page media context": the label, poster, duration, and dimensions
// of the video the user is currently looking at. Built up from possibly
// several frames (top frame supplies the page title; a player iframe supplies
// the poster/duration of an MSE <video> whose blob: src we can't otherwise
// tie to the network-observed stream).
const activeContexts = new Map(); // tabId -> { label, poster, duration, width, height }
const pageTitles = new Map();     // tabId -> document.title of the top frame

const CONTEXT_FIELDS = ['poster', 'duration', 'width', 'height'];

function mergeContext(tabId, patch, { allowLabelClear } = {}) {
  const prev = activeContexts.get(tabId) || {};
  const next = { ...prev };
  if ('label' in patch) {
    if (patch.label) next.label = patch.label;
    else if (allowLabelClear) delete next.label;
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
    // Only the top frame may clear the label (subframes that find no context
    // must not clobber a label the top frame set). Poster/duration/dims from
    // any frame are merged in.
    mergeContext(sender.tab.id, msg, { allowLabelClear: !!msg.frameTop });
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
    setJob(msg.jobId, { status: 'done', filename: msg.filename }, { immediate: true });
    scheduleJobCleanup(msg.jobId);
    return false;
  }
  if (msg?.type === 'stream-error' && msg.jobId) {
    setJob(msg.jobId, { status: 'error', error: msg.error }, { immediate: true });
    scheduleJobCleanup(msg.jobId);
    return false;
  }

  if (msg?.type === 'get-jobs') {
    getJobsMerged().then((j) => sendResponse({ jobs: j }));
    return true;
  }

  if (msg?.type === 'get-status') {
    (async () => {
      const data = await getDownloadStats();
      const paid = await isPaid();
      const trial = await getTrialStatus();
      sendResponse({
        monetizationEnabled: MONETIZATION.enabled,
        paid,
        trialActive: trial.active,
        trialDaysLeft: trial.daysLeft,
        trialTotalDays: MONETIZATION.trialDays,
        trialEndsAt: trial.endsAt || 0,
        trialMsLeft: trial.msLeft || 0,
        limit: MONETIZATION.freeDailyLimit,
        used: data.count,
        priceLabel: MONETIZATION.priceLabel,
      });
    })();
    return true;
  }

  if (msg?.type === 'open-payment-page') {
    if (extpay) {
      extpay.openPaymentPage();
      sendResponse({ ok: true });
    } else {
      sendResponse({
        ok: false,
        error: MONETIZATION.enabled
          ? 'ExtPay not initialized'
          : 'Monetization is disabled in this build',
      });
    }
    return false;
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
        sendResponse({ ok: false, error: pre.error });
        return;
      }
      chrome.downloads.download(
        { url: msg.url, filename: msg.filename, saveAs: !!msg.saveAs },
        async (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            // Only count downloads that consume the free-tier quota.
            // Trial and paid downloads are unlimited.
            if (gate.metered) await bumpDownloadCount();
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
    // so we don't re-gate.
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
        if (gate.metered) await bumpDownloadCount();
        sendResponse({ ok: true, jobId });
      } catch (err) {
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
        if (gate.metered) await bumpDownloadCount();
        sendResponse({ ok: true, jobId });
      } catch (err) {
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
    try {
      const host = new URL(details.url).hostname;
      const domain = registrableDomain(host);
      const referer = refererFromDetails(details);
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
      referer: refererFromDetails(details),
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
