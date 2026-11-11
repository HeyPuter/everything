/**
 * Graph operations on the document: creating graphs, changing their data
 * and options (keeping the series keys in step), finding the graphs and
 * series in a selection, and graph designs.
 */
import { createGroup, createPath } from '../../model/nodes.js';
import { transformAnchors } from '../../model/bezier.js';
import { nodeBounds } from '../../model/geometry.js';
import { uid } from '../../lib/ids.js';
import { parseGraphData, sampleData, rectAnchors, SERIES_PALETTE, graphOptions } from './graph-math.js';
import { isGraph, graphScene, graphDesigns } from './graph-live.js';

/** Insert a new graph (inside a transaction). Returns its id. */
export function createGraph(doc, parentId, { x, y, w, h }, type = 'column', { data = null, options = {}, index = Infinity } = {}) {
  const g = createGroup([], {
    live: { kind: 'graph', type, data: data || sampleData(type), options, frame: { w: Math.max(1, w), h: Math.max(1, h) }, matrix: [1, 0, 0, 1, x, y] },
  });
  doc.insert(g, parentId, index);
  syncKeys(doc, g.id);
  return g.id;
}

/**
 * Keep one series key per series (inside a transaction): new series get a
 * key in the next palette color, keys of removed series go, and every key
 * is named after its series and placed on its legend swatch.
 */
export function syncKeys(doc, gid) {
  let g = doc.get(gid);
  if (!isGraph(g)) return;
  const { series } = parseGraphData(g.live.data, g.live.type);
  const M = g.live.matrix || [1, 0, 0, 1, 0, 0];
  const scene = graphScene(g);
  const keys = g.children.map((id) => doc.get(id)).filter(Boolean);
  for (let i = 0; i < series.length; i++) {
    const r = scene.keys[i] || { x: 0, y: 0, w: 1, h: 1 };
    const anchors = transformAnchors(rectAnchors(r.x, r.y, r.w, r.h), M);
    const name = series[i].name || `Series ${i + 1}`;
    const key = keys[i];
    if (!key) {
      const k = createPath(anchors, true, { fill: { type: 'solid', color: SERIES_PALETTE[i % SERIES_PALETTE.length] }, stroke: null, strokeWidth: 0 }, { name, graphKey: true });
      doc.insert(k, gid, i);
      continue;
    }
    const same = key.name === name && key.anchors.length === 4 && key.anchors.every((a, k) => Math.abs(a.x - anchors[k].x) < 1e-6 && Math.abs(a.y - anchors[k].y) < 1e-6);
    if (!same) doc.update(key.id, { anchors, name, shape: undefined });
  }
  for (const key of keys.slice(series.length)) doc.remove(key.id);
  g = doc.get(gid);
  return g;
}

/** Change a graph's live parameters (inside a transaction) and resync its keys. */
export function updateGraph(doc, gid, patch) {
  const g = doc.get(gid);
  if (!isGraph(g)) return;
  const live = { ...g.live, ...patch };
  if (patch.options) live.options = { ...patch.options };
  doc.update(gid, { live });
  syncKeys(doc, gid);
}

/** The graph a node belongs to (itself or its parent), or null. */
export function graphOf(doc, node) {
  if (!node) return null;
  if (isGraph(node)) return node;
  const p = doc.get(node.parent);
  return isGraph(p) ? p : null;
}

/** Graphs in or around the selection, in paint order. */
export function selectedGraphs(editor) {
  if (!editor) return [];
  const out = new Map();
  for (const id of editor.selection) {
    const g = graphOf(editor.doc, editor.doc.get(id));
    if (g && !editor.doc.isLocked(g.id)) out.set(g.id, g);
  }
  return editor.doc.sortByPaintOrder([...out.keys()]).map((id) => out.get(id));
}

/**
 * Series picked in the selection: [{ graph, index }] for selected series
 * keys; when whole graphs are selected, every series of them.
 */
export function selectedSeries(editor) {
  const doc = editor.doc;
  const keys = [];
  for (const id of editor.selection) {
    const n = doc.get(id);
    const g = doc.get(n?.parent);
    if (isGraph(g) && !editor.selection.has(g.id)) keys.push({ graph: g, index: g.children.indexOf(id) });
  }
  if (keys.length) return keys;
  const out = [];
  for (const g of selectedGraphs(editor)) g.children.forEach((_, index) => out.push({ graph: g, index }));
  return out;
}

/** Set per-series options (column or marker design settings) for picked series (inside a transaction). */
export function setSeriesOption(doc, picks, key, value) {
  const byGraph = new Map();
  for (const p of picks) {
    if (!byGraph.has(p.graph.id)) byGraph.set(p.graph.id, []);
    byGraph.get(p.graph.id).push(p.index);
  }
  for (const [gid, idxs] of byGraph) {
    const g = doc.get(gid);
    const opt = graphOptions(g.live.options);
    const series = { ...opt.series };
    for (const i of idxs) {
      const cur = { ...(series[i] || {}) };
      if (value) cur[key] = value;
      else delete cur[key];
      series[i] = cur;
    }
    updateGraph(doc, gid, { options: { ...(g.live.options || {}), series } });
  }
}

// ---- designs ----

/** Add a design made from document objects (inside a transaction). Returns it. */
export function addDesign(doc, ids, name) {
  const sorted = doc.sortByPaintOrder(ids);
  const nodes = [];
  const rootId = uid('gd');
  const children = [];
  let bounds = null;
  for (const id of sorted) {
    const sub = doc.exportSubtree(id);
    children.push(sub.root);
    for (const n of sub.nodes) nodes.push(n.id === sub.root ? { ...n, parent: rootId } : n);
    const b = nodeBounds(doc, doc.get(id));
    if (b) bounds = bounds ? union(bounds, b) : { ...b };
  }
  if (!bounds) return null;
  const design = { id: uid('gd'), name, root: rootId, nodes: [{ id: rootId, type: 'group', name: '', children, clip: false, hidden: false, locked: false }, ...nodes], bounds };
  doc.updateRoot({ graphDesigns: [...graphDesigns(doc), design] });
  return design;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** A design name not yet used: "Design 1", "Design 2", ... */
export function nextDesignName(doc) {
  const used = new Set(graphDesigns(doc).map((d) => d.name));
  let i = 1;
  while (used.has(`Design ${i}`)) i++;
  return `Design ${i}`;
}

export function renameDesign(doc, id, name) {
  doc.updateRoot({ graphDesigns: graphDesigns(doc).map((d) => (d.id === id ? { ...d, name } : d)) });
}

export function deleteDesign(doc, id) {
  doc.updateRoot({ graphDesigns: graphDesigns(doc).filter((d) => d.id !== id) });
}

/** Place a copy of a design's artwork into a layer (inside a transaction). Returns the new group. */
export function pasteDesign(doc, id, parentId) {
  const d = graphDesigns(doc).find((x) => x.id === id);
  if (!d) return null;
  return doc.importSubtree({ root: d.root, nodes: d.nodes }, parentId);
}

/** Design ids a graph's series options use. */
function designIdsOf(g) {
  const out = [];
  for (const s of Object.values(g.live.options?.series || {})) {
    if (s?.column?.design) out.push(s.column.design);
    if (s?.marker?.design) out.push(s.marker.design);
  }
  return out;
}

/** The designs some (copied) nodes' graphs use, for carrying them to another document. */
export function designsFor(doc, nodes) {
  const ids = new Set();
  for (const n of nodes) if (isGraph(n)) for (const id of designIdsOf(n)) ids.add(id);
  return graphDesigns(doc).filter((d) => ids.has(d.id));
}

/**
 * Add the designs pasted graphs use that the document does not have
 * (inside a transaction); a design keeps its id, so graphs find it, and is
 * renamed when its name is taken.
 */
export function importDesigns(doc, designs = []) {
  const have = graphDesigns(doc);
  const missing = designs.filter((d) => d?.id && !have.some((x) => x.id === d.id));
  if (!missing.length) return;
  const used = new Set(have.map((d) => d.name));
  const added = missing.map((d) => {
    let name = d.name;
    for (let i = 2; used.has(name); i++) name = `${d.name} ${i}`;
    used.add(name);
    return { ...d, name };
  });
  doc.updateRoot({ graphDesigns: [...have, ...added] });
}

/** Designs no graph in the document uses. */
export function unusedDesigns(doc) {
  const used = new Set();
  doc.walk((n) => {
    if (isGraph(n)) for (const id of designIdsOf(n)) used.add(id);
    return true;
  });
  return graphDesigns(doc).filter((d) => !used.has(d.id));
}
