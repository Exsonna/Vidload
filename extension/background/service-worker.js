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
// Referer rewrite rules
// =============================================================================
// Some CDNs (video.twimg.com, *.fbcdn.net, *.cdninstagram.com, *.tiktokcdn.com)
// reject media requests when the Referer header is the extension's
// chrome-extension:// origin — even though we hold host permissions. These
// dynamic rules rewrite the Referer to look like a normal in-page fetch.
//
// tabIds: [-1] scopes the rule to requests that don't originate from a
// browser tab — i.e. our SW, offscreen document, and popup. The user's
// normal browsing is unaffected because tab requests have their own tabId.
const REFERER_RULES = [
  {
    id: 1001,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://x.com/' }],
    },
    condition: { requestDomains: ['twimg.com'], tabIds: [-1] },
  },
  {
    id: 1002,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.instagram.com/' }],
    },
    condition: { requestDomains: ['fbcdn.net', 'cdninstagram.com'], tabIds: [-1] },
  },
  {
    id: 1003,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.tiktok.com/' }],
    },
    condition: { requestDomains: ['tiktokcdn.com', 'tiktokcdn-us.com'], tabIds: [-1] },
  },
];

async function setupRefererRules() {
  // Session-scoped rules (not dynamic) because Chrome only honors the
  // tabIds / excludedTabIds condition keys on session rules. tabIds: [-1]
  // is what scopes the Referer rewrite to extension-originated requests
  // only (SW / offscreen / popup) so the user's normal browsing is
  // untouched. Session rules are cleared on browser restart — we
  // re-register on startup below.
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ourIds = existing.filter((r) => r.id >= 1001 && r.id <= 1099).map((r) => r.id);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ourIds,
      addRules: REFERER_RULES,
    });
    console.log('[VidLoad SW] Referer rewrite session rules registered:', REFERER_RULES.length);
  } catch (err) {
    console.error('[VidLoad SW] Failed to set up Referer rules', err);
  }
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
  trialDays: 7,                      // free-trial length on fresh install
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
const INSTALL_TS_KEY = 'vidload_install_ts';
const DAY_MS = 86_400_000;

// Trial timer starts on first install — not on update — so existing users keep
// any time they had left if we later update the build.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  try {
    await chrome.storage.local.set({ [INSTALL_TS_KEY]: Date.now() });
    console.log(`[VidLoad] Free trial started (${MONETIZATION.trialDays}d)`);
  } catch (err) {
    console.error('[VidLoad] Failed to record install timestamp', err);
  }
});

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

async function getTrialStatus() {
  if (!MONETIZATION.enabled) return { active: false, daysLeft: 0 };
  const stored = await chrome.storage.local.get(INSTALL_TS_KEY);
  const installTs = stored[INSTALL_TS_KEY];
  // No recorded timestamp = either onInstalled hasn't fired yet (first run
  // race) or storage was wiped. Treat as fresh trial — generous fallback
  // because the alternative (denying trial) feels punitive.
  if (!installTs) return { active: true, daysLeft: MONETIZATION.trialDays };
  const elapsed = Date.now() - installTs;
  const total = MONETIZATION.trialDays * DAY_MS;
  if (elapsed >= total) return { active: false, daysLeft: 0 };
  return { active: true, daysLeft: Math.max(1, Math.ceil((total - elapsed) / DAY_MS)) };
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

function dedupKey(url) {
  try {
    const u = new URL(url);
    for (const p of RANGE_NOISE_PARAMS) u.searchParams.delete(p);
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
    existing.url = key;
    await setTabItems(tabId, items);
    return;
  }
  items.push({ ...item, url: key });
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

const activeContexts = new Map();

async function backfillActiveContext(tabId, label) {
  if (!label) return;
  try {
    const items = await getTabItems(tabId);
    const cutoff = Date.now() - 30_000;
    let changed = false;
    for (const item of items) {
      if (item.contextLabel) continue;
      if (item.source !== 'network') continue;
      if (item.ts && item.ts < cutoff) continue;
      item.contextLabel = label;
      changed = true;
    }
    if (changed) await setTabItems(tabId, items);
  } catch (err) {
    console.debug('[VidLoad SW] active context backfill failed', err?.message || err);
  }
}

// =============================================================================
// Message router
// =============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target && msg.target !== 'sw') return false;

  if (msg?.type === 'active-context' && sender.tab?.id !== undefined) {
    if (msg.label) {
      activeContexts.set(sender.tab.id, msg.label);
      backfillActiveContext(sender.tab.id, msg.label);
    } else {
      activeContexts.delete(sender.tab.id);
    }
    return false;
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

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const ctHeader = headers.find((h) => h.name.toLowerCase() === 'content-type');
    const kind = classifyContentType(ctHeader?.value) || classifyByUrl(details.url);
    if (!kind) return;
    upsertItem(details.tabId, {
      source: 'network',
      url: details.url,
      label: guessFilename(details.url),
      kind,
      bytes: parseTotalBytes(headers),
      contextLabel: activeContexts.get(details.tabId) || null,
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(STORAGE_KEY(tabId));
  activeContexts.delete(tabId);
});
