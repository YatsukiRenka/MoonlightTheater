import {icon} from './icons.mjs';

const extensions = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg'};

export function mountImageDeck(container, record, {
  compact = false, preview = false, initialIndex = 0, initialRatio = 1, keyboardScope, openPreview,
} = {}) {
  const {images, model, language, seed} = record;
  const urls = images.map(image => URL.createObjectURL(image));
  const deck = document.createElement('figure');
  deck.className = 'image-deck';
  deck.classList.toggle('image-deck-compact', compact);
  deck.classList.toggle('image-deck-preview', preview);
  deck.style.setProperty('--image-ratio', String(initialRatio));
  const stage = document.createElement('div');
  stage.className = 'image-deck-stage';
  stage.classList.toggle('has-stack', !preview && images.length > 1);
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', '本批生成图片');
  let current = initialIndex;
  let swipe;
  let suppressClick = false;

  function setImageRatio(image) {
    if (image.naturalWidth && image.naturalHeight) {
      deck.style.setProperty('--image-ratio', String(image.naturalWidth / image.naturalHeight));
    }
  }

  const cards = urls.map((url, index) => {
    const card = document.createElement(preview ? 'div' : 'button');
    card.className = 'image-deck-card';
    const image = document.createElement('img');
    image.alt = preview ? '第 ' + (index + 1) + ' 张生成的角色图' : '';
    image.loading = compact ? 'lazy' : 'eager';
    image.draggable = false;
    image.referrerPolicy = 'no-referrer';
    image.onload = () => { if (current === index) setImageRatio(image); };
    image.onerror = () => {
      if (!preview) card.disabled = true;
      card.textContent = '图片载入失败';
    };
    image.src = url;
    if (!preview) {
      card.type = 'button';
      card.setAttribute('aria-label', '放大查看角色图 ' + (index + 1));
      card.onclick = event => {
        if (suppressClick && event.detail !== 0) return;
        const ratio = image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
        openPreview({record, index, ratio, select: index => show(index, true)});
      };
    }
    card.append(image);
    stage.append(card);
    return {card, image};
  });
  const caption = document.createElement('figcaption');
  if (!compact && !preview) {
    const metadata = document.createElement('span');
    metadata.textContent = model + ' · ' + (language === 'en' ? 'EN' : '中文') + ' · ' + seed;
    caption.append(metadata);
  }
  const counter = document.createElement('span');
  counter.className = 'image-deck-count';
  counter.setAttribute('aria-live', 'polite');
  counter.hidden = images.length < 2;
  const link = document.createElement('a');
  link.textContent = '下载原图';
  const fileSeed = seed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  caption.append(counter, link);
  deck.append(stage, caption);
  container.append(deck);

  function show(index, focus = false) {
    if (!deck.parentNode) return;
    current = ((index % cards.length) + cards.length) % cards.length;
    const next = (current + 1) % cards.length;
    const back = (current + 2) % cards.length;
    cards.forEach(({card}, i) => {
      const active = i === current;
      let position = 'background';
      if (active) position = 'front';
      else if (!preview && i === next) position = 'next';
      else if (!preview && i === back) position = 'back';
      card.dataset.position = position;
      card.hidden = position === 'background';
      card.inert = !active;
    });
    const active = cards[current];
    setImageRatio(active.image);
    counter.textContent = (current + 1) + ' / ' + cards.length;
    link.href = urls[current];
    link.download = 'moonlight-' + fileSeed + '-' + (current + 1) + '.' + extensions[images[current].type];
    if (focus) active.card.focus({preventScroll: true});
  }

  function handleKeys(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    show(current + (event.key === 'ArrowLeft' ? -1 : 1), event.target === cards[current].card);
  }

  const keyTarget = keyboardScope || deck;
  if (cards.length > 1) {
    for (const [offset, name, direction] of [[-1, '上一张', 'left'], [1, '下一张', 'right']]) {
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'image-deck-nav ' + direction;
      arrow.setAttribute('aria-label', name);
      arrow.innerHTML = icon(direction);
      arrow.onclick = () => show(current + offset);
      deck.insertBefore(arrow, caption);
    }
    keyTarget.addEventListener('keydown', handleKeys);
    stage.onpointerdown = event => {
      if (event.isPrimary) suppressClick = false;
      swipe = event.isPrimary && event.pointerType === 'touch'
        ? {id: event.pointerId, x: event.clientX, y: event.clientY} : undefined;
    };
    stage.onpointercancel = () => { swipe = undefined; };
    stage.onpointerup = event => {
      if (swipe?.id !== event.pointerId) return;
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      swipe = undefined;
      // A narrow portrait may offer less room for a horizontal swipe.
      const threshold = Math.min(45, stage.clientWidth / 3);
      suppressClick = Math.max(Math.abs(dx), Math.abs(dy)) >= threshold;
      if (suppressClick && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
    };
  }
  show(initialIndex);
  return {
    get currentIndex() { return current; },
    dispose() {
      keyTarget.removeEventListener('keydown', handleKeys);
      deck.remove();
      urls.forEach(url => URL.revokeObjectURL(url));
    },
  };
}
