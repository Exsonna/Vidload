const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tierBadgeEl = document.getElementById('tier-badge');
const tpl = document.getElementById('row-template');
const toggleEl = document.getElementById('toggle-hidden');
const paywallEl = document.getElementById('paywall');
const paywallDetailEl = document.getElementById('paywall-detail');
const paywallPriceEl = document.getElementById('paywall-price');
const paywallFootEl = document.getElementById('paywall-foot');
const upgradeBtn = document.getElementById('upgrade-btn');
const paywallBackBtn = document.getElementById('paywall-back');
const footerEl = document.querySelector('footer');
const headerEl = document.querySelector('header');

const MIN_DIRECT_BYTES = 100 * 1024;

const activeJobs = new Map();
let allItems = [];
let showHidden = false;
const dismissed = new Set();
let tierStatus = { monetizationEnabled: false, paid: true };

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setDownloadButton(btn, text, opts = {}) {
  btn.querySelector('.dl-label').textContent = text;
  btn.disabled = !!opts.disabled;
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
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return parts.slice(-2).join('.');
}

function looksLikeGibberish(s) {
  if (!s) return true;
  const cleaned = s.replace(/\.\w{1,5}$/, '').replace(/[-_]/g, '');
  if (cleaned.length < 12) return false;
  return /^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length >= 16;
}

function hasMetadata(item) {
  return !!(item.poster || item.description || item.duration || (item.width && item.height));
}

function isFilteredOut(item) {
  if (item.kind !== 'direct') return false;
  if (item.source !== 'network') return false;
  if (hasMetadata(item)) return false;
  if (item.bytes != null && item.bytes < MIN_DIRECT_BYTES) return true;
  return false;
}

const VIDEO_EXT_RE = /\.(mp4|m4s|m4v|m4a|mov|webm|ts|mkv|avi)(?:$|\?)/i;

function formatFromKind(item) {
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
  if (item.kind === 'hls' || item.kind === 'dash') return '';
  try {
    const m = new URL(item.url).pathname.match(VIDEO_EXT_RE);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return '.mp4';
}

function chooseTitle(item) {
  if (item.userLabel) return item.userLabel;
  if (item.contextLabel) return item.contextLabel;
  if (item.description) return item.description;
  if (item.pageTitle && item.source !== 'network') return item.pageTitle;
  if (looksLikeGibberish(item.label)) {
    const host = shortHost(item.url);
    return host ? `Video on ${host}` : `${item.kind.toUpperCase()} stream`;
  }
  return item.label;
}

function chooseFilename(item) {
  if (item.userLabel) return ensureExtension(sanitizeFilename(item.userLabel), item);
  let base;
  if (item.contextLabel) base = item.contextLabel;
  else if (item.description) base = item.description.slice(0, 40);
  else if (item.pageTitle && item.source !== 'network') base = item.pageTitle;
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
  titleEl.contentEditable = 'true';
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    titleEl.contentEditable = 'false';
    titleEl.removeEventListener('blur', onBlur);
    titleEl.removeEventListener('keydown', onKey);
    if (commit) {
      const next = titleEl.textContent.trim();
      if (next) {
        item.userLabel = next;
        item.label = next;
      }
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
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  } catch (e) {
    console.error('VidLoad: clipboard write failed', e);
  }
}

// HLS/DASH manifests don't carry duration in their HTTP headers, so the
// service worker can't know it from webRequest observation alone. When the
// popup renders an item without duration, we lazily fetch the manifest and
// compute it. Cached on the item via _probed so repeated renders don't refetch.
async function probeStreamDuration(item) {
  try {
    const res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) return null;
    const text = await res.text();
    if (item.kind === 'hls') return await computeHlsDuration(text, item.url);
    if (item.kind === 'dash') return computeDashDuration(text);
  } catch (err) {
    console.debug('VidLoad: duration probe failed for', item.url, err.message);
  }
  return null;
}

async function computeHlsDuration(text, baseUrl) {
  // If master playlist, fetch the first variant.
  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    let variantUrl = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith('#')) j++;
        const next = lines[j]?.trim();
        if (next) {
          variantUrl = new URL(next, baseUrl).href;
          break;
        }
      }
    }
    if (!variantUrl) return null;
    const res = await fetch(variantUrl, { credentials: 'include' });
    if (!res.ok) return null;
    text = await res.text();
  }
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) total += parseFloat(m[1]);
  }
  return total > 0 ? Math.round(total) : null;
}

function computeDashDuration(mpdText) {
  const m = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
  if (!m) return null;
  const dur = m[1].match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!dur) return null;
  const seconds =
    parseFloat(dur[1] || 0) * 86400 +
    parseFloat(dur[2] || 0) * 3600 +
    parseFloat(dur[3] || 0) * 60 +
    parseFloat(dur[4] || 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

function maybeProbeDuration(item, durEl) {
  if (item.duration || item._probed) return;
  if (item.kind !== 'hls' && item.kind !== 'dash') return;
  item._probed = true;
  probeStreamDuration(item).then((duration) => {
    if (!duration) return;
    item.duration = duration;
    // Only update if the element is still in the DOM (popup might have closed).
    if (durEl.isConnected) durEl.textContent = formatDuration(duration);
  });
}

function renderTier(status) {
  tierStatus = status;
  if (!status.monetizationEnabled) {
    tierBadgeEl.hidden = true;
    return;
  }
  tierBadgeEl.hidden = false;
  if (status.paid) {
    tierBadgeEl.textContent = 'Pro';
    tierBadgeEl.className = 'pro';
  } else {
    tierBadgeEl.textContent = `Free · ${status.used}/${status.limit}`;
    tierBadgeEl.className = 'free';
  }
}

function showPaywall(detail) {
  paywallEl.hidden = false;
  listEl.hidden = true;
  footerEl.hidden = true;
  if (detail) {
    paywallDetailEl.textContent = `You've used ${detail.used} of ${detail.limit} free downloads today.`;
    if (detail.priceLabel) paywallPriceEl.textContent = detail.priceLabel.replace(/\s+one-time.*$/i, '') || '$4.99';
  }
  paywallFootEl.textContent = tierStatus.monetizationEnabled
    ? 'Counter resets at midnight local time.'
    : 'Monetization is disabled in this build — this is a preview of the paywall UI.';
}

function hidePaywall() {
  paywallEl.hidden = true;
  listEl.hidden = false;
  footerEl.hidden = false;
}

upgradeBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'open-payment-page' });
  if (!res?.ok) {
    paywallFootEl.textContent = res?.error || 'Could not open payment page.';
    return;
  }
  window.close();
});

paywallBackBtn.addEventListener('click', () => hidePaywall());

function render() {
  const filtered = allItems.filter((it) => !dismissed.has(it.url));
  const visible = showHidden ? filtered : filtered.filter((it) => !isFilteredOut(it));
  const hiddenCount = filtered.length - visible.length;

  listEl.replaceChildren();
  if (allItems.length === 0) {
    statusEl.textContent = 'No videos detected on this page yet. Try scrolling or hitting play.';
    toggleEl.hidden = true;
    return;
  }
  if (filtered.length === 0) {
    statusEl.textContent = 'All items dismissed.';
    toggleEl.hidden = true;
    return;
  }
  if (visible.length === 0) {
    statusEl.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'} detected — all filtered as probes/segments.`;
  } else if (hiddenCount > 0) {
    statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} · ${hiddenCount} small item${hiddenCount === 1 ? '' : 's'} hidden.`;
  } else {
    statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} detected.`;
  }

  toggleEl.hidden = hiddenCount === 0 && !showHidden;
  toggleEl.textContent = showHidden
    ? 'Hide small probe items'
    : `Show ${hiddenCount} hidden small item${hiddenCount === 1 ? '' : 's'}`;

  visible.forEach((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const titleEl = node.querySelector('.title');
    titleEl.textContent = chooseTitle(item);

    const formatBadge = node.querySelector('.format-badge');
    formatBadge.textContent = formatFromKind(item);
    formatBadge.classList.add(item.kind);

    node.querySelector('.thumb-quality').textContent = qualityLabel(item.width, item.height) || '';
    const durEl = node.querySelector('.thumb-duration');
    durEl.textContent = formatDuration(item.duration) || '';
    maybeProbeDuration(item, durEl);
    node.querySelector('.thumb-kind').textContent = item.kind;

    // Tiny "bytes" on HLS/DASH items is the manifest text size, not the video
    // size. The actual video is the sum of all segments, which we don't know
    // until the offscreen engine downloads them. Hide that misleading number.
    const sizePill = node.querySelector('.size-pill');
    const isManifestSize = (item.kind === 'hls' || item.kind === 'dash') &&
      item.bytes != null && item.bytes < 50 * 1024;
    const sizeStr = isManifestSize ? null : formatBytes(item.bytes);
    if (sizeStr) sizePill.textContent = sizeStr;
    else sizePill.remove();

    const sourcePill = node.querySelector('.source-pill');
    const sourceText = item.source && item.source !== 'dom' && item.source !== 'network'
      ? item.source
      : shortHost(item.url);
    if (sourceText) {
      sourcePill.textContent = sourceText;
      sourcePill.title = hostFromUrl(item.url);
    } else {
      sourcePill.remove();
    }

    const thumbImg = node.querySelector('.thumb-img');
    if (item.poster) {
      thumbImg.src = item.poster;
      thumbImg.addEventListener('error', () => thumbImg.classList.add('broken'), { once: true });
    } else {
      thumbImg.classList.add('broken');
    }

    node.querySelector('.edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      makeTitleEditable(titleEl, item);
    });

    node.querySelector('.dismiss').addEventListener('click', () => {
      dismissed.add(item.url);
      render();
    });

    const moreBtn = node.querySelector('.more');
    moreBtn.addEventListener('click', () => copyUrl(item, moreBtn));

    const dlBtn = node.querySelector('.dl');
    dlBtn.addEventListener('click', () => startDownload(item, dlBtn));

    listEl.appendChild(node);
  });
}

toggleEl.addEventListener('click', () => {
  showHidden = !showHidden;
  render();
});

async function refreshTier() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  if (status) renderTier(status);
  return status;
}

async function startDownload(item, btn) {
  setDownloadButton(btn, 'Saving…', { disabled: true });
  const filename = chooseFilename(item);
  if (item.kind === 'hls' || item.kind === 'dash') {
    const res = await chrome.runtime.sendMessage({
      type: 'download-stream',
      format: item.kind,
      url: item.url,
      filename,
    });
    if (res?.error === 'paywall') {
      setDownloadButton(btn, 'Download');
      showPaywall(res);
      return;
    }
    if (!res?.ok) {
      setDownloadButton(btn, 'Retry');
      console.error('VidLoad stream start failed:', res?.error);
      return;
    }
    activeJobs.set(res.jobId, { btn });
    refreshTier();
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'download',
    url: item.url,
    filename,
  });
  if (res?.error === 'paywall') {
    setDownloadButton(btn, 'Download');
    showPaywall(res);
    return;
  }
  if (res?.ok) {
    setDownloadButton(btn, 'Saved', { disabled: true });
    btn.title = '';
    refreshTier();
  } else {
    setDownloadButton(btn, 'Retry');
    btn.title = `Download failed: ${res?.error || 'unknown error'}`;
    console.error('VidLoad download failed:', res?.error);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.jobId || !activeJobs.has(msg.jobId)) return;
  const { btn } = activeJobs.get(msg.jobId);
  if (msg.type === 'stream-progress') {
    if (msg.phase === 'manifest') setDownloadButton(btn, 'Reading…', { disabled: true });
    else if (msg.phase === 'save') setDownloadButton(btn, 'Finalizing…', { disabled: true });
    else setDownloadButton(btn, `${msg.current}/${msg.total}`, { disabled: true });
    btn.title = '';
  } else if (msg.type === 'stream-done') {
    setDownloadButton(btn, 'Saved', { disabled: true });
    btn.title = '';
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'stream-error') {
    setDownloadButton(btn, 'Retry');
    btn.title = `Download failed: ${msg.error || 'unknown error'}`;
    console.error('VidLoad stream error:', msg.error);
    activeJobs.delete(msg.jobId);
  }
});

(async () => {
  await refreshTier();
  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    statusEl.textContent = 'No active tab.';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'list', tabId });
  allItems = res?.items || [];
  render();
})();
