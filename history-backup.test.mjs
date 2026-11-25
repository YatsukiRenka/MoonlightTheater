import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initializeHistoryBackup} from './history-backup.mjs';
import {defaultHistoryLimits, readHistoryLimits, saveHistoryLimits} from './history-limits.mjs';

class ElementStub {
  value = '';
  classList = {toggle() {}};

  get valueAsNumber() {
    return this.value === '' ? NaN : Number(this.value);
  }

  addEventListener() {}
  querySelector() { return new ElementStub(); }
  replaceChildren() {}
}

function overrideGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test('stale retention form asks before saving its displayed capacity', async t => {
  const stored = new Map();
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  const fields = new Map(['promptCount', 'imageCount', 'imageCapacity', 'imageUnit']
    .map(name => [name, new ElementStub()]));
  const form = Object.assign(new ElementStub(), {elements: {namedItem: name => fields.get(name)}});
  const elements = new Map([['historyLimits', form]]);
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new ElementStub());
      return elements.get(id);
    },
    querySelector: () => null,
  };
  let allowSave = false;
  const confirm = t.mock.fn(() => allowSave);
  const window = Object.assign(new EventTarget(), {confirm});

  overrideGlobal(t, 'document', document);
  overrideGlobal(t, 'localStorage', storage);
  overrideGlobal(t, 'location', {origin: 'https://example.test'});
  overrideGlobal(t, 'Option', class OptionStub {
    constructor(text, value) { this.text = text; this.value = value; }
  });
  overrideGlobal(t, 'indexedDB', {open() {
    const request = {error: new Error('No IndexedDB test fixture')};
    queueMicrotask(() => request.onerror?.());
    return request;
  }});
  overrideGlobal(t, 'window', window);

  initializeHistoryBackup({
    readPrompts: () => [],
    mergePrompts() {},
    applyPromptLimit: () => 0,
    refreshHistory() {},
    cloud: {enabled: false, interval: 15, ready: false, lock() {}, configure() {}},
  });

  const capacityInput = fields.get('imageCapacity');
  const unitInput = fields.get('imageUnit');
  const filledLimits = readHistoryLimits(storage);
  assert.deepEqual(filledLimits, defaultHistoryLimits);

  const changedLimits = saveHistoryLimits({...filledLimits, imageCapacity: 100, imageUnit: 'MB'}, storage);
  window.dispatchEvent(new Event('storage'));
  assert.match(elements.get('imageHistoryLimit').textContent, /总计 100 MB/);
  assert.equal(capacityInput.value, '64');
  assert.equal(unitInput.value, 'MiB');

  const submit = () => form.onsubmit({preventDefault() {}});
  submit();
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepEqual(readHistoryLimits(storage), changedLimits);

  allowSave = true;
  submit();
  assert.equal(confirm.mock.callCount(), 2);
  assert.deepEqual(readHistoryLimits(storage), filledLimits);
  await new Promise(resolve => setImmediate(resolve));
});
