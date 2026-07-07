#!/usr/bin/env node
// VidLoad build script — produces dist/webstore and dist/selfhost from extension/.
//
// Web Store build: omits adapters/youtube.js and the YouTube content-script
//   registration. Manifest description is a generic "save HTML5 and HLS videos".
// Self-host build: includes everything, distributed as .crx from a separate site.
//
// Source extension/ is the dev build — load it unpacked while iterating.
// Release artifacts come from this script.

import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const ADAPTERS = {
  tiktok: {
    file: 'adapters/tiktok.js',
    contentScript: {
      matches: ['*://*.tiktok.com/*'],
      js: ['adapters/tiktok.js'],
      run_at: 'document_idle',
    },
  },
  instagram: {
    file: 'adapters/instagram.js',
    contentScript: {
      matches: ['*://*.instagram.com/*'],
      js: ['adapters/instagram.js'],
      run_at: 'document_idle',
    },
  },
  twitter: {
    file: 'adapters/twitter.js',
    contentScript: {
      matches: ['*://*.twitter.com/*', '*://*.x.com/*'],
      js: ['adapters/twitter.js'],
      run_at: 'document_idle',
    },
  },
  youtube: {
    // Two files: the MAIN-world hook (captures the player's deciphered stream
    // URLs, must run at document_start) + the isolated-world adapter.
    files: ['adapters/youtube.js', 'adapters/youtube-hook.js'],
    contentScripts: [
      {
        matches: ['*://*.youtube.com/*'],
        js: ['adapters/youtube-hook.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
      {
        matches: ['*://*.youtube.com/*'],
        js: ['adapters/youtube.js'],
        run_at: 'document_idle',
      },
    ],
  },
};

const adapterFiles = (a) => a.files || [a.file];
const adapterContentScripts = (a) => a.contentScripts || [a.contentScript];

const BUILDS = {
  webstore: {
    description: 'Save HTML5 and HLS videos from any webpage to your computer.',
    adapters: ['tiktok', 'instagram', 'twitter'],
  },
  selfhost: {
    description: 'Save videos from any webpage, including major social platforms.',
    adapters: ['tiktok', 'instagram', 'twitter', 'youtube'],
  },
};

async function build(target) {
  const cfg = BUILDS[target];
  const outDir = path.join(DIST, target);
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const allAdapterFiles = Object.values(ADAPTERS).flatMap(adapterFiles);
  const includedAdapterFiles = cfg.adapters.flatMap((name) => adapterFiles(ADAPTERS[name]));
  const excluded = allAdapterFiles.filter((f) => !includedAdapterFiles.includes(f));

  await cp(SRC, outDir, {
    recursive: true,
    filter: (srcPath) => {
      const rel = path.relative(SRC, srcPath).replace(/\\/g, '/');
      return !excluded.some((ex) => rel === ex);
    },
  });

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.description = cfg.description;
  manifest.content_scripts = [
    {
      // ExtensionPay: relays paid status from the payment page back to the
      // extension. Required by ExtPay in both builds.
      matches: ['https://extensionpay.com/*'],
      js: ['lib/extpay.js'],
      run_at: 'document_start',
    },
    {
      matches: ['<all_urls>'],
      js: ['content/content-script.js'],
      run_at: 'document_idle',
      all_frames: true, // detect <video> inside player iframes (Hotmart, Wistia, …)
    },
    ...cfg.adapters.flatMap((name) => adapterContentScripts(ADAPTERS[name])),
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Enforce the two-build invariant: the Web Store build must contain NO YouTube
  // capability code (that gets the listing removed). The only allowed mention is
  // the non-support disclaimer. This turns the documented manual grep into a hard
  // build gate — a leak in any shared file fails the build instead of shipping.
  if (target === 'webstore') await assertNoYouTubeLeak(outDir);

  const adapters = cfg.adapters.length ? cfg.adapters.join(', ') : '(none)';
  console.log(`Built ${target} → ${path.relative(ROOT, outDir)} (adapters: ${adapters})`);
}

// Files in the webstore build that are ALLOWED to mention YouTube: the
// non-support disclaimer (banner logic + its markup/style). Anything else that
// matches the capability regex is a real leak.
const LEAK_WHITELIST = new Set([
  'popup/youtube-notice.js',
  'popup/popup.html',
  'popup/popup.css',
]);
// Vendored minified libraries — trusted black boxes, not our capability code.
const LEAK_SKIP = new Set([
  'lib/mux.min.js',
  'lib/mp4box.min.js',
  'lib/extpay.js',
]);
const LEAK_RE = /youtube|googlevideo|ytinitial|ytcfg|youtu\.be/i;
const BINARY_RE = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|zip|crx)$/i;

async function assertNoYouTubeLeak(outDir) {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const abs = path.join(ent.parentPath ?? ent.path, ent.name);
    const rel = path.relative(outDir, abs).replace(/\\/g, '/');
    if (LEAK_WHITELIST.has(rel) || LEAK_SKIP.has(rel) || BINARY_RE.test(rel)) continue;
    const text = await readFile(abs, 'utf8');
    if (LEAK_RE.test(text)) {
      throw new Error(
        `YouTube capability leak in webstore build: "${rel}" matches ${LEAK_RE}. ` +
        `This would get the Chrome Web Store listing removed. Move the code to the ` +
        `self-host-only path, or add the file to LEAK_WHITELIST if it is a disclaimer.`
      );
    }
  }
}

await Promise.all(Object.keys(BUILDS).map(build));
console.log('Done — webstore build passed the YouTube-leak check.');
