// VidLoad — "YouTube not supported here" notice + download block.
//
// Shown ONLY in builds that ship without the YouTube adapter (the Chrome Web
// Store build), and only when the user is actually on YouTube. The Web Store
// prohibits extensions that download YouTube, so that build omits the feature.
// On a YouTube tab this build (a) shows the non-support banner and (b) disables
// the download list entirely, so the generic detection engine never surfaces
// googlevideo streams as downloadable — YouTube download is truly off here.
//
// Build-aware: we infer "this build supports YouTube" from the presence of a
// YouTube content script in our own manifest — true in the self-host build,
// false in the Web Store build — so this is the ONLY place the webstore build
// references YouTube, and only as an explicit non-support disclaimer + block.
(() => {
  const el = document.getElementById('youtube-notice');
  if (!el) return;

  function buildSupportsYouTube() {
    try {
      const cs = chrome.runtime.getManifest().content_scripts || [];
      return cs.some((s) => (s.matches || []).some((m) => m.includes('youtube')));
    } catch {
      return false;
    }
  }

  async function onYouTubeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return false;
      const host = new URL(tab.url).hostname;
      return /(^|\.)youtube\.com$/i.test(host)
        || /(^|\.)youtube-nocookie\.com$/i.test(host)
        || host === 'youtu.be';
    } catch {
      return false;
    }
  }

  (async () => {
    if (buildSupportsYouTube()) return;     // self-host build → YouTube works, no notice
    if (!(await onYouTubeTab())) return;     // only relevant while on YouTube
    el.hidden = false;
    // Disable the download list so this build never offers YouTube media (the
    // generic engine would otherwise surface googlevideo streams). The reason
    // string lives here (this file is the only YouTube-aware one in the build).
    window.vidloadDisableDownloads?.("YouTube downloads aren't available in this version.");
  })();
})();
