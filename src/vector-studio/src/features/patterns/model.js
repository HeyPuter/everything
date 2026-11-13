/**
 * Pattern swatches: definitions, tiling geometry and the pattern art view.
 *
 * A pattern definition lives in doc.root.patterns (undoable like every root
 * edit) and a swatch in doc.root.swatches refers to it by paint:
 *
 *   { id, name,
 *     tileType   'grid' | 'brickRow' | 'brickColumn' | 'hexColumn' | 'hexRow'
 *     brickOffset  fraction of a tile that each brick row (column) shifts: '1/2', '1/3', ...
 *     width, height   the tile (pattern units, the tile's top-left is 0,0)
 *     hSpacing, vSpacing  gaps added around the art when the tile is sized to it
 *     sizeToArt, moveWithArt, overlapH 'left'|'right', overlapV 'top'|'bottom'
 *     art { roots: [ids], nodes: [nodes] }   the tile artwork in pattern units }
 *
 * A pattern paint is { type: 'pattern', id, transform? } where `transform`
 * maps pattern units to document space (identity aligns the tiles with the
 * document origin). Objects use it like any other fill or stroke paint.
 *
 * Tiles repeat on a lattice spanned by two vectors (brick and hex layouts
 * shift every other row or column). For drawing and export the lattice is
 * reduced to a rectangular `cell` that repeats on a plain grid, holding all
 * the copies (and parts of copies) that fall inside it.
 */
import { uid } from '../../lib/ids.js';
import { stackPaints } from '../../model/appearance.js';
import { nodeBounds, visualBounds, unionRect } from '../../model/geometry.js';

export const TILE_TYPES = [
  { value: 'grid', label: 'Grid' },
  { value: 'brickRow', label: 'Brick by Row' },
  { value: 'brickColumn', label: 'Brick by Column' },
  { value: 'hexColumn', label: 'Hex by Column' },
  { value: 'hexRow', label: 'Hex by Row' },
];

export const BRICK_OFFSETS = ['1/2', '1/3', '2/3', '1/4', '3/4', '1/5', '2/5', '3/5', '4/5'];

export const COPIES = ['3x3', '5x5', '7x7', '9x9', '11x11', '1x3', '3x1'];

export const PATTERN_DEFAULTS = Object.freeze({
  name: 'New Pattern',
  tileType: 'grid',
  brickOffset: '1/2',
  width: 72,
  height: 72,
  hSpacing: 0,
  vSpacing: 0,
  sizeToArt: false,
  moveWithArt: true,
  overlapH: 'left',
  overlapV: 'top',
});

/** Options the Pattern Options panel edits (everything but the art). */
export const OPTION_KEYS = Object.keys(PATTERN_DEFAULTS);

export function patternsOf(doc) {
  return doc.root.patterns || [];
}

export function findPattern(doc, id) {
  return patternsOf(doc).find((p) => p.id === id) || null;
}

export function newPatternId() {
  return uid('pat');
}

/** Add a definition (inside a transaction). Returns it. */
export function addPattern(doc, def) {
  const out = { ...PATTERN_DEFAULTS, ...def, id: def.id || newPatternId() };
  doc.updateRoot({ patterns: [...patternsOf(doc).filter((p) => p.id !== out.id), out] });
  return out;
}

export function updatePattern(doc, id, patch) {
  doc.updateRoot({ patterns: patternsOf(doc).map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}

export function removePattern(doc, id) {
  doc.updateRoot({ patterns: patternsOf(doc).filter((p) => p.id !== id) });
}

/** Parse '2/3' into 2/3 (1/2 for anything unusable). */
export function fraction(s) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(s ?? ''));
  if (!m || +m[2] === 0 || +m[1] <= 0 || +m[1] >= +m[2]) return { p: 1, q: 2, v: 0.5 };
  return { p: +m[1], q: +m[2], v: +m[1] / +m[2] };
}

/**
 * The tiling lattice of a definition: basis vectors a, b (pattern units)
 * and the rectangular cell { x, y, w, h } that repeats on a plain grid.
 */
export function lattice(def) {
  const W = Math.max(1e-3, def.width || 1);
  const H = Math.max(1e-3, def.height || 1);
  const f = fraction(def.brickOffset);
  switch (def.tileType) {
    case 'brickRow':
      return { a: [W, 0], b: [f.v * W, H], cell: { x: 0, y: 0, w: W, h: f.q * H } };
    case 'brickColumn':
      return { a: [W, f.v * H], b: [0, H], cell: { x: 0, y: 0, w: f.q * W, h: H } };
    case 'hexColumn':
      // Flat-topped hexagons: columns 3/4 of a tile apart, every other one half a tile down.
      return { a: [0.75 * W, H / 2], b: [0, H], cell: { x: 0, y: 0, w: 1.5 * W, h: H } };
    case 'hexRow':
      return { a: [W, 0], b: [W / 2, 0.75 * H], cell: { x: 0, y: 0, w: W, h: 1.5 * H } };
    default:
      return { a: [W, 0], b: [0, H], cell: { x: 0, y: 0, w: W, h: H } };
  }
}

/** Tile outline (pattern units): a rectangle, or a hexagon for hex tiles. */
export function tileOutline(def) {
  const W = def.width || 1;
  const H = def.height || 1;
  if (def.tileType === 'hexColumn') return [[0, H / 2], [W / 4, 0], [(3 * W) / 4, 0], [W, H / 2], [(3 * W) / 4, H], [W / 4, H]];
  if (def.tileType === 'hexRow') return [[W / 2, 0], [W, H / 4], [W, (3 * H) / 4], [W / 2, H], [0, (3 * H) / 4], [0, H / 4]];
  return [[0, 0], [W, 0], [W, H], [0, H]];
}

/**
 * Paint order for overlapping copies: later copies draw on top, so with
 * "left in front" copies further left come later, and likewise for rows.
 */
export function overlapOrder(def) {
  const sx = def.overlapH === 'right' ? 1 : -1;
  const sy = def.overlapV === 'bottom' ? 1 : -1;
  return (p, q) => (Math.abs(p.dy - q.dy) > 1e-9 ? sy * (p.dy - q.dy) : sx * (p.dx - q.dx));
}

/**
 * Lattice offsets { dx, dy } whose copy of the art (bounds `art`, pattern
 * units) touches `rect`, in overlap paint order. `limit` caps the count.
 */
export function copiesIn(def, rect, art = artBounds(def), limit = 20000) {
  if (!art || !rect) return [];
  const { a, b } = lattice(def);
  // Solve for the lattice index range covering the rect grown by the art's extent.
  const det = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(det) < 1e-12) return [];
  const x0 = rect.x - (art.x + art.w);
  const x1 = rect.x + rect.w - art.x;
  const y0 = rect.y - (art.y + art.h);
  const y1 = rect.y + rect.h - art.y;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [(x * b[1] - y * b[0]) / det, (y * a[0] - x * a[1]) / det]);
  const imin = Math.floor(Math.min(...corners.map((c) => c[0]))) - 1;
  const imax = Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1;
  const jmin = Math.floor(Math.min(...corners.map((c) => c[1]))) - 1;
  const jmax = Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1;
  if ((imax - imin + 1) * (jmax - jmin + 1) > limit * 4) return [];
  const out = [];
  for (let j = jmin; j <= jmax; j++) {
    for (let i = imin; i <= imax; i++) {
      const dx = i * a[0] + j * b[0];
      const dy = i * a[1] + j * b[1];
      if (art.x + dx < rect.x + rect.w && art.x + art.w + dx > rect.x && art.y + dy < rect.y + rect.h && art.y + art.h + dy > rect.y) {
        out.push({ dx, dy, i, j });
        if (out.length > limit) return out.sort(overlapOrder(def));
      }
    }
  }
  return out.sort(overlapOrder(def));
}

/** Offsets for the preview copies around the tile in pattern editing mode ('5x5' -> 25 offsets). */
export function previewCopies(def, copies = '5x5') {
  const m = /^(\d+)x(\d+)$/.exec(copies) || [0, 5, 5];
  const cols = +m[1];
  const rows = +m[2];
  const { a, b } = lattice(def);
  const f = fraction(def.brickOffset).v;
  const out = [];
  for (let row = -Math.floor(rows / 2); row <= Math.floor(rows / 2); row++) {
    for (let col = -Math.floor(cols / 2); col <= Math.floor(cols / 2); col++) {
      // Brick and hex lattices slant: pick the lattice point nearest each cell of the visual grid.
      let i = col;
      let j = row;
      if (def.tileType === 'brickRow') i = col - Math.round(row * f);
      else if (def.tileType === 'hexRow') i = col - Math.floor(row / 2);
      else if (def.tileType === 'brickColumn') j = row - Math.round(col * f);
      else if (def.tileType === 'hexColumn') j = row - Math.floor(col / 2);
      out.push({ dx: i * a[0] + j * b[0], dy: i * a[1] + j * b[1], center: col === 0 && row === 0 });
    }
  }
  return out.sort(overlapOrder(def));
}

const viewCache = new WeakMap();

/**
 * A read-only document view of a definition's art (get/has/assets/root/walk),
 * cached per definition object. `assets` come from the owning document.
 */
export function patternView(doc, def) {
  let v = viewCache.get(def);
  if (v && v.assets === (doc?.assets || v.assets)) return v;
  const map = new Map();
  for (const n of Array.isArray(def.art?.nodes) ? def.art.nodes : []) {
    if (n && typeof n.id === 'string' && n.id !== '__pattern') map.set(n.id, n);
  }
  // Pattern art can come from libraries or damaged files. Give each node one
  // place in the tree so bounds and rendering cannot recurse through a cycle.
  // Repair only the view; the stored definition and valid node identities stay intact.
  const claimed = new Set(['__pattern']);
  const claimChildren = (ids) => (Array.isArray(ids) ? ids : []).filter((id) => {
    if (!map.has(id) || claimed.has(id)) return false;
    claimed.add(id);
    return true;
  });
  const roots = claimChildren(def.art?.roots);
  const pending = roots.slice().reverse();
  while (pending.length) {
    const id = pending.pop();
    const node = map.get(id);
    if (node.children === undefined) continue;
    const children = claimChildren(node.children);
    if (!Array.isArray(node.children) || children.length !== node.children.length) map.set(id, { ...node, children });
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  const root = { id: '__pattern', type: 'root', children: roots, artboards: [], patterns: doc?.root?.patterns || [] };
  v = {
    get: (id) => (id === root.id ? root : map.get(id)),
    has: (id) => id === root.id || map.has(id),
    assets: doc?.assets || new Map(),
    root,
    name: def.name,
    artboards: [],
    roots,
    walk(fn, id = root.id, depth = 0) {
      const n = v.get(id);
      if (!n) return;
      if (id !== root.id && fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) v.walk(fn, c, depth + 1);
    },
  };
  viewCache.set(def, v);
  return v;
}

/** Visual bounds of the art (pattern units), or null for an empty pattern. */
export function artBounds(def, doc = null) {
  const v = patternView(doc, def);
  let b = null;
  for (const id of v.roots) b = unionRect(b, visualBounds(v, v.get(id)) || nodeBounds(v, v.get(id)));
  return b;
}

/** The art's geometric bounds (pattern units), or null. */
export function artGeomBounds(def, doc = null) {
  const v = patternView(doc, def);
  let b = null;
  for (const id of v.roots) b = unionRect(b, nodeBounds(v, v.get(id)));
  return b;
}

/** True when a paint is a pattern paint. */
export function isPatternPaint(p) {
  return Boolean(p && p.type === 'pattern');
}

/** Pattern paint for a definition. */
export function patternPaint(id, transform = null) {
  return transform ? { type: 'pattern', id, transform } : { type: 'pattern', id };
}

/**
 * Clipboard support: copied objects carry the definitions of the patterns
 * they are painted with (and the patterns drawn inside those), and pasting
 * into another document adds the ones it lacks.
 */
export const patternClipboardHook = {
  copy(doc, ids, data) {
    const defs = new Map();
    const visit = (p) => {
      if (p?.type !== 'pattern' || defs.has(p.id)) return;
      const def = findPattern(doc, p.id);
      if (!def) return;
      defs.set(p.id, def);
      for (const n of def.art?.nodes || []) visitNode(n);
    };
    const visitNode = (n) => {
      visit(n.fill);
      visit(n.stroke);
      for (const paint of stackPaints(n)) visit(paint);
      if (n.runs) for (const r of n.runs) visit(r.fill), visit(r.stroke);
    };
    for (const item of data.items || []) for (const n of item.nodes || []) visitNode(n);
    data.patterns = [...defs.values()];
  },
  paste(doc, data) {
    for (const def of data.patterns || []) if (!findPattern(doc, def.id)) addPattern(doc, structuredClone(def));
  },
};

/** Pattern ids used by objects in the document (fills, strokes and styled type runs). */
export function usedPatternIds(doc) {
  const out = new Set();
  const visit = (p) => p?.type === 'pattern' && out.add(p.id);
  for (const n of doc.nodes.values()) {
    visit(n.fill);
    visit(n.stroke);
    if (n.runs) for (const r of n.runs) visit(r.fill), visit(r.stroke);
  }
  // Patterns drawn inside other patterns.
  for (const def of patternsOf(doc)) for (const n of def.art?.nodes || []) visit(n.fill), visit(n.stroke);
  return out;
}
