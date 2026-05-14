const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('row-template');

// jobId -> { btn, kind }
const activeJobs = new Map();

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

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function chooseTitle(item) {
  if (item.description) return item.description;
  if (item.pageTitle && item.source !== 'network') return item.pageTitle;
  return item.label;
}

function chooseSub(item) {
  const parts = [];
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  const dur = formatDuration(item.duration);
  if (dur) parts.push(dur);
  const size = formatBytes(item.bytes);
  if (size) parts.push(size);
  if (item.source && item.source !== 'dom' && item.source !== 'network') {
    parts.push(item.source);
  } else if (item.source === 'network') {
    parts.push('network');
  }
  return parts.join(' · ');
}

function render(items) {
  listEl.replaceChildren();
  if (!items || items.length === 0) {
    statusEl.textContent =
      'No videos detected on this page yet. Try scrolling or hitting play.';
    return;
  }
  statusEl.textContent = `${items.length} video${items.length === 1 ? '' : 's'} detected.`;
  items.forEach((item) => {
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
    node.querySelector('.thumb-kind').textContent = item.kind;

    const btn = node.querySelector('.dl');
    btn.addEventListener('click', () => startDownload(item, btn));
    listEl.appendChild(node);
  });
}

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
  render(res?.items || []);
})();
