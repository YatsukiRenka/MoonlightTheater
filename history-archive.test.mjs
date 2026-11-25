import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveIsEncrypted, createHistoryArchive, decryptHistoryArchive, encryptHistoryArchive, readHistoryArchive} from './history-archive.mjs';

const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw0cAAAAASUVORK5CYII='),
  value => value.charCodeAt(0));
const image = new Blob([pngBytes], {type: 'image/png'});
const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], {type: 'image/svg+xml'});
const prompts = {
  records: [{id: 'last-prompt', profileId: 'initial', prompt: {zh: '月下的向日葵', en: 'Sunflower in moonlight'}}],
  profiles: {initial: {profileVersion: '0.1.0'}},
  manualMaterials: {},
};
const record = {
  id: 82, model: 'gpt-image-1.5', provider: 'openai', prompt: '画一张花', seed: 'SEED42', language: 'zh', time: 1700000000123,
  text: '完成', metrics: {elapsed: 42, tokens: {input: 120, output: null}, cost: {value: .02, currency: 'USD', source: 'official'}},
  sources: [{title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Sunflower'}], images: [image],
};

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

test('the archive round-trips the history order, IDs, Unicode, MIME types and original image bytes', async () => {
  const archived = createHistoryArchive({prompts, images: [record, {...record, id: 'later-record', images: [svg, image]}]});
  const restored = await readHistoryArchive(archived);
  assert.equal(await archiveIsEncrypted(archived), false);
  assert.deepEqual(restored.prompts, prompts);
  assert.deepEqual(restored.images.map(group => group.id), [82, 'later-record']);
  assert.deepEqual({...restored.images[0], images: undefined}, {...record, images: undefined});
  assert.deepEqual(restored.images.map(group => group.images.map(blob => blob.type)), [['image/png'], ['image/svg+xml', 'image/png']]);
  assert.deepEqual(await bytes(restored.images[0].images[0]), pngBytes);
  assert.deepEqual(await bytes(restored.images[1].images[0]), await bytes(svg));
  assert.deepEqual(await bytes(restored.images[1].images[1]), pngBytes);
});

test('backup projection excludes unrelated controls, credentials and extra image metadata', async () => {
  const token = 'fixture-account-secret';
  const original = {
    apiKey: token,
    prompts: {...prompts, settings: {apiKey: token}},
    images: [{...record, apiKey: token, size: 0, metrics: {...record.metrics, credentials: token,
      tokens: {...record.metrics.tokens, authentication: token}, cost: {...record.metrics.cost, key: token}},
    sources: [{...record.sources[0], apiKey: token}]}],
  };
  const archived = createHistoryArchive(original);
  assert(!((await archived.text()).includes(token)));
  const restored = await readHistoryArchive(archived);
  assert.deepEqual(restored.prompts, prompts);
  assert.deepEqual(restored.images[0].metrics, record.metrics);
  assert.deepEqual(restored.images[0].sources, record.sources);
  assert.equal(restored.images[0].size, undefined);
});

test('cloud-only image records export cached thumbnails and preserve Drive references', async () => {
  const thumbnail = {mime: 'image/png', bytes: image.size, digest: 'a'.repeat(64)};
  const preview = {mime: 'image/jpeg', bytes: 512_000, digest: 'b'.repeat(64)};
  const original = {mime: 'image/webp', bytes: 2_000_000, digest: 'c'.repeat(64)};
  const cloud = {version: 1, batchId: 'legacy-82', manifestId: 'manifest-82', renditions: [{
    thumbnail: 'thumb-82', preview: 'preview-82', original: 'original-82', mime: original.mime, bytes: original.bytes,
    details: {thumbnail, preview, original},
  }]};
  const archived = createHistoryArchive({prompts, images: [{...record, id: cloud.batchId, cloud, images: [image]}]});
  assert(archived.size < preview.bytes);
  const {images: [restored]} = await readHistoryArchive(archived);
  assert.deepEqual(restored.cloud, cloud);
  assert.deepEqual(await bytes(restored.images[0]), pngBytes);
  assert.throws(() => createHistoryArchive({prompts, images: [{...restored, cloud: {...cloud, manifestId: '../escape'}}]}), /格式无效/);
});

test('malformed headers, unsupported MIME types, invalid IDs and truncation are rejected', async () => {
  assert.throws(() => createHistoryArchive({prompts, images: [{...record, images: [new Blob(['html'], {type: 'text/html'})]}]}), /格式无效/);
  assert.throws(() => createHistoryArchive({prompts, images: [{...record, id: '__proto__'}]}), /格式无效/);
  assert.throws(() => createHistoryArchive({prompts, images: [{...record, id: '../outside'}]}), /格式无效/);
  const archived = createHistoryArchive({prompts, images: [record]});
  await assert.rejects(readHistoryArchive(archived.slice(0, -1)), /格式无效/);
  await assert.rejects(readHistoryArchive(new Blob([archived, 'extra bytes'])), /格式无效/);
  const header = await bytes(archived.slice(0, 12));
  new DataView(header.buffer).setUint32(8, 0xffffffff);
  await assert.rejects(readHistoryArchive(new Blob([header, archived.slice(12)])), /格式无效/);
});

test('encryption protects the complete multichunk archive with independent salts and exact passwords', async () => {
  const large = new Blob([image, new Uint8Array(2 * 1024 * 1024 + 37)], {type: 'image/png'});
  const archived = createHistoryArchive({prompts, images: [{...record, images: [large, svg]}]});
  const password = ' 包含两侧空格的密码 ☽ ';
  const encrypted = await encryptHistoryArchive(archived, password);
  assert(await archiveIsEncrypted(encrypted));
  assert.notDeepEqual(await bytes(encrypted.slice(8, 32)), await bytes((await encryptHistoryArchive(archived, password)).slice(8, 32)));
  await assert.rejects(readHistoryArchive(encrypted), /先解密/);
  assert.deepEqual(await bytes(await decryptHistoryArchive(encrypted, password)), await bytes(archived));
  await assert.rejects(decryptHistoryArchive(encrypted, password.trim()), /密码不正确/);

  const finalByte = await bytes(encrypted.slice(-1));
  finalByte[0] ^= 1;
  await assert.rejects(decryptHistoryArchive(new Blob([encrypted.slice(0, -1), finalByte]), password), /加密文件已损坏/);
  await assert.rejects(decryptHistoryArchive(encrypted.slice(0, -1), password), /格式无效/);
  const headerSize = 36;
  const cipherChunkSize = 1024 * 1024 + 16;
  const second = headerSize + cipherChunkSize;
  const third = second + cipherChunkSize;
  const rearranged = new Blob([encrypted.slice(0, headerSize), encrypted.slice(second, third),
    encrypted.slice(headerSize, second), encrypted.slice(third)]);
  await assert.rejects(decryptHistoryArchive(rearranged, password), /加密文件已损坏/);
});
