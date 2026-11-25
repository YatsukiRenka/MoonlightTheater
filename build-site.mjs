import {cp, mkdir, rm, writeFile} from 'node:fs/promises';

const assets = [
  'index.html', 'style.css', 'app.mjs', 'engine.mjs', 'icons.mjs', 'images.mjs',
  'image-settings.mjs', 'image-client.mjs', 'image-history.mjs', 'image-usage.mjs', 'manual-materials.mjs',
  'image-options.mjs', 'image-controls.mjs', 'image-stream.mjs', 'image-deck.mjs', 'design-library.mjs',
  'history-limits.mjs', 'history-archive.mjs', 'history-backup.mjs', 'prompt-history.mjs', 'google-oauth.mjs', 'drive-history.mjs', 'image-file.mjs',
  'profile.json', 'assets/banner.webp',
];
const output = new URL('./dist/', import.meta.url);
await rm(output, {recursive: true, force: true});
await mkdir(new URL('assets/', output), {recursive: true});
await Promise.all(assets.map(path => cp(new URL(path, import.meta.url), new URL(path, output))));
await writeFile(new URL('_headers', output), [
  '/*',
  '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
  '  Referrer-Policy: no-referrer',
  '',
].join('\n'));
