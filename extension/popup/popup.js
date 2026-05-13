const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('row-template');

// jobId -> { btn, kind, totalCached }
const activeJobs = new Map();

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setButton(btn, text, opts = {}) {
  btn.textContent = text;
  btn.disabled = !!opts.disabled;
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
    node.querySelector('.name').textContent = item.label;
    const kindEl = node.querySelector('.kind');
    kindEl.textContent = `${item.kind}${item.source === 'network' ? ' · network' : ''}`;
    const btn = node.querySelector('.dl');
    if (item.kind === 'dash') {
      // DASH not implemented yet; HLS supported.
      setButton(btn, 'Soon', { disabled: true });
      btn.title = 'DASH download support arrives in a later version.';
    }
    btn.addEventListener('click', () => startDownload(item, btn));
    listEl.appendChild(node);
  });
}

async function startDownload(item, btn) {
  setButton(btn, 'Saving…', { disabled: true });
  if (item.kind === 'hls') {
    const res = await chrome.runtime.sendMessage({
      type: 'download-hls',
      url: item.url,
      filename: item.label,
    });
    if (!res?.ok) {
      setButton(btn, 'Retry');
      console.error('VidLoad HLS start failed:', res?.error);
      return;
    }
    activeJobs.set(res.jobId, { btn, kind: 'hls' });
    return;
  }
  // Direct download path (v0.1)
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
  const job = activeJobs.get(msg.jobId);
  const { btn } = job;
  if (msg.type === 'hls-progress') {
    if (msg.phase === 'manifest') {
      setButton(btn, 'Reading…', { disabled: true });
    } else if (msg.phase === 'save') {
      setButton(btn, 'Finalizing…', { disabled: true });
    } else {
      setButton(btn, `${msg.current}/${msg.total}`, { disabled: true });
    }
  } else if (msg.type === 'hls-done') {
    setButton(btn, 'Saved', { disabled: true });
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'hls-error') {
    setButton(btn, 'Retry');
    console.error('VidLoad HLS error:', msg.error);
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
