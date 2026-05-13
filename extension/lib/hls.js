// VidLoad HLS helpers — parser + AES-128 decryption.
// Hand-rolled because: minimal feature set needed (parse, pick variant, decrypt),
// no external deps, easier to debug.

export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const result = {
    isMaster: false,
    variants: [],
    segments: [],
    initSegment: null,
    targetDuration: 0,
    mediaSequence: 0,
  };

  let pendingDuration = null;
  let pendingByteRange = null;
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      result.isMaster = true;
      const attrs = parseAttrs(line);
      let uri = lines[++i]?.trim();
      while (uri && uri.startsWith('#')) uri = lines[++i]?.trim();
      if (uri) {
        result.variants.push({
          uri: resolveUrl(uri, baseUrl),
          bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
          resolution: attrs.RESOLUTION || null,
          codecs: attrs.CODECS || null,
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      result.mediaSequence = parseInt(line.split(':')[1] || '0', 10);
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      result.targetDuration = parseFloat(line.split(':')[1] || '0');
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttrs(line);
      if (attrs.URI) {
        result.initSegment = { uri: resolveUrl(attrs.URI, baseUrl) };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttrs(line);
      const method = (attrs.METHOD || '').toUpperCase();
      if (method === 'NONE' || method === '') {
        currentKey = null;
      } else if (method === 'AES-128') {
        currentKey = {
          method: 'AES-128',
          uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
          iv: attrs.IV || null,
        };
      } else {
        throw new Error(`Unsupported HLS encryption method: ${method}`);
      }
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      pendingDuration = parseFloat(line.split(':')[1] || '0');
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      pendingByteRange = line.split(':')[1] || null;
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      result.endlist = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pendingDuration !== null) {
      result.segments.push({
        uri: resolveUrl(line, baseUrl),
        duration: pendingDuration,
        byteRange: pendingByteRange,
        sequence: result.mediaSequence + result.segments.length,
        key: currentKey,
      });
      pendingDuration = null;
      pendingByteRange = null;
    }
  }

  return result;
}

function parseAttrs(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return {};
  const rest = line.slice(colon + 1);
  const attrs = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && (rest[i] === ' ' || rest[i] === ',')) i++;
    const eq = rest.indexOf('=', i);
    if (eq === -1) break;
    const key = rest.slice(i, eq).trim();
    i = eq + 1;
    let val;
    if (rest[i] === '"') {
      const close = rest.indexOf('"', i + 1);
      val = rest.slice(i + 1, close === -1 ? rest.length : close);
      i = close === -1 ? rest.length : close + 1;
    } else {
      const comma = rest.indexOf(',', i);
      val = rest.slice(i, comma === -1 ? rest.length : comma);
      i = comma === -1 ? rest.length : comma;
    }
    attrs[key] = val;
  }
  return attrs;
}

function resolveUrl(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

export function pickBestVariant(variants) {
  return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

export async function importAesKey(keyBytes) {
  return crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
  );
}

export async function decryptSegment(cipherBuf, cryptoKey, iv) {
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, cipherBuf);
}

export function parseHexIV(hex) {
  const clean = (hex || '').replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export function sequenceToIV(sequence) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  // High 8 bytes stay zero; low 8 bytes hold the sequence as a big-endian uint64.
  view.setBigUint64(8, BigInt(sequence));
  return iv;
}

export function guessOutputExtension(segments, initSegment) {
  // Fragmented MP4 if we have an init segment with .m4s/.mp4 extensions.
  if (initSegment) return 'mp4';
  const first = segments[0]?.uri || '';
  if (/\.(m4s|mp4)(\?|$)/i.test(first)) return 'mp4';
  return 'ts';
}
