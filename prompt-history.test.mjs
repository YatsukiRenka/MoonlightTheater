import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {generate} from './engine.mjs';
import {makePromptBackup, mergePromptBackup, trimPromptHistory, validatePromptBackup} from './prompt-history.mjs';

const profile = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url), 'utf8'));
const manualId = 'manual-history-fixture';
const record = (id, time, overrides = {}) => ({id, time, profileId: 'initial', seed: id, selection: generate(profile, id).selection,
  prompt: {zh: '中文提示词', en: 'English prompt'}, edits: {}, ...overrides});
const state = overrides => ({library: 'initial', profiles: {initial: structuredClone(profile)}, history: [], manualMaterials: {}, ...overrides});

test('prompt export includes only relevant profiles and saved manual entries and strips unrelated data', () => {
  const entry = record('one', 1);
  entry.selection.hair = manualId;
  const local = state({history: [entry], archivedManualMaterials: {[manualId]: {id: manualId, zh: '发型', en: 'Hair', key: 'hidden-credential'}},
    config: {key: 'hidden-credential'}});
  local.profiles.initial.branches[0].en = {key: 'hidden-credential'};
  local.profiles.initial.styles[0].tags = [{key: 'hidden-credential'}];
  local.profiles.other = profile;
  const backup = makePromptBackup(local);
  assert(!JSON.stringify(backup).includes('hidden-credential'));
  assert.deepEqual(Object.keys(backup.profiles), ['initial']);
  assert.equal(backup.manualMaterials.hair[0].id, manualId);
});

test('restoring deduplicates recorded prompts and remaps conflicting library and manual IDs', () => {
  const first = record('existing', 10);
  first.selection.hair = manualId;
  const remote = record('remote', 20, {selection: {...first.selection}, edits: {en: 'My edited prompt'}});
  remote.feedback = {rating: '喜欢', target: 'design', note: '', time: 21, selection: {...remote.selection}};
  const changed = structuredClone(profile);
  changed.profileVersion = 'new-test-profile';
  const local = state({current: first, history: [first], manualMaterials: {hair: [{id: manualId, zh: '本地发型', en: 'Local hair'}]}});
  const source = state({profiles: {initial: changed}, history: [first, remote], manualMaterials: {hair: [{id: manualId, zh: '备份发型', en: 'Backup hair'}]}});
  const restored = mergePromptBackup(local, validatePromptBackup(makePromptBackup(source)), 10);
  assert.equal(restored.added, 1);
  assert.equal(restored.duplicates, 1);
  assert.equal(restored.patch.history[0], first);
  const restoredRemote = restored.patch.history[1];
  assert.notEqual(restoredRemote.profileId, 'initial');
  assert.equal(restored.patch.profiles[restoredRemote.profileId].profileVersion, changed.profileVersion);
  assert.equal(restoredRemote.edits.en, 'My edited prompt');
  assert.notEqual(restoredRemote.selection.hair, manualId);
  assert.equal(restored.patch.archivedManualMaterials[restoredRemote.selection.hair].zh, '备份发型');
  assert.equal(restoredRemote.feedback.selection.hair, restoredRemote.selection.hair);
});

test('a zero retention count clears history while leaving the current design available', () => {
  const current = record('current', 5, {profileId: 'previous'});
  current.selection.hair = manualId;
  const local = state({current, history: [current], profiles: {initial: profile, previous: profile, unused: profile}, archivedManualMaterials: {
    [manualId]: {id: manualId, zh: '自定义发型', en: 'Custom hair'},
  }});
  const result = trimPromptHistory(local, 0);
  assert.deepEqual(result.history, []);
  assert.deepEqual(Object.keys(result.profiles), ['initial', 'previous']);
  assert.equal(result.archivedManualMaterials[manualId].zh, '自定义发型');
  assert.throws(() => validatePromptBackup({records: [record('bad\0id', 1)], profiles: {initial: profile}, manualMaterials: {}}), /格式无效/);
});
