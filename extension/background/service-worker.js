// VidLoad background service worker (MV3)
// - Receives <video> sightings from content scripts and site adapters
// - Observes network responses with video/HLS/DASH Content-Type or URL pattern
// - Captures Content-Length and Content-Range (total file size)
// - Dedupes byte-range chunks of the same media into one canonical item
// - Stores per-tab detected media in chrome.storage.session
// - Routes direct downloads to chrome.downloads, segmented downloads to offscreen

const STORAGE_KEY = (tabId) => `tab:${tabId}`;
const OFFSCREEN_URL = 'offscreen/offscreen.html';

// Query params that vary across byte-range requests for the same media.
// Stripping them collapses many chunks into one canonical URL.
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
    // Prefer the largest observed byte count (full-file size from Content-Range
    // beats a single chunk's Content-Length).
    if (item.bytes && (!existing.bytes || item.bytes > existing.bytes)) {
      existing.bytes = item.bytes;
    }
    // Prefer an adapter-supplied source over the generic 'network' source.
    if (existing.source === 'network' && item.source && item.source !== 'network') {
      existing.source = item.source;
    }
    // Canonicalize URL to the no-range form once we've seen it.
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

// Per-tab "active context label" — the on-page name (Instagram handle,
// Twitter handle, heading) of the <video> currently closest to viewport
// center. Updated by content-script scroll/mutation events. Used to
// tag network-observed URLs (which arrive without a DOM tie) with a
// meaningful filename.
const activeContexts = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target && msg.target !== 'sw') return false;

  if (msg?.type === 'active-context' && sender.tab?.id !== undefined) {
    if (msg.label) activeContexts.set(sender.tab.id, msg.label);
    else activeContexts.delete(sender.tab.id);
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
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
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
    const jobId = makeJobId();
    const format = msg.format === 'dash' ? 'dash' : 'hls';
    ensureOffscreenDocument()
      .then(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'fetch-stream',
          format,
          jobId,
          url: msg.url,
          filename: msg.filename,
        });
        sendResponse({ ok: true, jobId });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  return false;
});

function parseTotalBytes(headers) {
  // Content-Range: bytes 0-1023/12345678  → 12345678 is the total file size
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
