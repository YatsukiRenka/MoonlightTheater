// Runs before the first paint so the page never flashes the wrong theme.
(() => {
  const root = document.documentElement;
  let theme = null;
  try {
    theme = localStorage.getItem('moonlight-theme');
  } catch {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.dataset.theme = theme;

  // Hide the Chinese source text until prefs.mjs has translated the page.
  let lang = null;
  try {
    lang = localStorage.getItem('moonlight-lang');
  } catch {}
  if (!['zh', 'en', 'ja'].includes(lang)) {
    const preferred = String(navigator.language || 'zh').toLowerCase();
    lang = preferred.startsWith('zh') ? 'zh' : preferred.startsWith('ja') ? 'ja' : 'en';
  }
  if (lang !== 'zh') root.classList.add('i18n-pending');
})();
