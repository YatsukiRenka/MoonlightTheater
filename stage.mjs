import {lang, t} from './i18n.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const minimumAngleGap = 21;
const romanValues = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
];

let previousSeed;
let previousSelection;
let stage;
let castingHero;
let plateObserver;
let observedPlate;
let plateBreakpoint;

function seedText(seed) {
  return String(seed ?? '');
}

function xmur3(value) {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = hash << 13 | hash >>> 19;
  }
  return function nextHash() {
    hash = Math.imul(hash ^ hash >>> 16, 2246822507);
    hash = Math.imul(hash ^ hash >>> 13, 3266489909);
    hash ^= hash >>> 16;
    return hash >>> 0;
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function seedRandom(seed) {
  return mulberry32(xmur3(seedText(seed))());
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function makeAngularGaps(count, random) {
  const freeDegrees = 360 - minimumAngleGap * count;
  const weights = Array.from({length: count}, () => -Math.log(Math.max(random(), 1e-9)));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  return weights.map(weight => minimumAngleGap + freeDegrees * weight / totalWeight);
}

function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function minimumSpanningLinks(stars) {
  const candidates = [];
  for (let first = 0; first < stars.length; first += 1) {
    for (let second = first + 1; second < stars.length; second += 1) {
      candidates.push({first, second, distance: distanceBetween(stars[first], stars[second])});
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.first - b.first || a.second - b.second);

  const parents = stars.map((star, index) => index);
  const find = index => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const links = [];
  const neighbors = stars.map(() => []);
  for (const edge of candidates) {
    const firstRoot = find(edge.first);
    const secondRoot = find(edge.second);
    if (firstRoot === secondRoot) continue;
    parents[firstRoot] = secondRoot;
    links.push([edge.first, edge.second]);
    neighbors[edge.first].push(edge.second);
    neighbors[edge.second].push(edge.first);
    if (links.length === stars.length - 1) break;
  }

  if (stars.length >= 8) {
    // A shared tree neighbor closes a three-star loop.
    const extra = candidates.find(({first, second}) =>
      neighbors[first].some(index => neighbors[second].includes(index))
    );
    if (extra) links.push([extra.first, extra.second]);
  }
  return links;
}

export function constellation(seed, options = {}) {
  const inner = numberOr(options.inner, 7);
  const outer = numberOr(options.outer, 25);
  const cx = numberOr(options.cx, 0);
  const cy = numberOr(options.cy, 0);
  const lowRadius = Math.min(inner, outer);
  const highRadius = Math.max(inner, outer);
  const radiusRange = highRadius - lowRadius;
  const radiusMargin = Math.min(0.000001, radiusRange / 4);
  const dotScale = radiusRange / 44;
  const random = seedRandom(seed);
  const count = 6 + Math.floor(random() * 4);
  const gaps = makeAngularGaps(count, random);
  let angle = random() * 360;
  const stars = [];

  for (let index = 0; index < count; index += 1) {
    const radians = angle * Math.PI / 180;
    const radius = radiusRange
      ? lowRadius + radiusMargin + random() * Math.max(0, radiusRange - radiusMargin * 2)
      : lowRadius;
    const size = (1.6 + random() * 1.6) * dotScale;
    stars.push({
      x: cx + Math.cos(radians) * radius,
      y: cy + Math.sin(radians) * radius,
      r: size
    });
    angle += gaps[index];
  }

  return {stars, links: minimumSpanningLinks(stars)};
}

export function romanNumeral(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  let remainder = value;
  let result = '';
  for (const [amount, numeral] of romanValues) {
    while (remainder >= amount) {
      result += numeral;
      remainder -= amount;
    }
  }
  return result;
}

export function dialAngle(seed) {
  return Math.floor(seedRandom(seed)() * 360);
}

// A leader line runs from a callout toward the moon's centre and stops on the frame ring.
export function leaderLine({sx, sy, cx, cy, r}) {
  const dx = cx - sx;
  const dy = cy - sy;
  const distance = Math.hypot(dx, dy);
  const radius = Math.max(0, r);
  if (!(distance > radius)) return {length: 0, angle: 0};
  return {length: distance - radius, angle: Math.atan2(dy, dx) * 180 / Math.PI};
}

function watchPlateLayout(plate, figure) {
  if (!plateBreakpoint) {
    plateBreakpoint = window.matchMedia('(min-width: 60em)');
    plateBreakpoint.addEventListener('change', layoutPlate);
  }

  if (observedPlate === plate || typeof ResizeObserver === 'undefined') return;
  plateObserver ??= new ResizeObserver(layoutPlate);
  if (observedPlate) plateObserver.disconnect();
  plateObserver.observe(plate);
  // The viewport-sized dial can resize after the surrounding shell reaches its maximum width.
  if (figure) plateObserver.observe(figure);
  observedPlate = plate;
}

export function layoutPlate() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const plate = document.getElementById('plate');
  if (!plate) return;
  const figure = plate.querySelector('.hero-dial');
  watchPlateLayout(plate, figure);

  const slots = Array.from(plate.querySelectorAll('.slot'));
  if (!plateBreakpoint.matches) {
    for (const slot of slots) { slot.style.removeProperty('--reach'); slot.style.removeProperty('--tilt'); }
    return;
  }

  if (!figure) return;

  const slotRects = slots.map(slot => slot.getBoundingClientRect());
  const figureRect = figure.getBoundingClientRect();
  // The square figure matches the SVG's layout size without the dial's scroll rotation.
  const radius = figureRect.width * 210 / 640;
  const cx = figureRect.left + figureRect.width / 2;
  const cy = figureRect.top + figureRect.height / 2;
  // The line starts .5rem beyond the callout's inner edge (see .slot::after).
  const gap = parseFloat(getComputedStyle(document.documentElement).fontSize) / 2;
  const lines = slotRects.map((rect, index) => {
    const side = slots[index].closest('[data-side]')?.dataset.side === 'right' ? 'right' : 'left';
    const sx = side === 'left' ? rect.right + gap : rect.left - gap;
    const {length, angle} = leaderLine({sx, sy: rect.top + rect.height / 2, cx, cy, r: radius});
    // Left lines grow rightward from their start; right lines grow leftward, so turn them half a circle.
    return {reach: Math.max(0, length - 2), tilt: side === 'left' ? angle : angle - Math.sign(angle || 1) * 180};
  });

  slots.forEach((slot, index) => {
    slot.style.setProperty('--reach', `${lines[index].reach.toFixed(1)}px`);
    slot.style.setProperty('--tilt', `${lines[index].tilt.toFixed(2)}deg`);
  });

}

function svgElement(tagName, attributes = {}) {
  const element = document.createElementNS(svgNamespace, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function formattedNumber(value) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function polarPoint(cx, cy, radius, degrees) {
  const radians = degrees * Math.PI / 180;
  return {
    x: cx + Math.cos(radians) * radius,
    y: cy + Math.sin(radians) * radius
  };
}

function buildOuterRing(ring) {
  const group = svgElement('g', {fill: 'none', stroke: 'currentColor', 'stroke-width': 1});
  group.append(svgElement('circle', {cx: 320, cy: 320, r: 300, 'stroke-opacity': '.5'}));

  let tickPath = '';
  for (let degrees = 0; degrees < 360; degrees += 3) {
    const length = degrees % 90 === 0 ? 22 : degrees % 15 === 0 ? 12 : 6;
    const outside = polarPoint(320, 320, 300, degrees - 90);
    const inside = polarPoint(320, 320, 300 - length, degrees - 90);
    tickPath += `M${formattedNumber(outside.x)} ${formattedNumber(outside.y)}L${formattedNumber(inside.x)} ${formattedNumber(inside.y)}`;
  }
  group.append(svgElement('path', {d: tickPath, 'stroke-opacity': '.5'}));
  ring.append(group);
}

export function textRingContent(seed, act) {
  // The ring carries the theatre's name in the page's own script; English already has it in Latin.
  const name = lang === 'en' ? '' : `${t('月光剧场')} · `;
  const unit = `MOONLIGHT THEATER · ${name}Nº ${seed} · ACT ${romanNumeral(act)} · `;
  const unitLength = Array.from(unit).length;
  const repetitionCount = Math.max(1, Math.round(145 / unitLength));
  return unit.repeat(repetitionCount);
}

function buildTextRing(ring) {
  const path = svgElement('path', {
    id: 'dialTextPath',
    d: 'M320 36a284 284 0 1 1 0 568a284 284 0 1 1 0-568',
    fill: 'none',
    stroke: 'none'
  });
  const text = svgElement('text', {
    fill: 'currentColor',
    'fill-opacity': '.72',
    'font-family': 'var(--f-latin)',
    'font-size': '15',
    'letter-spacing': '5',
    'textLength': formattedNumber(2 * Math.PI * 284),
    'lengthAdjust': 'spacing'
  });
  const textPath = svgElement('textPath', {href: '#dialTextPath', startOffset: '0%'});
  text.append(textPath);
  ring.append(path, text);
  return textPath;
}

function buildDashedRing(ring) {
  ring.append(svgElement('circle', {
    cx: 320, cy: 320, r: 268, fill: 'none', stroke: 'currentColor',
    'stroke-width': '1', 'stroke-dasharray': '1 7', 'stroke-opacity': '.45'
  }));
}

function buildFrame(svg) {
  svg.append(svgElement('circle', {
    id: 'dialFrame', class: 'dial-frame', cx: 320, cy: 320, r: 210,
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1', 'stroke-opacity': '.5'
  }));
  const arc = svgElement('path', {
    class: 'exploration-arc', fill: 'none', stroke: 'var(--lilac)',
    'stroke-width': '2', 'stroke-linecap': 'round'
  });
  const bead = svgElement('g', {class: 'exploration-bead'});
  bead.append(svgElement('circle', {
    class: 'phase-lit', cx: '0', cy: '0', r: '9', fill: 'var(--moon)'
  }));
  const phaseDark = svgElement('circle', {
    class: 'phase-dark', cx: '0', cy: '0', r: '9', fill: 'var(--ink)',
    'clip-path': 'url(#stageBeadClip)'
  });
  bead.append(phaseDark, svgElement('circle', {
    class: 'phase-outline', cx: '0', cy: '0', r: '9', fill: 'none',
    stroke: 'var(--moon-2)', 'stroke-width': '1'
  }));
  svg.append(arc, bead);
  return {arc, bead, phaseDark};
}

const gelAngles = [200, 213, 226];
const fallbackGels = ['var(--lilac)', 'var(--ver)', 'var(--moon-2)'];

function buildPaletteRing(ring) {
  return gelAngles.map(degrees => {
    const point = polarPoint(320, 320, 300, degrees);
    const gel = svgElement('circle', {
      cx: formattedNumber(point.x), cy: formattedNumber(point.y), r: '6',
      stroke: '#ece7f366', 'stroke-width': '1'
    });
    ring.append(gel);
    return gel;
  });
}

function buildStage(svg) {
  const defs = svgElement('defs');
  const phaseClip = svgElement('clipPath', {id: 'stageBeadClip', clipPathUnits: 'userSpaceOnUse'});
  phaseClip.append(svgElement('circle', {cx: '0', cy: '0', r: '9'}));
  const skyClip = svgElement('clipPath', {id: 'stageSkyClip'});
  skyClip.append(svgElement('path', {
    d: 'M0 0H640V640H0Z M320 108a212 212 0 1 1 0 424a212 212 0 1 1 0-424Z',
    'clip-rule': 'evenodd'
  }));
  const linkReveal = svgElement('mask', {
    id: 'dialLinkReveal', 'mask-type': 'alpha', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 640, height: 640
  });
  defs.append(phaseClip, skyClip, linkReveal);

  const ring = svgElement('g', {class: 'dial-ring'});
  buildOuterRing(ring);
  const textPath = buildTextRing(ring);
  buildDashedRing(ring);
  const sky = svgElement('g', {'clip-path': 'url(#stageSkyClip)'});
  const links = svgElement('g');
  const stars = svgElement('g');
  sky.append(links, stars);
  ring.append(sky);
  const gels = buildPaletteRing(ring);

  svg.replaceChildren(defs, ring);
  return {svg, ring, textPath, links, stars, linkReveal, gels, frame: buildFrame(svg)};
}

function updateExploration({arc, bead, phaseDark}, value) {
  const exploration = Math.max(0, Math.min(1, numberOr(value, 0)));
  const start = polarPoint(320, 320, 210, -90);
  const startText = `${formattedNumber(start.x)} ${formattedNumber(start.y)}`;
  if (exploration === 0) {
    arc.setAttribute('d', `M${startText}`);
  } else if (exploration === 1) {
    arc.setAttribute('d', `M${startText}A210 210 0 1 1 320 530A210 210 0 1 1 ${startText}`);
  } else {
    const end = polarPoint(320, 320, 210, -90 + exploration * 360);
    const largeArc = exploration > 0.5 ? 1 : 0;
    arc.setAttribute('d', `M${startText}A210 210 0 ${largeArc} 1 ${formattedNumber(end.x)} ${formattedNumber(end.y)}`);
  }
  const beadPoint = polarPoint(320, 320, 210, -90 + exploration * 360);
  bead.setAttribute('transform', `translate(${formattedNumber(beadPoint.x)} ${formattedNumber(beadPoint.y)})`);
  phaseDark.setAttribute('cx', formattedNumber(exploration * 18));
}

function drawConstellation({links, stars, linkReveal}, seed, shouldAnimate) {
  const constellationData = constellation(seed, {inner: 222, outer: 258, cx: 320, cy: 320});
  links.replaceChildren();
  stars.replaceChildren();
  linkReveal.replaceChildren();
  if (shouldAnimate) links.setAttribute('mask', 'url(#dialLinkReveal)');
  else links.removeAttribute('mask');

  for (const [firstIndex, secondIndex] of constellationData.links) {
    const first = constellationData.stars[firstIndex];
    const second = constellationData.stars[secondIndex];
    const d = `M${formattedNumber(first.x)} ${formattedNumber(first.y)}L${formattedNumber(second.x)} ${formattedNumber(second.y)}`;
    links.append(svgElement('path', {class: 'dial-link', d, fill: 'none'}));
    if (shouldAnimate) {
      const reveal = svgElement('path', {
        class: 'dial-link-reveal', d, fill: 'none', stroke: 'white', 'stroke-width': 3, pathLength: 1
      });
      linkReveal.append(reveal);
    }
  }

  constellationData.stars.forEach((star, index) => {
    const dot = svgElement('circle', {
      class: `dial-star${shouldAnimate ? ' draw-in' : ''}`,
      cx: formattedNumber(star.x), cy: formattedNumber(star.y), r: formattedNumber(star.r),
      fill: 'currentColor'
    });
    dot.style.setProperty('--star-delay', `${index * 70}ms`);
    stars.append(dot);
  });
}

function highlightChangedSlots(selection) {
  for (const editButton of document.querySelectorAll('#slots [data-edit]')) {
    const key = editButton.dataset.edit;
    const changed = !Object.is(previousSelection?.[key], selection?.[key]);
    editButton.closest('.slot')?.classList.toggle('recast', changed);
  }
}

function updateHeroAct(seed, act) {
  const label = document.getElementById('heroAct');
  if (label) label.textContent = `Nº ${seed} · Act ${romanNumeral(act)}`;
}

function restartMoonrise() {
  const hero = document.querySelector('.stage');
  const moon = hero?.querySelector('.dial-moon');
  if (!moon) return;

  const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
  if (!motion.matches) return;

  if (castingHero !== hero) {
    hero.addEventListener('animationend', event => {
      if (event.target !== moon || event.animationName !== 'moonrise') return;
      const moonriseRunning = moon.getAnimations().some(animation =>
        animation.animationName === 'moonrise' && animation.playState === 'running'
      );
      if (!moonriseRunning) hero.classList.remove('casting');
    });
    motion.addEventListener('change', event => {
      if (!event.matches) hero.classList.remove('casting');
    });
    castingHero = hero;
  }

  moon.style.setProperty('--moonrise-start-filter', window.getComputedStyle(moon).filter);
  hero.classList.remove('casting');
  void hero.offsetWidth;
  hero.classList.add('casting');
}

export function renderStage({seed, act, exploration, colors, selection} = {}) {
  if (typeof document === 'undefined') return;
  const svg = document.getElementById('stageDial');
  if (!svg) return;

  const normalizedSeed = seedText(seed);
  const seedChanged = previousSeed !== undefined && previousSeed !== normalizedSeed;
  if (seedChanged) restartMoonrise();
  const structureChanged = stage?.svg !== svg || !svg.contains(stage.ring);
  if (structureChanged) stage = buildStage(svg);

  updateHeroAct(normalizedSeed, act);
  paintMoon({seed: normalizedSeed, colors, selection});
  stage.textPath.textContent = textRingContent(normalizedSeed, act);
  updateExploration(stage.frame, exploration);
  stage.gels.forEach((gel, index) => gel.setAttribute('fill', colors?.[index] || fallbackGels[index]));
  if (structureChanged || seedChanged) {
    stage.ring.style.setProperty('--dial-angle', `${dialAngle(normalizedSeed)}deg`);
    drawConstellation(stage, normalizedSeed, seedChanged);
  }
  if (seedChanged) highlightChangedSlots(selection);

  previousSeed = normalizedSeed;
  previousSelection = {...(selection || {})};
  layoutPlate();
}

const moonStyles = {clean_cel: 'cel', soft_pastel: 'soft', graphic_cel: 'graphic'};

function hexChannels(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
}

function relativeLuminance(color) {
  const channels = hexChannels(color);
  if (!channels) return 0.5;
  const [red, green, blue] = channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function hslHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = n => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [channel(0), channel(8), channel(4)].map(value => value.toString(16).padStart(2, '0')).join('');
}

// The moon is painted from the cast itself: the palette supplies the colours, the seed and palette together
// place the light, and the drawing style decides how the light is rendered.
export function moonArt({seed, palette, colors, style} = {}) {
  const random = seedRandom(`${seedText(seed)}|${palette ?? ''}`);
  const given = (colors || []).filter(color => hexChannels(color));
  let tones;
  if (given.length >= 3) {
    tones = given.slice(0, 3);
  } else {
    // Custom palettes have no swatches: derive a triad from the seed instead.
    const hue = random() * 360;
    tones = [hslHex(hue, 55, 86), hslHex((hue + 38) % 360, 42, 64), hslHex((hue + 210) % 360, 38, 28)];
  }
  const [light, mid, deep] = [...tones].sort((first, second) => relativeLuminance(second) - relativeLuminance(first));
  const percent = (low, high) => `${(low + random() * (high - low)).toFixed(1)}%`;
  const angle = Math.round(random() * 360);
  // The gradient runs light → deep along the angle (CSS: 0deg points up), so the lit side is behind it.
  const radians = angle * Math.PI / 180;
  const toward = {x: Math.sin(radians), y: -Math.cos(radians)};
  const lit = 20 + random() * 10;
  const edge = 9 + random() * 8;
  const at = value => `${value.toFixed(1)}%`;
  // Four colour pools for the slowly turning marble inside the moon.
  const pools = Array.from({length: 4}, () => [percent(14, 86), percent(14, 86)]);
  return {
    variant: moonStyles[style] || 'soft',
    vars: {
      '--m-light': light,
      '--m-mid': mid,
      '--m-deep': deep,
      '--m-angle': `${angle}deg`,
      '--m-x': at(50 - toward.x * lit),
      '--m-y': at(50 - toward.y * lit),
      // The cel terminator: a circle shifted toward the light; everything outside it is shadow.
      '--m-tx': at(50 - toward.x * edge),
      '--m-ty': at(50 - toward.y * edge),
      ...Object.fromEntries(pools.flatMap(([x, y], index) => [[`--p${index}x`, x], [`--p${index}y`, y]]))
    }
  };
}

function paintMoon({seed, colors, selection}) {
  const moon = document.getElementById('dialMoon');
  if (!moon) return;
  const art = moonArt({seed, palette: selection?.palette, colors, style: selection?.style});
  moon.dataset.variant = art.variant;
  for (const [name, value] of Object.entries(art.vars)) moon.style.setProperty(name, value);
}

export function setExploration(value) {
  if (stage) updateExploration(stage.frame, value);
}

export function sigil(seed) {
  const data = constellation(seed, {inner: 7, outer: 25, cx: 32, cy: 32});
  const links = data.links.map(([firstIndex, secondIndex]) => {
    const first = data.stars[firstIndex];
    const second = data.stars[secondIndex];
    return `<path class="sigil-link" d="M${formattedNumber(first.x)} ${formattedNumber(first.y)}L${formattedNumber(second.x)} ${formattedNumber(second.y)}"/>`;
  }).join('');
  const stars = data.stars.map(star =>
    `<circle class="sigil-star" cx="${formattedNumber(star.x)}" cy="${formattedNumber(star.y)}" r="${formattedNumber(star.r)}"/>`
  ).join('');
  return `<svg class="sigil" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle class="sigil-frame" cx="32" cy="32" r="30" fill="none"/>${links}${stars}</svg>`;
}
