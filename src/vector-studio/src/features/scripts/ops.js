/**
 * Path operations for scripts: the Pathfinder, Offset Path and Outline
 * Stroke commands run on given objects with given settings, without their
 * dialogs or the selection. Each takes object ids and returns the ids of
 * the objects it made.
 */
import { runGeom } from '../geometry/engine/index.js';
import {
  ALL_KINDS,
  shapesFor,
  buildResults,
  emptyShapeModeReason,
  pathfinderOptions,
} from '../geometry/pathfinder.js';
import {
  geometryLeaves,
  replaceWith,
  insertionPoint,
  snapshot,
  unchangedSince,
  visibleShapes,
  withMasks,
} from '../geometry/nodes-io.js';
import { offsetRecords, insertOffsets, outlineStrokeNodes } from '../geometry/path-ops.js';

export const PATHFINDER_KINDS = ALL_KINDS.map((k) => k.kind);

const JOINS = ['miter', 'round', 'bevel'];

const changedMeanwhile = (what) =>
  new Error(`${what} was canceled because the artwork changed while it ran.`);

/**
 * Paths and compound paths of the given objects (groups give their
 * contents), back to front. The clipping path of a clipping group given as
 * a whole is not one of them; `clipped` maps each clipped path to the
 * clipping paths over it.
 */
function pathsOf(doc, ids, clipped = new Map()) {
  return geometryLeaves(doc, ids, { skipLocked: false, intoLive: false, clipped });
}

/**
 * A Pathfinder operation (`kind` from PATHFINDER_KINDS) on the paths of
 * `ids`. Results replace the operands, as from the Pathfinder panel; shape
 * modes give one object, the others one group. `commit(fn)` makes the
 * document change. Options: precision (points), removeRedundant,
 * removeUnpainted (default to the Pathfinder Options).
 */
export async function pathfinderOn(doc, kind, ids, opts, commit) {
  const def = ALL_KINDS.find((k) => k.kind === kind);
  if (!def)
    throw new Error(`Unknown pathfinder "${kind}". Use one of: ${PATHFINDER_KINDS.join(', ')}.`);
  const o = { ...pathfinderOptions, ...opts };
  const clipped = new Map();
  const leaves = pathsOf(doc, ids, clipped);
  const oneCompound = leaves.length === 1 && leaves[0].type === 'compound';
  const single = kind === 'unite' || kind === 'divide' || kind === 'outline';
  if (leaves.length < 2 && !(single && oneCompound)) {
    throw new Error(`${def.label} needs two or more paths${single ? ', or a compound path' : ''}.`);
  }
  const snap = snapshot(doc, withMasks(doc, leaves, clipped));
  const tol = { tol: o.precision };
  // Clipped objects take part with what they show (as from the Pathfinder panel).
  const all = await visibleShapes(doc, leaves, shapesFor(doc, kind, leaves), clipped, tol);
  const used = leaves.filter((_, i) => all[i]);
  const shapes = all.filter(Boolean);
  if (!shapes.length || emptyShapeModeReason(kind, shapes)) return [];
  if (shapes.length < 2 && shapes.length < leaves.length && !single) return [];
  const records = await runGeom(def.op, shapes, [], tol);
  if (!unchangedSince(doc, snap)) throw changedMeanwhile(def.label);
  const items = buildResults(kind, used, records, o);
  if (!items.length) return [];
  return commit(() => replaceWith(doc, leaves, items, insertionPoint(doc, leaves, clipped)));
}

/**
 * Offset Path on the paths of `ids` by `offset` points (negative insets);
 * each result goes above its path (below for a negative offset), which
 * stays. Options: joins ('miter' | 'round' | 'bevel'), miterLimit.
 */
export async function offsetOn(doc, ids, { offset, joins = 'miter', miterLimit = 4 }, commit) {
  if (!JOINS.includes(joins)) throw new Error(`"joins" must be one of: ${JOINS.join(', ')}.`);
  const nodes = pathsOf(doc, ids);
  if (!nodes.length) return [];
  const v = { offset, joins, miter: miterLimit };
  const snap = snapshot(doc, nodes);
  const records = await offsetRecords(doc, nodes, v);
  if (!unchangedSince(doc, snap)) throw changedMeanwhile('Offset Path');
  return commit(() => insertOffsets(doc, nodes, v, records));
}

/** Outline Stroke on the stroked paths of `ids`: each becomes a filled shape (a group with its fill). */
export async function outlineStrokeOn(app, doc, ids, { keepFill = true } = {}, commit) {
  const nodes = pathsOf(doc, ids).filter((n) => n.stroke && n.strokeWidth > 0);
  if (!nodes.length) return [];
  const out = await outlineStrokeNodes(app, doc, nodes, { expandFill: keepFill, commit });
  if (!out) throw changedMeanwhile('Outline Stroke');
  return out;
}
