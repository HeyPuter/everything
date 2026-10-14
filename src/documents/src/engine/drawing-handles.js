import { EMU_PER_PX, ANGLE_PER_DEGREE, normalizedRotation, CROP_SIDES } from './images.js';

/**
 * Geometry for direct manipulation of drawings on the page: resizing from any of eight handles,
 * snapping rotations and positions, and the crop rectangle of a picture. Everything here works in
 * page pixels (96 per inch) and DrawingML units; it neither reads nor changes the document.
 */

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const isCorner = handle => handle.length === 2;

/**
 * Resize from a handle in the drawing's own (rotated) axes. A corner scales both sides; an edge
 * scales one, keeping the opposite edge in place. With preserveAspect an edge scales both sides
 * about the opposite edge's midpoint. Returns rounded EMU dimensions and the painted frame.
 */
export function resizeFromHandle(frame, handle, dx, dy, { preserveAspect = false, fromCenter = false } = {}) {
  const image = frame.image, angle = normalizedRotation(image.rotation) / ANGLE_PER_DEGREE * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const factor = fromCenter ? 2 : 1;
  const localX = (dx * c + dy * s) * factor, localY = (-dx * s + dy * c) * factor;
  let scaleX, scaleY;
  if (preserveAspect) {
    const scale = sx && sy ? 1 + (localX * sx * frame.width + localY * sy * frame.height) / (frame.width ** 2 + frame.height ** 2)
      : sx ? 1 + localX * sx / frame.width : 1 + localY * sy / frame.height;
    scaleX = scaleY = Math.max(.01, scale);
  } else {
    scaleX = sx ? Math.max(.01, 1 + localX * sx / frame.width) : 1;
    scaleY = sy ? Math.max(.01, 1 + localY * sy / frame.height) : 1;
  }
  const width = Math.max(1, Math.round(image.width * scaleX));
  const height = Math.max(1, Math.round(preserveAspect ? width * image.height / image.width : image.height * scaleY));
  const paintedWidth = width / EMU_PER_PX, paintedHeight = height / EMU_PER_PX;
  const halfX = fromCenter ? 0 : sx * (paintedWidth - frame.width) / 2;
  const halfY = fromCenter ? 0 : sy * (paintedHeight - frame.height) / 2;
  return { width, height, frame: { ...frame,
    x: frame.x + (frame.width - paintedWidth) / 2 + halfX * c - halfY * s,
    y: frame.y + (frame.height - paintedHeight) / 2 + halfX * s + halfY * c,
    width: paintedWidth, height: paintedHeight } };
}

/** The pointer's angle about a center, in degrees clockwise from straight up. */
export function pointerAngle(center, point) {
  return Math.atan2(point.x - center.x, -(point.y - center.y)) * 180 / Math.PI;
}

/** A rotation in degrees as DrawingML 1/60,000 degree units in [0, 360), optionally snapped to `step` degrees. */
export function rotationUnits(degrees, step = 0) {
  const snapped = step ? Math.round(degrees / step) * step : degrees;
  return normalizedRotation(Math.round(snapped * ANGLE_PER_DEGREE));
}

/**
 * Snap a moving box to guides. targets: { x: [{ value, from?, to? }], y: [...] } in page pixels.
 * The box's left, center and right (top, middle, bottom) are tried against every target; the
 * nearest one within `threshold` wins on each axis. Returns the offset to apply and the guides hit.
 */
export function snapBox(box, targets, threshold) {
  const result = { dx: 0, dy: 0, guides: [] };
  for (const axis of ['x', 'y']) {
    const start = box[axis], size = axis === 'x' ? box.width : box.height;
    const edges = [start, start + size / 2, start + size];
    let best = null;
    for (const target of targets[axis] || []) for (const edge of edges) {
      const distance = target.value - edge;
      if (Math.abs(distance) <= threshold && (!best || Math.abs(distance) < Math.abs(best.distance) - 1e-9)) best = { distance, target };
    }
    if (!best) continue;
    result[axis === 'x' ? 'dx' : 'dy'] = best.distance;
    // Every target at the snapped position shows its guide (an edge can meet a margin and another drawing at once).
    const moved = edges.map(edge => edge + best.distance);
    for (const target of targets[axis]) if (moved.some(edge => Math.abs(edge - target.value) < 1e-6) && !result.guides.some(g => g.axis === axis && Math.abs(g.value - target.value) < 1e-6)) result.guides.push({ axis, value: target.value, from: target.from, to: target.to, kind: target.kind });
  }
  return result;
}

/** Guide targets on a page: its edges and center, its margins, and other drawings' edges and centers. */
export function pageGuideTargets(page, others = []) {
  const x = [
    { value: 0, kind: 'page' }, { value: page.width / 2, kind: 'center' }, { value: page.width, kind: 'page' },
    { value: page.left, kind: 'margin' }, { value: page.width - page.right, kind: 'margin' },
  ];
  const y = [
    { value: 0, kind: 'page' }, { value: page.height / 2, kind: 'center' }, { value: page.height, kind: 'page' },
    { value: page.top, kind: 'margin' }, { value: page.height - page.bottom, kind: 'margin' },
  ];
  for (const box of others) {
    for (const value of [box.x, box.x + box.width / 2, box.x + box.width]) x.push({ value, kind: 'object', from: box.y, to: box.y + box.height });
    for (const value of [box.y, box.y + box.height / 2, box.y + box.height]) y.push({ value, kind: 'object', from: box.x, to: box.x + box.width });
  }
  return { x, y };
}

/* ---- Cropping ---- */
const UNIT = 100000;

/**
 * The whole picture's rectangle on the page for a frame showing `crop` (srcRect offsets in 1/1000 %).
 * Flips mirror which side of the source each visual side shows.
 */
export function uncroppedRect(frame, crop = {}, { flipH = false, flipV = false } = {}) {
  const c = Object.fromEntries(CROP_SIDES.map(side => [side, crop[side] || 0]));
  const left = flipH ? c.right : c.left, right = flipH ? c.left : c.right, top = flipV ? c.bottom : c.top, bottom = flipV ? c.top : c.bottom;
  const width = frame.width / (1 - (left + right) / UNIT), height = frame.height / (1 - (top + bottom) / UNIT);
  return { x: frame.x - width * left / UNIT, y: frame.y - height * top / UNIT, width, height };
}

/** The srcRect offsets that show `rect` of the whole picture `full` (both in page pixels). */
export function cropFromRects(full, rect, { flipH = false, flipV = false } = {}) {
  const fraction = value => Math.round(value * UNIT);
  const left = fraction((rect.x - full.x) / full.width), top = fraction((rect.y - full.y) / full.height);
  const right = fraction((full.x + full.width - rect.x - rect.width) / full.width), bottom = fraction((full.y + full.height - rect.y - rect.height) / full.height);
  const result = { left: flipH ? right : left, right: flipH ? left : right, top: flipV ? bottom : top, bottom: flipV ? top : bottom };
  for (const side of CROP_SIDES) if (Object.is(result[side], -0)) result[side] = 0;
  return result;
}

/** Move one side (or two, for a corner) of the crop rectangle; keepAspect holds its proportions. */
export function dragCropRect(rect, handle, dx, dy, { keepAspect = false, minimum = 4 } = {}) {
  let { x, y, width, height } = rect;
  const right = x + width, bottom = y + height;
  if (handle.includes('w')) { x = Math.min(right - minimum, x + dx); width = right - x; }
  if (handle.includes('e')) width = Math.max(minimum, width + dx);
  if (handle.includes('n')) { y = Math.min(bottom - minimum, y + dy); height = bottom - y; }
  if (handle.includes('s')) height = Math.max(minimum, height + dy);
  if (keepAspect && isCorner(handle)) {
    const ratio = rect.width / rect.height;
    if (width / height > ratio) width = height * ratio; else height = width / ratio;
    if (handle.includes('w')) x = right - width;
    if (handle.includes('n')) y = bottom - height;
  }
  return { x, y, width, height };
}

/** The largest rectangle with this aspect ratio (width / height), centered in `full`. */
export function aspectRect(full, ratio) {
  const width = Math.min(full.width, full.height * ratio), height = width / ratio;
  return { x: full.x + (full.width - width) / 2, y: full.y + (full.height - height) / 2, width, height };
}

/** Fill: scale the whole picture (natural aspect `natural`) to cover `frame`, centered. Fit: to sit inside it. */
export function coverRect(frame, natural, fit = false) {
  const scale = (fit ? Math.min : Math.max)(frame.width / natural.width, frame.height / natural.height);
  const width = natural.width * scale, height = natural.height * scale;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}
