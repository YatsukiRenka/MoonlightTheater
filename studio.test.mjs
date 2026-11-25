import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {generate, labels, materialChoices, renderPrompt, validate} from './engine.mjs';
import {importManualMaterials, resolveManualMaterial} from './manual-materials.mjs';
import {catalogPrice, modelPrice, summarizeImageUsage} from './image-usage.mjs';

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
