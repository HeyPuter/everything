/**
 * Page background fill effects drawn for this project: gradients, textures and patterns rendered to a
 * PNG tile that the document stores as a picture page background. The tile carries its resolution
 * (pHYs), so a small image covers a whole page when it is shown at that resolution.
 */

export const GRADIENT_STYLES = [
  ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['diagonalUp', 'Diagonal up'], ['diagonalDown', 'Diagonal down'], ['center', 'From center'], ['corner', 'From corner'],
];
/** Patterns on an 8 × 8 cell: each is a list of [x, y, w, h] foreground rectangles. */
export const PATTERNS = [
  ['dots10', '10% dots', [[1, 1, 1, 1], [5, 5, 1, 1]]],
  ['dots25', '25% dots', [[0, 0, 2, 2], [4, 4, 2, 2]]],
  ['horizontal', 'Horizontal lines', [[0, 3, 8, 1], [0, 7, 8, 1]]],
  ['vertical', 'Vertical lines', [[3, 0, 1, 8], [7, 0, 1, 8]]],
  ['grid', 'Grid', [[0, 0, 8, 1], [0, 0, 1, 8]]],
  ['checker', 'Checkerboard', [[0, 0, 4, 4], [4, 4, 4, 4]]],
  ['diagonalUp', 'Diagonal up', Array.from({ length: 8 }, (_, i) => [i, 7 - i, 1, 1])],
  ['diagonalDown', 'Diagonal down', Array.from({ length: 8 }, (_, i) => [i, i, 1, 1])],
  ['cross', 'Diagonal cross', Array.from({ length: 8 }, (_, i) => [[i, i, 1, 1], [i, 7 - i, 1, 1]]).flat()],
  ['bricks', 'Bricks', [[0, 0, 8, 1], [0, 4, 8, 1], [0, 0, 1, 4], [4, 4, 1, 4]]],
  ['weave', 'Weave', [[0, 0, 3, 1], [4, 2, 1, 3], [5, 4, 3, 1], [1, 6, 1, 2]]],
  ['confetti', 'Confetti', [[1, 0, 1, 1], [6, 1, 1, 1], [3, 3, 1, 1], [0, 5, 1, 1], [5, 6, 1, 1]]],
];
/** Textures generated from a seed: a base color and how its grain is drawn. */
export const TEXTURES = [
  ['paper', 'Paper', 'F6F1E6', 'grain'], ['linen', 'Linen', 'EFE9DD', 'threads'], ['parchment', 'Parchment', 'F3E6C9', 'clouds'],
  ['slate', 'Slate', 'D9DDE1', 'clouds'], ['sand', 'Sand', 'EADBC0', 'grain'], ['denim', 'Denim', 'C7D3E3', 'threads'],
  ['sage', 'Sage', 'DCE6D3', 'clouds'], ['blush', 'Blush', 'F4DCDC', 'grain'],
];

const hex = value => `#${value}`;
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
/** Draw a gradient over (width × height). */
export function drawGradient(ctx, width, height, { color1, color2, style }) {
  let gradient;
  if (style === 'center' || style === 'corner') {
    const [cx, cy] = style === 'center' ? [width / 2, height / 2] : [0, 0];
    gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width - cx, height - cy));
  } else {
    const [x0, y0, x1, y1] = { horizontal: [0, 0, 0, height], vertical: [0, 0, width, 0], diagonalUp: [0, height, width, 0], diagonalDown: [0, 0, width, height] }[style] || [0, 0, 0, height];
    gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  }
  gradient.addColorStop(0, hex(color1)); gradient.addColorStop(1, hex(color2));
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
}
export function drawPattern(ctx, width, height, { pattern, foreground, background }, cell = 1) {
  const rects = PATTERNS.find(p => p[0] === pattern)?.[2] || PATTERNS[0][2];
  ctx.fillStyle = hex(background); ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = hex(foreground);
  for (let y = 0; y < height; y += 8 * cell) for (let x = 0; x < width; x += 8 * cell) for (const [rx, ry, rw, rh] of rects) ctx.fillRect(x + rx * cell, y + ry * cell, rw * cell, rh * cell);
}
/** A texture is drawn from a fixed seed, so the same texture always gives the same picture. */
export function drawTexture(ctx, width, height, { texture }) {
  const [, , base, kind] = TEXTURES.find(t => t[0] === texture) || TEXTURES[0];
  ctx.fillStyle = hex(base); ctx.fillRect(0, 0, width, height);
  let seed = 0x9e3779b9;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  if (kind === 'threads') {
    for (let y = 0; y < height; y += 2) { ctx.fillStyle = `rgba(0,0,0,${0.02 + random() * 0.04})`; ctx.fillRect(0, y, width, 1); }
    for (let x = 0; x < width; x += 2) { ctx.fillStyle = `rgba(255,255,255,${0.04 + random() * 0.06})`; ctx.fillRect(x, 0, 1, height); }
  } else if (kind === 'clouds') {
    for (let i = 0; i < 120; i++) {
      const x = random() * width, y = random() * height, r = 6 + random() * 22;
      ctx.fillStyle = `rgba(${random() < 0.5 ? '255,255,255' : '0,0,0'},${0.025 + random() * 0.03})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    for (let i = 0; i < width * height / 6; i++) {
      ctx.fillStyle = `rgba(0,0,0,${random() * 0.06})`;
      ctx.fillRect(Math.floor(random() * width), Math.floor(random() * height), 1, 1);
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** Insert (or replace) a PNG's pHYs chunk so readers know its resolution in dots per inch. */
export function withResolution(png, dpi) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const size = view.getUint32(at), type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type !== 'pHYs') chunks.push(png.subarray(at, at + size + 12));
    at += size + 12;
  }
  const ppm = Math.round(dpi / 0.0254), data = new Uint8Array(17), dv = new DataView(data.buffer);
  dv.setUint32(0, 9); data.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); data[16] = 1;
  const chunk = new Uint8Array(21); chunk.set(data); new DataView(chunk.buffer).setUint32(17, crc32(data.subarray(4)));
  const parts = [png.subarray(0, 8), chunks[0], chunk, ...chunks.slice(1)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
async function pngBytes(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
/**
 * Render a fill effect for a page (width × height in CSS pixels at 96 dpi) as { bytes, mime, title }.
 * Gradients cover the page with one quarter-resolution tile; patterns and textures repeat.
 */
export async function renderFill(effect, page) {
  if (effect.kind === 'gradient') {
    const scale = 4, width = Math.max(1, Math.ceil(page.width / scale)), height = Math.max(1, Math.ceil(page.height / scale));
    const canvas = makeCanvas(width, height); drawGradient(canvas.getContext('2d'), width, height, effect);
    return { bytes: withResolution(await pngBytes(canvas), 96 / scale), mime: 'image/png', title: 'Gradient' };
  }
  if (effect.kind === 'pattern') {
    const canvas = makeCanvas(16, 16); drawPattern(canvas.getContext('2d'), 16, 16, effect, 1);
    return { bytes: withResolution(await pngBytes(canvas), 96), mime: 'image/png', title: PATTERNS.find(p => p[0] === effect.pattern)?.[1] || 'Pattern' };
  }
  if (effect.kind === 'texture') {
    const canvas = makeCanvas(256, 256); drawTexture(canvas.getContext('2d'), 256, 256, effect);
    return { bytes: withResolution(await pngBytes(canvas), 96), mime: 'image/png', title: TEXTURES.find(t => t[0] === effect.texture)?.[1] || 'Texture' };
  }
  return { bytes: effect.bytes, mime: effect.mime, title: effect.name || 'Picture' };
}
