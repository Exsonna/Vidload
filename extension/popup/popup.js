// =============================================================================
// Error surface — registered BEFORE any DOM access so even module-load
// failures show up as a red banner instead of dying silently.
// =============================================================================
function showError(message) {
  console.error('[VidLoad popup]', message);
  try {
    let banner = document.getElementById('vidload-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'vidload-error-banner';
      banner.style.cssText =
        'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:6px;' +
        'margin:8px;padding:8px 10px;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;';
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.textContent = String(message);
  } catch (e) {
    /* document not ready yet, console is our fallback */
  }
}
window.addEventListener('error', (ev) => {
  showError(
    `Uncaught: ${ev.message}\n` +
    `${ev.filename}:${ev.lineno}:${ev.colno}\n` +
    (ev.error?.stack || '')
  );
});
window.addEventListener('unhandledrejection', (ev) => {
  showError(
    `Unhandled rejection: ${ev.reason?.message || ev.reason}\n` +
    (ev.reason?.stack || '')
  );
});

// =============================================================================
// DOM references (returns null if missing — every use below is null-guarded)
// =============================================================================
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
const menuEl = document.getElementById('row-menu');
let menuTarget = null; // { item, rowEl }

// Surface missing elements early so we know what's wrong.
{
  const required = { listEl, statusEl, tpl };
  const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) showError(`Missing DOM element(s) in popup.html: ${missing.join(', ')}`);
}

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
  if (!btn) return;
  const label = btn.querySelector('.dl-label');
  if (label) label.textContent = text;
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
  return !!(item?.poster || item?.description || item?.duration || (item?.width && item?.height));
}

function isFilteredOut(item) {
  if (!item) return true;
  if (item.kind !== 'direct') return false;
  if (item.source !== 'network') return false;
  if (hasMetadata(item)) return false;
  if (item.bytes != null && item.bytes < MIN_DIRECT_BYTES) return true;
  return false;
}

const VIDEO_EXT_RE = /\.(mp4|m4s|m4v|m4a|mov|webm|ts|mkv|avi)(?:$|\?)/i;

function formatFromKind(item) {
  if (!item) return 'MP4';
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
  if (!item) return '.mp4';
  if (item.kind === 'hls' || item.kind === 'dash') return '';
  try {
    const m = new URL(item.url).pathname.match(VIDEO_EXT_RE);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return '.mp4';
}

function chooseTitle(item) {
  if (!item) return 'Unknown';
  if (item.userLabel) return item.userLabel;
  if (item.contextLabel) return item.contextLabel;
  if (item.description) return item.description;
  if (item.pageTitle && item.source !== 'network') return item.pageTitle;
  if (looksLikeGibberish(item.label)) {
    const host = shortHost(item.url);
    return host ? `Video on ${host}` : `${(item.kind || 'video').toUpperCase()} stream`;
  }
  return item.label || 'Video';
}

function chooseFilename(item) {
  if (!item) return `vidload-${Date.now()}.mp4`;
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
  if (!titleEl) return;
  titleEl.contentEditable = 'true';
  titleEl.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {}

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
    btn?.classList.add('copied');
    setTimeout(() => btn?.classList.remove('copied'), 1200);
  } catch (e) {
    console.error('VidLoad: clipboard write failed', e);
  }
}

function showRowMenu(item, anchorBtn, rowEl) {
  if (!menuEl || !anchorBtn) return;
  menuTarget = { item, rowEl, anchorBtn };
  // Make menu visible first (so we can measure its size) but offscreen.
  menuEl.style.visibility = 'hidden';
  menuEl.hidden = false;
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = menuEl.offsetWidth || 200;
  const menuH = menuEl.offsetHeight || 180;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 4) top = Math.max(4, rect.top - menuH - 4);
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${left}px`;
  menuEl.style.visibility = '';
}

function hideRowMenu() {
  if (!menuEl) return;
  menuEl.hidden = true;
  menuTarget = null;
}

menuEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !menuTarget) return;
  const action = btn.dataset.action;
  const { item, rowEl } = menuTarget;
  hideRowMenu();
  try {
    if (action === 'copy-url') {
      const moreBtn = rowEl?.querySelector('.more');
      copyUrl(item, moreBtn);
    } else if (action === 'open-tab') {
      chrome.tabs.create({ url: item.url });
    } else if (action === 'save-as') {
      const dlBtn = rowEl?.querySelector('.dl');
      if (dlBtn) startDownload(item, dlBtn, { saveAs: true });
    } else if (action === 'dismiss') {
      dismissed.add(item.url);
      render();
    }
  } catch (err) {
    showError(`Menu action "${action}" failed: ${err?.message || err}`);
  }
});

// Outside-click and Escape dismiss the menu. Re-clicking another kebab
// doesn't trigger this branch — the kebab's own handler reopens it on the
// new row.
document.addEventListener('click', (e) => {
  if (!menuEl || menuEl.hidden) return;
  if (menuEl.contains(e.target)) return;
  if (e.target.closest('.more')) return;
  hideRowMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideRowMenu();
});
// Scrolling the list moves the kebab but the fixed menu stays put — easier
// to dismiss than to track.
listEl?.addEventListener('scroll', () => hideRowMenu(), { passive: true });

// Probe HLS/DASH manifests for duration + bandwidth + resolution. We don't get
// any of these from webRequest headers — the playlist content is the only
// source. Results enrich the item: duration -> overlay, bandwidth*duration/8 ->
// estimated size pill, resolution -> quality badge.
async function probeStreamMetadata(item) {
  try {
    const res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) return null;
    const text = await res.text();
    if (item.kind === 'hls') return await parseHlsMetadata(text, item.url);
    if (item.kind === 'dash') return parseDashMetadata(text);
  } catch (err) {
    console.debug('VidLoad: metadata probe failed for', item?.url, err?.message || err);
  }
  return null;
}

async function parseHlsMetadata(text, baseUrl) {
  let bandwidth = null;
  let width = null;
  let height = null;

  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    let bestBw = 0;
    let bestUrl = null;
    let bestW = null;
    let bestH = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
      const bwVal = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith('#')) j++;
      const next = lines[j]?.trim();
      if (next && bwVal > bestBw) {
        bestBw = bwVal;
        bestUrl = new URL(next, baseUrl).href;
        if (resMatch) {
          bestW = parseInt(resMatch[1], 10);
          bestH = parseInt(resMatch[2], 10);
        }
      }
    }
    if (!bestUrl) return null;
    bandwidth = bestBw;
    width = bestW;
    height = bestH;
    const res = await fetch(bestUrl, { credentials: 'include' });
    if (!res.ok) return { duration: null, bandwidth, width, height };
    text = await res.text();
  }

  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) total += parseFloat(m[1]);
  }
  const duration = total > 0 ? Math.round(total) : null;
  return { duration, bandwidth, width, height };
}

function parseDashMetadata(mpdText) {
  let duration = null;
  const dm = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
  if (dm) {
    const d = dm[1].match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
    if (d) {
      const seconds =
        parseFloat(d[1] || 0) * 86400 +
        parseFloat(d[2] || 0) * 3600 +
        parseFloat(d[3] || 0) * 60 +
        parseFloat(d[4] || 0);
      if (seconds > 0) duration = Math.round(seconds);
    }
  }

  let bandwidth = 0;
  let width = null;
  let height = null;
  const reps = mpdText.match(/<Representation[^>]*>/gi) || [];
  for (const rep of reps) {
    const bw = parseInt(rep.match(/bandwidth="(\d+)"/i)?.[1] || '0', 10);
    if (bw <= bandwidth) continue;
    bandwidth = bw;
    const w = parseInt(rep.match(/width="(\d+)"/i)?.[1] || '0', 10);
    const h = parseInt(rep.match(/height="(\d+)"/i)?.[1] || '0', 10);
    width = w || null;
    height = h || null;
  }
  return { duration, bandwidth: bandwidth || null, width, height };
}

function maybeProbeMetadata(item, refs) {
  if (!item || item._probed) return;
  if (item.kind !== 'hls' && item.kind !== 'dash') return;
  item._probed = true;
  probeStreamMetadata(item)
    .then((meta) => {
      if (!meta) return;
      if (meta.duration && !item.duration) {
        item.duration = meta.duration;
        if (refs.durEl?.isConnected) refs.durEl.textContent = formatDuration(meta.duration);
      }
      if (meta.width && meta.height && !item.width) {
        item.width = meta.width;
        item.height = meta.height;
        const q = qualityLabel(meta.width, meta.height);
        if (q && refs.qualityEl?.isConnected) refs.qualityEl.textContent = q;
      }
      if (meta.bandwidth && (meta.duration || item.duration)) {
        const dur = meta.duration || item.duration;
        item.estimatedBytes = Math.round((meta.bandwidth * dur) / 8);
        if (refs.sizePill?.isConnected) {
          refs.sizePill.textContent = '~' + formatBytes(item.estimatedBytes);
        }
      }
    })
    .catch((err) => console.debug('VidLoad: probe rejected', err?.message || err));
}

function renderTier(status) {
  if (!tierBadgeEl) return;
  tierStatus = status || tierStatus;
  if (!status?.monetizationEnabled) {
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
  if (!paywallEl) return;
  paywallEl.hidden = false;
  if (listEl) listEl.hidden = true;
  if (footerEl) footerEl.hidden = true;
  if (detail && paywallDetailEl) {
    paywallDetailEl.textContent = `You've used ${detail.used} of ${detail.limit} free downloads today.`;
  }
  if (detail?.priceLabel && paywallPriceEl) {
    paywallPriceEl.textContent = detail.priceLabel.replace(/\s+one-time.*$/i, '') || '$4.99';
  }
  if (paywallFootEl) {
    paywallFootEl.textContent = tierStatus?.monetizationEnabled
      ? 'Counter resets at midnight local time.'
      : 'Monetization is disabled in this build — this is a preview of the paywall UI.';
  }
}

function hidePaywall() {
  if (paywallEl) paywallEl.hidden = true;
  if (listEl) listEl.hidden = false;
  if (footerEl) footerEl.hidden = false;
}

upgradeBtn?.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'open-payment-page' });
    if (!res?.ok) {
      if (paywallFootEl) paywallFootEl.textContent = res?.error || 'Could not open payment page.';
      return;
    }
    window.close();
  } catch (err) {
    showError(`Upgrade click failed: ${err?.message || err}`);
  }
});

paywallBackBtn?.addEventListener('click', () => hidePaywall());

function render() {
  if (!listEl || !statusEl) {
    showError('Cannot render — list or status element missing.');
    return;
  }
  try {
    const filtered = allItems.filter((it) => it && !dismissed.has(it.url));
    const visible = showHidden ? filtered : filtered.filter((it) => !isFilteredOut(it));
    const hiddenCount = filtered.length - visible.length;

    listEl.replaceChildren();
    if (allItems.length === 0) {
      statusEl.textContent = 'No videos detected on this page yet. Try scrolling or hitting play.';
      if (toggleEl) toggleEl.hidden = true;
      return;
    }
    if (filtered.length === 0) {
      statusEl.textContent = 'All items dismissed.';
      if (toggleEl) toggleEl.hidden = true;
      return;
    }
    if (visible.length === 0) {
      statusEl.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'} detected — all filtered as probes/segments.`;
    } else if (hiddenCount > 0) {
      statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} · ${hiddenCount} small item${hiddenCount === 1 ? '' : 's'} hidden.`;
    } else {
      statusEl.textContent = `${visible.length} video${visible.length === 1 ? '' : 's'} detected.`;
    }

    if (toggleEl) {
      toggleEl.hidden = hiddenCount === 0 && !showHidden;
      toggleEl.textContent = showHidden
        ? 'Hide small probe items'
        : `Show ${hiddenCount} hidden small item${hiddenCount === 1 ? '' : 's'}`;
    }

    visible.forEach((item) => {
      try { renderRow(item); } catch (err) {
        console.error('VidLoad: row render failed for', item, err);
        showError(`Row render failed: ${err?.message || err}\n${err?.stack || ''}`);
      }
    });
  } catch (err) {
    showError(`Render failed: ${err?.message || err}\n${err?.stack || ''}`);
  }
}

function renderRow(item) {
  if (!tpl || !listEl) return;
  const node = tpl.content.firstElementChild?.cloneNode(true);
  if (!node) return;

  const titleEl = node.querySelector('.title');
  if (titleEl) titleEl.textContent = chooseTitle(item);

  const formatBadge = node.querySelector('.format-badge');
  if (formatBadge) {
    formatBadge.textContent = formatFromKind(item);
    if (item.kind) formatBadge.classList.add(item.kind);
  }

  const quality = node.querySelector('.thumb-quality');
  if (quality) quality.textContent = qualityLabel(item.width, item.height) || '';

  const durEl = node.querySelector('.thumb-duration');
  if (durEl) durEl.textContent = formatDuration(item.duration) || '';

  const kindEl = node.querySelector('.thumb-kind');
  if (kindEl) kindEl.textContent = item.kind || '';

  const sizePill = node.querySelector('.size-pill');
  let keepSizePill = false;
  if (sizePill) {
    const isStream = item.kind === 'hls' || item.kind === 'dash';
    if (item.estimatedBytes) {
      sizePill.textContent = '~' + formatBytes(item.estimatedBytes);
      keepSizePill = true;
    } else if (isStream) {
      // Manifest-size bytes are misleading; leave the pill empty and let
      // maybeProbeMetadata fill it with the bandwidth*duration estimate.
      sizePill.textContent = '';
      keepSizePill = true;
    } else {
      const sizeStr = formatBytes(item.bytes);
      if (sizeStr) {
        sizePill.textContent = sizeStr;
        keepSizePill = true;
      }
    }
    if (!keepSizePill) sizePill.remove();
  }

  // Kick off the manifest probe — fills in duration overlay, resolution
  // badge, and estimated size pill as they resolve.
  maybeProbeMetadata(item, {
    durEl,
    qualityEl: quality,
    sizePill: keepSizePill ? sizePill : null,
  });

  const sourcePill = node.querySelector('.source-pill');
  if (sourcePill) {
    const sourceText = item.source && item.source !== 'dom' && item.source !== 'network'
      ? item.source
      : shortHost(item.url);
    if (sourceText) {
      sourcePill.textContent = sourceText;
      sourcePill.title = hostFromUrl(item.url);
    } else {
      sourcePill.remove();
    }
  }

  const thumbImg = node.querySelector('.thumb-img');
  if (thumbImg) {
    if (item.poster) {
      thumbImg.src = item.poster;
      thumbImg.addEventListener('error', () => thumbImg.classList.add('broken'), { once: true });
    } else {
      thumbImg.classList.add('broken');
    }
  }

  node.querySelector('.edit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (titleEl) makeTitleEditable(titleEl, item);
  });

  node.querySelector('.dismiss')?.addEventListener('click', () => {
    dismissed.add(item.url);
    render();
  });

  const moreBtn = node.querySelector('.more');
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showRowMenu(item, moreBtn, node);
  });

  const dlBtn = node.querySelector('.dl');
  dlBtn?.addEventListener('click', () => startDownload(item, dlBtn));

  listEl.appendChild(node);
}

toggleEl?.addEventListener('click', () => {
  showHidden = !showHidden;
  render();
});

async function refreshTier() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (status) renderTier(status);
    return status;
  } catch (err) {
    console.debug('VidLoad: get-status failed', err?.message || err);
    return null;
  }
}

async function startDownload(item, btn, opts = {}) {
  const saveAs = !!opts.saveAs;
  setDownloadButton(btn, 'Saving…', { disabled: true });
  const filename = chooseFilename(item);
  try {
    if (item.kind === 'hls' || item.kind === 'dash') {
      const res = await chrome.runtime.sendMessage({
        type: 'download-stream',
        format: item.kind,
        url: item.url,
        filename,
        saveAs,
      });
      if (res?.error === 'paywall') {
        setDownloadButton(btn, 'Download');
        showPaywall(res);
        return;
      }
      if (!res?.ok) {
        setDownloadButton(btn, 'Retry');
        if (btn) btn.title = `Download failed: ${res?.error || 'unknown error'}`;
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
      saveAs,
    });
    if (res?.error === 'paywall') {
      setDownloadButton(btn, 'Download');
      showPaywall(res);
      return;
    }
    if (res?.ok) {
      setDownloadButton(btn, 'Saved', { disabled: true });
      if (btn) btn.title = '';
      refreshTier();
    } else {
      setDownloadButton(btn, 'Retry');
      if (btn) btn.title = `Download failed: ${res?.error || 'unknown error'}`;
      console.error('VidLoad download failed:', res?.error);
    }
  } catch (err) {
    setDownloadButton(btn, 'Retry');
    if (btn) btn.title = `Download failed: ${err?.message || err}`;
    showError(`Download click failed: ${err?.message || err}`);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.jobId || !activeJobs.has(msg.jobId)) return;
  const { btn } = activeJobs.get(msg.jobId);
  if (msg.type === 'stream-progress') {
    if (msg.phase === 'manifest') setDownloadButton(btn, 'Reading…', { disabled: true });
    else if (msg.phase === 'save') setDownloadButton(btn, 'Finalizing…', { disabled: true });
    else setDownloadButton(btn, `${msg.current}/${msg.total}`, { disabled: true });
    if (btn) btn.title = '';
  } else if (msg.type === 'stream-done') {
    setDownloadButton(btn, 'Saved', { disabled: true });
    if (btn) btn.title = '';
    activeJobs.delete(msg.jobId);
  } else if (msg.type === 'stream-error') {
    setDownloadButton(btn, 'Retry');
    if (btn) btn.title = `Download failed: ${msg.error || 'unknown error'}`;
    console.error('VidLoad stream error:', msg.error);
    activeJobs.delete(msg.jobId);
  }
});

(async () => {
  try {
    await refreshTier();
    const tabId = await getActiveTabId();
    if (tabId === undefined) {
      if (statusEl) statusEl.textContent = 'No active tab.';
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'list', tabId });
    allItems = res?.items || [];
    render();
  } catch (err) {
    showError(`Startup failed: ${err?.message || err}\n${err?.stack || ''}`);
  }
})();
