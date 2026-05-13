const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('row-template');

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
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
    if (item.kind !== 'direct') {
      btn.disabled = true;
      btn.title = 'Stream-format downloads (HLS/DASH) arrive in v0.2.';
      btn.textContent = 'Soon';
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const res = await chrome.runtime.sendMessage({
        type: 'download',
        url: item.url,
        filename: item.label,
      });
      if (res?.ok) {
        btn.textContent = 'Saved';
      } else {
        btn.disabled = false;
        btn.textContent = 'Retry';
        console.error('VidLoad download failed:', res?.error);
      }
    });
    listEl.appendChild(node);
  });
}

(async () => {
  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    statusEl.textContent = 'No active tab.';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'list', tabId });
  render(res?.items || []);
})();
