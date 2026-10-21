/**
 * Resolved element properties: levels, elevations, heights and sizes that
 * depend on other items (levels, types, hosts).
 */
import { typeThickness } from './catalog.js';
import { norm, sub, len, perp, add, scale } from './geom.js';

export function levelOf(doc, el) {
  if (!el) return null;
  if (el.levelId) return doc.get(el.levelId) ?? null;
  if (el.hostId) return levelOf(doc, doc.get(el.hostId));
  if (el.kind === 'level') return el;
  return null;
}

export function levelElevation(doc, levelId) {
  return doc.get(levelId)?.elevation ?? 0;
}

/** Base and top elevation of a wall (or column) in absolute millimetres. */
export function verticalExtent(doc, el) {
  const base = levelElevation(doc, el.levelId) + (+el.baseOffset || 0);
  let top;
  if (el.topLevelId && doc.get(el.topLevelId)) top = levelElevation(doc, el.topLevelId) + (+el.topOffset || 0);
  else top = base + (+el.height || 3000);
  if (top < base + 1) top = base + 1;
  return { base, top };
}

export function wallType(doc, w) {
  return doc.get(w.typeId) ?? null;
}

export function wallThickness(doc, w) {
  return Math.max(1, typeThickness(wallType(doc, w)) || 200);
}

/**
 * Centerline of a wall. The stored points lie on the location line; the
 * exterior side is the left of a→b unless the wall is flipped.
 */
export function wallAxis(doc, w) {
  const half = wallThickness(doc, w) / 2;
  const d = sub(w.b, w.a);
  const length = len(d);
  const dir = length > 1e-9 ? norm(d) : [1, 0];
  const n = perp(dir);
  const ext = w.flipped ? scale(n, -1) : n;
  let shift = 0;
  if (w.locationLine === 'exterior') shift = -half;
  else if (w.locationLine === 'interior') shift = half;
  const off = scale(ext, shift);
  return { a: add(w.a, off), b: add(w.b, off), dir, n, ext, half, length };
}

/** Height-related values for a hosted opening (door, window, opening). */
export function openingSize(doc, el) {
  const type = doc.get(el.typeId);
  if (el.kind === 'opening') return { width: +el.width || 900, height: +el.height || 2100, sill: +el.sill || 0 };
  const width = +(el.width ?? type?.width) || 900;
  const height = +(el.height ?? type?.height) || 2100;
  const sill = el.kind === 'window' ? +(el.sill ?? type?.sill ?? 900) : 0;
  return { width, height, sill };
}

/** Elements hosted by a wall. */
export function hostedBy(doc, wallId) {
  if (doc.hosted) return [...doc.hosted(wallId)].map((id) => doc.get(id)).filter(Boolean);
  const out = [];
  for (const k of ['door', 'window', 'opening']) for (const el of doc.all(k)) if (el.hostId === wallId) out.push(el);
  return out;
}

/** Elements that reference an id (hosted elements, tags, dimensions, rooms' views...). */
export function dependentsOf(doc, id) {
  const out = [];
  for (const el of doc.items.values()) {
    if (el.id === id) continue;
    if (el.hostId === id || el.targetId === id || el.viewId === id || el.levelId === id) out.push(el);
    else if (el.kind === 'dimension' && el.refs?.some((r) => r.id === id)) out.push(el);
    else if (el.kind === 'sheet' && el.viewports?.some((v) => v.viewId === id)) out.push(el);
  }
  return out;
}

/** Height of a stair's rise. */
export function stairRise(doc, s) {
  const base = levelElevation(doc, s.levelId) + (+s.baseOffset || 0);
  let top;
  if (s.topLevelId && doc.get(s.topLevelId)) top = levelElevation(doc, s.topLevelId) + (+s.topOffset || 0);
  else top = base + (+s.height || 3000);
  return { base, top, rise: Math.max(1, top - base) };
}

/**
 * Ramp run: the rise between its levels divided by the slope (1 in
 * slopeRatio), along a→b. The stored b is only a direction; `end` is where
 * the ramp really ends.
 */
export function rampLayout(doc, r) {
  const type = doc.get(r.typeId) || {};
  const { base, top, rise } = stairRise(doc, r);
  const ratio = Math.max(1, +(r.slopeRatio ?? type.slopeRatio) || 12);
  const run = rise * ratio;
  const d = sub(r.b, r.a);
  const dir = len(d) > 1e-6 ? norm(d) : [1, 0];
  const width = +(r.width ?? type.width) || 1200;
  return { base, top, rise, ratio, run, dir, side: perp(dir), width, end: add(r.a, scale(dir, run)), thickness: +type.thickness || 150 };
}

/** Plan outline of a ramp (a rectangle centred on its run line). */
export function rampOutline(doc, r) {
  const g = rampLayout(doc, r);
  const h = scale(g.side, g.width / 2);
  return [sub(r.a, h), sub(g.end, h), add(g.end, h), add(r.a, h)];
}

/** Riser count, riser height and tread depth for a stair. */
export function stairLayout(doc, s) {
  const type = doc.get(s.typeId) || {};
  const { base, top, rise } = stairRise(doc, s);
  const maxRiser = +type.maxRiser || 180;
  const risers = Math.max(2, s.risers || Math.ceil(rise / maxRiser));
  const riserHeight = rise / risers;
  const tread = +(s.tread ?? type.tread) || 280;
  return { base, top, rise, risers, riserHeight, tread, runLength: (risers - 1) * tread, width: +(s.width ?? type.width) || 1100 };
}
