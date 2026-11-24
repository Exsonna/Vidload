// VidLoad streaming download engine — runs inside the offscreen document so
// fetches survive the service worker's 30s idle suspension and we can use the
// full fetch/Blob/Web Crypto/DOMParser APIs.
//
// Handles both HLS (.m3u8) and DASH (.mpd) via a shared segment-download path.

import {
  parseM3U8,
  pickBestVariant,
  pickAudioRendition,
  importAesKey,
  decryptSegment,
  parseHexIV,
  sequenceToIV,
  guessOutputExtension,
} from '../lib/hls.js';
import { parseDASH } from '../lib/dash.js';

const MAX_PARALLEL_FETCHES = 5;
const MAX_RETRIES = 2;
// Everything is assembled in memory (segments + concat + transmux + Blob), so a
// very large stream can exhaust the offscreen document's heap. Abort with a
// clear message instead of dying with an opaque RangeError near 100%.
const MAX_TOTAL_BYTES = 2_000_000_000; // ~2 GB
const tooLargeError = () =>
  new Error(`Video too large to assemble in memory (over ${Math.round(MAX_TOTAL_BYTES / 1e9)} GB). Try a lower quality if available.`);
const REVOKE_DELAY_MS = 60_000;
const PLAYLIST_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 60_000;

const log = (...args) => console.log('[VidLoad stream]', ...args);
const warn = (...args) => console.warn('[VidLoad stream]', ...args);

log('offscreen worker loaded');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'fetch-stream') {
    log('received fetch-stream', { jobId: msg.jobId, format: msg.format, url: msg.url, saveAs: !!msg.saveAs });
    const runner = msg.format === 'dash' ? runDashJob : runHlsJob;
    runner(msg.jobId, msg.url, msg.filename, !!msg.saveAs, msg.audioUrl || null).catch((err) => {
      warn('job failed', err);
      sendStatus({ type: 'stream-error', jobId: msg.jobId, error: String(err?.message || err) });
    });
  } else if (msg.type === 'fetch-av') {
    // Two complete media files (a video-only + optional audio-only) to download
    // whole and mux into one MP4.
    log('received fetch-av', { jobId: msg.jobId, hasAudio: !!msg.audioUrl, saveAs: !!msg.saveAs });
    runMuxJob(msg.jobId, msg.videoUrl, msg.audioUrl, msg.filename, !!msg.saveAs).catch((err) => {
      warn('mux job failed', err);
      sendStatus({ type: 'stream-error', jobId: msg.jobId, error: String(err?.message || err) });
    });
  }
  return false;
});

function sendStatus(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// Transmux concatenated MPEG-TS bytes into a real (fragmented) MP4 using mux.js
// — same codecs (H.264/AAC), just a container rewrap, no re-encode. mux.js is
// loaded as a classic script by offscreen.html and lives on globalThis.muxjs.
// Returns an array of Uint8Array parts (init segment + media) on success.
function transmuxTsToMp4(tsParts) {
  return new Promise((resolve, reject) => {
    const mux = globalThis.muxjs;
    if (!mux?.mp4?.Transmuxer) {
      reject(new Error('mux.js transmuxer unavailable'));
      return;
    }
    let transmuxer;
    try {
      transmuxer = new mux.mp4.Transmuxer();
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    let init = null;
    transmuxer.on('data', (seg) => {
      if (!init && seg.initSegment) {
        init = seg.initSegment;
        out.push(seg.initSegment);
      }
      if (seg.data) out.push(seg.data);
    });
    transmuxer.on('done', () => {
      const total = out.reduce((n, p) => n + (p?.byteLength || 0), 0);
      if (!total) {
        reject(new Error('transmux produced no output (unsupported codec?)'));
        return;
      }
      resolve(out);
    });
    try {
      for (const part of tsParts) {
        transmuxer.push(part instanceof Uint8Array ? part : new Uint8Array(part));
      }
      transmuxer.flush();
    } catch (err) {
      reject(err);
    }
  });
}

// options may carry `headers` (e.g. a Range request) and an external `signal`
// (job-wide cancellation). We combine the external signal with our own timeout
// controller so either can abort the fetch.
async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const { signal: extSignal, ...rest } = options;
  const ctrl = new AbortController();
  const onExtAbort = () => ctrl.abort(extSignal?.reason);
  if (extSignal) {
    if (extSignal.aborted) ctrl.abort(extSignal.reason);
    else extSignal.addEventListener('abort', onExtAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`Fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      ...rest,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
    if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
  }
}

async function fetchText(url) {
  log('fetchText', url);
  const res = await fetchWithTimeout(url, PLAYLIST_TIMEOUT_MS);
  return res.text();
}

async function fetchBytes(url, options = {}) {
  const res = await fetchWithTimeout(url, SEGMENT_TIMEOUT_MS, options);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBytesWithRetry(url, retries = MAX_RETRIES, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new Error('cancelled');
    try {
      return await fetchBytes(url, options);
    } catch (err) {
      lastErr = err;
      if (options.signal?.aborted) throw err; // job cancelled — don't keep retrying
      warn(`fetch attempt ${attempt + 1}/${retries + 1} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

// Combine an array of byte chunks into one ArrayBuffer tagged with fileStart=0,
// which is what MP4Box.appendBuffer expects.
function concatToFileBuffer(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  const ab = out.buffer;
  ab.fileStart = 0;
  return ab;
}

// Mux a video-only stream and an audio-only stream (each a complete MP4, given
// as an array of byte chunks) into one playable MP4 using mp4box.js. Container
// remux only — no re-encode. The codec config is carried over by handing
// addTrack the parsed description box (avcC for H.264, esds for AAC) straight
// from the input, which mp4box adds to the output sample entry.
function muxAvToMp4(videoParts, audioParts) {
  return new Promise((resolve, reject) => {
    const MP4Box = globalThis.MP4Box;
    if (!MP4Box?.createFile) { reject(new Error('mp4box not loaded')); return; }

    const out = MP4Box.createFile();
    let pending = 2;
    let settled = false;
    const collected = []; // { outId, kind, samples, timescale } per ingested track
    const fail = (m) => { if (!settled) { settled = true; reject(new Error(m)); } };

    const finish = () => {
      if (settled || pending > 0) return;
      try {
        // Interleave samples across tracks in ~1-second windows. Real-world
        // players (VLC's mp4 demuxer in particular) expect audio chunks laid
        // out near their video neighbours; our previous all-video-then-all-
        // audio layout left the audio track unplayed in them.
        const idx = new Map(collected.map((r) => [r, 0]));
        const sums = {}; // outId -> { sum, timescale } — real durations for the header backfill
        for (let windowEnd = 1; windowEnd < 1e6; windowEnd++) {
          let remaining = false;
          for (const r of collected) {
            const limit = windowEnd * r.timescale;
            let i = idx.get(r);
            while (i < r.samples.length && (r.samples[i].dts || 0) < limit) {
              const s = r.samples[i++];
              out.addSample(r.outId, s.data, {
                duration: s.duration, cts: s.cts, dts: s.dts, is_sync: s.is_sync,
              });
              const rec = sums[r.outId] || (sums[r.outId] = { sum: 0, timescale: r.timescale });
              rec.sum += s.duration || 0;
            }
            idx.set(r, i);
            if (i < r.samples.length) remaining = true;
          }
          if (!remaining) break;
        }
        // Backfill real durations into mvhd/tkhd/mdhd. Fragmented inputs report
        // t.duration = 0; a 0-length header makes Windows Media Foundation fail
        // to read the file's length and never start its audio pipeline.
        try {
          const mvhd = out.moov && out.moov.mvhd;
          if (mvhd) {
            let movieDur = 0;
            for (const trak of out.moov.traks || []) {
              const rec = sums[trak.tkhd.track_id];
              if (!rec || !rec.sum) continue;
              trak.mdia.mdhd.duration = rec.sum;
              const tk = Math.round((rec.sum / rec.timescale) * mvhd.timescale);
              trak.tkhd.duration = tk;
              if (tk > movieDur) movieDur = tk;
            }
            if (movieDur > 0) mvhd.duration = movieDur;
          }
        } catch (e) { warn('duration backfill skipped:', e?.message || e); }
        const buf = out.getBuffer();
        if (!buf || buf.byteLength < 1024) { fail('mux produced empty output'); return; }
        settled = true;
        resolve([new Uint8Array(buf)]);
      } catch (e) { fail('mux finalize failed: ' + (e?.message || e)); }
    };

    const ingest = (parts, kind) => {
      try {
        const inFile = MP4Box.createFile();
        inFile.onError = (e) => fail(`${kind} parse error: ${e}`);
        inFile.onReady = (info) => {
          try {
            const t = ((kind === 'video' ? info.videoTracks : info.audioTracks) || [])[0]
              || (info.tracks || [])[0];
            if (!t) { fail(`no ${kind} track in stream`); return; }
            const inTrak = inFile.getTrackById(t.id);
            const entry = inTrak.mdia.minf.stbl.stsd.entries[0];
            const cfg = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C || entry.esds || entry.dOps || null;
            // Normalize the audio track to its real sample rate. X ships audio
            // with timescale 441000 (10× the 44100 sample rate) — spec-legal,
            // but picky demuxers mishandle it. Rescale timestamps by the exact
            // integer factor; non-integer ratios are left untouched.
            let timescale = t.timescale;
            let tsDiv = 1;
            const sampleRate = (t.audio && t.audio.sample_rate)
              || (t.timescale <= 65535 ? t.timescale : 44100);
            if (kind === 'audio' && sampleRate > 0 && timescale !== sampleRate && timescale % sampleRate === 0) {
              tsDiv = timescale / sampleRate;
              timescale = sampleRate;
            }
            const opts = {
              type: entry.type,
              timescale,
              duration: 0, // backfilled from real sample durations in finish()
              language: t.language || 'und',
              description: cfg,
              // mp4box defaults hdlr to "vide" for EVERY track — an audio track
              // written that way plays in lenient players (Chrome classifies by
              // the mp4a sample entry) but strict ones drop the audio.
              hdlr: kind === 'video' ? 'vide' : 'soun',
            };
            if (kind === 'video') {
              opts.width = (t.video && t.video.width) || t.track_width || 0;
              opts.height = (t.video && t.video.height) || t.track_height || 0;
            } else {
              opts.channel_count = (t.audio && t.audio.channel_count) || 2;
              opts.samplerate = sampleRate;
              opts.samplesize = (t.audio && t.audio.sample_size) || 16;
            }
            const outId = out.addTrack(opts);
            log(`mux ${kind} track`, { type: entry.type, hasConfig: !!cfg, outId, timescale, tsDiv });

            const samples = [];
            inFile.setExtractionOptions(t.id, null, { nbSamples: 10_000_000 });
            inFile.onSamples = (id, user, batch) => {
              for (const s of batch) {
                samples.push({
                  data: s.data,
                  duration: Math.round((s.duration || 0) / tsDiv),
                  cts: Math.round((s.cts || 0) / tsDiv),
                  dts: Math.round((s.dts || 0) / tsDiv),
                  is_sync: s.is_sync,
                });
              }
            };
            inFile.start();
            inFile.flush();
            log(`mux ${kind} samples`, samples.length);
            if (samples.length === 0) { fail(`${kind} stream had no samples`); return; }
            collected.push({ outId, kind, samples, timescale });
            pending -= 1;
            finish();
          } catch (e) { fail(`${kind} mux setup: ${e?.message || e}`); }
        };
        inFile.appendBuffer(concatToFileBuffer(parts));
        inFile.flush();
      } catch (e) { fail(`${kind} ingest: ${e?.message || e}`); }
    };

    ingest(videoParts, 'video');
    if (!settled) ingest(audioParts, 'audio');
  });
}

async function downloadSegments({ jobId, parsed, totalSteps, decryptor, startAt = 0 }) {
  let completed = startAt;
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

  // Job-wide cancellation: when one worker fails (or we blow the memory ceiling)
  // abort the rest instead of letting them keep fetching for a doomed job.
  const ctrl = new AbortController();
  let totalBytes = 0;
  const account = (n) => {
    totalBytes += n;
    if (totalBytes > MAX_TOTAL_BYTES) { ctrl.abort(); throw tooLargeError(); }
  };

  const parts = [];
  if (parsed.initSegment) {
    log('fetching init segment', parsed.initSegment.uri);
    const initBytes = await fetchBytesWithRetry(parsed.initSegment.uri, MAX_RETRIES, rangeOptions(parsed.initSegment, ctrl.signal));
    account(initBytes.byteLength);
    parts.push(initBytes);
    tick('init segment');
  }

  const buffers = new Array(parsed.segments.length);
  let nextIdx = 0;
  async function worker() {
    while (!ctrl.signal.aborted) {
      const idx = nextIdx++;
      if (idx >= parsed.segments.length) return;
      const seg = parsed.segments[idx];
      let bytes = await fetchBytesWithRetry(seg.uri, MAX_RETRIES, rangeOptions(seg, ctrl.signal));
      if (decryptor) bytes = await decryptor(bytes, seg);
      account(bytes.byteLength);
      buffers[idx] = bytes;
      tick(`segment ${idx + 1}/${parsed.segments.length}`);
    }
  }
  const runWorker = async () => {
    try { await worker(); }
    catch (err) { ctrl.abort(); throw err; } // first failure cancels siblings
  };

  log(`starting ${Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length)} parallel workers for ${parsed.segments.length} segments`);
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_PARALLEL_FETCHES, parsed.segments.length) },
      () => runWorker()
    )
  );
  log('all segments fetched');

  for (const buf of buffers) parts.push(buf);
  return parts;
}

// Build fetch options for a segment: the job-wide abort signal plus, for a
// byte-range segment (a single-file HLS resource sliced by #EXT-X-BYTERANGE),
// the Range header so we fetch only that slice instead of the whole file.
function rangeOptions(seg, signal) {
  const opts = { signal };
  if (seg?.byteRange) {
    const { offset, length } = seg.byteRange;
    opts.headers = { Range: `bytes=${offset}-${offset + length - 1}` };
  }
  return opts;
}

async function finalize(jobId, parts, ext, baseFilename, totalSteps, saveAs, warning = null) {
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  const finalName = deriveFilename(baseFilename, ext);
  log('blob assembled', { size: blob.size, ext, finalName, saveAs: !!saveAs });
  sendStatus({ type: 'stream-progress', jobId, phase: 'save', current: totalSteps, total: totalSteps });

  // chrome.downloads is not available inside offscreen documents — Chrome
  // restricts the API surface there. Hand the blob URL off to the SW, which
  // can call chrome.downloads.download. The URL is reachable across same-origin
  // extension contexts as long as offscreen stays alive (we keep it alive
  // long enough by awaiting the response).
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'commit-download',
      jobId,
      url: blobUrl,
      filename: finalName,
      saveAs: !!saveAs,
    });
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(`commit-download dispatch failed: ${err?.message || err}`);
  }
  if (!result?.ok) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(result?.error || 'commit-download failed');
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_DELAY_MS);
  log('download started', { downloadId: result.downloadId, finalName, warning: warning || undefined });
  sendStatus({ type: 'stream-done', jobId, filename: finalName, downloadId: result.downloadId, bytes: blob.size, warning });
}

async function runHlsJob(jobId, playlistUrl, baseFilename, saveAs, audioUrlHint = null) {
  log('HLS job start', { jobId, playlistUrl, saveAs: !!saveAs, audioUrlHint: !!audioUrlHint });
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
    audioRenditions: parsed.audioRenditions.length,
  });

  // Split-track HLS (X/Twitter fmp4 and similar): video variants carry NO
  // audio; the audio lives in #EXT-X-MEDIA renditions. Resolve the audio URL
  // from the master when we have it, else trust the hint threaded in from the
  // popup (which parsed the master during its probe — the variant-picker path
  // hands us the bare variant URL, so the master never reaches this job).
  let audioUrl = audioUrlHint;

  if (parsed.isMaster) {
    if (parsed.variants.length === 0) throw new Error('Master playlist has no variants');
    const variant = pickBestVariant(parsed.variants);
    log('picked variant', variant);
    audioUrl = pickAudioRendition(parsed, variant) || audioUrl;
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

  // Fetch + parse the audio rendition up front so the progress total covers
  // both tracks. Any failure here degrades to video-only — but FLAGGED, so the
  // popup never reports a silent file as a plain success.
  let audioParsed = null;
  let audioFetchFailed = false;
  if (audioUrl) {
    try {
      audioParsed = parseM3U8(await fetchText(audioUrl), audioUrl);
      if (audioParsed.segments.length === 0) { audioParsed = null; audioFetchFailed = true; }
    } catch (err) {
      warn('audio rendition playlist fetch failed, continuing video-only:', err?.message || err);
      audioParsed = null;
      audioFetchFailed = true;
    }
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

  const videoSteps = (parsed.initSegment ? 1 : 0) + parsed.segments.length;
  const audioSteps = audioParsed
    ? (audioParsed.initSegment ? 1 : 0) + audioParsed.segments.length
    : 0;
  const totalSteps = videoSteps + audioSteps;
  const parts = await downloadSegments({ jobId, parsed, totalSteps, decryptor });
  let ext = guessOutputExtension(parsed.segments, parsed.initSegment);
  let outParts = parts;
  let warning = audioFetchFailed
    ? 'Saved without audio — the audio track could not be fetched.'
    : null;

  // MPEG-TS segments concatenate into a valid .ts, but users expect .mp4 and
  // many players won't open .ts. Transmux to MP4 (no re-encode). Fall back to
  // raw .ts if mux.js can't handle the codec, so the user still gets the video.
  if (ext === 'ts') {
    try {
      sendStatus({ type: 'stream-progress', jobId, phase: 'remux', current: totalSteps, total: totalSteps });
      log('transmuxing MPEG-TS → MP4');
      outParts = await transmuxTsToMp4(parts);
      ext = 'mp4';
      log('transmux done');
    } catch (err) {
      warn('transmux failed, saving raw .ts instead:', err?.message || err);
      outParts = parts;
      ext = 'ts';
    }
  }

  // Mux the separate audio rendition in (same machinery as split DASH). On any
  // failure keep the old video-only output, flagged so the popup says so.
  if (audioParsed) {
    try {
      const audioParts = await downloadSegments({
        jobId, parsed: audioParsed, totalSteps, decryptor, startAt: videoSteps,
      });
      if (ext !== 'mp4') throw new Error(`cannot mux separate audio into a .${ext} output`);
      sendStatus({ type: 'stream-progress', jobId, phase: 'remux', current: totalSteps, total: totalSteps });
      log('muxing HLS video variant + audio rendition → MP4');
      outParts = await muxAvToMp4(outParts, audioParts);
      log('mux done');
    } catch (err) {
      warn('HLS audio mux failed, saving video-only:', err?.message || err);
      warning = 'Saved without audio — the audio track could not be merged.';
    }
  }

  await finalize(jobId, outParts, ext, baseFilename, totalSteps, saveAs, warning);
}

// Download a complete media file, streaming so we can report progress.
async function fetchFullWithProgress(url, onByte) {
  const res = await fetchWithTimeout(url, SEGMENT_TIMEOUT_MS);
  const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onByte(buf.byteLength, total || buf.byteLength);
    return [buf];
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received > MAX_TOTAL_BYTES) {
      try { await reader.cancel(); } catch {}
      throw tooLargeError();
    }
    onByte(received, total);
  }
  return chunks;
}

// Download a video-only stream and an optional audio-only stream (both complete
// MP4 files), then mux them into one MP4. Used for adaptive sources that split
// audio and video. If audioUrl is null the video already carries audio.
async function runMuxJob(jobId, videoUrl, audioUrl, baseFilename, saveAs) {
  log('mux job start', { jobId, hasAudio: !!audioUrl, saveAs: !!saveAs });
  sendStatus({ type: 'stream-progress', jobId, phase: 'manifest', current: 0, total: 100 });

  // Progress model: video download 0–55%, audio 55–85%, mux 85–95%, save 95–100.
  const report = (pct) => sendStatus({ type: 'stream-progress', jobId, phase: 'segments', current: Math.round(pct), total: 100 });

  let videoParts;
  try {
    videoParts = await fetchFullWithProgress(videoUrl, (r, t) => report(t ? (r / t) * 55 : 5));
  } catch (err) {
    throw new Error(`Could not download video stream: ${err.message}`);
  }

  if (!audioUrl) {
    // Progressive (already-muxed) format — save the video as-is.
    await finalize(jobId, videoParts, 'mp4', baseFilename, 100, saveAs);
    return;
  }

  let audioParts;
  try {
    audioParts = await fetchFullWithProgress(audioUrl, (r, t) => report(55 + (t ? (r / t) * 30 : 5)));
  } catch (err) {
    warn('audio download failed, saving video-only:', err?.message || err);
    await finalize(jobId, videoParts, 'mp4', baseFilename, 100, saveAs, 'Saved without audio — the audio track could not be downloaded.');
    return;
  }

  sendStatus({ type: 'stream-progress', jobId, phase: 'remux', current: 90, total: 100 });
  log('muxing captured video + audio → MP4');
  let outParts;
  let warning = null;
  try {
    outParts = await muxAvToMp4(videoParts, audioParts);
    log('mux done');
  } catch (err) {
    warn('mux failed, saving video-only:', err?.message || err);
    outParts = videoParts;
    warning = 'Saved without audio — the audio track could not be merged.';
  }
  await finalize(jobId, outParts, 'mp4', baseFilename, 100, saveAs, warning);
}

async function runDashJob(jobId, mpdUrl, baseFilename, saveAs) {
  log('DASH job start', { jobId, mpdUrl, saveAs: !!saveAs });
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

  const videoSteps = (best.initSegment ? 1 : 0) + best.segments.length;

  // No separate audio track → the video stream is already muxed (or audio-less).
  if (!best.audio) {
    const parts = await downloadSegments({ jobId, parsed: best, totalSteps: videoSteps });
    await finalize(jobId, parts, 'mp4', baseFilename, videoSteps, saveAs);
    return;
  }

  // Separate audio AdaptationSet (Reddit, Facebook, and other adaptive streams): download
  // both tracks, then mux into one MP4. The mux can't make a video-only file
  // play with sound any other way.
  log('DASH has separate audio track — will mux');
  const audioSteps = (best.audio.initSegment ? 1 : 0) + best.audio.segments.length;
  const totalSteps = videoSteps + audioSteps;
  const videoParts = await downloadSegments({ jobId, parsed: best, totalSteps, startAt: 0 });
  const audioParts = await downloadSegments({ jobId, parsed: best.audio, totalSteps, startAt: videoSteps });

  sendStatus({ type: 'stream-progress', jobId, phase: 'remux', current: totalSteps, total: totalSteps });
  log('muxing video + audio → MP4');
  let outParts;
  let warning = null;
  try {
    outParts = await muxAvToMp4(videoParts, audioParts);
    log('mux done');
  } catch (err) {
    // Last resort: save video-only so the user gets *something* (silent) rather
    // than nothing, but flag it so the popup can tell them audio was dropped.
    warn('mux failed, saving video-only:', err?.message || err);
    outParts = videoParts;
    warning = 'Saved without audio — the audio track could not be merged.';
  }
  await finalize(jobId, outParts, 'mp4', baseFilename, totalSteps, saveAs, warning);
}

function deriveFilename(label, ext) {
  let base = (label || `vidload-${Date.now()}`).replace(/\.(m3u8|mpd)(\?.*)?$/i, '');
  base = base.replace(/[\\/:*?"<>|]/g, '_');
  if (new RegExp(`\\.${ext}$`, 'i').test(base)) return base;
  return `${base}.${ext}`;
}
