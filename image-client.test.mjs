import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  describeImageResources, generateImage, readImageResources, resolveImageResourceConfig, verifyImageResourceConfig,
} from './image-client.mjs';

const origin = 'https://moonlight.example';

test('saving a key requires successful verification of that key and an offered model', async () => {
  const resolve = (values, verification) => resolveImageResourceConfig('openai', values, {origin, verification});
  const draft = {key: 'fixture-key', model: 'gpt-image-2.6-flare'};
  assert.throws(() => resolve(draft), /先验证/);
  await assert.rejects(verifyImageResourceConfig('openai', draft, {
    origin, send: async () => new Response(null, {status: 401}),
  }), /身份验证/);

  const proof = await verifyImageResourceConfig('openai', draft, {
    origin,
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
  assert.throws(() => resolve({...draft, key: 'different-key'}, proof), /先验证/);
  assert.throws(() => resolve({...draft, model: 'made-up-model'}, proof), /列表/);
  const config = resolve(draft, proof);
  const resources = {openai: config};
  assert.equal(config.model, draft.model);
  assert(!JSON.stringify(describeImageResources(resources, null, origin)).includes(draft.key));
  const updated = resolveImageResourceConfig('openai', {key: '', model: 'gpt-image-2.6-sunburst'}, {origin, previous: config});
  assert.equal(updated.key, draft.key);
  await assert.rejects(generateImage({
    provider: 'openai', model: 'made-up-model', aspect: 'auto', prompt: 'A character',
  }, resources, null, {origin, send: () => assert.fail('unexpected request')}), /列表/);
});

test('Gemini reads all pages before offering valid image models and supports saved legacy keys', async () => {
  const storage = new Map([['moonlight-image-resources-v1', JSON.stringify({gemini: {key: 'legacy-key'}})]]);
  const resources = readImageResources({getItem: key => storage.get(key) ?? null});
  assert.equal(describeImageResources(resources, null, origin).providers.gemini.ready, false);
  const previous = resources.gemini;
  const proof = await verifyImageResourceConfig('gemini', {}, {
    origin, previous,
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
  const config = resolveImageResourceConfig('gemini', {model: proof.models[1]}, {origin, previous, verification: proof});
  assert.equal(config.key, 'legacy-key');
});

test('gateway verification only sends keys to the chosen origin and declines an anonymous catalog', async () => {
  const draft = {url: 'https://gateway.example/v1/images/generations', format: 'openai', key: 'gateway-key'};
  await assert.rejects(verifyImageResourceConfig('custom', {...draft, modelsURL: 'https://other.example/models'}, {
    origin, send: () => assert.fail('unexpected request'),
  }), /同源/);
  const catalog = () => Response.json({data: [{id: 'custom-alias'}]});
  await assert.rejects(verifyImageResourceConfig('custom', draft, {origin, send: async () => catalog()}), /无法校验/);
  const proof = await verifyImageResourceConfig('custom', draft, {
    origin,
    send: async (url, request) => {
      assert.equal(url, 'https://gateway.example/v1/models');
      if (!request.headers) return new Response(null, {status: 401});
      assert.equal(request.headers.Authorization, 'Bearer gateway-key');
      return catalog();
    },
  });
  assert.deepEqual(proof.models, ['custom-alias']);
  assert.throws(() => resolveImageResourceConfig('custom', {...draft, model: proof.models[0], modelsURL: 'https://gateway.example/other'}, {
    origin, verification: proof,
  }), /先验证/);
});

test('Vertex verification lists models with the authorized project and stores no OAuth token', async () => {
  const draft = {clientId: 'fixture.apps.googleusercontent.com', project: 'fixture-project'};
  const authorization = {...draft, token: 'fixture-token', expires: Date.now() + 60000};
  const proof = await verifyImageResourceConfig('gemini-oauth', draft, {
    origin,
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
  const config = resolveImageResourceConfig('gemini-oauth', {...draft, model: proof.models[0]}, {origin, verification: proof});
  assert(!JSON.stringify(config).includes(authorization.token));
  assert(describeImageResources({'gemini-oauth': config}, proof.authorization, origin).providers['gemini-oauth'].connected);
});

test('gateway pricing is saved during verification and used with returned image usage', async () => {
  const draft = {url: 'https://gateway.example/v1/images/generations', format: 'openai', model: 'custom-model'};
  const proof = await verifyImageResourceConfig('custom', draft, {
    origin,
    send: async () => Response.json({data: [{id: draft.model, pricing: {currency: 'USD', unit: 'per_image', output: 0.25}}]}),
  });
  const resources = {custom: resolveImageResourceConfig('custom', draft, {origin, verification: proof})};
  const request = {provider: 'custom', aspect: 'auto', prompt: 'A character'};
  const data = [{b64_json: 'iVBORw0KGgoAAAANSUhEUg=='}];
  const usage = {input_tokens: 2, output_tokens: 8};
  const result = await generateImage(request, resources, null, {
    origin, send: async () => Response.json({data, usage}),
  });
  assert(result.metrics.elapsed >= 0);
  assert.equal(result.metrics.tokens.total, 10);
  assert.deepEqual(result.metrics.cost, {value: 0.25, currency: 'USD', source: 'catalog'});
  const billed = await generateImage(request, resources, null, {
    origin, send: async () => Response.json({data, usage: {...usage, cost_usd: 0}}),
  });
  assert.deepEqual(billed.metrics.cost, {value: 0, currency: 'USD', source: 'reported'});
});

const fixturePNG = 'iVBORw0KGgoAAAANSUhEUg==';
const referenceFile = name => new File([Uint8Array.from(atob(fixturePNG), char => char.charCodeAt(0))], name, {type: 'image/png'});

test('linked image URLs follow the configured endpoint protocol', async t => {
  const model = 'fixture-model';
  const resources = url => ({custom: {url, format: 'openai', models: [model], model}});
  const request = {provider: 'custom', model, aspect: 'auto', prompt: 'A character'};
  const png = Uint8Array.from(atob(fixturePNG), char => char.charCodeAt(0));

  await t.test('remote HTTPS endpoint rejects loopback image URLs without requesting them', async () => {
    const sent = [];
    await assert.rejects(generateImage(request, resources('https://gateway.example/v1/images/generations'), null, {
      origin, send: async url => {
        sent.push(url);
        return Response.json({data: [{url: 'http://127.0.0.1:8765/image.png'}]});
      },
    }), {message: '接口返回了无效的外部图片地址。'});
    assert.deepEqual(sent, ['https://gateway.example/v1/images/generations']);
  });

  await t.test('remote HTTPS endpoint accepts HTTPS image URLs', async () => {
    const sent = [];
    const result = await generateImage(request, resources('https://gateway.example/v1/images/generations'), null, {
      origin, send: async url => {
        sent.push(url);
        return sent.length === 1
          ? Response.json({data: [{url: 'https://images.example/image.png'}]})
          : new Response(png, {headers: {'Content-Type': 'image/png'}});
      },
    });
    assert.deepEqual(sent, [
      'https://gateway.example/v1/images/generations', 'https://images.example/image.png',
    ]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mime, 'image/png');
  });

  await t.test('loopback HTTP endpoint accepts loopback image URLs', async () => {
    const sent = [];
    const result = await generateImage(request, resources('http://127.0.0.1:8765/v1/images/generations'), null, {
      origin, send: async url => {
        sent.push(url);
        return sent.length === 1
          ? Response.json({data: [{url: 'http://127.0.0.1:8766/image.png'}]})
          : new Response(png, {headers: {'Content-Type': 'image/png'}});
      },
    });
    assert.deepEqual(sent, [
      'http://127.0.0.1:8765/v1/images/generations', 'http://127.0.0.1:8766/image.png',
    ]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mime, 'image/png');
  });
});

test('OpenAI reference images go to edits as multipart and streamed images report final usage', async () => {
  const model = 'gpt-image-2.6-flare';
  const partials = [];
  let requests = 0;
  const result = await generateImage({provider: 'openai', prompt: 'Use both references', references: [referenceFile('one.png'), referenceFile('two.png')],
    options: {n: '2', complexity: 'low', output_format: 'png', partial_images: '1'},
  }, {openai: {key: 'fixture-token', models: [model], model}}, null, {
    origin, onPartial: image => partials.push(image.mime),
    send: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      assert.equal(request.headers['Content-Type'], undefined);
      assert.deepEqual(request.body.getAll('image[]').map(file => file.name), ['one.png', 'two.png']);
      assert.equal(request.body.get('complexity'), 'low');
      assert.equal(request.body.get('stream'), 'true');
      assert.equal(request.body.get('n'), null);
      requests++;
      const events = [
        {type: 'image_edit.partial_image', b64_json: fixturePNG},
        {type: 'image_edit.completed', b64_json: fixturePNG, usage: {input_tokens: 2, output_tokens: 18}},
      ];
      const stream = new ReadableStream({start(controller) {
        const encoder = new TextEncoder();
        const data = events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('');
        controller.enqueue(encoder.encode(data.slice(0, 17)));
        controller.enqueue(encoder.encode(data.slice(17)));
        controller.close();
      }});
      return new Response(stream, {headers: {'Content-Type': 'text/event-stream'}});
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.images.length, 2);
  assert.deepEqual(partials, ['image/png', 'image/png']);
  assert.equal(result.metrics.tokens.total, 40);
});

test('Gemini sends references inline, batches explicit requests, and retains completed results on failure', async () => {
  const model = 'gemini-nano-banana-2.1';
  let requests = 0;
  const result = await generateImage({provider: 'gemini', prompt: 'A character', references: [referenceFile('image.png')],
    options: {n: '3', imageSize: '4K', aspectRatio: '8:1', thinkingLevel: 'MEDIUM', modalities: 'image'},
  }, {gemini: {key: 'fixture-key', models: [model], model}}, null, {
    origin, send: async (url, request) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent');
      const body = JSON.parse(request.body);
      assert.deepEqual(body.generationConfig, {
        responseModalities: ['IMAGE'], imageConfig: {aspectRatio: '8:1', imageSize: '4K'}, thinkingConfig: {thinkingLevel: 'MEDIUM'},
      });
      assert.deepEqual(body.contents[0].parts[1].inlineData, {mimeType: 'image/png', data: fixturePNG});
      requests++;
      if (requests === 3) return new Response(null, {status: 429});
      return Response.json({candidates: [{content: {parts: [{inlineData: {data: fixturePNG}}]}}], usageMetadata: {totalTokenCount: 15}});
    },
  });
  assert.equal(result.images.length, 2);
  assert.equal(result.metrics.tokens.total, 30);
  assert.match(result.warning, /限/);
});

test('Vertex batches preserve completed images and the HTTP status from a later authorization failure', async () => {
  const model = 'gemini-nano-banana-2.1';
  const project = 'fixture-project';
  const clientId = 'fixture.apps.googleusercontent.com';
  const config = {project, clientId, model, models: [model]};
  const authorization = {project, clientId, token: 'fixture-token', expires: Date.now() + 60_000};
  let requests = 0;
  const result = await generateImage({provider: 'gemini-oauth', prompt: 'A character', options: {n: '3'}},
    {'gemini-oauth': config}, authorization, {
      origin,
      send: async (url, request) => {
        assert.equal(request.headers.Authorization, 'Bearer fixture-token');
        if (++requests === 2) {
          const body = new ReadableStream({start: stream => stream.error(new Error('Connection closed'))});
          return new Response(body, {status: 401});
        }
        return Response.json({candidates: [{content: {parts: [{inlineData: {data: fixturePNG}}]}}]});
      },
    });
  assert.equal(requests, 2);
  assert.equal(result.images.length, 1);
  assert.match(result.warning, /身份验证/);
  assert.equal(result.warningStatus, 401);
});

test('generation uses longer deadlines and localizes body timeouts for JSON and SSE', async t => {
  const model = 'gpt-image-2.6-flare';
  const resources = {openai: {key: 'fixture-key', models: [model], model}};
  const timeouts = [];
  let controller;
  t.mock.method(AbortSignal, 'timeout', timeout => {
    timeouts.push(timeout);
    controller = new AbortController();
    return controller.signal;
  });

  for (const streaming of [false, true]) {
    await assert.rejects(generateImage({provider: 'openai', prompt: 'A character',
      options: streaming ? {partial_images: '1'} : {},
    }, resources, null, {
      origin,
      send: async (url, request) => {
        assert.equal(request.signal, controller.signal);
        const body = new ReadableStream({pull(stream) {
          controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
          // Browser fetch can expose a generic abort after response headers arrived.
          stream.error(new DOMException('The operation was aborted', 'AbortError'));
        }}, {highWaterMark: 0});
        return new Response(body, {headers: {'Content-Type': streaming ? 'text/event-stream' : 'application/json'}});
      },
    }), {message: '读取接口响应超时。'});
  }
  assert.deepEqual(timeouts, [600_000, 900_000]);
});
