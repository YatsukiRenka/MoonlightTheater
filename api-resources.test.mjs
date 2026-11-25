import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readAPIResources, removeAPIResource, saveAPIResource, verifyAPIResource} from './api-resources.mjs';

const origin = 'https://moonlight.example';
const legacy = 'moonlight-image-resources-v1';
const current = 'moonlight-image-resources-v2';
const model = 'gpt-image-2.6-flare';
const alternative = 'gpt-image-2.6-sunburst';

function browserStorage() {
  const values = new Map();
  return {getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, String(value)), removeItem: name => values.delete(name)};
}

function openaiCatalog(expected) {
  return async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(request.headers.Authorization, 'Bearer ' + expected);
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    return Response.json({data: [{id: model}, {id: alternative}]});
  };
}

function proofFor(key, options) {
  return verifyAPIResource('openai', {key}, {...options, send: openaiCatalog(key)});
}

const saveOpenai = (name, key, verification, options) => saveAPIResource({
  provider: 'openai', name, values: {key, model}, verification,
}, options);

test('legacy resource IDs migrate without reviving entries removed from the newer library', async () => {
  const storage = browserStorage();
  storage.setItem(legacy, JSON.stringify({openai: {key: 'fixture-legacy', model, models: [model]},
    'gemini-oauth': {clientId: 'fixture.apps.googleusercontent.com', project: 'fixture-project', token: 'ignore-old-token'}}));
  assert.deepEqual(readAPIResources(storage).map(({id, provider, name}) => ({id, provider, name})), [
    {id: 'openai', provider: 'openai', name: 'OpenAI'},
    {id: 'gemini-oauth', provider: 'gemini-oauth', name: 'Gemini · Google OAuth'},
  ]);
  assert.equal(storage.getItem(current), null);
  assert.equal(await removeAPIResource('gemini-oauth', {storage}), true);
  assert.equal(storage.getItem(legacy), null);
  assert(!storage.getItem(current).includes('ignore-old-token'));
  assert.equal(readAPIResources(storage)[0].config.key, 'fixture-legacy');
  assert.equal(await removeAPIResource('openai', {storage}), true);
  assert.equal(storage.getItem(current), '[]');
  assert.deepEqual(readAPIResources(storage), []);
  assert.equal(await removeAPIResource('openai', {storage}), false);
});

test('failing to write the new library leaves the old credentials untouched', async () => {
  const stored = browserStorage();
  const legacyData = JSON.stringify({openai: {key: 'fixture-legacy', model, models: [model]}});
  stored.setItem(legacy, legacyData);
  let rejectWrite = true;
  const storage = {...stored, setItem(name, value) {
    if (rejectWrite && name === current) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    stored.setItem(name, value);
  }};
  const options = {storage, origin};
  const proof = await proofFor('key-new', options);
  await assert.rejects(saveOpenai('新接口', 'key-new', proof, options), /无法保存/);
  assert.equal(storage.getItem(legacy), legacyData);
  assert.equal(storage.getItem(current), null);
  rejectWrite = false;
  await saveOpenai('新接口', 'key-new', proof, options);
  assert.equal(storage.getItem(legacy), null);
  assert.deepEqual(readAPIResources(storage).map(({config}) => config.key), ['fixture-legacy', 'key-new']);
});

test('two resources of one provider retain their own identities, credentials and model lists', async () => {
  const storage = browserStorage();
  const options = {storage, origin};
  const first = await saveOpenai('个人', 'key-personal', await proofFor('key-personal', options), options);
  const second = await saveOpenai('团队', 'key-team', await proofFor('key-team', options), options);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(readAPIResources(storage).map(row => [row.id, row.name, row.config.key]), [
    [first.id, '个人', 'key-personal'], [second.id, '团队', 'key-team'],
  ]);
  const verifyPersonal = await verifyAPIResource('openai', {}, {...options, id: first.id, send: openaiCatalog('key-personal')});
  assert.deepEqual(verifyPersonal.models, [model, alternative]);
  assert(!JSON.stringify(verifyPersonal).includes('key-personal'));
  const updated = await saveAPIResource({id: second.id, provider: 'openai', name: '团队-新名字', values: {model: alternative}}, options);
  assert.equal(updated.config.key, 'key-team');
  assert.equal(updated.config.model, alternative);
  assert.equal(readAPIResources(storage).find(row => row.id === first.id).config.model, model);
  await assert.rejects(verifyAPIResource('openai', {}, {...options, send: () => assert.fail('new resources cannot reuse a key')}), /API Key/);
  await assert.rejects(verifyAPIResource('gemini', {}, {...options, id: first.id,
    send: () => assert.fail('provider may not change')}), /类型已变更/);
});

test('blank names get unique provider defaults and preserve the selected row name when editing', async () => {
  const storage = browserStorage();
  storage.setItem(legacy, JSON.stringify({openai: {key: 'legacy-key', model, models: [model]}}));
  const options = {storage, origin};
  const second = await saveOpenai(undefined, 'second-key', await proofFor('second-key', options), options);
  const third = await saveOpenai('  ', 'third-key', await proofFor('third-key', options), options);
  assert.deepEqual(readAPIResources(storage).map(row => row.name), ['OpenAI', 'OpenAI 2', 'OpenAI 3']);
  const edit = await saveAPIResource({id: second.id, provider: 'openai', name: '', values: {model: alternative}}, options);
  assert.equal(edit.name, 'OpenAI 2');
  assert.equal(third.name, 'OpenAI 3');
});

test('cannot save unverified credentials, unavailable models, or a proof for another target/origin/storage', async () => {
  const storage = browserStorage();
  const options = {storage, origin};
  const key = 'test-key';
  await assert.rejects(saveOpenai('未验证', key, undefined, options), /先验证/);
  const newProof = await proofFor(key, options);
  await assert.rejects(saveOpenai('另一个来源', key, newProof, {...options, origin: 'https://other.example'}), /先验证/);
  await assert.rejects(saveOpenai('另一个储存空间', key, newProof, {...options, storage: browserStorage()}), /先验证/);
  await assert.rejects(saveAPIResource({provider: 'openai', values: {model: 'not-listed', key}, verification: newProof}, options), /列表/);
  const first = await saveOpenai('第一条', key, newProof, options);
  await assert.rejects(saveOpenai('同一份新建验证', key, newProof, options), /先验证/);
  const second = await saveOpenai('第二条', key, await proofFor(key, options), options);
  const firstProof = await verifyAPIResource('openai', {}, {...options, id: first.id, send: openaiCatalog(key)});
  await assert.rejects(saveAPIResource({id: second.id, provider: 'openai', values: {model}, verification: firstProof}, options), /先验证/);
  assert.equal((await saveAPIResource({id: first.id, provider: 'openai', values: {model}, verification: firstProof}, options)).id, first.id);
});

test('saved custom secrets are not reused after a domain or protocol change', async () => {
  const storage = browserStorage();
  const options = {storage, origin};
  const values = {url: 'https://gateway.example/v1/images/generations', format: 'openai', key: 'gateway-test-key', model: 'image-any'};
  const proof = await verifyAPIResource('custom', values, {...options, send: async (url, request) => {
    assert.equal(url, 'https://gateway.example/v1/models');
    if (!request.headers) return new Response(null, {status: 401});
    assert.equal(request.headers.Authorization, 'Bearer gateway-test-key');
    return Response.json({data: [{id: values.model}]});
  }});
  const row = await saveAPIResource({provider: 'custom', values, verification: proof}, options);
  const swapped = {format: 'openai', url: 'https://new-gateway.example/v1/images/generations', model: values.model};
  for (const next of [swapped, {format: 'gemini', url: 'https://gateway.example/v1/models/{model}:generateContent'}]) {
    await assert.rejects(verifyAPIResource('custom', next, {...options, id: row.id,
      send: () => assert.fail('old stored API key must not be forwarded')}), /域名或协议/);
  }

  const open = await verifyAPIResource('custom', {...swapped, clearKey: true}, {...options, id: row.id,
    send: async (url, request) => {
      assert.equal(url, 'https://new-gateway.example/v1/models');
      assert.deepEqual(request.headers, {});
      return Response.json({data: [{id: values.model}]});
    }});
  const changed = await saveAPIResource({id: row.id, provider: 'custom', values: {...swapped, clearKey: true}, verification: open}, options);
  assert.equal(changed.config.key, '');
  assert.equal(changed.config.url, swapped.url);
});

test('OAuth proof authorization remains available only in memory', async () => {
  const options = {origin, storage: browserStorage()};
  const values = {clientId: 'fixture.apps.googleusercontent.com', project: 'fixture-project', model: 'gemini-nano-banana-2.1'};
  const authorization = {clientId: values.clientId, project: values.project, token: 'opaque-oauth-fixture', expires: Date.now() + 60_000};
  const proof = await verifyAPIResource('gemini-oauth', values, {...options, authorize: async () => authorization,
    send: async (url, request) => {
      assert.equal(request.headers.Authorization, 'Bearer opaque-oauth-fixture');
      return Response.json({publisherModels: [{name: 'publishers/google/models/' + values.model}]});
    }});
  const row = await saveAPIResource({provider: 'gemini-oauth', name: 'Project A', values, verification: proof}, options);
  assert.equal(proof.authorization.token, authorization.token);
  assert(!JSON.stringify(proof).includes(authorization.token));
  assert(!JSON.stringify(row).includes(authorization.token));
  assert(!options.storage.getItem(current).includes(authorization.token));
});

test('concurrent saves coordinate the read/modify/write with Web Locks', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  let queued = Promise.resolve();
  let acquisitions = 0;
  Object.defineProperty(globalThis.navigator, 'locks', {configurable: true, value: {request(name, run) {
    assert.equal(name, current);
    acquisitions++;
    const pending = queued.then(run);
    queued = pending.catch(() => {});
    return pending;
  }}});
  t.after(() => {
    if (original) Object.defineProperty(globalThis.navigator, 'locks', original);
    else delete globalThis.navigator.locks;
  });
  const storage = browserStorage();
  const options = {origin, storage};
  const [personal, team] = await Promise.all([proofFor('key-has-little', options), proofFor('key-has-much', options)]);
  const [first] = await Promise.all([
    saveOpenai('小项目', 'key-has-little', personal, options), saveOpenai('大项目', 'key-has-much', team, options),
  ]);
  assert.equal(readAPIResources(storage).length, 2);
  assert.equal(await removeAPIResource(first.id, options), true);
  assert.equal(readAPIResources(storage).length, 1);
  assert.equal(acquisitions, 3);
});
