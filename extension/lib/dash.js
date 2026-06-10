// VidLoad DASH (.mpd) parser — minimal, targets static MPDs with
// SegmentTemplate or SegmentList. Picks the best-bandwidth video
// representation; audio adaptation sets are ignored for now
// (would require muxing). Returns a normalized shape compatible
// with the HLS download pipeline.

export function parseDASH(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Invalid MPD XML');

  const mpd = doc.documentElement;
  if (mpd.localName !== 'MPD') throw new Error('Root element is not <MPD>');
  if ((mpd.getAttribute('type') || 'static') === 'dynamic') {
    throw new Error('Live DASH streams are not supported in v0.3.1');
  }

  const period = mpd.getElementsByTagName('Period')[0];
  if (!period) throw new Error('No <Period> in MPD');

  const mpdBaseUrl = resolveUrl(directChildText(mpd, 'BaseURL'), baseUrl);
  const periodBaseUrl = resolveUrl(directChildText(period, 'BaseURL'), mpdBaseUrl);
  const totalDurationSeconds = parseDurationSeconds(mpd.getAttribute('mediaPresentationDuration'));

  let bestVideo = null;
  let bestAudio = null;
  for (const set of period.getElementsByTagName('AdaptationSet')) {
    const ct = set.getAttribute('contentType');
    const mime = set.getAttribute('mimeType') || '';
    const isVideo = ct === 'video' || mime.startsWith('video/');
    const isAudio = ct === 'audio' || mime.startsWith('audio/');
    if (!isVideo && !isAudio) continue;

    const setBaseUrl = resolveUrl(directChildText(set, 'BaseURL'), periodBaseUrl);
    const setSegmentTemplate = set.getElementsByTagName('SegmentTemplate')[0];

    for (const rep of set.getElementsByTagName('Representation')) {
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const repBaseUrl = resolveUrl(directChildText(rep, 'BaseURL'), setBaseUrl);
      const segmentTemplate = rep.getElementsByTagName('SegmentTemplate')[0] || setSegmentTemplate;
      const segmentList = rep.getElementsByTagName('SegmentList')[0];

      let parsed = null;
      if (segmentTemplate) {
        parsed = fromSegmentTemplate(segmentTemplate, rep, repBaseUrl, totalDurationSeconds);
      } else if (segmentList) {
        parsed = fromSegmentList(segmentList, repBaseUrl);
      } else if (repBaseUrl && /\.(mp4|m4s|m4a|webm)(\?|$)/i.test(repBaseUrl)) {
        // SegmentBase / single-file representation (e.g. Reddit v.redd.it):
        // the whole BaseURL file is a self-contained track. Download it whole.
        parsed = { initSegment: null, segments: [{ uri: repBaseUrl }] };
      }
      if (!parsed) continue;

      const candidate = {
        bandwidth,
        width: parseInt(rep.getAttribute('width') || '0', 10),
        height: parseInt(rep.getAttribute('height') || '0', 10),
        mimeType: rep.getAttribute('mimeType') || mime || (isAudio ? 'audio/mp4' : 'video/mp4'),
        ...parsed,
      };
      if (isVideo) {
        if (!bestVideo || candidate.bandwidth > bestVideo.bandwidth) bestVideo = candidate;
      } else if (!bestAudio || candidate.bandwidth > bestAudio.bandwidth) {
        bestAudio = candidate;
      }
    }
  }

  if (!bestVideo) throw new Error('No supported video Representation found in MPD');
  // Returns the video representation as the top-level shape (compatible with the
  // HLS pipeline) plus a separate `audio` representation when the stream splits
  // audio into its own AdaptationSet (common on adaptive streams). offscreen muxes the two.
  return { ...bestVideo, audio: bestAudio };
}

function fromSegmentTemplate(tmpl, rep, baseUrl, totalDurationSeconds) {
  const initTemplate = tmpl.getAttribute('initialization');
  const mediaTemplate = tmpl.getAttribute('media');
  if (!mediaTemplate) return null;

  const startNumber = parseInt(tmpl.getAttribute('startNumber') || '1', 10);
  const timescale = parseInt(tmpl.getAttribute('timescale') || '1', 10);
  const segDuration = parseFloat(tmpl.getAttribute('duration') || '0');
  const repId = rep.getAttribute('id') || '';
  const bandwidth = rep.getAttribute('bandwidth') || '0';
  const vars = { RepresentationID: repId, Bandwidth: bandwidth };

  const initSegment = initTemplate
    ? { uri: resolveUrl(substituteVars(initTemplate, vars), baseUrl) }
    : null;

  const segments = [];
  const timeline = tmpl.getElementsByTagName('SegmentTimeline')[0];
  if (timeline) {
    let number = startNumber;
    let time = 0;
    for (const s of timeline.getElementsByTagName('S')) {
      const t = s.getAttribute('t');
      const d = parseInt(s.getAttribute('d') || '0', 10);
      const r = parseInt(s.getAttribute('r') || '0', 10);
      if (t !== null && t !== '') time = parseInt(t, 10);
      for (let i = 0; i <= r; i++) {
        segments.push({
          uri: resolveUrl(substituteVars(mediaTemplate, { ...vars, Number: number, Time: time }), baseUrl),
        });
        time += d;
        number += 1;
      }
    }
  } else if (segDuration > 0 && totalDurationSeconds > 0) {
    const segSeconds = segDuration / timescale;
    const count = Math.ceil(totalDurationSeconds / segSeconds);
    for (let i = 0; i < count; i++) {
      const number = startNumber + i;
      const time = i * segDuration;
      segments.push({
        uri: resolveUrl(substituteVars(mediaTemplate, { ...vars, Number: number, Time: time }), baseUrl),
      });
    }
  } else {
    return null;
  }

  return { initSegment, segments };
}

function fromSegmentList(list, baseUrl) {
  const initEl = list.getElementsByTagName('Initialization')[0];
  const initSegment = initEl?.getAttribute('sourceURL')
    ? { uri: resolveUrl(initEl.getAttribute('sourceURL'), baseUrl) }
    : null;
  const segments = [];
  for (const u of list.getElementsByTagName('SegmentURL')) {
    const media = u.getAttribute('media');
    if (media) segments.push({ uri: resolveUrl(media, baseUrl) });
  }
  if (segments.length === 0) return null;
  return { initSegment, segments };
}

function substituteVars(template, vars) {
  return template.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (m, name, padding) => {
    const v = vars[name];
    if (v === undefined || v === null) return m;
    const s = String(v);
    return padding ? s.padStart(parseInt(padding, 10), '0') : s;
  });
}

function directChildText(parent, name) {
  for (const child of parent.children) {
    if (child.localName === name) return child.textContent.trim();
  }
  return '';
}

function resolveUrl(uri, base) {
  if (!uri) return base;
  try { return new URL(uri, base).href; } catch { return uri; }
}

function parseDurationSeconds(iso) {
  if (!iso) return 0;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!m) return 0;
  return (
    (parseFloat(m[1] || '0') * 86400) +
    (parseFloat(m[2] || '0') * 3600) +
    (parseFloat(m[3] || '0') * 60) +
    parseFloat(m[4] || '0')
  );
}
