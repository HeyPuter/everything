/**
 * Symbols: reusable artwork stored once in the document and placed any
 * number of times as instances.
 *
 * Storage. Symbol definitions live in a detached store node (id
 * 'symbols', type 'symbols', no parent) that is not part of the page tree,
 * so doc.walk(), doc.leaves(), the Layers panel, hit testing, Select All
 * and the exporters never see master artwork. Each definition is a group
 * whose children are the master artwork, in master coordinates:
 *
 *   { id, type: 'group', name, children: [master ids], clip: false,
 *     symbolDef: { kind: 'dynamic' | 'static', reg: { x, y },
 *                  slice9: null | { x, y, w, h }, pixelAlign, source? } }
 *
 * `reg` is the registration point (placement and Reset Transformation
 * pivot) and `slice9` the center rectangle of the 9-slice scaling guides.
 * Everything is an ordinary node, so undo, saving and opening need nothing
 * special.
 *
 * Instances are leaf live artwork:
 *
 *   { id, type: 'instance', symbol: defId, transform, overrides?, tint?, style? }
 *
 * `transform` maps master coordinates to the page. Dynamic symbols accept
 * per-part `overrides` ({ [master node id]: { fill, stroke, strokeWidth,
 * opacity } }); `tint` ({ color, amount }) and `style` (a graphic style)
 * come from the Symbol Stainer and Styler and apply to every part.
 */
import { uid } from '../../lib/ids.js';
import { registerLive, liveArtwork, virtualId, virtualView, expandLive } from '../../model/live.js';
import { transformPatches, nodeBounds, unionRect, visualBounds } from '../../model/geometry.js';
import { STYLE_KEYS } from '../../model/nodes.js';
import { apply, multiply, translate, IDENTITY, invert } from '../../lib/matrix.js';
import { hexToRgb, rgbToHex } from '../../lib/color.js';
import { remapIdRefs } from '../../model/document.js';

export const STORE_ID = 'symbols';

// ---- store and definitions ----

export function isSymbolDef(node) {
  return Boolean(node && node.type === 'group' && node.symbolDef);
}

export function symbolStore(doc) {
  const s = doc.get(STORE_ID);
  return s && s.type === 'symbols' ? s : null;
}

/** The store node, created on first use (inside a transaction). */
export function ensureStore(doc) {
  const existing = symbolStore(doc);
  if (existing) return existing;
  // The document API inserts under a parent; the store hangs off nothing, so
  // insert it under the root and detach it again in the same transaction.
  doc.insert({ id: STORE_ID, type: 'symbols', children: [], editing: [] }, 'root');
  doc.update('root', { children: doc.root.children.filter((c) => c !== STORE_ID) });
  return doc.update(STORE_ID, { parent: null });
}

/** The stack of symbols being edited in place: [{ id, index, via }], innermost last. */
export function editingStack(doc) {
  return symbolStore(doc)?.editing || [];
}

/** Symbol definitions in panel order (a symbol being edited keeps its place). */
export function symbolDefs(doc) {
  const store = symbolStore(doc);
  if (!store) return [];
  const ids = store.children.slice();
  for (const e of store.editing || []) if (!ids.includes(e.id)) ids.splice(Math.min(e.index, ids.length), 0, e.id);
  const out = [];
  for (const id of ids) {
    const d = doc.get(id);
    if (isSymbolDef(d)) {
      out.push(d);
      symbolNames.set(d.id, d.name);
    }
  }
  return out;
}

export function getDef(doc, id) {
  const d = id ? doc.get(id) : null;
  return isSymbolDef(d) ? d : null;
}

/** Symbol names by id, for labels that only see the instance node (Layers panel). */
export const symbolNames = new Map();

/** Refresh the name index from a document. */
export function indexSymbolNames(doc) {
  symbolDefs(doc);
}

/** A name not used by another symbol: "Leaf", "Leaf 2", ... */
export function uniqueSymbolName(doc, name, exceptId = null) {
  const base = String(name || 'New Symbol').trim() || 'New Symbol';
  const used = new Set(symbolDefs(doc).filter((d) => d.id !== exceptId).map((d) => d.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const stem = base.replace(/\s+\d+$/, '');
  for (let i = 2; ; i++) if (!used.has(`${stem} ${i}`.toLowerCase())) return `${stem} ${i}`;
}

/** Every node of a definition's master artwork (not the definition itself). */
export function masterNodes(doc, def) {
  return def ? doc.descendants(def.id) : [];
}

/** Geometric bounds of a symbol's master artwork in master coordinates. */
export function masterBounds(doc, def, visual = false) {
  let b = null;
  for (const c of def?.children || []) {
    const n = doc.get(c);
    if (n && !n.hidden) b = unionRect(b, visual ? visualBounds(doc, n) : nodeBounds(doc, n));
  }
  return b;
}

/** Registration point for one of the nine positions ('tl' ... 'br', 'cc') of a rect. */
export function registrationPoint(b, pos = 'cc') {
  if (!b) return { x: 0, y: 0 };
  const fx = pos[1] === 'l' ? 0 : pos[1] === 'r' ? 1 : 0.5;
  const fy = pos[0] === 't' ? 0 : pos[0] === 'b' ? 1 : 0.5;
  return { x: b.x + b.w * fx, y: b.y + b.h * fy };
}

/** Default 9-slice guides: the middle third of the artwork. */
export function defaultSlice(b) {
  return { x: b.x + b.w / 3, y: b.y + b.h / 3, w: b.w / 3, h: b.h / 3 };
}

/**
 * Add a definition with the given master nodes (already built, with their
 * descendants) to the store. Returns the definition node.
 */
export function addDefinition(doc, { name, kind = 'dynamic', reg = null, slice9 = null, pixelAlign = false, source = undefined, index = Infinity } = {}) {
  ensureStore(doc);
  const def = {
    id: uid('y'),
    type: 'group',
    name: uniqueSymbolName(doc, name),
    children: [],
    clip: false,
    hidden: false,
    locked: false,
    symbolDef: { kind: kind === 'static' ? 'static' : 'dynamic', reg: reg || { x: 0, y: 0 }, slice9, pixelAlign: Boolean(pixelAlign), ...(source ? { source } : {}) },
  };
  const out = doc.insert(def, STORE_ID, index);
  symbolNames.set(out.id, out.name);
  return out;
}

export function updateDefinition(doc, id, patch) {
  const def = getDef(doc, id);
  if (!def) return null;
  const { name, ...rest } = patch;
  const next = { symbolDef: { ...def.symbolDef, ...rest } };
  if (name !== undefined) next.name = uniqueSymbolName(doc, name, id);
  const out = doc.update(id, next);
  symbolNames.set(id, out.name);
  return out;
}

// ---- instances ----

export function createInstance(symbolId, transform = IDENTITY, extra = {}) {
  return {
    id: uid('s'),
    type: 'instance',
    name: '',
    symbol: symbolId,
    transform: transform.slice(),
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    hidden: false,
    locked: false,
    ...extra,
  };
}

export function isInstance(node) {
  return node?.type === 'instance';
}

/** Every instance of a symbol (or of any symbol), on the page and inside other symbols. */
export function instancesOf(doc, symbolId = null) {
  const out = [];
  for (const n of doc.nodes.values()) if (n.type === 'instance' && (!symbolId || n.symbol === symbolId)) out.push(n);
  return out;
}

/** Is a node part of the page (under a layer), as opposed to stored master artwork? */
export function onPage(doc, id) {
  let n = doc.get(id);
  while (n) {
    if (n.type === 'layer') return true;
    if (n.type === 'symbols') return false;
    n = n.parent ? doc.get(n.parent) : null;
  }
  return false;
}

/** Symbols with no instances anywhere. */
export function unusedSymbols(doc) {
  const used = new Set(instancesOf(doc).map((n) => n.symbol));
  return symbolDefs(doc).filter((d) => !used.has(d.id));
}

/** Matrix placing a symbol's registration point at (x, y), snapped to whole points when the symbol asks for it. */
export function placementMatrix(doc, def, x, y) {
  const reg = def.symbolDef.reg;
  let tx = x - reg.x;
  let ty = y - reg.y;
  if (def.symbolDef.pixelAlign) {
    const b = masterBounds(doc, def);
    if (b) {
      tx = Math.round(b.x + tx) - b.x;
      ty = Math.round(b.y + ty) - b.y;
    }
  }
  return translate(tx, ty);
}

/** Insert an instance with its registration point at (x, y). */
export function placeInstance(doc, symbolId, parentId, x, y, index = Infinity) {
  const def = getDef(doc, symbolId);
  if (!def) return null;
  return doc.insert(createInstance(def.id, placementMatrix(doc, def, x, y)), parentId, index);
}

/** Where an instance's registration point is on the page. */
export function instanceRegPoint(doc, inst) {
  const def = getDef(doc, inst.symbol);
  const reg = def ? def.symbolDef.reg : { x: 0, y: 0 };
  return apply(inst.transform || IDENTITY, reg.x, reg.y);
}

/** Patch removing an instance's rotation, scale and skew, keeping its registration point in place. */
export function resetTransformPatch(doc, inst) {
  const def = getDef(doc, inst.symbol);
  if (!def) return null;
  const p = instanceRegPoint(doc, inst);
  const reg = def.symbolDef.reg;
  return { transform: [1, 0, 0, 1, p.x - reg.x, p.y - reg.y], frameAngle: undefined };
}

/** Patch pointing an instance at another symbol, registration points aligned. */
export function replacePatch(doc, inst, symbolId) {
  const from = getDef(doc, inst.symbol);
  const to = getDef(doc, symbolId);
  if (!to) return null;
  const a = from ? from.symbolDef.reg : to.symbolDef.reg;
  const b = to.symbolDef.reg;
  return { symbol: to.id, transform: multiply(inst.transform || IDENTITY, translate(a.x - b.x, a.y - b.y)), overrides: undefined };
}

/** Break the link: replace an instance with plain artwork (inside a transaction). Returns the new group. */
export function breakLink(doc, id) {
  const n = doc.get(id);
  if (!isInstance(n)) return null;
  const g = expandLive(doc, id);
  // A single expanded object needs no wrapping group.
  if (g && g.children.length === 1 && !(n.opacity < 1) && (n.blendMode || 'normal') === 'normal' && !(n.effects || []).length && !n.name) {
    const only = g.children[0];
    const parent = doc.get(g.parent);
    doc.move(only, g.parent, parent.children.indexOf(g.id));
    doc.remove(g.id);
    return doc.get(only);
  }
  return g;
}

// ---- generating instance artwork ----

/** Virtual node -> the master node id it was made from (Direct Selection of instance parts). */
export const masterOf = new WeakMap();
/** Virtual nested instance -> ids of the symbols it sits inside (stops recursive symbols). */
const ancestry = new WeakMap();

function hsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h / 6, s, l };
}

function hslHex({ h, s, l }) {
  if (!s) return rgbToHex({ r: l * 255, g: l * 255, b: l * 255 });
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex({ r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 });
}

/**
 * Stain a color toward a tint: the tint's hue and saturation at the
 * original's lightness (so shading survives), mixed in by `amount` (0..1).
 */
export function tintColor(hex, tint, amount) {
  if (!(amount > 0)) return hex;
  const a = hsl(hex);
  const t = hsl(tint);
  const target = hslHex({ h: t.h, s: t.s, l: a.l });
  const A = hexToRgb(hex);
  const B = hexToRgb(target);
  const k = Math.min(1, amount);
  return rgbToHex({ r: A.r + (B.r - A.r) * k, g: A.g + (B.g - A.g) * k, b: A.b + (B.b - A.b) * k });
}

function tintPaint(p, tint) {
  if (!p || !tint) return p;
  if (p.type === 'solid') return { ...p, color: tintColor(p.color, tint.color, tint.amount), swatchId: undefined };
  if (p.stops) return { ...p, stops: p.stops.map((s) => ({ ...s, color: tintColor(s.color, tint.color, tint.amount), swatchId: undefined })) };
  return p;
}

const PAINTED = new Set(['path', 'compound', 'text']);

/** A master node with the instance's overrides, style and tint applied (or the node itself). */
function styledPart(n, overrides, style, tint) {
  if (!PAINTED.has(n.type) && !(n.type === 'image' && overrides?.[n.id]?.opacity !== undefined)) return n;
  let out = n;
  if (style) out = { ...out, ...style };
  const o = overrides?.[n.id];
  if (o) out = { ...out, ...o };
  if (tint?.amount > 0 && out.type !== 'image') out = { ...out, fill: tintPaint(out.fill, tint), stroke: tintPaint(out.stroke, tint) };
  return out;
}

/**
 * 9-slice mapping for one axis: master coordinate v inside bounds
 * [b0, b1] with center band [g0, g1] under scale s. The outer bands keep
 * their size; the center band takes up the rest. When the outer bands do
 * not fit they shrink together and the center collapses.
 */
export function sliceAxis(v, b0, b1, g0, g1, s) {
  const W = (b1 - b0) * s;
  const L = Math.max(0, g0 - b0);
  const R = Math.max(0, b1 - g1);
  const C = g1 - g0;
  const base = b0 * s;
  if (L + R <= W && C > 1e-9) {
    const k = (W - L - R) / C;
    if (v <= g0) return base + (v - b0);
    if (v >= g1) return base + W - (b1 - v);
    return base + L + (v - g0) * k;
  }
  if (L + R <= 1e-9) return v * s;
  const f = Math.min(1, W / (L + R));
  if (v <= g0) return base + (v - b0) * f;
  if (v >= g1) return base + W - (b1 - v) * f;
  return base + L * f;
}

/**
 * The point mapping of a 9-slice instance, or null when plain scaling
 * gives the same result (no guides, no scale). Splits the transform into
 * a scale along the master axes, applied band by band, and the rest
 * (rotation, reflection, skew, move) applied as a matrix.
 */
export function sliceMapping(doc, def, M) {
  const g = def.symbolDef.slice9;
  if (!g) return null;
  const sx = Math.hypot(M[0], M[1]);
  const det = M[0] * M[3] - M[1] * M[2];
  const sy = sx ? Math.abs(det) / sx : 0;
  if (!(sx > 1e-9) || !(sy > 1e-9)) return null;
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return null;
  const b = masterBounds(doc, def);
  if (!b) return null;
  const R = [M[0] / sx, M[1] / sx, M[2] / sy, M[3] / sy, M[4], M[5]];
  const fn = (x, y) => apply(R, sliceAxis(x, b.x, b.x + b.w, g.x, g.x + g.w, sx), sliceAxis(y, b.y, b.y + b.h, g.y, g.y + g.h, sy));
  return { fn, R };
}

function mapAnchors(anchors, fn) {
  return anchors.map((a) => {
    const p = fn(a.x, a.y);
    const i = fn(a.ix, a.iy);
    const o = fn(a.ox, a.oy);
    return { ...a, x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
  });
}

function mapPaint(p, fn) {
  if (!p || p.x1 === undefined) return p;
  const a = fn(p.x1, p.y1);
  const b = fn(p.x2, p.y2);
  return { ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Patches mapping a master subtree through a 9-slice mapping. */
function slicePatches(sdoc, node, slice, out) {
  const { fn, R } = slice;
  switch (node.type) {
    case 'path':
      out.set(node.id, { anchors: mapAnchors(node.anchors, fn), shape: undefined, fill: mapPaint(node.fill, fn), stroke: mapPaint(node.stroke, fn) });
      break;
    case 'compound':
      out.set(node.id, { fill: mapPaint(node.fill, fn), stroke: mapPaint(node.stroke, fn) });
      for (const c of node.children) {
        const cn = sdoc.get(c);
        if (cn) out.set(cn.id, { anchors: mapAnchors(cn.anchors, fn), shape: undefined });
      }
      break;
    case 'group':
      for (const c of node.children) {
        const cn = sdoc.get(c);
        if (cn) slicePatches(sdoc, cn, slice, out);
      }
      break;
    default: {
      // Type, images and nested instances cannot be sliced: they move with
      // the slice their center falls in and keep their own scale.
      if (!node.transform) break;
      const b = nodeBounds(sdoc, node);
      const c = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: node.transform[4], y: node.transform[5] };
      const p = fn(c.x, c.y);
      const q = apply(R, c.x, c.y);
      out.set(node.id, { transform: multiply(translate(p.x - q.x, p.y - q.y), multiply(R, node.transform)) });
    }
  }
}

function collectSubtree(doc, id, out) {
  const n = doc.get(id);
  if (!n) return;
  out.push(n);
  if (n.children) for (const c of n.children) collectSubtree(doc, c, out);
}

/** Every node an instance's artwork depends on: its definition, the master and nested symbols. */
export function symbolDeps(doc, symbolId, out = [], seen = new Set()) {
  if (!symbolId || seen.has(symbolId)) return out;
  seen.add(symbolId);
  const def = getDef(doc, symbolId);
  if (!def) return out;
  const start = out.length;
  collectSubtree(doc, def.id, out);
  for (let i = start, n = out.length; i < n; i++) if (out[i].type === 'instance') symbolDeps(doc, out[i].symbol, out, seen);
  return out;
}

/** Generate an instance's artwork: copies of the master mapped onto the page. */
export function generateInstance(doc, inst) {
  const def = getDef(doc, inst.symbol);
  if (!def) return { items: [] };
  const inside = ancestry.get(inst) || [];
  // A symbol placed inside itself (directly or through others) draws once.
  if (inside.includes(def.id)) return { items: [] };
  const sd = def.symbolDef;
  const overrides = sd.kind === 'static' ? null : inst.overrides || null;
  const style = inst.style && Object.keys(inst.style).length ? pickKnownStyle(inst.style) : null;
  const tint = inst.tint?.amount > 0 && inst.tint.color ? inst.tint : null;
  const M = inst.transform || IDENTITY;

  // Master parts with the instance's own paint applied.
  const styled = new Map();
  if (overrides || style || tint) {
    const visit = (id) => {
      const n = doc.get(id);
      if (!n) return;
      const s = styledPart(n, overrides, style, tint);
      if (s !== n) styled.set(id, s);
      if (n.children) for (const c of n.children) visit(c);
    };
    for (const c of def.children) visit(c);
  }
  const sdoc = styled.size ? virtualView(doc, styled) : doc;

  const patches = new Map();
  const slice = sliceMapping(doc, def, M);
  for (const c of def.children) {
    const n = sdoc.get(c);
    if (!n) continue;
    if (slice) slicePatches(sdoc, n, slice, patches);
    else transformPatches(sdoc, n, M, { scaleStrokes: true, scaleCorners: true }, patches);
  }

  const extra = new Map();
  const chain = [...inside, def.id];
  const ids = new Map();
  const build = (id, parent) => {
    const n = sdoc.get(id);
    if (!n) return null;
    const vid = virtualId(id);
    ids.set(id, vid);
    let v = { ...n, ...patches.get(id), id: vid, parent };
    if (n.children) {
      v.children = n.children.map((c) => build(c, vid)).filter(Boolean);
      // Live parts that name their children (interlace zones, Objects on Path) name the copies.
      v = remapIdRefs(v, ids);
    }
    masterOf.set(v, id);
    if (v.type === 'instance') ancestry.set(v, chain);
    extra.set(vid, v);
    return vid;
  };
  const items = def.children.map((c) => build(c, inst.id)).filter(Boolean);
  return { items, extra };
}

function pickKnownStyle(style) {
  const out = {};
  for (const k of STYLE_KEYS) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

registerLive('instance', {
  test: (n) => n.type === 'instance',
  label: (n) => symbolNames.get(n.symbol) || '<Symbol>',
  generate: generateInstance,
  deps: (doc, n) => symbolDeps(doc, n.symbol),
});

/**
 * Symbol sets (made by the Symbol Sprayer): groups of instances the
 * symbolism tools work on together. They draw and select like groups; the
 * live kind gives them their label and lets Expand turn them into a plain
 * group of instances.
 */
registerLive('symbolSet', {
  label: '<Symbol Set>',
  generate: (doc, n) => ({ items: n.children.slice() }),
});

export function isSymbolSet(node) {
  return Boolean(node && node.type === 'group' && node.live?.kind === 'symbolSet');
}

export function createSymbolSet(children = []) {
  return { id: uid('g'), type: 'group', name: '', children, clip: false, hidden: false, locked: false, live: { kind: 'symbolSet' } };
}

/** Topmost generated part of an instance under a page point: { vnode, masterId } or null. */
export function instancePartAt(doc, inst, x, y, tol, hitNode) {
  const { items, vdoc } = liveArtwork(doc, inst);
  const visit = (n) => {
    if (!n || n.hidden) return null;
    if (n.type === 'group') {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const r = visit(vdoc.get(n.children[i]));
        if (r) return r;
      }
      return null;
    }
    return hitNode(vdoc, n, x, y, tol) ? n : null;
  };
  for (let i = items.length - 1; i >= 0; i--) {
    const v = visit(items[i]);
    if (v) return { vnode: v, masterId: masterOf.get(v) || null, vdoc };
  }
  return null;
}

/** Generated artwork of an instance by master id (for outlining selected parts). */
export function instancePartNodes(doc, inst, masterIds) {
  const { items, vdoc } = liveArtwork(doc, inst);
  const want = new Set(masterIds);
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (want.has(masterOf.get(n))) out.push(n);
    else if (n.children && n.type !== 'compound') for (const c of n.children) visit(vdoc.get(c));
  };
  for (const n of items) visit(n);
  return { nodes: out, vdoc };
}

// ---- making symbols ----

/**
 * Turn page objects into a new symbol (inside a transaction): the objects
 * move into the definition unchanged, so the master keeps their
 * coordinates, and an instance with an identity transform takes their
 * place (unless `replace` is false, when they are copied instead).
 * Returns { def, instance }.
 */
export function createSymbolFrom(doc, ids, opts = {}) {
  const { name = 'New Symbol', kind = 'dynamic', registration = 'cc', slice9 = false, pixelAlign = false, replace = true } = opts;
  const sorted = doc.sortByPaintOrder(ids).filter((id) => doc.has(id));
  if (!sorted.length) return null;
  let b = null;
  for (const id of sorted) b = unionRect(b, nodeBounds(doc, doc.get(id)));
  const def = addDefinition(doc, { name, kind, reg: registrationPoint(b, registration), slice9: slice9 && b ? defaultSlice(b) : null, pixelAlign });
  const top = doc.get(sorted[sorted.length - 1]);
  const parent = doc.get(top.parent);
  let instance = null;
  if (replace) {
    instance = doc.insert(createInstance(def.id), top.parent, parent.children.indexOf(top.id) + 1);
    for (const id of sorted) doc.move(id, def.id);
  } else {
    for (const id of sorted) doc.importSubtree(doc.exportSubtree(id), def.id);
  }
  return { def: doc.get(def.id), instance };
}

/**
 * Replace a symbol's master with copies of other objects (Redefine
 * Symbol). The new artwork is centered on the registration point, so
 * instances keep their place. The objects themselves stay on the page.
 */
export function redefineSymbol(doc, symbolId, ids) {
  const def = getDef(doc, symbolId);
  if (!def) return null;
  const sorted = doc.sortByPaintOrder(ids).filter((id) => doc.has(id) && id !== symbolId && !doc.isAncestor(symbolId, id));
  if (!sorted.length) return null;
  let b = null;
  for (const id of sorted) b = unionRect(b, nodeBounds(doc, doc.get(id)));
  for (const c of [...def.children]) doc.remove(c);
  const reg = def.symbolDef.reg;
  const dx = b ? reg.x - (b.x + b.w / 2) : 0;
  const dy = b ? reg.y - (b.y + b.h / 2) : 0;
  const patches = new Map();
  for (const id of sorted) {
    const copy = doc.importSubtree(doc.exportSubtree(id), def.id);
    if (dx || dy) transformPatches(doc, copy, translate(dx, dy), {}, patches);
  }
  for (const [id, p] of patches) doc.update(id, p);
  const moved = b ? { ...b, x: b.x + dx, y: b.y + dy } : null;
  updateDefinition(doc, def.id, { slice9: def.symbolDef.slice9 && moved ? defaultSlice(moved) : null });
  // Overrides named parts of the old master.
  for (const inst of instancesOf(doc, symbolId)) if (inst.overrides) doc.update(inst.id, { overrides: undefined });
  return doc.get(def.id);
}

/** Copy a definition (Duplicate Symbol). */
export function duplicateSymbol(doc, symbolId) {
  const def = getDef(doc, symbolId);
  if (!def) return null;
  const store = symbolStore(doc);
  const at = store.children.indexOf(def.id);
  const copy = addDefinition(doc, { ...def.symbolDef, name: `${def.name} copy`, source: undefined, index: at < 0 ? Infinity : at + 1 });
  for (const c of def.children) doc.importSubtree(doc.exportSubtree(c), copy.id);
  return doc.get(copy.id);
}

/**
 * Delete symbols (inside a transaction). Instances are expanded into plain
 * artwork (`instances: 'expand'`) or removed (`'delete'`).
 */
export function deleteSymbols(doc, symbolIds, { instances = 'expand' } = {}) {
  const set = new Set(symbolIds);
  for (const inst of instancesOf(doc)) {
    if (!set.has(inst.symbol) || !doc.has(inst.id)) continue;
    // Instances inside a symbol that is itself going away go with it.
    if (!onPage(doc, inst.id) && [...set].some((s) => doc.isAncestor(s, inst.id))) continue;
    if (instances === 'delete') doc.remove(inst.id);
    else breakLink(doc, inst.id);
  }
  for (const id of set) if (getDef(doc, id)) doc.remove(id);
}

/** Sort the symbols by name. */
export function sortSymbolsByName(doc) {
  const store = symbolStore(doc);
  if (!store) return;
  const order = [...store.children].sort((a, b) => (doc.get(a)?.name || '').localeCompare(doc.get(b)?.name || '', undefined, { numeric: true, sensitivity: 'base' }));
  doc.update(STORE_ID, { children: order });
}

// ---- copying symbols between documents ----

/** Definitions (as exportSubtree() subtrees) that some nodes need, nested symbols included. */
export function exportSymbolsFor(doc, nodes) {
  const ids = new Set();
  const visit = (sid) => {
    if (!sid || ids.has(sid)) return;
    const def = getDef(doc, sid);
    if (!def) return;
    ids.add(sid);
    for (const n of doc.descendants(def.id)) if (n.type === 'instance') visit(n.symbol);
  };
  for (const n of nodes) if (n?.type === 'instance') visit(n.symbol);
  return [...ids].map((id) => doc.exportSubtree(id));
}

/** The document's copy of a symbol from another document (same symbol or same origin), or null. */
function matchingSymbol(doc, src) {
  const direct = getDef(doc, src.id);
  if (direct) return direct;
  const origin = src.symbolDef.origin || src.id;
  return symbolDefs(doc).find((d) => d.id === origin || (d.symbolDef.origin || d.id) === origin) || null;
}

/**
 * Master parts of an incoming definition matched to the document's copy by
 * position (instance overrides are keyed by part id, and a copied master's
 * parts have other ids): incoming part id -> document part id.
 */
function matchParts(sub, doc, defId) {
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const out = new Map();
  const walk = (sid, did) => {
    const a = byId.get(sid);
    const b = doc.get(did);
    if (!a || !b || a.type !== b.type) return;
    if (sid !== did) out.set(sid, did);
    if (a.children && b.children) a.children.forEach((c, i) => b.children[i] && walk(c, b.children[i]));
  };
  walk(sub.root, defId);
  return out;
}

/** An instance's overrides keyed by the part ids of the document's copy of its symbol. */
function remapOverrides(overrides, parts) {
  if (!overrides || !parts?.size) return overrides;
  return Object.fromEntries(Object.entries(overrides).map(([k, v]) => [parts.get(k) || k, v]));
}

/**
 * Make sure a document has the definitions some pasted nodes refer to
 * (inside a transaction). Symbols the document already has are reused;
 * others are added, renamed when their name is taken. Returns a map from
 * the incoming symbol ids to the ids to use; its `parts` maps each incoming
 * symbol's part ids to the document's (see remapInstances).
 */
export function importSymbols(doc, subtrees = []) {
  const map = new Map();
  map.parts = new Map();
  const added = [];
  for (const sub of subtrees) {
    const src = sub.nodes[0];
    const same = matchingSymbol(doc, src);
    if (same) {
      map.set(src.id, same.id);
      map.parts.set(src.id, matchParts(sub, doc, same.id));
      continue;
    }
    ensureStore(doc);
    // `origin` remembers where a copied symbol came from, so pasting it again (or back) reuses it.
    const origin = src.symbolDef.origin || src.id;
    const node = doc.importSubtree({ root: sub.root, nodes: [{ ...src, name: uniqueSymbolName(doc, src.name), symbolDef: { ...src.symbolDef, origin } }, ...sub.nodes.slice(1)] }, STORE_ID);
    symbolNames.set(node.id, node.name);
    map.set(src.id, node.id);
    map.parts.set(src.id, matchParts(sub, doc, node.id));
    added.push(node.id);
  }
  // Nested instances inside the added masters point at the new ids (and parts) too.
  for (const id of added) {
    for (const n of doc.descendants(id)) {
      if (n.type !== 'instance' || !map.has(n.symbol)) continue;
      const parts = map.parts.get(n.symbol);
      if (map.get(n.symbol) !== n.symbol || (n.overrides && parts.size)) doc.update(n.id, { symbol: map.get(n.symbol), overrides: remapOverrides(n.overrides, parts) });
    }
  }
  return map;
}

/** Subtree nodes with their instances pointing through an id map (and their overrides through its parts). */
export function remapInstances(nodes, map) {
  if (!map.size) return nodes;
  return nodes.map((n) => {
    if (n.type !== 'instance' || !map.has(n.symbol)) return n;
    const parts = map.parts?.get(n.symbol);
    if (map.get(n.symbol) === n.symbol && !(n.overrides && parts?.size)) return n;
    return { ...n, symbol: map.get(n.symbol), overrides: remapOverrides(n.overrides, parts) };
  });
}

// ---- moving master artwork (editing in place) ----

/**
 * Move a symbol's master by (dx, dy) without changing how anything looks:
 * every instance's transform absorbs the opposite move (inside a transaction).
 */
export function rebaseSymbol(doc, symbolId, dx, dy) {
  const def = getDef(doc, symbolId);
  if (!def || (!dx && !dy)) return;
  const T = translate(dx, dy);
  const patches = new Map();
  for (const c of def.children) {
    const n = doc.get(c);
    if (n) transformPatches(doc, n, T, {}, patches);
  }
  for (const [id, p] of patches) doc.update(id, p);
  const sd = def.symbolDef;
  doc.update(def.id, {
    symbolDef: {
      ...sd,
      reg: { x: sd.reg.x + dx, y: sd.reg.y + dy },
      slice9: sd.slice9 ? { ...sd.slice9, x: sd.slice9.x + dx, y: sd.slice9.y + dy } : sd.slice9,
    },
  });
  const back = translate(-dx, -dy);
  for (const inst of instancesOf(doc, symbolId)) doc.update(inst.id, { transform: multiply(inst.transform || IDENTITY, back) });
}

/** Page point -> master point for an instance. */
export function toMaster(inst, x, y) {
  return apply(invert(inst.transform || IDENTITY), x, y);
}
