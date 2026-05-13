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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'fetch-hls') {
    runJob(msg.jobId, msg.url, msg.filename).catch((err) => {
      sendStatus({ type: 'hls-error', jobId: msg.jobId, error: String(err?.message || err) });
    });
  }
  return false;
});

function sendStatus(payload) {
  // Fire-and-forget; receivers may not be listening (popup closed, etc.).
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchBytes(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchBytes(url);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function runJob(jobId, playlistUrl, baseFilename) {
  sendStatus({ type: 'hls-progress', jobId, phase: 'manifest', current: 0, total: 1 });

  let manifestText = await fetchText(playlistUrl);
  let parsed = parseM3U8(manifestText, playlistUrl);

  // If this is a master playlist, resolve to its best variant.
  if (parsed.isMaster) {
    if (parsed.variants.length === 0) throw new Error('Master playlist has no variants');
    const variant = pickBestVariant(parsed.variants);
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
  }

  if (parsed.segments.length === 0) throw new Error('No segments found in HLS playlist');

  const totalSteps = (parsed.initSegment ? 1 : 0) + parsed.segments.length;
  let completed = 0;
  const tick = (detail) => {
    completed += 1;
    sendStatus({ type: 'hls-progress', jobId, phase: 'segments', current: completed, total: totalSteps, detail });
  };

  // Pre-warm AES keys (each unique key URI is fetched once).
  const keyCache = new Map();
  async function getKey(keyInfo) {
    if (!keyInfo) return null;
    if (!keyCache.has(keyInfo.uri)) {
      const keyBytes = await fetchWithRetry(keyInfo.uri);
      keyCache.set(keyInfo.uri, await importAesKey(keyBytes));
    }
    return keyCache.get(keyInfo.uri);
  }

  // Init segment first (fragmented MP4).
  const parts = [];
  if (parsed.initSegment) {
    parts.push(await fetchWithRetry(parsed.initSegment.uri));
    tick('init segment');
  }

  // Reserve segment slots so output order is deterministic regardless of fetch order.
  const segmentBuffers = new Array(parsed.segments.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= parsed.segments.length) return;
      const seg = parsed.segments[idx];
      let bytes = await fetchWithRetry(seg.uri);
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

  const workers = Array.from(
    { length: Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length) },
    () => worker()
  );
  await Promise.all(workers);

  for (const buf of segmentBuffers) parts.push(buf);

  // Concatenate to a single Blob and hand it off as a download.
  const ext = guessOutputExtension(parsed.segments, parsed.initSegment);
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  const finalName = deriveFilename(baseFilename, ext);

  sendStatus({ type: 'hls-progress', jobId, phase: 'save', current: totalSteps, total: totalSteps });

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename: finalName, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(blobUrl);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_DELAY_MS);
        sendStatus({ type: 'hls-done', jobId, filename: finalName, downloadId, bytes: blob.size });
        resolve();
      }
    });
  });
}

function deriveFilename(label, ext) {
  const base = (label || `vidload-${Date.now()}`).replace(/\.(m3u8|mpd)(\?.*)?$/i, '');
  if (new RegExp(`\\.${ext}$`, 'i').test(base)) return base;
  return `${base}.${ext}`;
}
