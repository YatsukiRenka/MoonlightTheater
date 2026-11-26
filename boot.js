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
})();
