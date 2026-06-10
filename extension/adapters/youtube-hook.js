// VidLoad YouTube media hook — runs in the page's MAIN world (self-host build
// only, registered at document_start). The YouTube player deciphers its stream
// URLs internally; rather than re-implementing the base.js signature/n-param
// cipher (a constantly-rotating target), we observe the resulting googlevideo
// `videoplayback` requests the player makes and report each distinct itag's
// URL. The isolated-world adapter (youtube.js) cross-references these with the
// player's format metadata and builds a downloadable item.
(() => {
  if (window.__vidloadYtHook) return;
  window.__vidloadYtHook = true;

  const seenItag = new Set();

  function maybeReport(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    if (rawUrl.indexOf('videoplayback') === -1) return;
    let u;
    try { u = new URL(rawUrl, location.href); } catch { return; }
    if (!/\bgooglevideo\.com$/i.test(u.hostname)) return;
    if (!u.pathname.includes('videoplayback')) return;
    const itag = u.searchParams.get('itag');
    if (!itag || seenItag.has(itag)) return;
    seenItag.add(itag);
    // Strip range / chunked-streaming params so the URL fetches the whole file
    // as raw media. Keep auth params (pot/sig/n/expire/ip) untouched, or the
    // CDN rejects the request.
    for (const p of ['range', 'rn', 'rbuf', 'rqh', 'ump', 'sq', 'srfvp']) {
      u.searchParams.delete(p);
    }
    window.postMessage({
      __vidload: 'yt-media',
      itag,
      url: u.toString(),
      mime: u.searchParams.get('mime') || '',
      clen: u.searchParams.get('clen') || '',
      dur: u.searchParams.get('dur') || '',
    }, location.origin);
  }

  // Hook fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try { maybeReport(typeof input === 'string' ? input : (input && input.url)); } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  // Hook XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { maybeReport(url); } catch (_) {}
    return origOpen.apply(this, arguments);
  };
})();
