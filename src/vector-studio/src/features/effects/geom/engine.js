/**
 * Effects computed by the geometry engine: Offset Path, Outline Stroke and
 * the Pathfinder effects.
 *
 * Drawing never waits for the engine. Once its module has loaded, small jobs
 * run synchronously on the spot; until then, and for big jobs, the job runs
 * in the background (a worker for big ones), its result is cached by a hash
 * of the job's input, and geomEffectsChanged() redraws everything once it
 * arrives. Meanwhile the effect passes its input through unchanged.
 */
import { OP, runGeom, geomIfLoaded } from '../../geometry/engine/index.js';
import { encode, jobSize } from '../../geometry/engine/codec.js';
import { geomEffectsChanged } from '../../../model/geom-effects.js';
import { paintParts } from '../../../model/geom-effects.js';
import { JOIN, CAP, ALIGN, strokeParams } from '../../geometry/stroke-params.js';
import { emptyShapeModeReason } from '../../geometry/pathfinder.js';

/** Anchor count up to which a job runs synchronously while drawing. */
export const SYNC_LIMIT = 4000;
const CACHE_SIZE = 200;
const results = new Map();
const running = new Set();

function hashInput(op, shapes, params, tol) {
  const buf = encode(shapes, params);
  const words = new Uint32Array(buf.buffer, buf.byteOffset, buf.length * 2);
  let h1 = 0x811c9dc5 ^ op;
  let h2 = 0x9e3779b9 ^ Math.round(tol * 1e6);
  for (let i = 0; i < words.length; i++) {
    h1 = Math.imul(h1 ^ words[i], 0x01000193);
    h2 = Math.imul(h2 ^ words[i], 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${op}:${words.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/**
 * Engine records for a job: an array, null when the engine failed, or
 * undefined while the result is still being computed in the background
 * (`pending()` is called then).
 */
export function engineResult(op, shapes, params = [], { tol = 0.02, pending = null } = {}) {
  const inst = geomIfLoaded();
  if (inst && jobSize(shapes) <= SYNC_LIMIT) {
    try {
      return inst.run(op, shapes, params, tol);
    } catch {
      return null;
    }
  }
  const key = hashInput(op, shapes, params, tol);
  if (results.has(key)) {
    const r = results.get(key);
    // Most recently used last.
    results.delete(key);
    results.set(key, r);
    return r;
  }
  pending?.();
  if (!running.has(key)) {
    running.add(key);
    runGeom(op, shapes, params, { tol })
      .then(
        (r) => r,
        () => null,
      )
      .then((r) => {
        running.delete(key);
        results.set(key, r);
        while (results.size > CACHE_SIZE) results.delete(results.keys().next().value);
        geomEffectsChanged();
      });
  }
  return undefined;
}

/** Forget cached background results (tests). */
export function clearEngineResults() {
  results.clear();
}


/** Engine shapes for outlines grouped by paint, applying `fn(subpaths, paint)` to each group. */
function byPaint(node, subs, fn) {
  const parts = paintParts(node, subs);
  if (!parts) return fn(subs, undefined);
  const out = [];
  for (const p of parts) {
    const paint = p.subpaths[0].paint;
    const r = fn(p.subpaths.map(({ paint: _p, ...s }) => s), paint);
    for (const s of r) out.push(paint ? { ...s, paint } : s);
  }
  return out;
}

const recordSubpaths = (records) => records.flatMap((r) => r.subpaths).filter((s) => s.anchors.length > 1);

/** Offset Path: the outlines grown (or shrunk, negative) by `offset` with the given joins. */
export function offsetPath(subs, fx, info) {
  const d = fx.offset || 0;
  if (!d) return subs;
  const evenodd = info.node?.fillRule === 'evenodd';
  return byPaint(info.node || {}, subs, (group) => {
    const closed = group.filter((s) => s.closed);
    const open = group.filter((s) => !s.closed);
    const out = [];
    if (closed.length) {
      const r = engineResult(OP.OFFSET, [{ subpaths: closed, filled: true, evenodd }], [d, JOIN[fx.joins] ?? 0, fx.miterLimit || 4], { pending: info.pending });
      out.push(...(r ? recordSubpaths(r) : closed));
    }
    if (open.length) {
      // An open line offsets into the band around it.
      const r = d > 0 ? engineResult(OP.STROKE, [{ subpaths: open, filled: false }], [2 * d, JOIN[fx.joins] ?? 0, CAP.butt, fx.miterLimit || 4, ALIGN.center, 0], { pending: info.pending }) : null;
      out.push(...(r ? recordSubpaths(r) : open));
    }
    return out;
  });
}

/** Outline Stroke: the stroke's area becomes the outline (the object's stroke weight, joins, caps and dashes). */
export function outlineStroke(subs, fx, info) {
  const n = info.node;
  if (!n || !(n.strokeWidth > 0) || !n.stroke) return subs;
  const params = strokeParams(n, null, subs);
  return byPaint(n, subs, (group, paint) => {
    if (paint) return group;
    const r = engineResult(OP.STROKE, [{ subpaths: group, filled: Boolean(n.fill), evenodd: n.fillRule === 'evenodd' }], params, { pending: info.pending });
    return r ? recordSubpaths(r) : group;
  });
}

export const PATHFINDER_EFFECTS = Object.freeze([
  { kind: 'unite', label: 'Add', op: OP.UNITE, mode: true },
  { kind: 'intersect', label: 'Intersect', op: OP.INTERSECT, mode: true },
  { kind: 'exclude', label: 'Exclude', op: OP.EXCLUDE, mode: true },
  { kind: 'minusFront', label: 'Subtract', op: OP.MINUS_FRONT, mode: true },
  { kind: 'minusBack', label: 'Minus Back', op: OP.MINUS_BACK, mode: true },
  { kind: 'divide', label: 'Divide', op: OP.DIVIDE },
  { kind: 'trim', label: 'Trim', op: OP.TRIM },
  { kind: 'merge', label: 'Merge', op: OP.MERGE },
  { kind: 'crop', label: 'Crop', op: OP.CROP },
  { kind: 'outline', label: 'Outline', op: OP.OUTLINE },
]);

const pfDef = (kind) => PATHFINDER_EFFECTS.find((k) => k.kind === kind) || PATHFINDER_EFFECTS[0];

/** Pathfinder on one object: its outlines act as separate shapes (Add on a compound path unites its parts). */
export function pathfinderOnShape(subs, fx, info) {
  const own = subs.filter((s) => !s.paint && s.anchors.length > 1);
  if (own.length < 2) return subs;
  const def = pfDef(fx.kind);
  const shapes = own.map((s) => ({ subpaths: [s], filled: true }));
  const r = engineResult(def.op, shapes, [], { pending: info.pending });
  if (!r) return subs;
  return [...recordSubpaths(r), ...subs.filter((s) => s.paint)];
}

/**
 * A shape item's outlines cut to a clipping path (shapeHooks.clip): the
 * filled area inside the clip, or undefined while the engine computes it.
 * Open outlines are left alone.
 */
export function clipItem(item, clip, info = {}) {
  const own = item.subpaths.filter((s) => !s.paint && s.anchors.length > 1);
  if (!own.length || own.every((s) => !s.closed)) return null;
  const shapes = [
    { subpaths: own, filled: true, evenodd: item.fillRule === 'evenodd' },
    { subpaths: clip, filled: true },
  ];
  const r = engineResult(OP.INTERSECT, shapes, [], { pending: info.pending });
  if (r === undefined) return undefined;
  return r ? recordSubpaths(r) : null;
}

const solidKey = (style) => (style.fill?.type === 'solid' ? `${style.fill.color.toLowerCase()}|${style.fill.opacity ?? 1}` : null);

/**
 * Pathfinder on a group: combine() items [{ style, subpaths, fillRule }]
 * back to front into the result shapes with the Pathfinder panel's style
 * rules: shape modes take the frontmost object's style (Subtract the
 * backmost's); Divide keeps each face's style; Trim, Merge and Crop keep
 * fills only; Outline strokes the edges with their face's fill.
 */
export function pathfinderCombine(items, fx, info) {
  const def = pfDef(fx.kind);
  const shapes = [];
  const owners = [];
  const keys = new Map();
  for (const it of items) {
    const subpaths = it.subpaths.filter((s) => !s.paint && s.anchors.length > 1);
    if (!subpaths.length) continue;
    const open = subpaths.every((s) => !s.closed) && !it.style.fill;
    let key = -1;
    if (def.kind === 'merge') {
      const k = solidKey(it.style);
      if (k) {
        if (!keys.has(k)) keys.set(k, keys.size);
        key = keys.get(k);
      }
    }
    shapes.push({ subpaths, filled: Boolean(it.style.fill), evenodd: it.fillRule === 'evenodd', string: !def.mode && open, key });
    owners.push(it);
  }
  if (!shapes.length) return items;
  const unite = def.kind === 'unite' || def.kind === 'divide' || def.kind === 'outline';
  if (shapes.length < 2 && !(unite && shapes[0].subpaths.length > 1)) return items;
  // The engine leaves out operands with no area (a straight line), so it would ignore one that empties the result.
  if (def.mode && emptyShapeModeReason(def.kind, shapes)) return [];
  const records = engineResult(def.op, shapes, [], { pending: info?.pending });
  if (records === undefined) return null;
  if (!records) return items;
  const out = [];
  if (def.mode) {
    const rec = records[0];
    if (rec?.subpaths.length) out.push({ style: owners[rec.owner]?.style || owners[owners.length - 1].style, subpaths: rec.subpaths, fillRule: 'nonzero' });
    return out;
  }
  for (const rec of records) {
    const owner = owners[rec.owner];
    if (!owner) continue;
    let style;
    if (def.kind === 'divide') style = owner.style;
    else if (def.kind === 'outline') style = { ...owner.style, fill: null, stroke: owner.style.fill || owner.style.stroke || null, strokeWidth: owner.style.strokeWidth > 0 ? owner.style.strokeWidth : 0.5, dash: [], arrowStart: null, arrowEnd: null };
    else {
      if (!owner.style.fill) continue;
      style = { ...owner.style, stroke: null };
    }
    out.push({ style, subpaths: rec.subpaths, fillRule: 'nonzero' });
  }
  return out;
}
