import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeImageRenditions} from './image-renditions.mjs';

const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {type: 'image/png'});

function stubBrowser(t, width, height, {webp = true, decodeError} = {}) {
  const drawn = [];
  const encodings = [];
  const created = [];
  const revoked = [];
  const cleared = [];
  const context = {drawImage: (image, ...position) => drawn.push([image.src, ...position])};
  const canvas = {
    getContext(type, options) {
      assert.equal(type, '2d');
      assert.deepEqual(options, {alpha: true});
      return context;
    },
    toBlob(callback, mime) {
      encodings.push([mime, this.width, this.height]);
      callback(!webp && mime === 'image/webp' ? null : new Blob(['encoded'], {type: mime}));
    },
  };
  const entries = {
    Image: class {
      naturalWidth = width;
      naturalHeight = height;
      decode() { return decodeError ? Promise.reject(decodeError) : Promise.resolve(); }
      removeAttribute(name) { cleared.push(name); }
    },
    document: {createElement: name => { assert.equal(name, 'canvas'); return canvas; }},
  };
  for (const [name, value] of Object.entries(entries)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  t.mock.method(URL, 'createObjectURL', image => { created.push(image); return 'blob:rendition-fixture'; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  return {canvas, drawn, encodings, created, revoked, cleared};
}

test('image variants fit their edge limits proportionally and reuse the exact original Blob', async t => {
  const {canvas, drawn, encodings, created, revoked, cleared} = stubBrowser(t, 2560, 960);
  const {thumbnail, preview, original} = await makeImageRenditions(png);
  assert.equal(thumbnail.type, 'image/webp');
  assert.equal(preview.type, 'image/webp');
  assert.strictEqual(original, png);
  assert.deepEqual(created, [png]);
  assert.deepEqual(encodings, [['image/webp', 320, 120], ['image/webp', 1280, 480]]);
  assert.deepEqual(drawn, [['blob:rendition-fixture', 0, 0, 320, 120], ['blob:rendition-fixture', 0, 0, 1280, 480]]);
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  assert.deepEqual(revoked, ['blob:rendition-fixture']);
  assert.deepEqual(cleared, ['src']);
});

test('small GIF renditions stay at original dimensions and fall back to PNG posters', async t => {
  const {encodings} = stubBrowser(t, 25, 40, {webp: false});
  const gif = new Blob(['GIF89a'], {type: 'image/gif'});
  const {thumbnail, preview, original} = await makeImageRenditions(gif);
  assert.equal(thumbnail.type, 'image/png');
  assert.equal(preview.type, 'image/png');
  assert.strictEqual(original, gif);
  assert.deepEqual(encodings, [['image/webp', 25, 40], ['image/png', 25, 40], ['image/webp', 25, 40], ['image/png', 25, 40]]);
});

test('forged MIME data never reaches the decoder and decoding failure releases its URL', async t => {
  const {created, revoked, cleared, encodings} = stubBrowser(t, 0, 0, {decodeError: new Error('decode failure')});
  await assert.rejects(makeImageRenditions(new Blob(['unexpected'], {type: 'image/png'})), /格式无效或不安全/);
  assert.deepEqual(created, []);
  await assert.rejects(makeImageRenditions(png), /无法解码/);
  assert.deepEqual(revoked, ['blob:rendition-fixture']);
  assert.deepEqual(cleared, ['src']);
  assert.deepEqual(encodings, []);
});
