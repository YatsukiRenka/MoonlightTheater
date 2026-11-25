const fields = (key, label, values) => ({key, label, values});
const range = (key, label, min, max, step = 1) => ({key, label, min, max, step});
const choice = (value, label) => [value, label];
const auto = choice('', '模型默认');
const levels = {low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', minimal: '最少'};
const levelOptions = ids => [auto, ...ids.map(id => choice(id, levels[id]))];
const numbers = (min, max) => Array.from({length: max - min + 1}, (_, i) => choice(String(i + min), String(i + min)));
const formats = [choice('', '默认'), choice('png', 'PNG'), choice('jpeg', 'JPEG'), choice('webp', 'WebP')];
const backgrounds = [auto, choice('opaque', '不透明')];
const standardSizes = [auto, choice('1024x1024', '方图 · 1024 × 1024'), choice('1024x1536', '竖图 · 1024 × 1536'), choice('1536x1024', '横图 · 1536 × 1024')];
const largerSizes = [choice('2048x2048', '方图 · 2048 × 2048'), choice('2048x1152', '横图 · 2048 × 1152'), choice('1152x2048', '竖图 · 1152 × 2048'), choice('3840x2160', '横图 · 3840 × 2160'), choice('2160x3840', '竖图 · 2160 × 3840')];
const baseRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'];
const legacySizes = {portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024'};
const legacyRatios = {portrait: '2:3', square: '1:1', landscape: '3:2'};

export function legacyImageOptions(format, aspect) {
  if (!Object.hasOwn(legacySizes, aspect)) return {};
  return format === 'openai' ? {size: legacySizes[aspect]} : {aspectRatio: legacyRatios[aspect]};
}

export function imageCapabilities(provider, format, model) {
  const id = (model || '').split('/').at(-1).replace(/-(?:preview(?:-\d{2}-\d{2})?|\d{4}-\d{2}-\d{2})$/, '');
  if (format === 'openai') {
    const modern = /^gpt-image-2\.[56]-(?:sunburst|flare)$/.test(id);
    const v26 = modern && id.startsWith('gpt-image-2.6');
    return {
      format, modern, v26, flexible: modern || id === 'gpt-image-2',
      fidelity: id === 'gpt-image-1.5', maxReferences: 16,
      maxReferenceBytes: 49 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024,
    };
  }
  const banana21 = id === 'gemini-nano-banana-2.1';
  const flash = id === 'gemini-3.1-flash-image';
  const lite = id === 'gemini-3.1-flash-lite-image';
  const pro = id === 'gemini-3-pro-image';
  const known = banana21 || flash || lite || pro || id === 'gemini-2.5-flash-image';
  return {
    format, known, vertex: provider === 'gemini-oauth', developer: provider === 'gemini',
    imageSizes: flash ? ['512', '1K', '2K', '4K'] : banana21 || pro ? ['1K', '2K', '4K'] : [],
    ratios: [...baseRatios, '21:9', ...((banana21 || flash || lite) ? ['1:4', '4:1', '1:8', '8:1'] : [])],
    thinking: banana21 ? ['minimal', 'medium', 'high'] : flash || lite ? ['minimal', 'high'] : [],
    search: banana21 || flash ? ['web', 'images', 'both'] : pro ? ['web'] : [],
    maxReferences: banana21 || flash || pro || lite ? 14 : 3,
    maxReferenceBytes: 14 * 1024 * 1024, maxTotalBytes: 14 * 1024 * 1024,
  };
}

export function imageOptionFields(caps, settings = {}, hasReferences = false) {
  const out = [];
  if (caps.format === 'openai') {
    const output = settings.output_format;
    const svg = output === 'svg' && caps.v26 && !hasReferences;
    const gif = output === 'gif' && caps.v26;
    const raster = !svg && !gif;
    const compressed = output === 'jpeg' || output === 'webp';
    const sizes = caps.flexible ? [...standardSizes, ...largerSizes, choice('custom', '自定义尺寸')] : standardSizes;
    out.push(fields('size', '尺寸与方向', sizes));
    if (caps.flexible && settings.size === 'custom') {
      out.push(range('width', '宽度（像素）', 16, 3840, 16), range('height', '高度（像素）', 16, 3840, 16));
    }
    out.push(fields('quality', '画质', levelOptions(['low', 'medium', 'high', ...(caps.modern ? ['xhigh', 'max'] : [])])));
    if (caps.v26) out.push(fields('complexity', '复杂度', levelOptions(['low', 'medium', 'high'])));
    if (!svg) out.push(fields('n', '图片数量', numbers(1, 10)));
    out.push(fields('output_format', '输出格式', [...formats, ...(caps.v26 ? [choice('gif', 'GIF 动图'), ...(!hasReferences ? [choice('svg', 'SVG 矢量')] : [])] : [])]));
    if (!svg) out.push(fields('background', '背景', [...backgrounds, ...(raster && output !== 'jpeg' ? [choice('transparent', '透明')] : [])]));
    out.push(fields('moderation', '内容审核', [auto, choice('low', '较宽松')]));
    if (compressed) out.push(range('output_compression', '压缩质量（0–100）', 0, 100));
    if (raster) out.push(fields('partial_images', '流式预览张数', [choice('', '关闭'), ...numbers(1, 3)]));
    if (gif) out.push(range('frame_count', '动图帧数（默认 9）', 2, 16), range('frame_duration_ms', '每帧毫秒（默认 200）', 20, 2000, 10));
    if (hasReferences && caps.fidelity) out.push(fields('input_fidelity', '参考图保真度', levelOptions(['low', 'high'])));
    return out;
  }
  out.push(fields('aspectRatio', '画幅', [auto, ...caps.ratios.map(value => choice(value, value))]));
  if (caps.imageSizes.length) out.push(fields('imageSize', '分辨率', [auto, ...caps.imageSizes.map(value => choice(value, value))]));
  if (caps.thinking.length) out.push(fields('thinkingLevel', '思考档位', levelOptions(caps.thinking).map(([value, label]) => [value.toUpperCase(), label])));
  out.push(fields('n', '生图请求次数', numbers(1, 4)));
  if (caps.known) out.push(fields('modalities', '返回内容', [choice('', '图文'), choice('image', '仅图片')]));
  if (caps.search.length && (caps.vertex || caps.developer)) {
    const searchNames = {web: '网页', images: '图片', both: '网页与图片'};
    out.push(fields('search', 'Google 搜索辅助', [choice('', '关闭'), ...caps.search.map(value => choice(value, searchNames[value]))]));
  }
  if (caps.known && caps.developer) out.push(fields('mimeType', '输出格式', [auto, choice('image/jpeg', 'JPEG')]));
  if (caps.known && caps.vertex) {
    out.push(fields('mimeType', '输出格式', [auto, choice('image/png', 'PNG'), choice('image/jpeg', 'JPEG')]));
    if (settings.mimeType === 'image/jpeg') out.push(range('compressionQuality', 'JPEG 压缩质量（0–100）', 0, 100));
    out.push(fields('personGeneration', '人像生成', [auto, choice('ALLOW_ALL', '允许人像'), choice('ALLOW_ADULT', '仅成人'), choice('ALLOW_NONE', '禁止人像')]));
  }
  return out;
}

export function prepareImageOptions(caps, settings, hasReferences) {
  const normalized = {};
  for (const field of imageOptionFields(caps, settings, hasReferences)) {
    const value = settings[field.key];
    if (value === undefined || value === '') continue;
    if (field.values) {
      if (field.values.some(([option]) => option === String(value))) normalized[field.key] = String(value);
    } else {
      const number = Number(value);
      if (!Number.isInteger(number) || number < field.min || number > field.max || (number - field.min) % field.step) {
        throw new Error(field.label + '需在 ' + field.min + ' 到 ' + field.max + ' 之间，步长为 ' + field.step + '。');
      }
      normalized[field.key] = number;
    }
  }
  if (caps.format !== 'openai') return normalized;
  if (normalized.size === 'custom') {
    const {width, height} = normalized;
    const pixels = width * height;
    if (!width || !height || Math.max(width, height) > 3 * Math.min(width, height)
      || (normalized.output_format !== 'gif' && (pixels < 655360 || pixels > 8294400))) {
      throw new Error('自定义尺寸需要两边都是 16 的倍数，比例在 1:3 到 3:1 之间。静态图还需满足 655,360 至 8,294,400 像素。');
    }
    normalized.size = width + 'x' + height;
  }
  delete normalized.width;
  delete normalized.height;
  for (const key of ['n', 'partial_images']) if (key in normalized) normalized[key] = Number(normalized[key]);
  return normalized;
}

export function validateReferenceImages(files, caps) {
  if (files.length > caps.maxReferences) throw new Error('当前模型最多可添加 ' + caps.maxReferences + ' 张参考图。');
  let total = 0;
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0) {
      throw new Error('参考图需为有效的 PNG、JPEG 或 WebP 文件。');
    }
    if (file.size > caps.maxReferenceBytes) throw new Error('参考图单张需小于 ' + Math.ceil(caps.maxReferenceBytes / 1048576) + ' MB。');
    total += file.size;
  }
  if (total > caps.maxTotalBytes) throw new Error('参考图总大小需在 ' + Math.floor(caps.maxTotalBytes / 1048576) + ' MB 以内。');
}
