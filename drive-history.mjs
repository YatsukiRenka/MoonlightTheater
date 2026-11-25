import {requestGoogleToken, validGoogleClientId} from './google-oauth.mjs';
import {archiveIsEncrypted} from './history-archive.mjs';

export {loadGoogleOAuth as preloadDriveAuthorization} from './google-oauth.mjs';
export const maxDriveBackupBytes = 544 * 1024 * 1024;
export const driveImageHeader = 'MLCIMG01';

const driveOrigin = 'https://www.googleapis.com';
const filesPath = '/drive/v3/files';
const uploadPath = '/upload/drive/v3/files';
const driveScope = 'https://www.googleapis.com/auth/drive.appdata';
const mediaType = 'application/octet-stream';
const fileKinds = {
  backup: {suffix: '.moonlight-history.enc', property: 'moonlightHistoryBackup'},
  manifest: {suffix: '.moonlight-image-manifest.enc', property: 'moonlightImageManifest'},
  rendition: {suffix: '.moonlight-image.enc', property: 'moonlightImageRendition'},
};
const backupFields = 'id,name,size,createdTime';
const checksumFields = 'id,size,sha256Checksum';
const checksumPattern = /^[0-9a-f]{64}$/i;
const fileIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const multipartLimit = 5_000_000;
const chunkSize = 8 * 1024 * 1024;
const metadataTimeout = 30_000;
const chunkTimeout = 180_000;
const fileTimeout = 1_800_000;
const uploadedRenditions = new WeakMap();

export async function authorizeDrive(clientId) {
  if (!validGoogleClientId(clientId)) throw new Error('请填写 Google Cloud 的 Web 应用 Client ID。');
  return requestGoogleToken(clientId, driveScope, 'Google 授权未完成，或未授予 Drive 应用数据权限。');
}

function driveURL(path, parameters) {
  const url = new URL(path, driveOrigin);
  url.search = new URLSearchParams(parameters);
  return url;
}

function statusError(status) {
  const messages = {
    401: 'Google Drive 授权已过期或失效，请重新授权。',
    403: 'Google Drive 权限不足或已达到存储或用量上限。',
    404: 'Google Drive 备份或上传会话已不存在。',
    429: 'Google Drive 请求太频繁，请稍后重试。',
  };
  return Object.assign(new Error(messages[status] || 'Google Drive 请求失败（HTTP ' + status + '）。'), {status});
}

function transferError(error, signal) {
  const timeout = error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError';
  return new Error(timeout ? 'Google Drive 传输超时，请检查网络后重试。' : '无法连接 Google Drive，请检查网络后重试。', {cause: error});
}

async function driveRequest(auth, url, send, {headers, incomplete = false, timeout = metadataTimeout, ...init} = {}) {
  if (typeof auth?.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(auth.token)
    || !Number.isFinite(auth.expires) || auth.expires <= Date.now()) throw statusError(401);
  const signal = AbortSignal.timeout(timeout);
  let response;
  try {
    response = await send(url.href, {
      ...init, headers: {...headers, Authorization: 'Bearer ' + auth.token}, signal,
      mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
  } catch (error) { throw transferError(error, signal); }
  if (!response.ok && !(incomplete && response.status === 308)) {
    await response.body?.cancel().catch(() => {});
    throw statusError(response.status);
  }
  return {response, signal};
}

async function driveJSON({response, signal}) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Google Drive 返回的备份信息无效。', {cause: error});
    throw transferError(error, signal);
  }
}

function fileRecord(item, kind) {
  if (typeof item?.id !== 'string' || !fileIdPattern.test(item.id)
    || typeof item.name !== 'string' || !item.name.endsWith(kind.suffix)
    || typeof item.createdTime !== 'string' || !Number.isFinite(Date.parse(item.createdTime))) return null;
  const size = Number(item.size);
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  return {id: item.id, name: item.name, size, createdTime: item.createdTime};
}

export async function listDriveBackups(auth, {send = globalThis.fetch} = {}) {
  return listAppDataFiles(auth, fileKinds.backup, send);
}

export async function listDriveImageManifests(auth, {send = globalThis.fetch} = {}) {
  return listAppDataFiles(auth, fileKinds.manifest, send);
}

async function listAppDataFiles(auth, kind, send) {
  const url = driveURL(filesPath, {
    spaces: 'appDataFolder', q: `trashed = false and appProperties has { key='${kind.property}' and value='1' }`,
    fields: `nextPageToken,files(${backupFields})`, orderBy: 'createdTime desc', pageSize: '100',
  });
  const backups = new Map();
  const tokens = new Set();
  for (;;) {
    const page = await driveJSON(await driveRequest(auth, url, send));
    if (!page || typeof page !== 'object' || Array.isArray(page)
      || (page.files !== undefined && !Array.isArray(page.files))) throw new Error('Google Drive 返回的备份列表无效。');
    for (const item of page.files || []) {
      const backup = fileRecord(item, kind);
      if (backup) backups.set(backup.id, backup);
    }
    if (!page.nextPageToken) break;
    if (typeof page.nextPageToken !== 'string' || tokens.has(page.nextPageToken) || tokens.size >= 99) {
      throw new Error('无法读取完整的 Google Drive 备份列表。');
    }
    tokens.add(page.nextPageToken);
    url.searchParams.set('pageToken', page.nextPageToken);
  }
  return [...backups.values()].sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
}

function uploadURL(type, kind) {
  const fields = kind === fileKinds.rendition ? `${backupFields},sha256Checksum` : backupFields;
  return driveURL(uploadPath, {uploadType: type, fields});
}

function uploadMetadata(kind) {
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomUUID();
  return {name: `moonlight-${date}-${suffix}${kind.suffix}`, parents: ['appDataFolder'], mimeType: mediaType,
    appProperties: {[kind.property]: '1'}};
}

async function uploadMultipart(auth, blob, metadata, kind, send) {
  const boundary = 'moonlight-' + crypto.randomUUID();
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`, blob, `\r\n--${boundary}--\r\n`,
  ]);
  const reply = await driveRequest(auth, uploadURL('multipart', kind), send, {
    method: 'POST', headers: {'Content-Type': `multipart/related; boundary=${boundary}`}, body, timeout: chunkTimeout,
  });
  return driveJSON(reply);
}

async function openUploadSession(auth, metadata, kind, size, send) {
  const {response} = await driveRequest(auth, uploadURL('resumable', kind), send, {
    method: 'POST', headers: {'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mediaType, 'X-Upload-Content-Length': String(size)}, body: JSON.stringify(metadata),
  });
  const location = response.headers.get('Location');
  await response.body?.cancel().catch(() => {});
  let session;
  try { session = new URL(location); } catch {}
  if (session?.origin !== driveOrigin || session.pathname !== uploadPath || session.username || session.password
    || session.hash || !session.searchParams.get('upload_id')) {
    throw new Error('Google Drive 未返回可用的大文件上传地址。');
  }
  return session;
}

async function uploadResumable(auth, blob, metadata, kind, send, onProgress) {
  const session = await openUploadSession(auth, metadata, kind, blob.size, send);
  let offset = 0;
  let checkedInterruptedOffset = false;
  // Google can report an upload offset in a 200 response, so the browser never follows a 308 redirect.
  const chunkHeaders = {'Content-Type': mediaType, 'X-GUploader-No-308': 'yes'};
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    let reply;
    let checked = false;
    try {
      reply = await driveRequest(auth, session, send, {
        method: 'PUT', incomplete: true, timeout: chunkTimeout, body: blob.slice(offset, end, mediaType),
        headers: {...chunkHeaders, 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`},
      });
    } catch (error) {
      if (checkedInterruptedOffset || (error.status && error.status < 500)) throw error;
      checked = checkedInterruptedOffset = true;
      reply = await driveRequest(auth, session, send, {method: 'PUT', incomplete: true,
        headers: {...chunkHeaders, 'Content-Range': `bytes */${blob.size}`}});
    }
    const {response} = reply;
    const range = response.headers.get('Range');
    const more = response.status === 308 || response.headers.get('X-Http-Status-Code-Override') === '308'
      || (end < blob.size && (range || response.headers.get('Content-Length') === '0'));
    if (!more) return driveJSON(reply);
    await response.body?.cancel().catch(() => {});
    // A browser may be unable to read the committed range through CORS. The first session
    // is still incomplete, so a new session can safely upload the whole file in one request.
    if (!range) {
      const wholeSession = await openUploadSession(auth, metadata, kind, blob.size, send);
      return driveJSON(await driveRequest(auth, wholeSession, send, {
        method: 'PUT', headers: {'Content-Type': mediaType}, body: blob, timeout: fileTimeout,
      }));
    }
    const match = /^bytes=0-(\d+)$/.exec(range);
    const next = match && Number(match[1]) + 1;
    if (!next || next < offset || (!checked && next === offset) || next > end || next === blob.size) {
      throw new Error('Google Drive 返回的上传进度无效。');
    }
    if (next > offset) {
      offset = next;
      checkedInterruptedOffset = false;
      onProgress(offset, blob.size);
    }
  }
  throw new Error('Google Drive 未确认备份上传完成。');
}

export async function uploadDriveBackup(auth, blob, {send = globalThis.fetch, onProgress = () => {}} = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('没有可上传的备份文件。');
  if (blob.size > maxDriveBackupBytes) throw new Error('备份超过 544 MiB 的上传上限。');
  if (!await archiveIsEncrypted(blob)) throw new Error('请先加密历史备份，再上传到 Google Drive。');
  return uploadAppDataFile(auth, blob, fileKinds.backup, send, onProgress);
}

export async function uploadDriveImageObject(auth, blob, type, {send = globalThis.fetch} = {}) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > maxDriveBackupBytes
    || (type !== 'manifest' && type !== 'rendition') || await blob.slice(0, driveImageHeader.length).text() !== driveImageHeader) {
    throw new Error('云端图片文件无效或尚未加密。');
  }
  const uploaded = await uploadAppDataFile(auth, blob, fileKinds[type], send, () => {});
  if (type === 'rendition') uploadedRenditions.set(uploaded, Object.freeze({...uploaded}));
  return uploaded;
}

function sha256Value(value) {
  return typeof value === 'string' && checksumPattern.test(value) ? value.toLowerCase() : null;
}

async function uploadAppDataFile(auth, blob, kind, send, onProgress) {
  const metadata = uploadMetadata(kind);
  const response = blob.size <= multipartLimit ? await uploadMultipart(auth, blob, metadata, kind, send)
    : await uploadResumable(auth, blob, metadata, kind, send, onProgress);
  const saved = fileRecord(response, kind);
  if (!saved || saved.size !== blob.size) throw new Error('Google Drive 未确认备份上传完成。');
  if (kind === fileKinds.rendition) saved.sha256Checksum = sha256Value(response.sha256Checksum);
  onProgress(blob.size, blob.size);
  return saved;
}

export async function downloadDriveBackup(auth, id, {send = globalThis.fetch} = {}) {
  return downloadAppDataFile(auth, id, maxDriveBackupBytes, send, '备份超过 544 MiB 的下载上限。');
}

export async function downloadDriveImageObject(auth, id, {send = globalThis.fetch, maxBytes = maxDriveBackupBytes} = {}) {
  return downloadAppDataFile(auth, id, maxBytes, send, '云端图片超过预期大小。');
}

export async function discardDriveImageRendition(auth, upload, {send = globalThis.fetch} = {}) {
  const id = uploadedRenditions.get(upload)?.id;
  if (!id) throw new Error('只能清理本次上传中尚未提交的图片。');
  await driveRequest(auth, driveURL(`${filesPath}/${id}`), send, {method: 'DELETE'});
  uploadedRenditions.delete(upload);
}

export async function readDriveImageChecksum(auth, upload, {send = globalThis.fetch} = {}) {
  const receipt = uploadedRenditions.get(upload);
  if (!receipt) throw new Error('无法验证本次上传的云端图片。');
  if (receipt.sha256Checksum) return receipt.sha256Checksum;
  const url = driveURL(`${filesPath}/${receipt.id}`, {fields: checksumFields});
  const data = await driveJSON(await driveRequest(auth, url, send));
  if (data?.id !== receipt.id || Number(data.size) !== receipt.size) throw new Error('Google Drive 返回的图片校验信息无效。');
  return sha256Value(data.sha256Checksum);
}

async function downloadAppDataFile(auth, id, maxBytes, send, sizeMessage) {
  if (typeof id !== 'string' || !fileIdPattern.test(id)) throw new Error('Google Drive 备份编号无效。');
  const {response, signal} = await driveRequest(auth, driveURL(`${filesPath}/${id}`, {alt: 'media'}), send, {timeout: fileTimeout});
  const tooLarge = new Error(sizeMessage);
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  if (!response.body) throw new Error('Google Drive 返回了空备份。');
  let bytes = 0;
  const bounded = new TransformStream({transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw tooLarge;
    controller.enqueue(chunk);
  }});
  let blob;
  try { blob = await new Response(response.body.pipeThrough(bounded), {headers: {'Content-Type': mediaType}}).blob(); }
  catch (error) { if (error === tooLarge) throw error; throw transferError(error, signal); }
  if (!blob.size) throw new Error('Google Drive 返回了空备份。');
  return blob;
}
