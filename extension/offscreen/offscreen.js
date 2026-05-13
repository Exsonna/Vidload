// VidLoad streaming download engine — runs inside the offscreen document so
// fetches survive the service worker's 30s idle suspension and we can use the
// full fetch/Blob/Web Crypto/DOMParser APIs.
//
// Handles both HLS (.m3u8) and DASH (.mpd) via a shared segment-download path.

import {
  parseM3U8,
  pickBestVariant,
  importAesKey,
  decryptSegment,
  parseHexIV,
  sequenceToIV,
  guessOutputExtension,
} from '../lib/hls.js';
import { parseDASH } from '../lib/dash.js';

const MAX_PARALLEL_FETCHES = 5;
const MAX_RETRIES = 2;
const REVOKE_DELAY_MS = 60_000;
const PLAYLIST_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 60_000;

const log = (...args) => console.log('[VidLoad stream]', ...args);
const warn = (...args) => console.warn('[VidLoad stream]', ...args);

log('offscreen worker loaded');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'fetch-stream') {
    log('received fetch-stream', { jobId: msg.jobId, format: msg.format, url: msg.url });
    const runner = msg.format === 'dash' ? runDashJob : runHlsJob;
    runner(msg.jobId, msg.url, msg.filename).catch((err) => {
      warn('job failed', err);
      sendStatus({ type: 'stream-error', jobId: msg.jobId, error: String(err?.message || err) });
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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  log('fetchText', url);
  const res = await fetchWithTimeout(url, PLAYLIST_TIMEOUT_MS);
  return res.text();
}

async function fetchBytes(url) {
  const res = await fetchWithTimeout(url, SEGMENT_TIMEOUT_MS);
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
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

async function downloadSegments({ jobId, parsed, totalSteps, decryptor }) {
  let completed = 0;
  const tick = (detail) => {
    completed += 1;
    sendStatus({
      type: 'stream-progress',
      jobId,
      phase: 'segments',
      current: completed,
      total: totalSteps,
      detail,
    });
  };

  const parts = [];
  if (parsed.initSegment) {
    log('fetching init segment', parsed.initSegment.uri);
    parts.push(await fetchBytesWithRetry(parsed.initSegment.uri));
    tick('init segment');
  }

  const buffers = new Array(parsed.segments.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= parsed.segments.length) return;
      const seg = parsed.segments[idx];
      let bytes = await fetchBytesWithRetry(seg.uri);
      if (decryptor) bytes = await decryptor(bytes, seg);
      buffers[idx] = bytes;
      tick(`segment ${idx + 1}/${parsed.segments.length}`);
    }
  }

  log(`starting ${Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length)} parallel workers for ${parsed.segments.length} segments`);
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length) },
      () => worker()
    )
  );
  log('all segments fetched');

  for (const buf of buffers) parts.push(buf);
  return parts;
}

async function finalize(jobId, parts, ext, baseFilename, totalSteps) {
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  const finalName = deriveFilename(baseFilename, ext);
  log('blob assembled', { size: blob.size, ext, finalName });
  sendStatus({ type: 'stream-progress', jobId, phase: 'save', current: totalSteps, total: totalSteps });

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename: finalName, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(blobUrl);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_DELAY_MS);
        log('download started', { downloadId, finalName });
        sendStatus({ type: 'stream-done', jobId, filename: finalName, downloadId, bytes: blob.size });
        resolve();
      }
    });
  });
}

async function runHlsJob(jobId, playlistUrl, baseFilename) {
  log('HLS job start', { jobId, playlistUrl });
  sendStatus({ type: 'stream-progress', jobId, phase: 'manifest', current: 0, total: 1 });

  let manifestText;
  try {
    manifestText = await fetchText(playlistUrl);
  } catch (err) {
    throw new Error(`Could not fetch playlist: ${err.message}`);
  }
  let parsed = parseM3U8(manifestText, playlistUrl);
  log('parsed M3U8', {
    isMaster: parsed.isMaster,
    variants: parsed.variants.length,
    segments: parsed.segments.length,
  });

  if (parsed.isMaster) {
    if (parsed.variants.length === 0) throw new Error('Master playlist has no variants');
    const variant = pickBestVariant(parsed.variants);
    log('picked variant', variant);
    sendStatus({
      type: 'stream-progress',
      jobId,
      phase: 'manifest',
      current: 1,
      total: 1,
      detail: `variant ${variant.resolution || variant.bandwidth}`,
    });
    manifestText = await fetchText(variant.uri);
    parsed = parseM3U8(manifestText, variant.uri);
  }

  if (parsed.segments.length === 0) {
    throw new Error('No segments in HLS playlist (live stream without #EXT-X-ENDLIST?)');
  }

  const keyCache = new Map();
  const decryptor = async (bytes, seg) => {
    if (!seg.key) return bytes;
    if (!keyCache.has(seg.key.uri)) {
      const keyBytes = await fetchBytesWithRetry(seg.key.uri);
      keyCache.set(seg.key.uri, await importAesKey(keyBytes));
    }
    const cryptoKey = keyCache.get(seg.key.uri);
    const iv = seg.key.iv ? parseHexIV(seg.key.iv) : sequenceToIV(seg.sequence);
    const plain = await decryptSegment(bytes.buffer, cryptoKey, iv);
    return new Uint8Array(plain);
  };

  const totalSteps = (parsed.initSegment ? 1 : 0) + parsed.segments.length;
  const parts = await downloadSegments({ jobId, parsed, totalSteps, decryptor });
  const ext = guessOutputExtension(parsed.segments, parsed.initSegment);
  await finalize(jobId, parts, ext, baseFilename, totalSteps);
}

async function runDashJob(jobId, mpdUrl, baseFilename) {
  log('DASH job start', { jobId, mpdUrl });
  sendStatus({ type: 'stream-progress', jobId, phase: 'manifest', current: 0, total: 1 });

  let mpdText;
  try {
    mpdText = await fetchText(mpdUrl);
  } catch (err) {
    throw new Error(`Could not fetch MPD: ${err.message}`);
  }
  const best = parseDASH(mpdText, mpdUrl);
  log('parsed MPD', {
    bandwidth: best.bandwidth,
    width: best.width,
    height: best.height,
    segments: best.segments.length,
    hasInit: !!best.initSegment,
  });

  sendStatus({
    type: 'stream-progress',
    jobId,
    phase: 'manifest',
    current: 1,
    total: 1,
    detail: `${best.width}x${best.height} @ ${Math.round(best.bandwidth / 1000)}kbps`,
  });

  const totalSteps = (best.initSegment ? 1 : 0) + best.segments.length;
  const parts = await downloadSegments({ jobId, parsed: best, totalSteps });
  await finalize(jobId, parts, 'mp4', baseFilename, totalSteps);
}

function deriveFilename(label, ext) {
  let base = (label || `vidload-${Date.now()}`).replace(/\.(m3u8|mpd)(\?.*)?$/i, '');
  base = base.replace(/[\\/:*?"<>|]/g, '_');
  if (new RegExp(`\\.${ext}$`, 'i').test(base)) return base;
  return `${base}.${ext}`;
}
