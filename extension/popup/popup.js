const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('row-template');
const toggleEl = document.getElementById('toggle-hidden');

// Minimum byte size for a direct/network item to be considered "real video".
// Anything smaller is almost always a probe response, adaptive sub-segment,
// or otherwise not a user-facing video. Items with metadata (poster, dimensions,
// duration, description) or non-direct kinds bypass this filter.
const MIN_DIRECT_BYTES = 100 * 1024;

const activeJobs = new Map();
let allItems = [];
let showHidden = false;

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setButton(btn, text, opts = {}) {
  btn.textContent = text;
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

function looksLikeGibberish(s) {
  if (!s) return true;
  const cleaned = s.replace(/\.\w{1,5}$/, '').replace(/[-_]/g, '');
  if (cleaned.length < 12) return false;
  // High-entropy alphanumeric strings with no spaces = encrypted CDN paths
  return /^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length >= 16;
}

function hasMetadata(item) {
  return !!(item.poster || item.description || item.duration || (item.width && item.height));
}

function isFilteredOut(item) {
  if (item.kind !== 'direct') return false; // HLS/DASH playlists pass
  if (item.source !== 'network') return false; // Adapter/DOM items pass
  if (hasMetadata(item)) return false;
  if (item.bytes != null && item.bytes < MIN_DIRECT_BYTES) return true;
  return false;
}

function chooseTitle(item) {
  if (item.description) return item.description;
  if (item.pageTitle && item.source !== 'network') return item.pageTitle;
  if (looksLikeGibberish(item.label)) {
    const host = hostFromUrl(item.url);
    return host ? `Video on ${host}` : `${item.kind.toUpperCase()} stream`;
  }
  return item.label;
}

function chooseSub(item) {
  const parts = [];
  const q = qualityLabel(item.width, item.height);
  if (q) parts.push(q);
  if (item.width && item.height && !q) parts.push(`${item.width}×${item.height}`);
  const dur = formatDuration(item.duration);
  if (dur) parts.push(dur);
  const size = formatBytes(item.bytes);
  if (size) parts.push(size);
  if (item.source && item.source !== 'dom' && item.source !== 'network') {
    parts.push(item.source);
  }
  return parts.join(' · ');
}

function render() {
  const visible = showHidden ? allItems : allItems.filter((it) => !isFilteredOut(it));
  const hiddenCount = allItems.length - (showHidden ? allItems.length : visible.length);

  listEl.replaceChildren();
  if (allItems.length === 0) {
    statusEl.textContent = 'No videos detected on this page yet. Try scrolling or hitting play.';
    toggleEl.hidden = true;
    return;
  }
  if (visible.length === 0) {
    statusEl.textContent = `${allItems.length} item${allItems.length === 1 ? '' : 's'} detected — all filtered as probes/segments.`;
  } else if (hiddenCount > 0) {
    statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} · ${hiddenCount} small item${hiddenCount === 1 ? '' : 's'} hidden.`;
  } else {
    statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} detected.`;
  }

  toggleEl.hidden = hiddenCount === 0 && !showHidden;
  toggleEl.textContent = showHidden
    ? `Hide small items (${allItems.length - allItems.filter((it) => !isFilteredOut(it)).length})`
    : `Show ${hiddenCount} hidden small item${hiddenCount === 1 ? '' : 's'}`;

  visible.forEach((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);

    node.querySelector('.title').textContent = chooseTitle(item);
    node.querySelector('.sub').textContent = chooseSub(item) || item.kind.toUpperCase();
    node.querySelector('.url').textContent = hostFromUrl(item.url);

    const thumbImg = node.querySelector('.thumb-img');
    if (item.poster) {
      thumbImg.src = item.poster;
      thumbImg.addEventListener('error', () => thumbImg.classList.add('broken'), { once: true });
    } else {
      thumbImg.classList.add('broken');
    }

    const q = qualityLabel(item.width, item.height);
    node.querySelector('.thumb-quality').textContent = q || '';
    node.querySelector('.thumb-kind').textContent = item.kind;

    const btn = node.querySelector('.dl');
    btn.addEventListener('click', () => startDownload(item, btn));
    listEl.appendChild(node);
  });
}

toggleEl.addEventListener('click', () => {
  showHidden = !showHidden;
  render();
});

async function startDownload(item, btn) {
  setButton(btn, 'Saving…', { disabled: true });
  if (item.kind === 'hls' || item.kind === 'dash') {
    const res = await chrome.runtime.sendMessage({
      type: 'download-stream',
      format: item.kind,
      url: item.url,
      filename: item.label,
    });
    if (!res?.ok) {
      setButton(btn, 'Retry');
      console.error('VidLoad stream start failed:', res?.error);
      return;
    }
    activeJobs.set(res.jobId, { btn, kind: item.kind });
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'download',
    url: item.url,
    filename: item.label,
  });
  if (res?.ok) {
    setButton(btn, 'Saved', { disabled: true });
  } else {
    setButton(btn, 'Retry');
    console.error('VidLoad download failed:', res?.error);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.jobId || !activeJobs.has(msg.jobId)) return;
  const { btn } = activeJobs.get(msg.jobId);
  if (msg.type === 'stream-progress') {
    if (msg.phase === 'manifest') setButton(btn, 'Reading…', { disabled: true });
    else if (msg.phase === 'save') setButton(btn, 'Finalizing…', { disabled: true });
    else setButton(btn, `${msg.current}/${msg.total}`, { disabled: true });
  } else if (msg.type === 'stream-done') {
    setButton(btn, 'Saved', { disabled: true });
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'stream-error') {
    setButton(btn, 'Retry');
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
