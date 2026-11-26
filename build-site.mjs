import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {validGoogleClientId} from './google-oauth.mjs';

const driveClientId = process.env.MOONLIGHT_DRIVE_CLIENT_ID;
if (driveClientId && (driveClientId !== driveClientId.trim() || !validGoogleClientId(driveClientId))) {
  throw new Error('MOONLIGHT_DRIVE_CLIENT_ID 必须填写有效的 Google OAuth Web 客户端 ID。');
}

const assets = [
  'index.html', 'favicon.svg', 'style.css', 'app.mjs', 'stage.mjs', 'engine.mjs', 'icons.mjs', 'images.mjs',
  'privacy.html', 'terms.html',
  'image-settings.mjs', 'image-client.mjs', 'api-resources.mjs', 'image-history.mjs', 'image-usage.mjs', 'manual-materials.mjs',
  'image-options.mjs', 'image-controls.mjs', 'image-stream.mjs', 'image-deck.mjs', 'design-library.mjs',
  'history-limits.mjs', 'history-archive.mjs', 'history-backup.mjs', 'prompt-history.mjs', 'google-oauth.mjs', 'drive-history.mjs', 'image-file.mjs',
  'cloud-history.mjs', 'cloud-image-store.mjs', 'image-renditions.mjs', 'vendor/noble-sha256.mjs',
  'profile.json', 'boot.js', 'prefs.mjs', 'i18n.mjs', 'i18n-dict.mjs', 'assets/grain.svg',
  'assets/fonts/noto-serif-sc-display.woff2', 'assets/fonts/cormorant.woff2', 'assets/fonts/cormorant-italic.woff2',
  'assets/fonts/OFL-NotoSerifSC.txt', 'assets/fonts/OFL-CormorantGaramond.txt', 'assets/fonts/README.md',
];
const output = new URL('./dist/', import.meta.url);
await rm(output, {recursive: true, force: true});
await mkdir(new URL('assets/fonts/', output), {recursive: true});
await Promise.all(assets.map(path => cp(new URL(path, import.meta.url), new URL(path, output))));
const page = new URL('index.html', output);
let html = await readFile(page, 'utf8');
if (!html.includes('</head>')) {
  if (driveClientId) throw new Error('找不到可加入 Drive 客户端 ID 的页面头部。');
  throw new Error('找不到可加入 modulepreload 的页面头部。');
}
const modulePreloads = assets
  .filter(path => path.endsWith('.mjs'))
  .map(path => `  <link rel="modulepreload" href="${path}">`)
  .join('\n');
html = html.replace('</head>', `${modulePreloads}\n</head>`);
if (driveClientId) html = html.replace('</head>', `<meta name="moonlight-drive-client-id" content="${driveClientId}"></head>`);
await writeFile(page, html);
// Hosts such as Cloudflare Pages or Netlify apply _headers, while GitHub Pages ignores it.
await writeFile(new URL('_headers', output), [
  '/*',
  '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
  '  Referrer-Policy: no-referrer',
  "  Content-Security-Policy: frame-ancestors 'none'",
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '',
].join('\n'));
