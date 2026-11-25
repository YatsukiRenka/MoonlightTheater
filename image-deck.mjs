import {icon} from './icons.mjs';

const extensions = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg'};

export function mountImageDeck(container, record, openPreview, compact = false) {
  const {images, model, language, seed} = record;
  const urls = images.map(image => URL.createObjectURL(image));
  const deck = document.createElement('figure');
  deck.className = 'image-deck' + (compact ? ' image-deck-compact' : '');
  const stage = document.createElement('div');
  stage.className = 'image-deck-stage';
  stage.classList.toggle('has-stack', images.length > 1);
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', '本批生成图片');
  let current = 0;
  let swipe;
  let lastSwipe = -Infinity;
  const cards = urls.map((url, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-deck-card';
    button.setAttribute('aria-label', '放大查看角色图 ' + (index + 1));
    const image = document.createElement('img');
    image.alt = '';
    image.loading = compact ? 'lazy' : 'eager';
    image.draggable = false;
    image.src = url;
    image.onerror = () => {
      button.disabled = true;
      button.textContent = '图片载入失败';
    };
    button.append(image);
    button.onclick = () => {
      if (performance.now() - lastSwipe > 350) openPreview(images[index]);
    };
    stage.append(button);
    return button;
  });
  const caption = document.createElement('figcaption');
  const metadata = document.createElement('span');
  if (!compact) metadata.textContent = model + ' · ' + (language === 'en' ? 'EN' : '中文') + ' · ' + seed;
  const counter = document.createElement('span');
  counter.className = 'image-deck-count';
  counter.setAttribute('aria-live', 'polite');
  counter.hidden = images.length < 2;
  const link = document.createElement('a');
  link.textContent = '下载原图';
  const fileSeed = seed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  caption.append(metadata, counter, link);
  deck.append(stage, caption);
  container.append(deck);

  function show(index) {
    current = (index + cards.length) % cards.length;
    cards.forEach((card, i) => {
      let position = 'background';
      if (i === current) position = 'front';
      else if (i === (current + 1) % cards.length) position = 'next';
      else if (i === (current + cards.length - 1) % cards.length) position = 'previous';
      card.dataset.position = position;
      card.tabIndex = i === current ? 0 : -1;
      card.setAttribute('aria-hidden', String(i !== current));
      card.inert = i !== current;
    });
    counter.textContent = (current + 1) + ' / ' + cards.length;
    link.href = urls[current];
    link.download = 'moonlight-' + fileSeed + '-' + (current + 1) + '.' + extensions[images[current].type];
  }

  if (cards.length > 1) {
    for (const [offset, name, direction] of [[-1, '上一张', 'left'], [1, '下一张', 'right']]) {
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'image-deck-nav ' + direction;
      arrow.setAttribute('aria-label', name);
      arrow.innerHTML = icon(direction);
      arrow.onclick = () => show(current + offset);
      stage.append(arrow);
    }
    stage.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const fromCard = event.target === cards[current];
      show(current + (event.key === 'ArrowLeft' ? -1 : 1));
      if (fromCard) cards[current].focus();
    };
    stage.onpointerdown = event => {
      swipe = event.pointerType === 'touch' && !event.target.closest('.image-deck-nav') ? [event.clientX, event.clientY] : undefined;
    };
    stage.onpointercancel = () => { swipe = undefined; };
    stage.onpointerup = event => {
      if (!swipe) return;
      const dx = event.clientX - swipe[0], dy = event.clientY - swipe[1];
      swipe = undefined;
      if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy)) return;
      lastSwipe = performance.now();
      show(current + (dx < 0 ? 1 : -1));
    };
  }
  show(0);
  return urls;
}
