// Theme preference for every page: a pressed toggle means the light theme.
const themeKey = 'moonlight-theme';
const root = document.documentElement;
const toggle = document.getElementById('themeToggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function savedTheme() {
  try {
    const theme = localStorage.getItem(themeKey);
    return theme === 'light' || theme === 'dark' ? theme : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  toggle?.setAttribute('aria-pressed', String(theme === 'light'));
  themeColor?.setAttribute('content', theme === 'light' ? '#efe8f7' : '#0b0a10');
}

function switchTheme(theme, origin) {
  if (typeof document.startViewTransition !== 'function' || reduceMotion.matches) {
    applyTheme(theme);
    return;
  }
  // The new theme spreads out from the toggle like light through a lens.
  const rect = origin?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  root.style.setProperty('--reveal-x', `${x}px`);
  root.style.setProperty('--reveal-y', `${y}px`);
  root.style.setProperty('--reveal-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  root.classList.add('theme-switching');
  const transition = document.startViewTransition(() => applyTheme(theme));
  transition.finished.finally(() => root.classList.remove('theme-switching'));
}

applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');

toggle?.addEventListener('click', () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem(themeKey, next);
  } catch {}
  switchTheme(next, toggle);
});

prefersLight.addEventListener('change', event => {
  if (!savedTheme()) applyTheme(event.matches ? 'light' : 'dark');
});
