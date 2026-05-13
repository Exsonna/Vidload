// VidLoad HLS download engine — runs inside the offscreen document so
// it can survive the service worker's 30s idle suspension and use the
// full fetch/Blob/Web Crypto APIs.

import {
  parseM3U8,
  pickBestVariant,
  importAesKey,
  decryptSegment,
  parseHexIV,
  sequenceToIV,
  guessOutputExtension,
} from '../lib/hls.js';

const MAX_PARALLEL_FETCHES = 5;
const MAX_RETRIES = 2;
const REVOKE_DELAY_MS = 60_000;
const PLAYLIST_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 60_000;

const log = (...args) => console.log('[VidLoad HLS]', ...args);
const warn = (...args) => console.warn('[VidLoad HLS]', ...args);

log('offscreen worker loaded');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'fetch-hls') {
    log('received fetch-hls', { jobId: msg.jobId, url: msg.url, filename: msg.filename });
    runJob(msg.jobId, msg.url, msg.filename).catch((err) => {
      warn('runJob failed', err);
      sendStatus({
        type: 'hls-error',
        jobId: msg.jobId,
        error: String(err?.message || err),
      });
    });
  }
  return false;
});

function sendStatus(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
      ...options,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = PLAYLIST_TIMEOUT_MS) {
  log('fetchText', url);
  const res = await fetchWithTimeout(url, timeoutMs);
  return res.text();
}

async function fetchBytes(url, timeoutMs = SEGMENT_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, timeoutMs);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBytesWithRetry(url, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchBytes(url);
    } catch (err) {
      lastErr = err;
      warn(`fetch attempt ${attempt + 1}/${retries + 1} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

async function runJob(jobId, playlistUrl, baseFilename) {
  log('runJob start', { jobId, playlistUrl, baseFilename });
  sendStatus({ type: 'hls-progress', jobId, phase: 'manifest', current: 0, total: 1 });

  let manifestText;
  try {
    manifestText = await fetchText(playlistUrl);
  } catch (err) {
    throw new Error(`Could not fetch playlist: ${err.message}`);
  }
  log('manifest fetched, length=', manifestText.length);

  let parsed = parseM3U8(manifestText, playlistUrl);
  log('parsed manifest', {
    isMaster: parsed.isMaster,
    variants: parsed.variants.length,
    segments: parsed.segments.length,
    hasInit: !!parsed.initSegment,
  });

  if (parsed.isMaster) {
    if (parsed.variants.length === 0) throw new Error('Master playlist has no variants');
    const variant = pickBestVariant(parsed.variants);
    log('picked variant', variant);
    sendStatus({
      type: 'hls-progress',
      jobId,
      phase: 'manifest',
      current: 1,
      total: 1,
      detail: `variant ${variant.resolution || variant.bandwidth}`,
    });
    manifestText = await fetchText(variant.uri);
    parsed = parseM3U8(manifestText, variant.uri);
    log('media playlist parsed', { segments: parsed.segments.length, hasInit: !!parsed.initSegment });
  }

  if (parsed.segments.length === 0) {
    throw new Error('No segments found in HLS playlist (likely a live stream without #EXT-X-ENDLIST, or an unsupported variant)');
  }

  const totalSteps = (parsed.initSegment ? 1 : 0) + parsed.segments.length;
  let completed = 0;
  const tick = (detail) => {
    completed += 1;
    sendStatus({
      type: 'hls-progress',
      jobId,
      phase: 'segments',
      current: completed,
      total: totalSteps,
      detail,
    });
  };

  const keyCache = new Map();
  async function getKey(keyInfo) {
    if (!keyInfo) return null;
    if (!keyCache.has(keyInfo.uri)) {
      log('fetching AES key', keyInfo.uri);
      const keyBytes = await fetchBytesWithRetry(keyInfo.uri);
      keyCache.set(keyInfo.uri, await importAesKey(keyBytes));
    }
    return keyCache.get(keyInfo.uri);
  }

  const parts = [];
  if (parsed.initSegment) {
    log('fetching init segment', parsed.initSegment.uri);
    parts.push(await fetchBytesWithRetry(parsed.initSegment.uri));
    tick('init segment');
  }

  const segmentBuffers = new Array(parsed.segments.length);
  let nextIndex = 0;

  async function worker(workerId) {
    while (true) {
      const idx = nextIndex++;
      if (idx >= parsed.segments.length) return;
      const seg = parsed.segments[idx];
      let bytes = await fetchBytesWithRetry(seg.uri);
      if (seg.key) {
        const cryptoKey = await getKey(seg.key);
        const iv = seg.key.iv ? parseHexIV(seg.key.iv) : sequenceToIV(seg.sequence);
        const plain = await decryptSegment(bytes.buffer, cryptoKey, iv);
        bytes = new Uint8Array(plain);
      }
      segmentBuffers[idx] = bytes;
      tick(`segment ${idx + 1}/${parsed.segments.length}`);
    }
  }

  log(`starting ${Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length)} parallel workers for ${parsed.segments.length} segments`);
  const workers = Array.from(
    { length: Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length) },
    (_, i) => worker(i)
  );
  await Promise.all(workers);
  log('all segments fetched');

  for (const buf of segmentBuffers) parts.push(buf);

  const ext = guessOutputExtension(parsed.segments, parsed.initSegment);
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  const finalName = deriveFilename(baseFilename, ext);
  log('blob assembled', { size: blob.size, ext, finalName });

  sendStatus({ type: 'hls-progress', jobId, phase: 'save', current: totalSteps, total: totalSteps });

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename: finalName, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(blobUrl);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_DELAY_MS);
        log('download started', { downloadId, finalName });
        sendStatus({
          type: 'hls-done',
          jobId,
          filename: finalName,
          downloadId,
          bytes: blob.size,
        });
        resolve();
      }
    });
  });
}

function deriveFilename(label, ext) {
  let base = (label || `vidload-${Date.now()}`).replace(/\.(m3u8|mpd)(\?.*)?$/i, '');
  base = base.replace(/[\\/:*?"<>|]/g, '_');
  if (new RegExp(`\\.${ext}$`, 'i').test(base)) return base;
  return `${base}.${ext}`;
}
