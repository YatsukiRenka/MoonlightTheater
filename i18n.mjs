// Page language: Chinese (source text), English, Japanese.
// Strings are keyed by their Chinese source, so untranslated text falls back to Chinese.
import {dictionary} from './i18n-dict.mjs';

export const languages = ['zh', 'en', 'ja'];
const langKey = 'moonlight-lang';
const htmlLang = {zh: 'zh-CN', en: 'en', ja: 'ja'};

function detectLanguage() {
  // Outside a browser (tests, build) the source language applies.
  if (typeof document === 'undefined') return 'zh';
  try {
    const saved = localStorage.getItem(langKey);
    if (languages.includes(saved)) return saved;
  } catch {}
  const preferred = String(navigator.language || 'zh').toLowerCase();
  if (preferred.startsWith('zh')) return 'zh';
  if (preferred.startsWith('ja')) return 'ja';
  return 'en';
}

export const lang = detectLanguage();

// Prompts exist in Chinese and English; Japanese pages use the English prompt.
export const promptLanguage = lang === 'zh' ? 'zh' : 'en';

export function t(text, params) {
  let result = text;
  if (lang !== 'zh') {
    const entry = dictionary[text];
    if (entry) result = entry[lang === 'en' ? 0 : 1] ?? text;
  }
  if (params) result = result.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
  return result;
}

// Material entries carry Chinese and English text; other languages read the English.
// Entries without English (the style branches) are looked up in the dictionary.
export function materialText(entry) {
  if (!entry) return '';
  return lang === 'zh' ? entry.zh : entry.en || t(entry.zh);
}

export function setLanguage(next) {
  if (!languages.includes(next) || next === lang) return;
  try {
    localStorage.setItem(langKey, next);
  } catch {}
  location.reload();
}

const translatedAttributes = ['aria-label', 'title', 'placeholder', 'alt', 'content'];

// Translate the static document once at start-up. Elements with data-i18n are replaced as a whole.
export function translateDocument(root = document) {
  document.documentElement.lang = htmlLang[lang];
  if (lang === 'zh') return;
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  const walker = document.createTreeWalker(root.body ?? root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (!text || !/[㐀-鿿]/.test(text) || node.parentElement?.closest('[data-i18n], [lang="zh-CN"], script, style, textarea')) continue;
    const translated = t(text);
    if (translated !== text) node.nodeValue = node.nodeValue.replace(text, translated);
  }
  for (const element of root.querySelectorAll(translatedAttributes.map(name => `[${name}]`).join(','))) {
    if (element.matches('[lang="zh-CN"]')) continue;
    for (const name of translatedAttributes) {
      const value = element.getAttribute(name);
      if (value && /[㐀-鿿]/.test(value)) element.setAttribute(name, t(value));
    }
  }
  document.title = t(document.title);
}
