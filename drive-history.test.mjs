import assert from 'node:assert/strict';
import {test} from 'node:test';
import {authorizeGoogle} from './image-client.mjs';
import {
  authorizeDrive, downloadDriveBackup, listDriveBackups, maxDriveBackupBytes, uploadDriveBackup,
} from './drive-history.mjs';

const auth = {token: 'drive-fixture-token', expires: 8_640_000_000_000_000};
const clientId = 'fixture.apps.googleusercontent.com';
const origin = 'https://www.googleapis.com';
const uploadPath = '/upload/drive/v3/files';
const createTime = '2026-11-25T00:00:00.000Z';

function checkRequest(href, request) {
  const url = new URL(href);
  assert.equal(url.origin, origin);
  assert.equal(request.headers.Authorization, 'Bearer drive-fixture-token');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store');
  assert.equal(url.searchParams.has('access_token'), false);
  return url;
}

test('Drive app data and Vertex authorize with separate scopes', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'google');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'google', descriptor);
    else delete globalThis.google;
  });
  const scopes = [];
  globalThis.google = {accounts: {oauth2: {
    hasGrantedAllScopes(response, scope) { return scope === response.scope; },
    initTokenClient(settings) {
      scopes.push(settings.scope);
      assert.equal(settings.include_granted_scopes, false);
      assert.equal(settings.client_id, clientId);
      return {requestAccessToken() {
        settings.callback({access_token: 'mock-token', expires_in: '3600', scope: settings.scope});
      }};
    },
  }}};
  const start = Date.now();
  const drive = await authorizeDrive(clientId);
  const vertex = await authorizeGoogle({clientId, project: 'fixture-project'});
  assert.deepEqual(Object.keys(drive), ['token', 'expires']);
  assert.equal(drive.token, 'mock-token');
  assert(drive.expires >= start + 3_600_000);
  assert.equal(vertex.project, 'fixture-project');
  assert.deepEqual(scopes, [
    'https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/cloud-platform',
  ]);
});

test('lists only app-data backups across pages and downloads the selected version', async () => {
  const entries = await listDriveBackups(auth, {send: async (href, request) => {
    const url = checkRequest(href, request);
    assert.equal(url.pathname, '/drive/v3/files');
    assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
    assert.match(url.searchParams.get('q'), /moonlightHistoryBackup/);
    if (url.searchParams.get('pageToken') === 'next') {
      return Response.json({files: [
        {id: 'new', name: 'new.moonlight-history.enc', size: '6', createdTime: createTime},
        {id: 'wrong-type', name: 'other.json', size: '4', createdTime: createTime},
      ]});
    }
    return Response.json({nextPageToken: 'next', files: [
      {id: 'old', name: 'old.moonlight-history.enc', size: '5', createdTime: '2026-11-24T00:00:00Z'},
    ]});
  }});
  assert.deepEqual(entries.map(entry => [entry.id, entry.size]), [['new', 6], ['old', 5]]);
  const chosen = await downloadDriveBackup(auth, entries[0].id, {send: async (href, request) => {
    const url = checkRequest(href, request);
    assert.equal(url.pathname, '/drive/v3/files/new');
    assert.equal(url.searchParams.get('alt'), 'media');
    return new Response('cipher');
  }});
  assert.equal(chosen.type, 'application/octet-stream');
  assert.equal(await chosen.text(), 'cipher');
});

test('a multipart backup only creates a new uniquely named version in appDataFolder', async () => {
  const names = [];
  const blob = new Blob(['MLHENC01', 'encrypted-history-bytes']);
  const send = async (href, request) => {
    const url = checkRequest(href, request);
    assert.equal(url.pathname, uploadPath);
    assert.equal(url.searchParams.get('uploadType'), 'multipart');
    assert.equal(request.method, 'POST');
    assert.match(request.headers['Content-Type'], /^multipart\/related; boundary=moonlight-/);
    const multipart = await request.body.text();
    const metadata = JSON.parse(multipart.split('\r\n')[3]);
    assert.deepEqual(metadata.parents, ['appDataFolder']);
    assert.deepEqual(metadata.appProperties, {moonlightHistoryBackup: '1'});
    assert(metadata.name.endsWith('.moonlight-history.enc'));
    assert(multipart.includes('encrypted-history-bytes'));
    names.push(metadata.name);
    return Response.json({id: `backup-${names.length}`, ...metadata, size: String(blob.size), createdTime: createTime});
  };
  assert.equal((await uploadDriveBackup(auth, blob, {send})).id, 'backup-1');
  assert.equal((await uploadDriveBackup(auth, blob, {send})).id, 'backup-2');
  assert.notEqual(names[0], names[1]);
});

test('large backups advance only to a confirmed chunk offset', async () => {
  const eightMiB = 8 * 1024 * 1024;
  const blob = new Blob(['MLHENC01', new Uint8Array(eightMiB - 7)]);
  const ranges = [], progress = [];
  let metadata;
  const uploaded = await uploadDriveBackup(auth, blob, {
    onProgress: (loaded, total) => progress.push([loaded, total]),
    send: async (href, request) => {
      const url = checkRequest(href, request);
      assert.equal(url.pathname, uploadPath);
      if (request.method === 'POST') {
        assert.equal(url.searchParams.get('uploadType'), 'resumable');
        assert.equal(request.headers['X-Upload-Content-Length'], String(blob.size));
        metadata = JSON.parse(request.body);
        assert.deepEqual(metadata.parents, ['appDataFolder']);
        return new Response(null, {headers: {Location: origin + uploadPath + '?upload_id=large'}});
      }
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers['X-GUploader-No-308'], 'yes');
      ranges.push([request.headers['Content-Range'], request.body.size]);
      if (ranges.length === 1) {
        return new Response(null, {headers: {Range: `bytes=0-${eightMiB - 1}`, 'X-Http-Status-Code-Override': '308'}});
      }
      return Response.json({id: 'large', ...metadata, size: String(blob.size), createdTime: createTime});
    },
  });
  assert.deepEqual(ranges, [[`bytes 0-${eightMiB - 1}/${blob.size}`, eightMiB], [`bytes ${eightMiB}-${eightMiB}/${blob.size}`, 1]]);
  assert.deepEqual(progress, [[eightMiB, blob.size], [blob.size, blob.size]]);
  assert.equal(uploaded.id, 'large');
});

test('an untrusted upload session URL cannot receive data or the Drive token', async () => {
  const largeBlob = new Blob(['MLHENC01', new Uint8Array(5_000_001)]);
  let requests = 0;
  await assert.rejects(uploadDriveBackup(auth, largeBlob, {send: async (href, request) => {
    checkRequest(href, request);
    assert.equal(++requests, 1);
    return new Response(null, {headers: {Location: 'https://www.googleapis.com.imposter.example' + uploadPath + '?upload_id=bad'}});
  }}), /未返回可用的大文件上传地址/);
  assert.equal(requests, 1);
});

test('a missing cross-origin chunk offset falls back without finalizing the first version', async () => {
  const blob = new Blob(['MLHENC01', new Uint8Array(8 * 1024 * 1024)]);
  let metadata;
  let sessions = 0;
  const uploads = [];
  await uploadDriveBackup(auth, blob, {send: async (href, request) => {
    const url = checkRequest(href, request);
    if (request.method === 'POST') {
      metadata = JSON.parse(request.body);
      return new Response(null, {headers: {Location: origin + uploadPath + '?upload_id=session-' + ++sessions}});
    }
    uploads.push(url.searchParams.get('upload_id'));
    if (uploads.length === 1) {
      assert(request.body.size < blob.size);
      return new Response(null, {headers: {'Content-Length': '0'}});
    }
    assert.equal(request.body, blob);
    assert.equal(request.headers['Content-Range'], undefined);
    return Response.json({id: 'new-version', ...metadata, size: String(blob.size), createdTime: createTime});
  }});
  assert.deepEqual(uploads, ['session-1', 'session-2']);
});

test('an interrupted chunk queries the same session and retries from the server offset', async () => {
  const eightMiB = 8 * 1024 * 1024;
  const blob = new Blob(['MLHENC01', new Uint8Array(eightMiB - 7)]);
  let metadata;
  const ranges = [];
  const result = await uploadDriveBackup(auth, blob, {send: async (href, request) => {
    const url = checkRequest(href, request);
    if (request.method === 'POST') {
      metadata = JSON.parse(request.body);
      return new Response(null, {headers: {Location: origin + uploadPath + '?upload_id=same-session'}});
    }
    assert.equal(url.searchParams.get('upload_id'), 'same-session');
    ranges.push(request.headers['Content-Range']);
    if (ranges.length === 2) throw new TypeError('Connection lost during upload');
    if (ranges.length < 4) {
      return new Response(null, {headers: {Range: `bytes=0-${eightMiB - 1}`, 'X-Http-Status-Code-Override': '308'}});
    }
    return Response.json({id: 'restored', ...metadata, size: String(blob.size), createdTime: createTime});
  }});
  const finalRange = `bytes ${eightMiB}-${eightMiB}/${blob.size}`;
  assert.deepEqual(ranges, [`bytes 0-${eightMiB - 1}/${blob.size}`, finalRange, `bytes */${blob.size}`, finalRange]);
  assert.equal(result.id, 'restored');
});

test('download enforces the backup size limit and expiration blocks requests', async () => {
  await assert.rejects(downloadDriveBackup(auth, 'back-up', {send: async () => new Response('bytes', {
    headers: {'Content-Length': String(maxDriveBackupBytes + 1)},
  })}), /下载上限/);
  await assert.rejects(listDriveBackups({token: 'inactive', expires: 0}, {
    send: () => assert.fail('should not send an expired token'),
  }), {status: 401});
});

test('unencrypted local history is rejected before any upload request', async () => {
  await assert.rejects(uploadDriveBackup(auth, new Blob(['MLHIST01', 'plain history']), {
    send: () => assert.fail('should not send an unencrypted archive'),
  }), /请先加密历史备份/);
});
