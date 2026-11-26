import {labels} from './engine.mjs';
import {t} from './i18n.mjs';

export const manualTextLimit = 240;
const normalized = text => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function resolveManualMaterial(choices, text, translation = '') {
  const zh = text.trim();
  const en = translation.trim();
  if (!zh) throw new Error(t('请输入要使用的文字。'));
  if (zh.length > manualTextLimit || en.length > manualTextLimit) throw new Error(t('每种语言最多 240 字符。'));

  const key = normalized(zh);
  const existing = choices.find(entry => normalized(entry.zh) === key || (typeof entry.en === 'string' && normalized(entry.en) === key));
  if (existing) {
    if (existing.manual && normalized(existing.zh) === key && en && existing.en !== en) {
      return {entry: {...existing, en}, updated: true};
    }
    return {entry: existing};
  }
  return {entry: {id: 'manual-' + crypto.randomUUID(), zh, en: en || zh, manual: true}, created: true};
}

export function importManualMaterials(current, imported) {
  if (imported === undefined) return current;
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error(t('导入的手动条目格式无效。'));
  const result = {...current};
  for (const key of Object.keys(labels)) {
    if (!Object.hasOwn(imported, key)) continue;
    if (!Array.isArray(imported[key])) throw new Error(t('{label}的手动条目格式无效。', {label: t(labels[key])}));
    const list = [...(current[key] || [])];
    for (const item of imported[key]) {
      if (typeof item?.zh !== 'string' || typeof item.en !== 'string') {
        throw new Error(t('{label}的手动条目文字无效。', {label: t(labels[key])}));
      }
      const candidate = resolveManualMaterial(list, item.zh, item.en);
      if (candidate.created) list.push(candidate.entry);
    }
    if (list.length) result[key] = list;
  }
  return result;
}
