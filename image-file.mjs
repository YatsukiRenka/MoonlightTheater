export function rasterMime(prefix) {
  if (prefix.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (prefix.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  if (prefix.startsWith('GIF89a') || prefix.startsWith('GIF87a')) return 'image/gif';
}

export function sanitizeSVG(text, {rejectUnsafe = false} = {}) {
  const namespace = 'http://www.w3.org/2000/svg';
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) return null;
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg' || svg.namespaceURI !== namespace || svg.querySelector('parsererror')) return null;
  const allowed = new Set('svg g defs title desc path rect circle ellipse line polyline polygon text tspan textPath symbol use clipPath mask pattern linearGradient radialGradient stop marker filter feGaussianBlur feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feBlend feDropShadow feOffset feMerge feMergeNode'.split(' '));
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (node.namespaceURI !== namespace || !allowed.has(node.localName)) {
      if (rejectUnsafe) return null;
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const {localName, value} = attribute;
      if (/^on/i.test(localName) || localName === 'base'
        || (localName === 'href' && !/^#[\w.:-]+$/.test(value))
        || /[\\\u0000]/.test(value) || /url\s*\((?!\s*['"]?#[\w.:-]+['"]?\s*\))/i.test(value)) {
        if (rejectUnsafe) return null;
        node.removeAttributeNode(attribute);
      }
    }
  }
  return new Blob([new XMLSerializer().serializeToString(svg)], {type: 'image/svg+xml'});
}

export async function isSafeHistoryImage(image) {
  if (image.type === 'image/svg+xml') return Boolean(sanitizeSVG(await image.text(), {rejectUnsafe: true}));
  const prefix = new Uint8Array(await image.slice(0, 12).arrayBuffer());
  return rasterMime(String.fromCharCode(...prefix)) === image.type;
}
