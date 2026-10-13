/**
 * Color mixing and trapping on top of Divide.
 *
 *  - Hard Mix: where objects overlap, each RGB channel takes the darkest
 *    value of the colors covering the area (inks print on top of each
 *    other), so overlaps look like overprinted inks.
 *  - Soft Mix: overlaps show the colors below through the ones above at a
 *    mixing rate (0 = only the bottom color, 1 = only the top one).
 *  - Trap: where two differently colored areas meet, a thin strip of the
 *    lighter color spreads into the darker one (or the reverse) to hide
 *    gaps from misregistered printing plates. The strip is tinted down and
 *    set to overprint.
 *
 * Everything works on combine() items [{ style, subpaths, fillRule }]
 * (see model/live-effects.js) with an `engine(op, shapes, params)` that
 * returns records, null when the engine failed, or undefined while a
 * background job runs, so the same code serves the live effects (cached
 * engine results) and the Pathfinder panel's Trap command (the loaded
 * engine, synchronously).
 */
import { OP } from './engine/index.js';
import { hexToRgb, rgbToHex } from '../../lib/color.js';

const solid = (paint) => (paint?.type === 'solid' && /^#[0-9a-f]{6}$/i.test(paint.color) ? paint.color.toLowerCase() : null);

/** Relative luminance of a hex color (0 black to 1 white). */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Hard Mix of colors (back to front): the darkest value of each channel. */
export function hardMixColor(hexes) {
  const cs = hexes.map(hexToRgb);
  return rgbToHex({ r: Math.min(...cs.map((c) => c.r)), g: Math.min(...cs.map((c) => c.g)), b: Math.min(...cs.map((c) => c.b)) });
}

/** Soft Mix of colors (back to front): each color laid over the result at `rate` (0-1). */
export function softMixColor(hexes, rate) {
  const t = Math.max(0, Math.min(1, rate));
  let c = hexToRgb(hexes[0]);
  for (const hex of hexes.slice(1)) {
    const d = hexToRgb(hex);
    c = { r: c.r + (d.r - c.r) * t, g: c.g + (d.g - c.g) * t, b: c.b + (d.b - c.b) * t };
  }
  return rgbToHex({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
}

/** A tint of a color toward white: amount 1 keeps it, 0 is white. */
export function tint(hex, amount) {
  const c = hexToRgb(hex);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex({ r: Math.round(255 + (c.r - 255) * t), g: Math.round(255 + (c.g - 255) * t), b: Math.round(255 + (c.b - 255) * t) });
}

/** Engine shapes for filled items (open or unfilled outlines take no part). */
export function fillShapes(items) {
  const shapes = [];
  const owners = [];
  for (const it of items) {
    const subpaths = it.subpaths.filter((s) => !s.paint && s.anchors.length > 2 && s.closed);
    if (!subpaths.length || !it.style.fill) continue;
    shapes.push({ subpaths, filled: true, evenodd: it.fillRule === 'evenodd' });
    owners.push(it);
  }
  return { shapes, owners };
}

/**
 * Faces of Divide records recolored by mixing the solid fills covering
 * each face. Faces covered by any non-solid paint keep the topmost style.
 * Strokes are removed, like the other dividing pathfinders.
 */
export function mixFaces(records, owners, kind, rate = 0.5) {
  const out = [];
  for (const rec of records) {
    const owner = owners[rec.owner];
    if (!owner || !rec.subpaths.length) continue;
    const cover = (rec.cover?.length ? rec.cover : [rec.owner]).slice().sort((a, b) => a - b);
    const colors = cover.map((i) => solid(owners[i]?.style.fill));
    let fill = owner.style.fill;
    if (colors.length > 1 && colors.every(Boolean)) {
      const color = kind === 'hardMix' ? hardMixColor(colors) : softMixColor(colors, rate);
      fill = { type: 'solid', color };
    }
    out.push({ style: { ...owner.style, fill, stroke: null }, subpaths: rec.subpaths, fillRule: 'nonzero' });
  }
  return out;
}

function boundsOf(subpaths) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of subpaths) {
    for (const a of s.anchors) {
      x0 = Math.min(x0, a.x, a.ix, a.ox);
      y0 = Math.min(y0, a.y, a.iy, a.oy);
      x1 = Math.max(x1, a.x, a.ix, a.ox);
      y1 = Math.max(y1, a.y, a.iy, a.oy);
    }
  }
  return { x0, y0, x1, y1 };
}

const near = (a, b, d) => a.x0 <= b.x1 + d && b.x0 <= a.x1 + d && a.y0 <= b.y1 + d && b.y0 <= a.y1 + d;

/**
 * Trap strips between adjacent faces of different solid colors. Options:
 * thickness (pt), tint (0-1 of the spreading color), reverse (spread the
 * darker color instead). Returns items, or undefined while the engine is
 * still computing.
 */
export function trapStrips(faces, { thickness = 0.25, tint: amount = 0.4, reverse = false } = {}, engine) {
  const t = Math.max(0.01, thickness);
  const list = faces
    .map((f) => ({ ...f, color: solid(f.style.fill), box: boundsOf(f.subpaths) }))
    .filter((f) => f.color && f.subpaths.length);
  const out = [];
  let pending = false;
  const bands = new Map();
  const band = (f) => {
    if (!bands.has(f)) {
      const r = engine(OP.STROKE, [{ subpaths: f.subpaths.map(({ paint: _p, ...s }) => s), filled: false }], [2 * t, 1, 1, 4, 0, 0]);
      bands.set(f, r === undefined ? undefined : r ? r.flatMap((x) => x.subpaths).filter((s) => s.anchors.length > 1) : null);
    }
    return bands.get(f);
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.color === b.color || !near(a.box, b.box, t)) continue;
      const aLighter = luminance(a.color) >= luminance(b.color);
      const spread = aLighter !== reverse ? a : b;
      const into = spread === a ? b : a;
      const strip = band(spread);
      if (strip === undefined) {
        pending = true;
        continue;
      }
      if (!strip?.length) continue;
      const r = engine(OP.INTERSECT, [{ subpaths: strip, filled: true }, { subpaths: into.subpaths.map(({ paint: _p, ...s }) => s), filled: true }], []);
      if (r === undefined) {
        pending = true;
        continue;
      }
      const subpaths = (r?.[0]?.subpaths || []).filter((s) => s.anchors.length > 2);
      if (!subpaths.length) continue;
      out.push({
        style: { ...spread.style, fill: { type: 'solid', color: tint(spread.color, amount) }, stroke: null, strokeWidth: 0, overprintFill: true },
        subpaths,
        fillRule: 'nonzero',
        trap: true,
      });
    }
  }
  return pending ? undefined : out;
}

/**
 * Mix or trap combine() for a group (the live effects). Returns new items,
 * the input when there is nothing to do, or null while computing.
 */
export function mixTrapCombine(items, fx, engine) {
  const { shapes, owners } = fillShapes(items);
  if (shapes.length < 2) return items;
  const records = engine(OP.DIVIDE, shapes, []);
  if (records === undefined) return null;
  if (!records) return items;
  if (fx.type === 'trap') {
    const faces = records.filter((r) => owners[r.owner] && r.subpaths.length).map((r) => ({ style: { ...owners[r.owner].style, stroke: null }, subpaths: r.subpaths, fillRule: 'nonzero' }));
    const traps = trapStrips(faces, fx, engine);
    if (traps === undefined) return null;
    // The objects keep their own look (strokes too); the strips go on top.
    return [...items, ...traps];
  }
  return mixFaces(records, owners, fx.type, fx.rate);
}
