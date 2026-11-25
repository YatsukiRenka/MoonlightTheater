import {isSafeHistoryImage} from './image-file.mjs';

const webp = 'image/webp';
const png = 'image/png';

function encode(canvas, mime, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

async function drawRendition(canvas, image, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', {alpha: true});
  if (!context) throw new Error('此浏览器无法生成图片预览。');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // drawImage uses the default frame of an animated image, so GIF previews are still posters.
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let blob;
  try { blob = await encode(canvas, webp, quality); } catch {}
  // Browsers can return PNG directly when WebP encoding is unavailable.
  if (blob?.size && (blob.type === webp || blob.type === png)) return blob;
  blob = await encode(canvas, png);
  if (!blob?.size || blob.type !== png) throw new Error('此浏览器无法保存图片预览。');
  return blob;
}

export async function makeImageRenditions(original) {
  if (!(original instanceof Blob) || !original.size || !await isSafeHistoryImage(original)) {
    throw new Error('历史图片格式无效或不安全。');
  }

  const image = new Image();
  const url = URL.createObjectURL(original);
  let canvas;
  try {
    image.decoding = 'async';
    image.src = url;
    try { await image.decode(); } catch (error) {
      throw new Error('浏览器无法解码这张历史图片。', {cause: error});
    }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取历史图片的尺寸。');

    canvas = document.createElement('canvas');
    const thumbnail = await drawRendition(canvas, image, 320, .76);
    const preview = await drawRendition(canvas, image, 1280, .86);
    return {thumbnail, preview, original};
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}
