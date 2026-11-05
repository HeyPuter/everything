// Schematic connectivity. Builds nets from wires, pins, net labels, power
// ports and ports across all sheets of a project (a flat design: equal names
// join everywhere), computes automatic junction dots, and names unnamed nets
// after their first pin.
//
// Connection rules:
// - A wire conducts along its whole length.
// - A wire end, pin end, label, power port or port touching the interior of a
//   wire connects to it (a T joint) and gets a junction dot.
// - Two wires crossing mid-segment do not connect unless a junction is placed.

import { placeSymbol } from './place.js';
import { connectionPoints } from './sch.js';
import { GROUND_STYLES } from './schema.js';

class DSU {
  constructor() { this.p = new Map(); }
  find(a) {
    let r = a;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r);
    let x = a;
    while (this.p.has(x) && this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    if (!this.p.has(r)) this.p.set(r, r);
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

const key = (x, y) => `${x},${y}`;

/** True when (x, y) lies strictly inside segment a-b (not at an end). */
function onSegInterior(x, y, ax, ay, bx, by) {
  if ((x === ax && y === ay) || (x === bx && y === by)) return false;
  if ((x - ax) * (by - ay) - (y - ay) * (bx - ax) !== 0) return false;
  return x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by);
}

/** Segment index bucketed on a coarse grid for point-on-wire lookups. */
class SegIndex {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  add(seg) {
    const c = this.cell;
    const x0 = Math.floor(Math.min(seg[0], seg[2]) / c), x1 = Math.floor(Math.max(seg[0], seg[2]) / c);
    const y0 = Math.floor(Math.min(seg[1], seg[3]) / c), y1 = Math.floor(Math.max(seg[1], seg[3]) / c);
    // Long diagonal wires are rare; cap the bucket span to stay linear.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { (this.big ||= []).push(seg); return; }
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
      const k = i * 73856093 ^ j * 19349663;
      let list = this.map.get(k);
      if (!list) this.map.set(k, (list = []));
      list.push(seg);
    }
  }
  at(x, y) {
    const k = Math.floor(x / this.cell) * 73856093 ^ Math.floor(y / this.cell) * 19349663;
    const list = this.map.get(k) || [];
    return this.big ? list.concat(this.big) : list;
  }
}

/**
 * Analyses one sheet. Returns the union-find over point keys plus the facts
 * needed for naming: which points carry pins, labels, power ports and ports.
 */
function analyseSheet(sheet, lib, dsu, prefix) {
  const objs = sheet.objects;
  const segs = new SegIndex(2_540_000 * 5);
  const pointCount = new Map();
  const bump = (k) => pointCount.set(k, (pointCount.get(k) || 0) + 1);
  const pins = [];
  const named = [];
  const tPoints = [];
  const wires = [];
  const junctionsManual = [];
  const noErc = new Set();

  for (const o of objs) {
    if (o.t === 'wire') {
      wires.push(o);
      for (let i = 0; i < o.pts.length; i += 2) {
        const k = prefix + key(o.pts[i], o.pts[i + 1]);
        dsu.find(k);
        if (i > 0) dsu.union(prefix + key(o.pts[i - 2], o.pts[i - 1]), k);
        if (i > 0) segs.add([o.pts[i - 2], o.pts[i - 1], o.pts[i], o.pts[i + 1], o.id]);
      }
      // Ends count toward junctions; interior vertices count twice (two segments meet).
      const n = o.pts.length;
      bump(key(o.pts[0], o.pts[1]));
      bump(key(o.pts[n - 2], o.pts[n - 1]));
      for (let i = 2; i < n - 2; i += 2) { bump(key(o.pts[i], o.pts[i + 1])); bump(key(o.pts[i], o.pts[i + 1])); }
      tPoints.push([o.pts[0], o.pts[1]], [o.pts[n - 2], o.pts[n - 1]]);
    } else if (o.t === 'part') {
      const def = lib[o.comp];
      if (!def) continue;
      const pl = placeSymbol(def, o);
      for (const p of pl.pins) {
        const k = prefix + key(p.x, p.y);
        dsu.find(k);
        pins.push({ part: o, pin: p, key: k, x: p.x, y: p.y });
        if (p.hidden) named.push({ kind: 'hidden', name: p.name, key: k });
        else { bump(key(p.x, p.y)); tPoints.push([p.x, p.y]); }
      }
    } else if (o.t === 'label' || o.t === 'power' || o.t === 'port') {
      // A port connects at either end (the editor snaps wires to both).
      const [[x, y], ...more] = connectionPoints(o, lib);
      const k = prefix + key(x, y);
      dsu.find(k);
      named.push({ kind: o.t, name: o.t === 'label' ? o.text : o.t === 'power' ? o.net : o.name, key: k, obj: o, ground: o.t === 'power' && GROUND_STYLES.has(o.style) });
      tPoints.push([x, y]);
      for (const [ex, ey] of more) {
        dsu.union(k, prefix + key(ex, ey));
        tPoints.push([ex, ey]);
      }
    } else if (o.t === 'junction') {
      junctionsManual.push([o.x, o.y]);
      dsu.find(prefix + key(o.x, o.y));
    } else if (o.t === 'noerc') {
      noErc.add(key(o.x, o.y));
    }
  }

  // T joints: points on the interior of a wire connect to it.
  const autoJunctions = new Map();
  for (const [x, y] of tPoints) {
    for (const s of segs.at(x, y)) {
      if (onSegInterior(x, y, s[0], s[1], s[2], s[3])) {
        dsu.union(prefix + key(x, y), prefix + key(s[0], s[1]));
        autoJunctions.set(key(x, y), [x, y]);
      }
    }
  }
  // Manual junctions connect crossing wires.
  for (const [x, y] of junctionsManual) {
    for (const s of segs.at(x, y)) {
      const onEnd = (x === s[0] && y === s[1]) || (x === s[2] && y === s[3]);
      if (onEnd || onSegInterior(x, y, s[0], s[1], s[2], s[3])) dsu.union(prefix + key(x, y), prefix + key(s[0], s[1]));
    }
  }
  // Three or more wire ends / pins at one point get a dot.
  for (const [k, n] of pointCount) {
    if (n >= 3) { const [x, y] = k.split(',').map(Number); autoJunctions.set(k, [x, y]); }
  }

  return { pins, named, wires, junctions: [...autoJunctions.values()], manualJunctions: junctionsManual, noErc, pointCount };
}

const NAME_RANK = { power: 0, hidden: 1, label: 2, port: 3 };

// One collator for every comparison: localeCompare with options builds a new one per call.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function naturalCompare(a, b) {
  return collator.compare(String(a), String(b));
}

/**
 * Builds the project netlist from schematic documents.
 * @param {Array<{id:string, objects:object[]}>} sheets
 * @param {Record<string, object>} lib
 */
export function buildNetlist(sheets, lib) {
  const dsu = new DSU();
  const info = new Map();
  for (const sheet of sheets) info.set(sheet.id, analyseSheet(sheet, lib, dsu, `${sheet.id}|`));

  // Equal names join across the whole project.
  const nameRoot = new Map();
  for (const [, si] of info) {
    for (const n of si.named) {
      if (!n.name) continue;
      const prev = nameRoot.get(n.name);
      if (prev) dsu.union(prev, n.key); else nameRoot.set(n.name, n.key);
    }
  }

  // Gather groups.
  const groups = new Map();
  const group = (root) => {
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { names: [], nodes: [], labels: [] }));
    return g;
  };
  for (const [sheetId, si] of info) {
    for (const n of si.named) {
      const g = group(dsu.find(n.key));
      if (n.name) g.names.push({ name: n.name, rank: NAME_RANK[n.kind], ground: n.ground });
      g.labels.push({ ...n, sheetId });
    }
    for (const p of si.pins) {
      const g = group(dsu.find(p.key));
      g.nodes.push({ ref: p.part.designator, pin: p.pin.num, pinName: p.pin.name, type: p.pin.type, partId: p.part.id, partUid: p.part.uid, sheetId, x: p.x, y: p.y, hidden: !!p.pin.hidden });
    }
  }

  const nets = [];
  const usedNames = new Set();
  const rootName = new Map();
  const nextSuffix = new Map();
  const sorted = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // Named nets first so automatic names never collide with a user's name.
  for (const [root, g] of sorted) {
    if (!g.names.length) continue;
    g.names.sort((a, b) => a.rank - b.rank || naturalCompare(a.name, b.name));
    const name = g.names[0].name;
    rootName.set(root, name);
    usedNames.add(name);
  }
  for (const [root, g] of sorted) {
    if (rootName.has(root)) continue;
    if (!g.nodes.length) { rootName.set(root, ''); continue; }
    const first = [...g.nodes].sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.pin, b.pin))[0];
    const base = `Net${first.ref}_${first.pin}`;
    let name = base;
    // Unannotated parts (R?) share a base name: continue from the last suffix used.
    let i = nextSuffix.get(base) || 2;
    while (usedNames.has(name)) name = `${base}_${i++}`;
    nextSuffix.set(base, i);
    usedNames.add(name);
    rootName.set(root, name);
  }

  const byPin = new Map();
  for (const [root, g] of sorted) {
    const name = rootName.get(root);
    if (!name) continue;
    g.nodes.sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.pin, b.pin));
    const aliases = [...new Set(g.names.map((n) => n.name))].filter((n) => n !== name);
    nets.push({ name, nodes: g.nodes, labels: g.labels, aliases, named: g.names.length > 0, ground: g.names.some((n) => n.ground) });
    for (const n of g.nodes) byPin.set(`${n.partId}:${n.pin}`, name);
  }
  nets.sort((a, b) => naturalCompare(a.name, b.name));

  // Per-sheet lookups for highlighting and the renderer.
  const sheetsOut = new Map();
  for (const sheet of sheets) {
    const si = info.get(sheet.id);
    const prefix = `${sheet.id}|`;
    const wireNet = new Map();
    for (const w of si.wires) wireNet.set(w.id, rootName.get(dsu.find(prefix + key(w.pts[0], w.pts[1]))) || '');
    const pointNet = (x, y) => {
      const k = prefix + key(x, y);
      return dsu.p.has(k) ? rootName.get(dsu.find(k)) || '' : '';
    };
    sheetsOut.set(sheet.id, { junctions: si.junctions, wireNet, pointNet, noErc: si.noErc, pointCount: si.pointCount });
  }

  return { nets, byPin, sheets: sheetsOut };
}

/** Netlist in the exporter's shape: parts and nets with ref/pin nodes. */
export function exportShape(netlist, sheets, lib) {
  const parts = [];
  for (const s of sheets) for (const o of s.objects) {
    if (o.t !== 'part') continue;
    const def = lib[o.comp];
    if (!def?.footprint && !def?.symbol?.pins?.length) continue;
    parts.push({ ref: o.designator, value: o.value ?? def?.value ?? '', footprint: o.footprint || def?.footprint?.name || '', comp: o.comp, uid: o.uid });
  }
  parts.sort((a, b) => naturalCompare(a.ref, b.ref));
  return { parts, nets: netlist.nets.map((n) => ({ name: n.name, nodes: n.nodes.filter((x) => x.ref).map((x) => ({ ref: x.ref, pin: x.pin })) })) };
}
