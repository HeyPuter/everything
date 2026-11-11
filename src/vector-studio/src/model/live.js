/**
 * Live artwork: objects whose drawn result is generated from their own
 * contents and parameters, so editing the source updates the result
 * (blends, repeats, envelopes, symbol instances, graphs, ...).
 *
 * A feature module registers a kind:
 *
 *   registerLive('repeat', {
 *     label: '<Repeat>',                    Layers panel label when unnamed
 *     test(node) -> bool,                   optional; default node.live?.kind === key
 *     generate(doc, node) -> { items, extra }
 *     deps(doc, node) -> [nodes],           optional: other nodes the result reads
 *     transformParams(node, m, opts) -> patch | null
 *                                           optional: keep parameters (centers,
 *                                           mesh points) in step when the object
 *                                           is moved, scaled or rotated
 *     bounds: 'source'                      optional: geometric bounds (the
 *                                           selection box) come from the source
 *                                           (children, or a path's own anchors)
 *                                           instead of the result
 *     expand(doc, node) -> node             optional: custom Object > Expand
 *                                           (inside a transaction); default
 *                                           replaces the node by a group of
 *                                           its generated artwork
 *     ownSpace: true                        optional: the children are stored in
 *                                           their own coordinate space, not where
 *                                           they draw (objects in perspective):
 *                                           outlines, snapping and marquee
 *                                           selection treat the object as a whole
 *     transform(doc, node, m, opts) -> { patch, matrix } | null
 *                                           optional, with ownSpace: map a document
 *                                           transform into that space; the node gets
 *                                           `patch`, its children `matrix`
 *     highlight: 'bounds'                   optional: the selection highlight
 *                                           outlines the object's box instead of
 *                                           its source children
 *     expandNode(node) -> node              optional: the node to generate from
 *                                           for Expand (e.g. without a display-only
 *                                           view mode)
 *     draw(ctx, doc, node, opts)            optional: canvas renderer replacing
 *                                           the generated artwork (gradient meshes)
 *     expandArtwork(doc, node) -> { items, extra }
 *                                           optional: artwork for Object > Expand
 *                                           when it differs from `generate`
 *     exportSelf: true                      optional: the exporters write the
 *                                           node itself (io/hooks.js exportWriters)
 *     first: true                           optional: tried before kinds without
 *                                           it, for effects that take over the
 *                                           whole object (3D)
 *   })
 *
 * Paths and compound paths can be live too (a brush stroke, a variable
 * width stroke): their generated artwork draws instead of the object, which
 * keeps its anchors for editing. In outline mode they draw their own
 * outline, and they stay clickable on it.
 *
 * `generate` returns the artwork in paint order: `items` lists child ids of
 * the node (drawn as themselves) and/or virtual node objects. Virtual nodes
 * with children list ids that resolve through `extra` (id -> virtual node).
 * Virtual ids come from virtualId() so they never collide with document ids.
 * A virtual node may name the document object it was made from in `source`;
 * clicking it then selects that object.
 *
 * Results are cached per node object and reused until the node, anything in
 * its subtree or one of its deps is replaced (nodes are immutable).
 *
 * Every consumer goes through this module: the canvas renderer, bounds, hit
 * testing, the exporters (via exportView) and Object > Expand.
 */

import { isGeomEffectType } from './geom-effects.js';

const KINDS = new Map();
// liveDef per node, keyed by id and checked by identity (nodes are immutable): a
// WeakMap keyed by node objects made every garbage collection slower, since
// each edit replaces node objects. Entries are reused in place; the cache is
// dropped when the kinds change or it outgrows any document.
let defCache = new Map();
const DEF_CACHE_LIMIT = 1 << 18;

export function registerLive(key, def) {
  defCache = new Map();
  KINDS.set(key, { key, ...def });
  // Keep the `first` kinds ahead of the others in test order.
  if (def.first) {
    for (const [k, d] of [...KINDS]) {
      if (d.first) continue;
      KINDS.delete(k);
      KINDS.set(k, d);
    }
  }
}

export function liveKinds() {
  return [...KINDS.values()];
}

/** The live kind definition for a node, or null for ordinary artwork. */
export function liveDef(node) {
  if (!node || node.type === 'root' || node.type === 'layer') return null;
  // Rendering, bounds and hit testing ask for every object, often several times: test the kinds once.
  const id = node.id;
  if (id === undefined) return findLiveDef(node);
  const e = defCache.get(id);
  if (e !== undefined) {
    if (e.node !== node) {
      e.node = node;
      e.def = findLiveDef(node);
    }
    return e.def;
  }
  if (defCache.size >= DEF_CACHE_LIMIT) defCache.clear();
  const d = findLiveDef(node);
  defCache.set(id, { node, def: d });
  return d;
}

function findLiveDef(node) {
  if (node.live?.kind) {
    const d = KINDS.get(node.live.kind);
    if (d && (!d.test || d.test(node))) return d;
  }
  for (const d of KINDS.values()) if (d.test && d.test(node)) return d;
  return null;
}

export function isLive(node) {
  return Boolean(liveDef(node));
}

let vid = 0;
/** A fresh id for a virtual (generated) node. */
export function virtualId(base = 'v') {
  return `${base}~${(++vid).toString(36)}`;
}

/** True for ids made by virtualId(). */
export function isVirtualId(id) {
  return typeof id === 'string' && id.includes('~');
}

/** A doc-like view resolving virtual nodes from `extra` before the document. */
export function virtualView(doc, extra) {
  if (!extra || !extra.size) return doc;
  return {
    get: (id) => extra.get(id) || doc.get(id),
    has: (id) => extra.has(id) || doc.has(id),
    assets: doc.assets,
    root: doc.root,
    name: doc.name,
    artboards: doc.artboards,
    walk: doc.walk ? (fn) => doc.walk(fn) : undefined,
  };
}

function subtreeInto(doc, id, out) {
  const n = doc.get(id);
  if (!n) return;
  out.push(n);
  if (n.children) for (const c of n.children) subtreeInto(doc, c, out);
}

const cache = new WeakMap();
const EMPTY = Object.freeze({ items: Object.freeze([]), vdoc: null, extra: new Map() });

/**
 * The generated artwork of a live node: { items: [node objects in paint
 * order], vdoc: doc view resolving virtual descendants, extra }. Returns an
 * empty result for nodes that are not live or fail to generate.
 */
export function liveArtwork(doc, node) {
  const def = liveDef(node);
  if (!def) return EMPTY;
  const snap = [];
  if (node.children) for (const c of node.children) subtreeInto(doc, c, snap);
  if (def.deps) {
    try {
      for (const d of def.deps(doc, node) || []) if (d) snap.push(d);
    } catch {
      // A missing dependency regenerates every time; generate() reports it.
    }
  }
  const hit = cache.get(node);
  if (hit && hit.doc === doc && hit.snap.length === snap.length && hit.snap.every((n, i) => n === snap[i])) return hit.result;
  let result;
  try {
    const g = def.generate(doc, node) || {};
    const extra = g.extra instanceof Map ? g.extra : new Map();
    const vdoc = virtualView(doc, extra);
    const items = [];
    for (const it of g.items || []) {
      const n = typeof it === 'string' ? vdoc.get(it) : it;
      if (n) items.push(n);
    }
    result = { items, vdoc, extra };
  } catch (err) {
    console.warn(`Live ${def.key} failed to generate`, err);
    result = { items: [], vdoc: doc, extra: new Map() };
  }
  // Results generated against a temporary view (exports) are not kept for the editor.
  cache.set(node, { doc, snap, result });
  return result;
}

function resolveGenerated(doc, g) {
  const extra = g?.extra instanceof Map ? g.extra : new Map();
  const vdoc = virtualView(doc, extra);
  const items = [];
  for (const it of g?.items || []) {
    const n = typeof it === 'string' ? vdoc.get(it) : it;
    if (n) items.push(n);
  }
  return { items, vdoc, extra };
}

/**
 * Real nodes for Object > Expand: a subtree { root, nodes } (document ids
 * for kept source objects, virtual ids for generated ones) ready for
 * VDocument.importSubtree, which gives everything fresh ids. The root is a
 * plain group keeping the live object's name, opacity, blending and
 * raster effects.
 */
export function liveExpansion(doc, node) {
  const def = liveDef(node);
  const target = def?.expandNode ? def.expandNode(node) : node;
  const { items, vdoc } = def?.expandArtwork ? resolveGenerated(doc, def.expandArtwork(doc, target)) : liveArtwork(doc, target);
  const nodes = [];
  const collect = (n, parent) => {
    const { source, ...plain } = n;
    const out = { ...plain, parent };
    nodes.push(out);
    if (n.children) {
      out.children = [];
      for (const c of n.children) {
        const cn = vdoc.get(c);
        if (!cn) continue;
        out.children.push(cn.id);
        collect(cn, n.id);
      }
    }
  };
  const rootId = virtualId(node.id);
  const root = {
    id: rootId,
    type: 'group',
    name: node.name || '',
    children: items.map((n) => n.id),
    clip: false,
    hidden: false,
    locked: false,
  };
  for (const k of ['opacity', 'blendMode', 'isolate', 'knockout']) if (node[k] !== undefined) root[k] = node[k];
  // Geometry effects are part of the generated artwork already; raster effects stay live.
  const effects = (node.effects || []).filter((e) => !isGeomEffectType(e.type));
  if (effects.length) root.effects = effects;
  nodes.push(root);
  for (const n of items) collect(n, rootId);
  return { root: rootId, nodes };
}

/** Replace a live node by its expanded artwork (inside a transaction). Returns the new group. */
export function expandLive(doc, id) {
  const node = doc.get(id);
  const def = liveDef(node);
  if (!def) return null;
  if (def.expand) return def.expand(doc, node);
  const sub = liveExpansion(doc, node);
  const parent = doc.get(node.parent);
  const index = parent ? parent.children.indexOf(id) : Infinity;
  doc.remove(id);
  return doc.importSubtree(sub, node.parent, index);
}
