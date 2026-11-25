import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {generate, labels, materialChoices, renderPrompt, validate} from './engine.mjs';
import {importManualMaterials, resolveManualMaterial} from './manual-materials.mjs';
import {catalogPrice, modelPrice, summarizeImageUsage} from './image-usage.mjs';
import {importDesignLibrary} from './design-library.mjs';
import {imageCapabilities, imageOptionFields, prepareImageOptions} from './image-options.mjs';

const profile = validate(JSON.parse(readFileSync(new URL('./profile.json', import.meta.url), 'utf8')));

test('all seventeen design fields support reusable bilingual choices and survive a locked redraw', () => {
  const native = generate(profile, 'test-design').selection;
  for (const key of Object.keys(labels)) {
    const choices = materialChoices(profile, key, native);
    const zh = '自定义' + labels[key];
    const en = 'Custom ' + key;
    const {entry} = resolveManualMaterial(choices, zh, en);
    const manual = {[key]: [entry]};
    const r = generate(profile, 'test-design', {fixed: {...native, [key]: entry.id}, manual});
    assert.equal(r.selection[key], entry.id);
    assert(renderPrompt(profile, r.selection, 'zh', manual).includes(zh));
    assert(renderPrompt(profile, r.selection, 'en', manual).includes(en));
    assert.equal(generate(profile, 'test-redraw', {fixed: {[key]: entry.id}, manual}).selection[key], entry.id);
    assert.deepEqual(generate(profile, 'test-design', {manual}).selection, native);
  }
});

test('local designs deduplicate normalized input and import keeps existing entries', () => {
  const {entry} = resolveManualMaterial([], '银白  波浪', 'Silver wave');
  assert.equal(resolveManualMaterial([entry], ' SILVER　ＷＡＶＥ ').entry, entry);
  const {entry: updated, updated: changed} = resolveManualMaterial([entry], '银白 波浪', 'Silvery waves');
  assert(changed);
  assert.equal(updated.id, entry.id);
  assert.equal(updated.en, 'Silvery waves');
  const exported = JSON.parse(JSON.stringify({hair: [entry, updated], pose: [{zh: '转身', en: 'Turning'}]}));
  const imported = importManualMaterials({hair: [entry]}, exported);
  assert.deepEqual(imported.hair, [entry]);
  assert.equal(imported.pose[0].en, 'Turning');
  assert.throws(() => importManualMaterials({}, {hair: [{zh: 'Invalid'}]}), /文字无效/);
});

test('Google image estimates honor modality and thinking charges and report missing usage', () => {
  const rate = modelPrice('gemini-oauth', 'gemini-3.1-flash-image-preview');
  const usage = {promptTokenCount: 100, candidatesTokenCount: 1000, thoughtsTokenCount: 100};
  const mixed = summarizeImageUsage({usageMetadata: {
    ...usage, candidatesTokensDetails: [{modality: 'IMAGE', tokenCount: 900}, {modality: 'TEXT', tokenCount: 100}],
  }}, 'gemini', rate, 1);
  assert.equal(mixed.tokens.total, 1200);
  assert.equal(mixed.cost.value, 0.05465);
  assert(!mixed.cost.upperBound);
  assert(summarizeImageUsage({usageMetadata: usage}, 'gemini', rate, 1).cost.upperBound);
  assert.equal(summarizeImageUsage({}, 'gemini', rate, 1).cost, null);
  assert.equal(catalogPrice({currency: 'USD', input: 3, output: 4}), null);
  assert.deepEqual(catalogPrice({currency: 'USD', unit: 'per_token', input: 0.000003, output: 0.000004}),
    {currency: 'USD', input: 3, output: 4, source: 'catalog'});
});

test('merge keeps local weights and adds designs, and replace uses the incoming library', () => {
  const incoming = structuredClone(profile);
  incoming.pools.hair[0].weight += 10;
  incoming.pools.hair.push({...incoming.pools.hair[0], id: 'import-test', zh: '新发型'});
  incoming.manualMaterials = {hair: [{zh: '导入素材', en: 'Imported'}]};
  const {entry} = resolveManualMaterial([], '本地素材');
  const local = {hair: [entry]};
  const merged = importDesignLibrary(profile, local, incoming, 'merge');
  assert.equal(merged.profile.pools.hair[0].weight, profile.pools.hair[0].weight);
  assert.equal(merged.profile.pools.hair.at(-1).id, 'import-test');
  assert.deepEqual(merged.manual.hair.map(item => item.zh), ['本地素材', '导入素材']);
  const replaced = importDesignLibrary(profile, local, incoming, 'replace');
  assert.equal(replaced.profile.pools.hair[0].weight, incoming.pools.hair[0].weight);
  assert.deepEqual(replaced.manual.hair.map(item => item.zh), ['导入素材']);
});

test('settings reflect GPT Image and Nano Banana generations and remove incompatible parameters', () => {
  const fields = (provider, format, model) => Object.fromEntries(
    imageOptionFields(imageCapabilities(provider, format, model)).map(item => [item.key, item.values]));
  const opts = model => fields('openai', 'openai', model);
  assert(!opts('gpt-image-1.5').size.some(([value]) => value === 'custom'));
  assert(opts('gpt-image-2-2026-04-21').size.some(([value]) => value === 'custom'));
  assert(opts('gpt-image-2.5-sunburst-2026-09-08').quality.some(([value]) => value === 'max'));
  assert(!Object.hasOwn(opts('gpt-image-2.5-flare'), 'complexity'));
  const caps = imageCapabilities('openai', 'openai', 'gpt-image-2.6-sunburst');
  assert.deepEqual(prepareImageOptions(caps, {size: 'custom', width: '1536', height: '864', quality: 'max', n: '2', complexity: 'low'}, false),
    {size: '1536x864', quality: 'max', n: 2, complexity: 'low'});
  assert.throws(() => prepareImageOptions(caps, {size: 'custom', width: '3000', height: '1024'}, false), /步长/);
  assert.deepEqual(prepareImageOptions(caps, {output_format: 'svg', n: '3', partial_images: '2'}, false), {output_format: 'svg'});
  assert.deepEqual(prepareImageOptions(caps, {output_format: 'jpeg', background: 'transparent', output_compression: '50'}, true),
    {output_format: 'jpeg', output_compression: 50});
  assert.deepEqual(prepareImageOptions(caps, {output_format: 'gif', frame_count: '6', partial_images: '2'}, true),
    {output_format: 'gif', frame_count: 6});
  const banana = model => fields('gemini', 'gemini', model);
  assert(!Object.hasOwn(banana('gemini-2.5-flash-image'), 'imageSize'));
  assert(!Object.hasOwn(banana('gemini-3.1-flash-lite-image'), 'search'));
  assert(banana('gemini-3.1-flash-image').imageSize.some(([value]) => value === '512'));
  assert(!banana('gemini-nano-banana-2.1').imageSize.some(([value]) => value === '512'));
  assert(banana('gemini-nano-banana-2.1').thinkingLevel.some(([value]) => value === 'MEDIUM'));
  assert(!Object.hasOwn(banana('gemini-3-pro-image-preview'), 'thinkingLevel'));
});
