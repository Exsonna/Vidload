// VidLoad background service worker (MV3)
// - Receives <video> sightings from content scripts and site adapters
// - Observes network responses with video/HLS/DASH Content-Type or URL pattern
// - Captures Content-Length when present
// - Stores per-tab detected media in chrome.storage.session
// - Routes direct downloads to chrome.downloads, segmented downloads to offscreen

const STORAGE_KEY = (tabId) => `tab:${tabId}`;
const OFFSCREEN_URL = 'offscreen/offscreen.html';

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
  const existing = items.find((it) => it.url === item.url);
  if (existing) {
    // Merge in any newly-known fields without overwriting existing values.
    for (const k of ['poster', 'width', 'height', 'duration', 'bytes', 'pageTitle', 'description']) {
      if (existing[k] == null && item[k] != null) existing[k] = item[k];
    }
    await setTabItems(tabId, items);
    return;
  }
  items.push(item);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target && msg.target !== 'sw') return false;

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

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const ctHeader = headers.find((h) => h.name.toLowerCase() === 'content-type');
    const clHeader = headers.find((h) => h.name.toLowerCase() === 'content-length');
    const kind = classifyContentType(ctHeader?.value) || classifyByUrl(details.url);
    if (!kind) return;
    const bytes = clHeader?.value ? parseInt(clHeader.value, 10) : null;
    upsertItem(details.tabId, {
      source: 'network',
      url: details.url,
      label: guessFilename(details.url),
      kind,
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(STORAGE_KEY(tabId));
});
