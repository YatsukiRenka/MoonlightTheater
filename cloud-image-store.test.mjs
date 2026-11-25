import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createCloudImageStore} from './cloud-image-store.mjs';

const auth = {token: 'image-token', expires: 8.64e15};
const password = 'independent image password';
const record = {id: 'batch-123', model: 'model-test', provider: 'custom', language: 'en', seed: 'seed',
  prompt: 'Private character prompt', time: Date.parse('2026-11-25T00:00:00Z'), apiKey: 'not-history-data',
  metrics: {elapsed: 50, tokens: {total: 10, credential: 'filter-me'}}};
const thumbnail = new Blob(['small thumbnail'], {type: 'image/webp'});
const preview = new Blob(['larger preview image'], {type: 'image/jpeg'});
const original = new Blob(['original image contents'], {type: 'image/svg+xml'});
const renditions = [{thumbnail, preview, original}];

async function readMultipart(request) {
  const delimiter = Buffer.from('\r\n--' + request.headers['Content-Type'].match(/boundary=(.+)$/)[1]);
  const breakBetweenHeadersAndBody = Buffer.from('\r\n\r\n');
  const body = Buffer.from(await request.body.arrayBuffer());
  const metadataStart = body.indexOf(breakBetweenHeadersAndBody) + breakBetweenHeadersAndBody.length;
  const metadataEnd = body.indexOf(delimiter, metadataStart);
  const mediaStart = body.indexOf(breakBetweenHeadersAndBody, metadataEnd) + breakBetweenHeadersAndBody.length;
  const mediaEnd = body.lastIndexOf(delimiter);
  return {metadata: JSON.parse(body.subarray(metadataStart, metadataEnd).toString('utf8')), bytes: body.subarray(mediaStart, mediaEnd)};
}

function fakeDrive({checksum = 'immediate', manifestResponseLost = false} = {}) {
  const files = new Map();
  const events = [];
  const send = async (href, request) => {
    const url = new URL(href);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(request.headers.Authorization, 'Bearer image-token');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    if (request.method === 'POST') {
      const {metadata, bytes} = await readMultipart(request);
      assert.deepEqual(metadata.parents, ['appDataFolder']);
      assert.equal(metadata.mimeType, 'application/octet-stream');
      const kind = metadata.appProperties.moonlightImageManifest === '1' ? 'manifest' : 'rendition';
      assert.deepEqual(Object.keys(metadata.appProperties), [kind === 'manifest' ? 'moonlightImageManifest' : 'moonlightImageRendition']);
      assert(!JSON.stringify(metadata).includes(record.prompt));
      assert.equal(bytes.subarray(0, 8).toString('utf8'), 'MLCIMG01');
      assert(!bytes.includes(Buffer.from(record.prompt)));
      const id = `file-${files.size + 1}`;
      const sha256Checksum = createHash('sha256').update(bytes).digest('hex');
      const saved = {id, name: metadata.name, size: String(bytes.length), createdTime: new Date(Date.now()).toISOString(), sha256Checksum};
      files.set(id, {saved, kind, bytes});
      events.push(['create', id, kind]);
      if (kind === 'manifest' && manifestResponseLost) throw new TypeError('simulated dropped manifest response');
      if (kind === 'rendition') assert.match(url.searchParams.get('fields'), /sha256Checksum/);
      return Response.json({...saved, sha256Checksum: checksum === 'immediate' ? sha256Checksum
        : checksum === 'wrong' ? '0'.repeat(64) : undefined});
    }
    if (url.pathname === '/drive/v3/files') {
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      assert.match(url.searchParams.get('q'), /moonlightImageManifest/);
      events.push(['list']);
      return Response.json({files: [...files.values()].filter(file => file.kind === 'manifest').map(file => file.saved)});
    }
    const id = url.pathname.split('/').at(-1);
    const file = files.get(id);
    if (!file) return new Response(null, {status: 404});
    if (request.method === 'DELETE') {
      events.push(['delete', id]);
      files.delete(id);
      return new Response(null, {status: 204});
    }
    if (url.searchParams.get('alt') === 'media') {
      events.push(['media', id, file.kind]);
      return new Response(file.bytes);
    }
    assert.equal(url.searchParams.get('fields'), 'id,size,sha256Checksum');
    events.push(['verify', id]);
    return Response.json({...file.saved, sha256Checksum: checksum === 'missing' ? undefined : file.saved.sha256Checksum});
  };
  return {send, files, events};
}

test('writes separately encrypted image tiers and publishes the manifest without retrieving originals', async () => {
  const {send, events, files} = fakeDrive();
  const client = createCloudImageStore(auth, password, {send});
  const cloud = await client.putBatch(record, renditions);
  assert.equal(cloud.version, 1);
  assert.equal(cloud.manifestId, 'file-4');
  assert.equal(cloud.batchId, record.id);
  const [image] = cloud.renditions;
  assert.deepEqual([image.thumbnail, image.preview, image.original], ['file-1', 'file-2', 'file-3']);
  assert.notDeepEqual(files.get(image.thumbnail).bytes.subarray(24, 36), files.get(image.preview).bytes.subarray(24, 36));
  assert.deepEqual(events.map(([operation, id, kind]) => [operation, kind]), [
    ['create', 'rendition'], ['create', 'rendition'], ['create', 'rendition'], ['create', 'manifest'],
  ]);

  const nextDevice = createCloudImageStore(auth, password, {send});
  const {records, skipped} = await nextDevice.listBatches();
  assert.equal(skipped, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].prompt, record.prompt);
  assert.equal(records[0].id, record.id);
  assert.equal(records[0].size, original.size);
  assert.equal(records[0].metrics.tokens.total, 10);
  assert(!Object.hasOwn(records[0], 'apiKey'));
  assert(!Object.hasOwn(records[0].metrics.tokens, 'credential'));
  assert(!Object.hasOwn(records[0], 'images'));
  assert.deepEqual(events.filter(event => event[0] === 'media'), [['media', cloud.manifestId, 'manifest']]);

  for (const [tier, expected] of Object.entries(renditions[0])) {
    const downloaded = await nextDevice.getImage(records[0].cloud, 0, tier);
    assert.equal(downloaded.type, expected.type);
    assert.equal(await downloaded.text(), await expected.text());
  }
  files.get(image.thumbnail).bytes[files.get(image.thumbnail).bytes.length - 1] ^= 1;
  await assert.rejects(nextDevice.getImage(cloud, 0, 'thumbnail'), /完整性校验/);
});

test('verifies the exact large original SHA-256 through a metadata-only fallback', async () => {
  const {send, events} = fakeDrive({checksum: 'later'});
  const client = createCloudImageStore(auth, password, {send});
  const image = new Blob([new Uint8Array(1024 * 1024 + 73), 'nonaligned bytes'], {type: 'image/png'});
  const cloud = await client.putBatch(record, [{thumbnail, preview, original: image}]);
  assert.deepEqual(events.filter(event => event[0] !== 'create'), [['verify', cloud.renditions[0].original]]);
  assert.equal(cloud.renditions[0].bytes, image.size);
});

test('checksum mismatch or absence cleans only newly created uncommitted rendition files', async () => {
  for (const checksum of ['wrong', 'missing']) {
    const {send, events, files} = fakeDrive({checksum});
    files.set('previous', {kind: 'backup', saved: {id: 'previous'}, bytes: Buffer.from('previous encrypted backup')});
    const client = createCloudImageStore(auth, password, {send});
    await assert.rejects(client.putBatch(record, renditions), /保留本地原图/);
    assert.deepEqual([...files.keys()], ['previous']);
    assert.deepEqual(events.filter(event => event[0] === 'delete').map(event => event[1]), ['file-2', 'file-3', 'file-4']);
    assert(!events.some(event => event[2] === 'manifest' || event[0] === 'media'));
  }
});

test('after manifest publication is attempted, unresolved network outcomes do not delete possibly committed media', async () => {
  const {send, events} = fakeDrive({manifestResponseLost: true});
  const client = createCloudImageStore(auth, password, {send});
  await assert.rejects(client.putBatch(record, renditions), /无法连接 Google Drive/);
  assert(!events.some(event => event[0] === 'delete'));
  assert.equal((await client.listBatches()).records.length, 1);
  const wrong = createCloudImageStore(auth, 'incorrect-password', {send});
  assert.deepEqual(await wrong.listBatches(), {records: [], skipped: 1});
});

test('polling caches authenticated manifests, evicts absent IDs, and rechecks failed reads', async () => {
  const {send, files, events} = fakeDrive();
  const client = createCloudImageStore(auth, password, {send});
  const {manifestId} = await client.putBatch(record, renditions);
  const manifest = files.get(manifestId);
  const reads = () => events.filter(([operation, id]) => operation === 'media' && id === manifestId).length;

  assert.equal((await client.listBatches()).records.length, 1);
  assert.equal((await client.listBatches()).records.length, 1);
  assert.equal(reads(), 1);

  files.delete(manifestId);
  assert.deepEqual(await client.listBatches(), {records: [], skipped: 0});
  files.set(manifestId, {...manifest, bytes: Buffer.from(manifest.bytes)});
  files.get(manifestId).bytes[manifest.bytes.length - 1] ^= 1;
  assert.deepEqual(await client.listBatches(), {records: [], skipped: 1});
  assert.equal(reads(), 2);

  files.set(manifestId, manifest);
  assert.equal((await client.listBatches()).records.length, 1);
  assert.equal(reads(), 3);
});
