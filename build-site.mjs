import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {validGoogleClientId} from './google-oauth.mjs';

const driveClientId = process.env.MOONLIGHT_DRIVE_CLIENT_ID;
if (driveClientId && (driveClientId !== driveClientId.trim() || !validGoogleClientId(driveClientId))) {
  throw new Error('MOONLIGHT_DRIVE_CLIENT_ID 必须填写有效的 Google OAuth Web 客户端 ID。');
}

const assets = [
  'index.html', 'style.css', 'app.mjs', 'engine.mjs', 'icons.mjs', 'images.mjs',
  'image-settings.mjs', 'image-client.mjs', 'image-history.mjs', 'image-usage.mjs', 'manual-materials.mjs',
  'image-options.mjs', 'image-controls.mjs', 'image-stream.mjs', 'image-deck.mjs', 'design-library.mjs',
  'history-limits.mjs', 'history-archive.mjs', 'history-backup.mjs', 'prompt-history.mjs', 'google-oauth.mjs', 'drive-history.mjs', 'image-file.mjs',
  'cloud-history.mjs', 'cloud-image-store.mjs', 'image-renditions.mjs', 'vendor/noble-sha256.mjs',
  'profile.json', 'assets/banner.webp',
];
const output = new URL('./dist/', import.meta.url);
await rm(output, {recursive: true, force: true});
await mkdir(new URL('assets/', output), {recursive: true});
await Promise.all(assets.map(path => cp(new URL(path, import.meta.url), new URL(path, output))));
if (driveClientId) {
  const page = new URL('index.html', output);
  const html = await readFile(page, 'utf8');
  if (!html.includes('</head>')) throw new Error('找不到可加入 Drive 客户端 ID 的页面头部。');
  await writeFile(page, html.replace('</head>', `<meta name="moonlight-drive-client-id" content="${driveClientId}"></head>`));
}
await writeFile(new URL('_headers', output), [
  '/*',
  '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
  '  Referrer-Policy: no-referrer',
  '',
].join('\n'));
