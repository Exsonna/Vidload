// VidLoad background service worker (MV3)
// - Receives <video> sightings from content scripts
// - Observes network responses with video/HLS/DASH Content-Type
// - Stores per-tab detected media in chrome.storage.session
// - Handles download requests from the popup

const STORAGE_KEY = (tabId) => `tab:${tabId}`;

function classify(contentType) {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('video/')) return 'direct';
  if (ct.includes('mpegurl')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
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

async function addItem(tabId, item) {
  const items = await getTabItems(tabId);
  if (items.some((it) => it.url === item.url)) return;
  items.push(item);
  if (items.length > 50) items.splice(0, items.length - 50);
  await setTabItems(tabId, items);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'media-found' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    const now = Date.now();
    Promise.all(
      (msg.items || []).map((it) =>
        addItem(tabId, {
          source: 'dom',
          url: it.url,
          label: it.label || guessFilename(it.url),
          kind: 'direct',
          pageUrl: msg.pageUrl,
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

  return false;
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const header = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    const kind = classify(header?.value);
    if (!kind) return;
    addItem(details.tabId, {
      source: 'network',
      url: details.url,
      label: guessFilename(details.url),
      kind,
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(STORAGE_KEY(tabId));
});
