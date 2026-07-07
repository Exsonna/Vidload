// Shared URL/domain helpers used by BOTH the service worker (via importScripts)
// and the popup (via a <script> tag). Written as a classic script that attaches
// to the global object so it works in a worker and a window without ES modules.
//
// Single source of truth for two things that were previously copy-pasted and
// drifted: "is this URL an HLS/DASH sub-segment?" and "reduce a hostname to its
// registrable domain (keeping multi-part public suffixes intact)".
(function (g) {
  // Multi-part public suffixes we must keep intact when reducing a hostname to
  // its registrable domain (so play.hotmart.com.br → hotmart.com.br, not com.br).
  const MULTI_PART_TLDS = new Set([
    'com.br', 'com.au', 'co.uk', 'co.jp', 'co.kr', 'co.in', 'com.cn',
    'com.mx', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'net.au', 'org.uk',
  ]);

  function registrableDomain(host) {
    if (!host) return null;
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
    return lastTwo;
  }

  // .ts / .m4s are HLS/DASH sub-segments, not standalone videos.
  function isStreamSegmentUrl(url) {
    try {
      return /\.(m4s|ts)(?:$|\?)/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  g.VidLoadUrl = { MULTI_PART_TLDS, registrableDomain, isStreamSegmentUrl };
})(typeof self !== 'undefined' ? self : globalThis);
