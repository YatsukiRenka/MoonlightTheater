// A drawn menu in front of a native <select>. The select stays the source of truth:
// choosing an option sets its value and dispatches the same change event app code listens for.
// Every single-choice select on the page is enhanced, including ones added later (dialogs, editors);
// code that sets .value, .selectedIndex, the options or disabled is mirrored without extra calls.
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';
const check = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const enhanced = new Map();
let counter = 0;

function place(state) {
  const {trigger, menu} = state;
  const rect = trigger.getBoundingClientRect();
  const below = innerHeight - rect.bottom;
  const height = Math.min(menu.scrollHeight, 320);
  const openUp = below < height + 16 && rect.top > below;
  menu.style.minWidth = `${rect.width}px`;
  menu.style.left = `${Math.min(rect.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = openUp ? `${Math.max(8, rect.top - height - 6)}px` : `${rect.bottom + 6}px`;
  menu.dataset.side = openUp ? 'up' : 'down';
}

function options(state) {
  return Array.from(state.menu.querySelectorAll('[role="option"]'));
}

function focusOption(state, option) {
  if (!option) return;
  for (const item of options(state)) item.tabIndex = item === option ? 0 : -1;
  option.focus({preventScroll: false});
}

function choose(state, option) {
  const {select, trigger, menu} = state;
  if (!option || option.getAttribute('aria-disabled') === 'true') return;
  const changed = select.value !== option.dataset.value;
  select.value = option.dataset.value;
  refresh(select);
  menu.hidePopover();
  trigger.focus();
  if (changed) select.dispatchEvent(new Event('change', {bubbles: true}));
}

export function refresh(select) {
  const state = enhanced.get(select);
  if (!state) return;
  const {trigger, menu, value} = state;
  const current = select.options[select.selectedIndex];
  value.textContent = current?.text ?? '';
  trigger.disabled = select.disabled;
  menu.replaceChildren(...Array.from(select.options, (option, index) => {
    const item = document.createElement('div');
    item.role = 'option';
    item.className = 'fs-option';
    item.dataset.value = option.value;
    item.tabIndex = -1;
    item.style.setProperty('--i', index);
    item.setAttribute('aria-selected', String(option.selected));
    if (option.disabled) item.setAttribute('aria-disabled', 'true');
    item.innerHTML = `<span class="fs-label"></span>${check}`;
    item.querySelector('.fs-label').textContent = option.text;
    return item;
  }));
}

export function enhanceSelect(select) {
  if (!select || enhanced.has(select) || typeof HTMLElement.prototype.showPopover !== 'function') return;
  const id = `fs${++counter}`;
  const label = select.closest('label');
  // Give the label text an id so the trigger can be named by it.
  let name = label?.querySelector('.fs-name');
  if (label && !name) {
    const text = Array.from(label.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
    if (text) {
      name = document.createElement('span');
      name.className = 'fs-name';
      text.replaceWith(name);
      name.append(text);
    }
  }
  if (name) name.id ||= `${id}-name`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'fs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${id}-menu`);
  trigger.innerHTML = `<span class="fs-value" id="${id}-value"></span>${chevron}`;
  if (name) trigger.setAttribute('aria-labelledby', `${name.id} ${id}-value`);
  const menu = document.createElement('div');
  menu.id = `${id}-menu`;
  menu.className = 'fs-menu';
  menu.role = 'listbox';
  menu.popover = 'auto';
  if (name) menu.setAttribute('aria-labelledby', name.id);

  select.classList.add('fs-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(trigger, menu);
  const state = {select, trigger, menu, value: trigger.querySelector('.fs-value')};
  enhanced.set(select, state);
  refresh(select);

  // Clicking the label text should open the drawn control, not the hidden select.
  label?.addEventListener('click', event => {
    if (event.target === select || trigger.contains(event.target) || menu.contains(event.target)) return;
    event.preventDefault();
    trigger.focus();
  });
  const open = () => {
    if (trigger.disabled) return;
    menu.showPopover();
    focusOption(state, menu.querySelector('[aria-selected="true"]') ?? options(state)[0]);
  };
  trigger.addEventListener('click', () => (menu.matches(':popover-open') ? menu.hidePopover() : open()));
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener('toggle', event => {
    const isOpen = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(isOpen));
    trigger.classList.toggle('is-open', isOpen);
    if (isOpen) place(state);
  });
  menu.addEventListener('click', event => choose(state, event.target.closest('[role="option"]')));
  menu.addEventListener('keydown', event => {
    const items = options(state).filter(item => item.getAttribute('aria-disabled') !== 'true');
    const index = items.indexOf(document.activeElement);
    const move = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1}[event.key];
    if (move !== undefined) {
      event.preventDefault();
      focusOption(state, items[Math.max(0, Math.min(items.length - 1, move))]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(state, document.activeElement.closest('[role="option"]'));
    } else if (event.key === 'Tab') {
      menu.hidePopover();
    } else if (event.key === 'Escape') {
      trigger.focus();
    }
  });
  // Mirror programmatic changes: value setters on this instance, and option or disabled mutations.
  for (const key of ['value', 'selectedIndex']) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
    Object.defineProperty(select, key, {
      configurable: true,
      get() { return native.get.call(this); },
      set(next) { native.set.call(this, next); refresh(this); }
    });
  }
  new MutationObserver(() => refresh(select)).observe(select, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label']});
  // The hidden select cannot show a validation bubble; point the person at the drawn control instead.
  select.addEventListener('invalid', () => trigger.focus());
  if (select.autofocus || document.activeElement === select) trigger.focus();
  const reposition = () => { if (menu.matches(':popover-open')) place(state); };
  addEventListener('resize', reposition);
  addEventListener('scroll', reposition, {passive: true, capture: true});
  select.addEventListener('change', () => refresh(select));
}

const eligible = select => !select.multiple && !(select.size > 1) && !select.closest('[data-native-select]');

export function enhanceAll(root = document) {
  for (const select of root.querySelectorAll('select')) if (eligible(select)) enhanceSelect(select);
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  enhanceAll();
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('select')) { if (eligible(node)) enhanceSelect(node); } else enhanceAll(node);
      }
    }
  }).observe(document.body, {childList: true, subtree: true});
}
