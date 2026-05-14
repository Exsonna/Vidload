const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('row-template');
const toggleEl = document.getElementById('toggle-hidden');

const MIN_DIRECT_BYTES = 100 * 1024;

const activeJobs = new Map();
let allItems = [];
let showHidden = false;
const dismissed = new Set();

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
  // Collapse long CDN hostnames like instagram.fhkg4-2.fna.fbcdn.net → fbcdn.net.
  // For 2-segment hosts (instagram.com) returns as-is.
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

function formatFromKind(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'MPD';
  try {
    const path = new URL(item.url).pathname;
    const m = path.match(/\.(mp4|webm|mov|m4v|m4a|ts)(?:$|\?)/i);
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
  if (item.kind === 'hls' || item.kind === 'dash') return ''; // engine appends .mp4/.ts
  try {
    const m = new URL(item.url).pathname.match(/\.(\w{2,4})(?:$|\?)/);
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
  if (!ext) return base; // HLS/DASH — engine decides
  return new RegExp(`${ext.replace('.', '\\.')}$`, 'i').test(base) ? base : `${base}${ext}`;
}

function makeTitleEditable(titleEl, item, rowEl) {
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
    node.querySelector('.thumb-duration').textContent = formatDuration(item.duration) || '';
    node.querySelector('.thumb-kind').textContent = item.kind;

    const sizeStr = formatBytes(item.bytes);
    const sizePill = node.querySelector('.size-pill');
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
      makeTitleEditable(titleEl, item, node);
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
    if (!res?.ok) {
      setDownloadButton(btn, 'Retry');
      console.error('VidLoad stream start failed:', res?.error);
      return;
    }
    activeJobs.set(res.jobId, { btn });
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'download',
    url: item.url,
    filename,
  });
  if (res?.ok) {
    setDownloadButton(btn, 'Saved', { disabled: true });
  } else {
    setDownloadButton(btn, 'Retry');
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
  } else if (msg.type === 'stream-done') {
    setDownloadButton(btn, 'Saved', { disabled: true });
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'stream-error') {
    setDownloadButton(btn, 'Retry');
    console.error('VidLoad stream error:', msg.error);
    activeJobs.delete(msg.jobId);
  }
});

(async () => {
  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    statusEl.textContent = 'No active tab.';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'list', tabId });
  allItems = res?.items || [];
  render();
})();
