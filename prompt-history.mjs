import {labels, optional, validate} from './engine.mjs';

const slots = Object.keys(labels);
const settingFields = ['exploration', 'branchAffinityMultiplier', 'accessoryProbability', 'nonhumanProbability',
  'propProbability', 'historySize', 'candidateCount', 'similarityThreshold', 'defaultStyle', 'defaultPresentation'];
const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));
const shortText = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validId = value => shortText(value) && !/[\u0000-\u001f\u007f]/.test(value);
const fail = () => { throw new Error('备份中的提示词历史格式无效。'); };

function copyPreset(entry, weightField) {
  const preset = {id: entry.id, zh: entry.zh};
  if (typeof entry.en === 'string') preset.en = entry.en;
  if (weightField) {
    preset.weight = entry.weight;
    preset[weightField] = entry[weightField];
  }
  return preset;
}

function copyProfile(value) {
  const profile = validate(value);
  return {
    schemaVersion: profile.schemaVersion,
    profileVersion: profile.profileVersion,
    branches: profile.branches.map(entry => copyPreset(entry, 'preferredTags')),
    styles: profile.styles.map(entry => copyPreset(entry)),
    presentations: profile.presentations.map(entry => copyPreset(entry)),
    palettes: profile.palettes.map(entry => ({...copyPreset(entry, 'tags'),
      hairColors: entry.hairColors.map(color => pick(color, ['zh', 'en'])),
      eyeColors: entry.eyeColors.map(color => pick(color, ['zh', 'en'])),
    })),
    pools: Object.fromEntries(slots.filter(key => Array.isArray(profile.pools[key]))
      .map(key => [key, profile.pools[key].map(entry => copyPreset(entry, 'tags'))])),
    rules: pick(profile.rules, ['headAccessoryExcludeWhenNonhuman', 'forceLegwearNoneForOutfits',
      'outfitHeadAccessoryExclusion', 'similarityWeights']),
    settings: pick(profile.settings, settingFields),
  };
}

function copySelection(value) {
  if (!plainRecord(value)) fail();
  const selection = pick(value, slots);
  for (const [key, id] of Object.entries(selection)) {
    if (typeof id !== 'string' && !(id === null && Object.hasOwn(optional, key))) fail();
  }
  return selection;
}

function copyRecord(value) {
  if (!plainRecord(value) || !validId(value.id) || !validId(value.profileId) || !shortText(value.seed)
      || !Number.isFinite(value.time) || Math.abs(value.time) > 8640000000000000
      || typeof value.prompt?.zh !== 'string' || typeof value.prompt?.en !== 'string') fail();
  const entry = {
    id: value.id, profileId: value.profileId, seed: value.seed, time: value.time,
    algorithmVersion: 1, selection: copySelection(value.selection), prompt: pick(value.prompt, ['zh', 'en']),
    edits: Object.fromEntries(['zh', 'en'].filter(key => typeof value.edits?.[key] === 'string').map(key => [key, value.edits[key]])),
  };
  if (['喜欢', '一般', '不喜欢'].includes(value.feedback?.rating)) {
    entry.feedback = {rating: value.feedback.rating, target: value.feedback.target === 'image' ? 'image' : 'design',
      note: typeof value.feedback.note === 'string' ? value.feedback.note.slice(0, 500) : '',
      time: Number.isFinite(value.feedback.time) ? value.feedback.time : entry.time,
      selection: copySelection(value.feedback.selection ?? entry.selection)};
  }
  return entry;
}

function referencedRecords(state) {
  return state.current ? [...state.history, state.current] : state.history;
}

export function trimPromptHistory(state, limit) {
  const history = state.history.slice(Math.max(0, state.history.length - limit));
  const records = referencedRecords({...state, history});
  const usedProfiles = new Set([state.library, ...records.map(record => record.profileId)]);
  const usedManual = new Set(records.flatMap(record => Object.values(record.selection)));
  const profiles = Object.fromEntries(Object.entries(state.profiles).filter(([id]) => usedProfiles.has(id)));
  const archivedManualMaterials = Object.fromEntries(Object.entries(state.archivedManualMaterials ?? {}).filter(([id]) => usedManual.has(id)));
  return {history, profiles, archivedManualMaterials};
}

export function makePromptBackup(state) {
  const records = state.history.map(copyRecord);
  const profiles = Object.fromEntries([...new Set(records.map(record => record.profileId))]
    .map(id => [id, copyProfile(state.profiles[id])]));
  const manualMaterials = {};
  for (const key of slots) {
    const ids = new Set(records.map(record => record.selection[key]));
    const saved = new Map((state.manualMaterials[key] ?? []).map(entry => [entry.id, entry]));
    const entries = [...ids].filter(id => typeof id === 'string' && id.startsWith('manual-')).map(id =>
      saved.get(id) ?? (Object.hasOwn(state.archivedManualMaterials ?? {}, id) ? state.archivedManualMaterials[id] : undefined));
    const used = entries.filter(Boolean).map(entry => ({...pick(entry, ['id', 'zh', 'en']), manual: true}));
    if (used.length) manualMaterials[key] = used;
  }
  return {records, profiles, manualMaterials};
}

export function validatePromptBackup(backup) {
  if (!Array.isArray(backup?.records) || !plainRecord(backup.profiles) || !plainRecord(backup.manualMaterials)) fail();
  const records = backup.records.map(copyRecord);
  const profiles = new Map();
  for (const {profileId} of records) {
    if (!Object.hasOwn(backup.profiles, profileId)) fail();
    if (!profiles.has(profileId)) profiles.set(profileId, copyProfile(backup.profiles[profileId]));
  }
  const manualMaterials = new Map();
  for (const [slot, entries] of Object.entries(backup.manualMaterials)) {
    if (!Object.hasOwn(labels, slot) || !Array.isArray(entries)) fail();
    for (const entry of entries) {
      if (!validId(entry?.id) || !entry.id.startsWith('manual-') || typeof entry.zh !== 'string' || !entry.zh.trim()
        || typeof entry.en !== 'string' || entry.zh.length > 240 || entry.en.length > 240 || manualMaterials.has(entry.id)) fail();
      manualMaterials.set(entry.id, {...pick(entry, ['id', 'zh', 'en']), manual: true});
    }
  }
  return {records, profiles, manualMaterials};
}

export function mergePromptBackup(state, backup, limit) {
  const profiles = {...state.profiles};
  const existing = new Set(state.history.map(record => record.id));
  if (state.current) existing.add(state.current.id);
  const incoming = new Set();
  let duplicates = 0;
  for (const record of backup.records) {
    if (existing.has(record.id)) { duplicates++; continue; }
    existing.add(record.id);
    incoming.add(record);
  }
  const history = [...state.history, ...incoming].sort((a, b) => a.time - b.time);
  const retained = history.slice(Math.max(0, history.length - limit));
  const retainedIncoming = retained.filter(record => incoming.has(record));
  const remapped = new Map();
  for (const record of retainedIncoming) {
    const source = record.profileId;
    if (!remapped.has(source)) {
      const profile = backup.profiles.get(source);
      let destination = source;
      if (Object.hasOwn(profiles, source)
        && JSON.stringify(copyProfile(profiles[source])) !== JSON.stringify(profile)) destination = 'profile-' + crypto.randomUUID();
      if (!Object.hasOwn(profiles, destination)) Object.defineProperty(profiles, destination, {value: profile, enumerable: true});
      remapped.set(source, destination);
    }
  }
  const archive = {...state.archivedManualMaterials};
  const localMaterials = new Map([...Object.values(archive), ...Object.values(state.manualMaterials).flat()]
    .map(entry => [entry.id, entry]));
  const usedMaterials = new Set(retainedIncoming.flatMap(record => Object.values(record.selection)));
  const remappedMaterials = new Map();
  for (const [id, entry] of backup.manualMaterials) {
    if (!usedMaterials.has(id)) continue;
    const local = localMaterials.get(id);
    if (local?.zh === entry.zh && local.en === entry.en) continue;
    const destination = local ? 'manual-' + crypto.randomUUID() : id;
    archive[destination] = {...entry, id: destination};
    if (local) remappedMaterials.set(id, destination);
  }
  const remapSelection = selection => Object.fromEntries(Object.entries(selection)
    .map(([key, id]) => [key, remappedMaterials.get(id) ?? id]));
  const patchedHistory = retained.map(record => {
    if (!incoming.has(record)) return record;
    const imported = {...record, profileId: remapped.get(record.profileId), selection: remapSelection(record.selection),
      profileVersion: backup.profiles.get(record.profileId).profileVersion};
    if (record.feedback) imported.feedback = {...record.feedback, selection: remapSelection(record.feedback.selection)};
    return imported;
  });
  const patch = trimPromptHistory({...state, history: patchedHistory, profiles, archivedManualMaterials: archive}, limit);
  return {patch, added: retainedIncoming.length, duplicates, skipped: incoming.size - retainedIncoming.length,
    removed: state.history.length - (retained.length - retainedIncoming.length)};
}
