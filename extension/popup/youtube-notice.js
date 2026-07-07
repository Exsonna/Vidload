// VidLoad — "YouTube not supported here" notice.
//
// Shown ONLY in builds that ship without the YouTube adapter (the Chrome Web
// Store build), and only when the user is actually on YouTube. The Web Store
// prohibits extensions that download YouTube, so that build omits the feature;
// without this banner the popup would just look empty/broken on YouTube.
//
// Build-aware: we infer "this build supports YouTube" from the presence of a
// YouTube content script in our own manifest — true in the self-host build,
// false in the Web Store build — so this is the ONLY place the webstore build
// references YouTube, and only as an explicit non-support disclaimer.
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
  })();
})();
