#!/usr/bin/env node
// VidLoad build script — produces dist/webstore and dist/selfhost from extension/.
//
// Web Store build: omits adapters/youtube.js and the YouTube content-script
//   registration. Manifest description is a generic "save HTML5 and HLS videos".
// Self-host build: includes everything, distributed as .crx from a separate site.
//
// Source extension/ is the dev build — load it unpacked while iterating.
// Release artifacts come from this script.

import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
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
  youtube: {
    file: 'adapters/youtube.js',
    contentScript: {
      matches: ['*://*.youtube.com/*'],
      js: ['adapters/youtube.js'],
      run_at: 'document_idle',
    },
  },
};

const BUILDS = {
  webstore: {
    description: 'Save HTML5 and HLS videos from any webpage to your computer.',
    adapters: ['tiktok'],
  },
  selfhost: {
    description: 'Save videos from any webpage, including major social platforms.',
    adapters: ['tiktok', 'youtube'],
  },
};

async function build(target) {
  const cfg = BUILDS[target];
  const outDir = path.join(DIST, target);
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const allAdapterFiles = Object.values(ADAPTERS).map((a) => a.file);
  const includedAdapterFiles = cfg.adapters.map((name) => ADAPTERS[name].file);
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
      matches: ['<all_urls>'],
      js: ['content/content-script.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
    ...cfg.adapters.map((name) => ADAPTERS[name].contentScript),
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const adapters = cfg.adapters.length ? cfg.adapters.join(', ') : '(none)';
  console.log(`Built ${target} → ${path.relative(ROOT, outDir)} (adapters: ${adapters})`);
}

await Promise.all(Object.keys(BUILDS).map(build));
console.log('Done.');
