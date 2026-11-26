import {validate} from './engine.mjs';
import {importManualMaterials} from './manual-materials.mjs';
import {t} from './i18n.mjs';

function addUnique(current, incoming, key, combine = entry => entry) {
  const entries = new Map(current.map(entry => [key(entry), entry]));
  for (const entry of incoming) {
    const id = key(entry);
    entries.set(id, entries.has(id) ? combine(entries.get(id), entry) : entry);
  }
  return [...entries.values()];
}

const byId = entry => entry.id;
const byColor = entry => entry.zh;
const union = (a, b) => [...new Set([...a, ...b])];

export function importDesignLibrary(current, manual, file, mode) {
  const {manualMaterials, ...incoming} = file;
  validate(incoming);
  if (mode === 'replace') {
    return {profile: incoming, manual: importManualMaterials({}, manualMaterials)};
  }
  if (mode !== 'merge') throw new Error(t('请选择导入方式。'));
  const rules = {...current.rules};
  const exclusions = new Map(Object.entries(rules.outfitHeadAccessoryExclusion));
  for (const [outfit, ids] of Object.entries(incoming.rules.outfitHeadAccessoryExclusion)) {
    exclusions.set(outfit, union(exclusions.get(outfit) || [], ids));
  }
  rules.outfitHeadAccessoryExclusion = Object.fromEntries(exclusions);
  for (const key of ['headAccessoryExcludeWhenNonhuman', 'forceLegwearNoneForOutfits']) {
    rules[key] = union(rules[key], incoming.rules[key]);
  }
  const profile = validate({
    ...current,
    branches: addUnique(current.branches, incoming.branches, byId),
    styles: addUnique(current.styles, incoming.styles, byId),
    presentations: addUnique(current.presentations, incoming.presentations, byId),
    palettes: addUnique(current.palettes, incoming.palettes, byId, (local, added) => ({
      ...local,
      hairColors: addUnique(local.hairColors, added.hairColors, byColor),
      eyeColors: addUnique(local.eyeColors, added.eyeColors, byColor),
    })),
    pools: Object.fromEntries(Object.keys(current.pools).map(key => [
      key, Array.isArray(incoming.pools[key]) ? addUnique(current.pools[key], incoming.pools[key], byId) : current.pools[key],
    ])),
    rules,
  });
  return {profile, manual: importManualMaterials(manual, manualMaterials)};
}
