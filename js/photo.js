// Photo pipeline: read EXIF GPS, decode (respecting orientation), resize to two JPEGs.
// Uses the global `exifr` only inside functions.

import { PHOTO_FULL_EDGE, PHOTO_GUESS_EDGE, JPEG_QUALITY } from './protocol.js';

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;

export async function processPhoto(file) {
  const looksImage = file && (file.type ? /^image\//i.test(file.type) : IMG_EXT.test(file.name || ''));
  if (!looksImage) throw new Error("That's not a photo. Pick an image.");

  // GPS first: re-encoding through a canvas strips all EXIF.
  const gps = await readGps(file);

  let src;
  try {
    src = await decode(file);
  } catch (e) {
    throw new Error("Couldn't open that photo. Try a JPEG, or snap it with the Camera app first.");
  }

  try {
    const full = await encode(src, PHOTO_FULL_EDGE);
    const guess = await encode(src, PHOTO_GUESS_EDGE);
    const previewUrl = URL.createObjectURL(guess);
    return { gps, full: await full.arrayBuffer(), guess: await guess.arrayBuffer(), previewUrl };
  } finally {
    src.close();
  }
}

async function readGps(file) {
  try {
    if (typeof exifr === 'undefined') return null;
    const g = await exifr.gps(file);
    if (!g) return null;
    const lat = Number(g.latitude), lng = Number(g.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null;   // bogus "null island" fix
    return { lat, lng };
  } catch (e) {
    return null;
  }
}

// -> { source, width, height, close() }
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => { try { bmp.close(); } catch (e) {} } };
    } catch (e) { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); });
    // <img> applies EXIF orientation by default in every current browser.
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function encode(src, edge) {
  const scale = Math.min(1, edge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';               // JPEG has no alpha
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.source, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      canvas.width = canvas.height = 0;  // free the backing store early (iOS memory)
      b ? resolve(b) : reject(new Error("Couldn't process that photo."));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}
