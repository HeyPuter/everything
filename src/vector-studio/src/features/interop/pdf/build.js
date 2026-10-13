/**
 * The node builder for importers: collects nodes per layer and turns
 * clipping and soft-mask state into clip groups and opacity-masked groups.
 *
 * Interpreters keep a list of "wraps" in their graphics state (clip
 * entries and soft-mask entries, compared by identity) and call push(id,
 * wraps) for every object they produce. Consecutive objects under the same
 * wraps share one clip group; restoring the state closes it. Form-like
 * groups nest with beginGroup/endGroup.
 *
 * A clip entry: { type: 'clip', subpaths: [{ anchors, closed }], evenOdd }
 *            or { type: 'clip', text: node } (type used as a clipping path).
 * A soft-mask entry: { type: 'smask', art: { root, nodes }, clip, invert }.
 */
import { createPath, createCompound, createGroup, createLayer, LAYER_COLORS } from '../../../model/nodes.js';
import { nodeBounds, unionRect } from '../../../model/geometry.js';

export class Builder {
  constructor() {
    this.nodes = new Map();
    this.layers = [];
    this.layerByKey = new Map();
    this.layer = null;
    this.frames = [];
  }

  add(node) {
    this.nodes.set(node.id, node);
    return node.id;
  }

  /** The layer record for a key (created on first use, in order of appearance). */
  layerFor(key, name, { hidden = false, locked = false } = {}) {
    let rec = this.layerByKey.get(key);
    if (!rec) {
      rec = { key, name, hidden, locked, ids: [] };
      this.layerByKey.set(key, rec);
      this.layers.push(rec);
    }
    return rec;
  }

  /** Switch the target layer (only outside groups; open clip groups close). */
  setLayer(rec) {
    if (rec === this.layer) return;
    if (this.frames.some((f) => f.type === 'group')) return;
    this.closeAll();
    this.layer = rec;
  }

  ensureLayer() {
    if (!this.layer) this.layer = this.layerFor('default', 'Layer 1');
    return this.layer;
  }

  container() {
    return this.frames.length ? this.frames[this.frames.length - 1].ids : this.ensureLayer().ids;
  }

  sync(wraps) {
    let gi = -1;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].type === 'group') {
        gi = i;
        break;
      }
    }
    const base = gi >= 0 ? this.frames[gi].base : 0;
    let k = 0;
    while (gi + 1 + k < this.frames.length && base + k < wraps.length && this.frames[gi + 1 + k].entry === wraps[base + k]) k++;
    while (this.frames.length > gi + 1 + k) this.closeFrame();
    for (let j = base + k; j < wraps.length; j++) this.frames.push({ type: wraps[j].type, entry: wraps[j], ids: [] });
  }

  /** Add an object (already in `nodes`) under the given wraps. */
  push(id, wraps = []) {
    this.ensureLayer();
    this.sync(wraps);
    this.container().push(id);
  }

  beginGroup(wraps, extra = {}) {
    this.ensureLayer();
    this.sync(wraps);
    this.frames.push({ type: 'group', base: wraps.length, ids: [], extra });
  }

  /** Close the innermost group; returns its id (null when empty). */
  endGroup() {
    while (this.frames.length && this.frames[this.frames.length - 1].type !== 'group') this.closeFrame();
    const f = this.frames.pop();
    if (!f || !f.ids.length) return null;
    const g = createGroup(f.ids, f.extra);
    this.add(g);
    this.container().push(g.id);
    return g.id;
  }

  closeFrame() {
    const f = this.frames.pop();
    if (!f || !f.ids.length) return;
    let id = null;
    if (f.type === 'clip') {
      const mask = this.maskNode(f.entry);
      if (!mask) {
        this.container().push(...f.ids);
        return;
      }
      id = this.add(createGroup([...f.ids, mask], { clip: true }));
    } else if (f.type === 'smask') {
      const om = { art: f.entry.art, transform: [1, 0, 0, 1, 0, 0], clip: f.entry.clip !== false, invert: Boolean(f.entry.invert) };
      const single = f.ids.length === 1 ? this.nodes.get(f.ids[0]) : null;
      if (single && !single.opacityMask) {
        this.nodes.set(single.id, { ...single, opacityMask: om });
        id = single.id;
      } else id = this.add(createGroup(f.ids, { opacityMask: om }));
    } else {
      id = this.add(createGroup(f.ids, f.extra));
    }
    this.container().push(id);
  }

  closeAll() {
    while (this.frames.length) {
      if (this.frames[this.frames.length - 1].type === 'group') this.endGroup();
      else this.closeFrame();
    }
  }

  maskNode(entry) {
    if (entry.text) return this.add({ ...entry.text });
    const sps = entry.subpaths.filter((s) => s.anchors.length >= 2);
    if (!sps.length) {
      // An empty clip hides everything: a degenerate rectangle.
      const a = { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 };
      return this.add(createPath([a, { ...a }], true, { fill: null, stroke: null }));
    }
    if (sps.length === 1) return this.add(createPath(sps[0].anchors, true, { fill: null, stroke: null }, entry.evenOdd ? { fillRule: 'evenodd' } : {}));
    const kids = sps.map((s) => this.add(createPath(s.anchors, true, { fill: null, stroke: null })));
    return this.add(createCompound(kids, { fill: null, stroke: null }, { fillRule: entry.evenOdd ? 'evenodd' : 'nonzero' }));
  }

  /** Close everything and return { layers, nodes } with parents set and trivial wrappers removed. */
  finish() {
    this.closeAll();
    const shim = { get: (id) => this.nodes.get(id) };
    for (const l of this.layers) l.ids = simplifyList(this.nodes, shim, l.ids);
    const layers = this.layers.filter((l) => l.ids.length || l.key !== 'default');
    layers.forEach((l, i) => (l.color = LAYER_COLORS[i % LAYER_COLORS.length]));
    // Drop unreachable nodes and set parents.
    const out = new Map();
    const visit = (id, parent) => {
      const n = this.nodes.get(id);
      if (!n || out.has(id)) return;
      const { shadingFill, keep, ...rest } = n;
      out.set(id, { ...rest, parent });
      for (const c of n.children || []) visit(c, id);
    };
    for (const l of layers) for (const id of l.ids) visit(id, undefined);
    return { layers, nodes: out };
  }
}

export function makeLayerNode(rec, i) {
  const layer = createLayer(rec.name || `Layer ${i + 1}`, rec.color || LAYER_COLORS[i % LAYER_COLORS.length]);
  if (rec.hidden) layer.hidden = true;
  if (rec.locked) layer.locked = true;
  return layer;
}

const EPS = 0.01;

function rectAnchors(a) {
  if (a.length < 4 || a.length > 5) return null;
  if (a.some((p) => Math.abs(p.ix - p.x) > 1e-6 || Math.abs(p.iy - p.y) > 1e-6 || Math.abs(p.ox - p.x) > 1e-6 || Math.abs(p.oy - p.y) > 1e-6)) return null;
  const pts = a.length === 5 ? a.slice(0, 4) : a;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (!pts.every((p) => (Math.abs(p.x - x0) < EPS || Math.abs(p.x - x1) < EPS) && (Math.abs(p.y - y0) < EPS || Math.abs(p.y - y1) < EPS))) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const contains = (o, r) => r.x >= o.x - EPS && r.y >= o.y - EPS && r.x + r.w <= o.x + o.w + EPS && r.y + r.h <= o.y + o.h + EPS;

function sameGeometry(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (const k of ['x', 'y', 'ix', 'iy', 'ox', 'oy']) if (Math.abs(a[i][k] - b[i][k]) > EPS) return false;
  }
  return true;
}

/**
 * Remove wrappers that change nothing: clip groups whose rectangular clip
 * contains their content, clip groups around a single shading fill (the
 * clipping path takes the fill), and plain groups with one child.
 */
function simplifyList(nodes, shim, ids) {
  const out = [];
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n) continue;
    if (n.type !== 'group') {
      out.push(id);
      continue;
    }
    let kids = simplifyList(nodes, shim, n.children);
    let node = { ...n, children: kids };
    nodes.set(id, node);
    if (node.clip && kids.length >= 1) {
      const maskId = kids[kids.length - 1];
      const mask = nodes.get(maskId);
      const content = kids.slice(0, -1);
      if (!content.length) continue;
      // A shading painted inside a clipping path: the path takes the gradient.
      if (content.length === 1 && mask && (mask.type === 'path' || mask.type === 'compound')) {
        const only = nodes.get(content[0]);
        if (only?.shadingFill && !only.opacityMask) {
          nodes.set(maskId, { ...mask, fill: only.fill, opacity: only.opacity ?? 1, blendMode: only.blendMode || 'normal' });
          if (!hasOwnAppearance(node)) {
            out.push(maskId);
            continue;
          }
          node = { ...node, clip: false, children: [maskId] };
          nodes.set(id, node);
          out.push(id);
          continue;
        }
        // A clip that repeats the clipped path's own outline.
        if (only && only.type === 'path' && mask.type === 'path' && sameGeometry(only.anchors, mask.anchors) && !hasOwnAppearance(node)) {
          out.push(content[0]);
          continue;
        }
      }
      const r = mask && mask.type === 'path' ? rectAnchors(mask.anchors) : null;
      if (r) {
        let b = null;
        for (const c of content) b = unionRect(b, nodeBounds(shim, nodes.get(c)));
        if (!b || contains(r, b)) {
          if (!hasOwnAppearance(node)) {
            out.push(...content);
            continue;
          }
          node = { ...node, clip: false, children: content };
          nodes.set(id, node);
          kids = content;
        }
      }
    }
    if (!node.clip && kids.length === 1 && !hasOwnAppearance(node) && !node.keep) {
      out.push(kids[0]);
      continue;
    }
    if (!kids.length) continue;
    out.push(id);
  }
  return out;
}

function hasOwnAppearance(n) {
  return (n.opacity != null && n.opacity < 1) || (n.blendMode && n.blendMode !== 'normal') || Boolean(n.opacityMask) || Boolean(n.name) || n.isolate || n.knockout;
}

export { createPath, createCompound, createGroup };
