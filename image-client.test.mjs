import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  describeImageResources, generateImage, readImageResources, updateImageResource, verifyImageResource,
} from './image-client.mjs';

const origin = 'https://moonlight.example';

function browserStorage() {
  const data = new Map();
  return {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key)};
}

test('saving a key requires successful verification of that key and an offered model', async () => {
  const options = {origin, storage: browserStorage()};
  const save = (values, verification) => updateImageResource('openai', 'save', values, {...options, verification});
  const draft = {key: 'fixture-key', model: 'gpt-image-2.6-flare'};
  assert.throws(() => save(draft), /先验证/);
  await assert.rejects(verifyImageResource('openai', draft, {
    ...options, send: async () => new Response(null, {status: 401}),
  }), /身份验证/);
  assert.deepEqual(readImageResources(options.storage), {});

  const proof = await verifyImageResource('openai', draft, {
    ...options,
    send: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(request.headers.Authorization, 'Bearer fixture-key');
      assert.equal(request.redirect, 'error');
      assert.equal(request.credentials, 'omit');
      assert.equal(request.body, undefined);
      return Response.json({data: [{id: draft.model}, {id: 'gpt-image-2.6-sunburst'}, {id: 'gpt-4o'}]});
    },
  });
  assert.deepEqual(proof.models, [draft.model, 'gpt-image-2.6-sunburst']);
  assert.deepEqual(readImageResources(options.storage), {});
  assert.throws(() => save({...draft, key: 'different-key'}, proof), /先验证/);
  assert.throws(() => save({...draft, model: 'made-up-model'}, proof), /列表/);
  const stored = save(draft, proof);
  assert.equal(stored.openai.model, draft.model);
  assert(!JSON.stringify(describeImageResources(stored, null, origin)).includes(draft.key));
  assert.equal(save({key: '', model: 'gpt-image-2.6-sunburst'}).openai.key, draft.key);
  await assert.rejects(generateImage({
    provider: 'openai', model: 'made-up-model', aspect: 'auto', prompt: 'A character',
  }, stored, null, {...options, send: () => assert.fail('unexpected request')}), /列表/);
});

test('Gemini reads all pages before offering valid image models and supports saved legacy keys', async () => {
  const options = {origin, storage: browserStorage()};
  options.storage.setItem('moonlight-image-resources-v1', JSON.stringify({gemini: {key: 'legacy-key'}}));
  assert.equal(describeImageResources(readImageResources(options.storage), null, origin).providers.gemini.ready, false);
  const proof = await verifyImageResource('gemini', {}, {
    ...options,
    send: async (url, request) => {
      assert.equal(request.headers['x-goog-api-key'], 'legacy-key');
      return new URL(url).searchParams.get('pageToken')
        ? Response.json({models: [{name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent']}]})
        : Response.json({nextPageToken: 'next', models: [
          {name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent']},
          {name: 'models/gemini-vision-only', outputModalities: ['TEXT']},
          {name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent']},
        ]});
    },
  });
  assert.deepEqual(proof.models, ['gemini-3.1-flash-image', 'gemini-nano-banana-2.1']);
  assert.equal(updateImageResource('gemini', 'save', {model: proof.models[1]}, {...options, verification: proof}).gemini.key, 'legacy-key');
});

test('gateway verification only sends keys to the chosen origin and declines an anonymous catalog', async () => {
  const options = {origin, storage: browserStorage()};
  const draft = {url: 'https://gateway.example/v1/images/generations', format: 'openai', key: 'gateway-key'};
  await assert.rejects(verifyImageResource('custom', {...draft, modelsURL: 'https://other.example/models'}, {
    ...options, send: () => assert.fail('unexpected request'),
  }), /同源/);
  const catalog = () => Response.json({data: [{id: 'custom-alias'}]});
  await assert.rejects(verifyImageResource('custom', draft, {...options, send: async () => catalog()}), /无法校验/);
  const proof = await verifyImageResource('custom', draft, {
    ...options,
    send: async (url, request) => {
      assert.equal(url, 'https://gateway.example/v1/models');
      if (!request.headers) return new Response(null, {status: 401});
      assert.equal(request.headers.Authorization, 'Bearer gateway-key');
      return catalog();
    },
  });
  assert.deepEqual(proof.models, ['custom-alias']);
  assert.throws(() => updateImageResource('custom', 'save', {...draft, model: proof.models[0], modelsURL: 'https://gateway.example/other'}, {
    ...options, verification: proof,
  }), /先验证/);
});

test('Vertex verification lists models with the authorized project and stores no OAuth token', async () => {
  const options = {origin, storage: browserStorage()};
  const draft = {clientId: 'fixture.apps.googleusercontent.com', project: 'fixture-project'};
  const authorization = {...draft, token: 'fixture-token', expires: Date.now() + 60000};
  const proof = await verifyImageResource('gemini-oauth', draft, {
    ...options,
    authorize: async config => {
      assert.deepEqual(config, draft);
      return authorization;
    },
    send: async (url, request) => {
      assert.equal(url, 'https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models');
      assert.equal(request.headers.Authorization, 'Bearer fixture-token');
      assert.equal(request.headers['x-goog-user-project'], draft.project);
      return Response.json({publisherModels: [
        {name: 'publishers/google/models/gemini-nano-banana-2.1', versionId: '001', outputModalities: ['IMAGE']},
        {name: 'publishers/google/models/gemma3', versionId: 'gemma-3-1b-it'},
      ]});
    },
  });
  assert.deepEqual(proof.models, ['gemini-nano-banana-2.1']);
  const stored = updateImageResource('gemini-oauth', 'save', {...draft, model: proof.models[0]}, {...options, verification: proof});
  assert(!JSON.stringify(stored).includes(authorization.token));
  assert(describeImageResources(stored, proof.authorization, origin).providers['gemini-oauth'].connected);
});

test('gateway pricing is saved during verification and used with returned image usage', async () => {
  const options = {origin, storage: browserStorage()};
  const draft = {url: 'https://gateway.example/v1/images/generations', format: 'openai', model: 'custom-model'};
  const proof = await verifyImageResource('custom', draft, {
    ...options,
    send: async () => Response.json({data: [{id: draft.model, pricing: {currency: 'USD', unit: 'per_image', output: 0.25}}]}),
  });
  updateImageResource('custom', 'save', draft, {...options, verification: proof});
  const resources = readImageResources(options.storage);
  const request = {provider: 'custom', aspect: 'auto', prompt: 'A character'};
  const data = [{b64_json: 'iVBORw0KGgoAAAANSUhEUg=='}];
  const usage = {input_tokens: 2, output_tokens: 8};
  const result = await generateImage(request, resources, null, {
    ...options, send: async () => Response.json({data, usage}),
  });
  assert(result.metrics.elapsed >= 0);
  assert.equal(result.metrics.tokens.total, 10);
  assert.deepEqual(result.metrics.cost, {value: 0.25, currency: 'USD', source: 'catalog'});
  const billed = await generateImage(request, resources, null, {
    ...options, send: async () => Response.json({data, usage: {...usage, cost_usd: 0}}),
  });
  assert.deepEqual(billed.metrics.cost, {value: 0, currency: 'USD', source: 'reported'});
});
