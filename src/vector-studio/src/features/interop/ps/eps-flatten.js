/**
 * Transparency for PostScript output: a copy of the document in which
 * every transparent object, together with the artwork under it that it
 * overlaps, is flattened (Object > Flatten Transparency with a flattener
 * preset's settings) into opaque shapes and clipped images. Artwork that
 * no transparency touches stays as it is.
 *
 *   flattenForOutput(doc, ids, flattenOpts, deps) -> { doc, ids, flattened, failed }
 */
import { VDocument } from '../../../model/document.js';
import { visualBounds } from '../../../model/geometry.js';
import { rasterEffects } from '../../../render/effects.js';
import { flattenSelection } from '../../effects/flatten.js';

const seeThrough = (p) => Boolean(p) && ((p.opacity ?? 1) < 1 || (p.stops || []).some((s) => (s.opacity ?? 1) < 1));

/** Whether a node itself needs flattening for opaque output. */
export function isTransparentNode(n) {
  if (!n || n.hidden) return false;
  if ((n.opacity ?? 1) < 1 || (n.blendMode && n.blendMode !== 'normal')) return true;
  if (n.opacityMask || n.knockout || rasterEffects(n)) return true;
  if (seeThrough(n.fill) || seeThrough(n.stroke)) return true;
  if (n.type === 'mesh' && (n.points || []).some((p) => (p.a ?? 1) < 1)) return true;
  // Items of an appearance stack.
  for (const it of n.appearance || []) {
    if (it.hidden) continue;
    if ((it.opacity ?? 1) < 1 || (it.blendMode && it.blendMode !== 'normal') || seeThrough(it.fill) || seeThrough(it.stroke)) return true;
    if ((it.effects || []).some((e) => e && !e.hidden && rasterEffects({ effects: [e] }))) return true;
  }
  return false;
}

/** Whether anything in a subtree needs flattening. */
export function hasTransparency(doc, id) {
  const n = doc.get(id);
  if (!n || n.hidden) return false;
  if (isTransparentNode(n)) return true;
  return (n.children || []).some((c) => hasTransparency(doc, c));
}

const overlaps = (a, b) => Boolean(a && b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const union = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The top-level items of an export: the given ids, or the children of the printable layers. */
function topItems(doc, ids) {
  if (ids?.length) return doc.sortByPaintOrder(ids.filter((id) => doc.get(id) && !doc.isHidden(id)));
  const out = [];
  for (const lid of doc.root.children) {
    const l = doc.get(lid);
    if (!l || l.hidden || l.template || l.print === false) continue;
    for (const c of l.children || []) if (!doc.get(c)?.hidden) out.push(c);
  }
  return out;
}

/**
 * Groups of items to flatten together: each transparent item with every
 * item painted before it that it overlaps (the backdrop it blends with),
 * merged while they overlap.
 */
export function transparencyClusters(doc, ids) {
  const items = topItems(doc, ids).map((id, order) => ({ id, order, box: visualBounds(doc, doc.get(id)), transparent: hasTransparency(doc, id) }));
  const clusters = [];
  const taken = new Set();
  for (const seed of items) {
    if (!seed.transparent || taken.has(seed.id)) continue;
    const members = new Set([seed.id]);
    let box = seed.box;
    let top = seed.order;
    for (let changed = true; changed; ) {
      changed = false;
      for (const it of items) {
        if (members.has(it.id) || taken.has(it.id) || !overlaps(it.box, box)) continue;
        // Backdrop under the cluster, or another transparent item over it.
        if (it.order < top || it.transparent) {
          members.add(it.id);
          box = union(box, it.box);
          top = Math.max(top, it.order);
          changed = true;
        }
      }
    }
    for (const id of members) taken.add(id);
    clusters.push(items.filter((it) => members.has(it.id)).map((it) => it.id));
  }
  return clusters;
}

/**
 * A flattened copy of the document. `ids` limits the output (null: the
 * whole page); the returned ids list what to write from the copy.
 */
export async function flattenForOutput(doc, ids, opts, deps = {}) {
  const clusters = transparencyClusters(doc, ids);
  if (!clusters.length) return { doc, ids, flattened: 0, failed: 0 };
  const copy = VDocument.fromJSON(doc.toJSON());
  let outIds = ids ? [...ids] : null;
  let flattened = 0;
  let failed = 0;
  for (const cluster of clusters) {
    let selection = cluster;
    const editor = { doc: copy, topSelection: () => selection, select: (next) => (selection = next) };
    let r;
    try {
      r = await flattenSelection(editor, opts, deps);
    } catch {
      r = { error: 'failed' };
    }
    if (r?.error || !r?.id) {
      failed++;
      continue;
    }
    flattened++;
    if (outIds) {
      const at = Math.min(...cluster.map((id) => outIds.indexOf(id)).filter((i) => i >= 0));
      outIds = outIds.filter((id) => !cluster.includes(id));
      outIds.splice(Number.isFinite(at) ? at : outIds.length, 0, r.id);
    }
  }
  return { doc: copy, ids: outIds, flattened, failed };
}
