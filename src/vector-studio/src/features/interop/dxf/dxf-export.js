/**
 * DXF export.
 *
 * AutoCAD 2000 (AC1015) files with handles, owner references and subclass
 * markers, or plain R12 (AC1009) files for older programs. Each document
 * layer becomes a DXF layer. Straight paths are written as polylines,
 * curves as cubic splines (or flattened to polylines), circles and
 * ellipses as CIRCLE/ELLIPSE entities, fills as solid hatches, text as
 * TEXT entities (or as outlines), with true colors (and the nearest color
 * index) and lineweights. Coordinates are in the chosen drawing units with
 * y up, measured from the exported region's lower-left corner.
 */
import { exportView } from '../../io/export-view.js';
import { nodeBounds } from '../../../model/geometry.js';
import { flattenPath } from '../../../model/bezier.js';
import { layoutText } from '../../../model/text-layout.js';
import { nearestAci, nearestLineweight, UNIT_CHOICES } from './common.js';

const KAPPA = 0.5522847498;

const clean = (s) => String(s || 'Layer').replace(/[<>/\\":;?*|=`,]/g, '_').slice(0, 255) || 'Layer';

function trueColor(hex) {
  return parseInt(String(hex || '#000000').slice(1), 16) & 0xffffff;
}

/** Paint color for DXF (gradients use their first stop). */
function paintColor(p) {
  if (!p) return null;
  if (p.type === 'solid') return p.color;
  if (p.stops?.length) return p.stops[0].color;
  return null;
}

class Writer {
  constructor(version) {
    this.r12 = version === 'R12';
    this.lines = [];
    this.handle = 0x20;
  }

  pair(code, value) {
    this.lines.push(String(code), typeof value === 'number' ? fmt(value) : String(value));
  }

  h() {
    return (this.handle++).toString(16).toUpperCase();
  }

  text() {
    return `${this.lines.join('\r\n')}\r\n`;
  }
}

function fmt(v) {
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Circle/ellipse parameters if anchors form one (4 anchors with quarter-ellipse handles). */
function ellipseOf(anchors, closed) {
  if (!closed || anchors.length !== 4) return null;
  const cx = anchors.reduce((s, a) => s + a.x, 0) / 4;
  const cy = anchors.reduce((s, a) => s + a.y, 0) / 4;
  const u = { x: anchors[0].x - cx, y: anchors[0].y - cy };
  const v = { x: anchors[1].x - cx, y: anchors[1].y - cy };
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu < 1e-9 || lv < 1e-9) return null;
  const tol = 1e-3 * Math.max(lu, lv);
  if (Math.abs(u.x * v.x + u.y * v.y) > tol * Math.max(lu, lv)) return null;
  // Opposite anchors mirror through the center; handles have kappa length along the other axis.
  for (let i = 0; i < 4; i++) {
    const a = anchors[i];
    const b = anchors[(i + 2) % 4];
    if (Math.abs(a.x + b.x - 2 * cx) > tol || Math.abs(a.y + b.y - 2 * cy) > tol) return null;
    const next = { x: anchors[(i + 1) % 4].x - cx, y: anchors[(i + 1) % 4].y - cy };
    const ex = { x: a.x + next.x * KAPPA, y: a.y + next.y * KAPPA };
    if (Math.hypot(a.ox - ex.x, a.oy - ex.y) > tol * 4) return null;
  }
  return { cx, cy, u, v, lu, lv };
}

/**
 * Write a DXF file.
 * opts: { rect (region in document space), ids (top-level ids, default all
 *   visible layers), version 'R2000'|'R12', unit (UNIT_CHOICES value),
 *   curves 'splines'|'polylines', fills (bool), outlines (Map id -> runs
 *   when text is converted) }
 * Returns { text, warnings }.
 */
export function writeDXF(source, opts = {}) {
  const doc = exportView(source);
  const version = opts.version === 'R12' ? 'R12' : 'R2000';
  const unit = UNIT_CHOICES.find((u) => u.value === opts.unit) || UNIT_CHOICES[0];
  const k = 1 / unit.pt;
  const rect = opts.rect || { x: 0, y: 0, w: 0, h: 0 };
  const X = (x) => (x - rect.x) * k;
  const Y = (y) => (rect.y + rect.h - y) * k;
  const w = new Writer(version);
  const warnings = new Set();
  const curves = opts.curves === 'polylines' || version === 'R12' ? 'polylines' : 'splines';
  const fills = opts.fills !== false && version !== 'R12';
  const flat = 0.05 * unit.pt;

  // ---- collect layers and entities ----
  const layers = [];
  const layerNames = new Set();
  const entities = [];
  const topIds = opts.ids || null;
  const visitLayer = (layer) => {
    let name = clean(layer.name);
    let n = 2;
    while (layerNames.has(name.toUpperCase())) name = `${clean(layer.name)}_${n++}`;
    layerNames.add(name.toUpperCase());
    layers.push({ name, color: layer.color || '#000000', hidden: layer.hidden, locked: layer.locked });
    return name;
  };
  const walk = (id, layerName, depth) => {
    const n = doc.get(id);
    if (!n || n.hidden || depth > 64) return;
    if (n.type === 'group' || n.type === 'layer') {
      const kids = n.children || [];
      if (n.clip && kids.length) {
        warnings.add('Clipping masks are not supported in DXF; clipped artwork was exported whole.');
        kids.slice(0, -1).forEach((c) => walk(c, layerName, depth + 1));
        return;
      }
      kids.forEach((c) => walk(c, layerName, depth + 1));
      return;
    }
    if (n.type === 'image') {
      warnings.add('Images are not exported to DXF.');
      return;
    }
    if (n.type === 'text') {
      const runs = opts.outlines?.get(n.id);
      if (runs?.length) {
        for (const r of runs) entities.push({ kind: 'shape', layer: layerName, subpaths: r.subpaths, fill: paintColor(r.fill), stroke: paintColor(r.stroke), strokeWidth: r.strokeWidth || 0 });
      } else entities.push({ kind: 'text', layer: layerName, node: n });
      return;
    }
    if (n.type === 'path' || n.type === 'compound') {
      const subpaths = n.type === 'path' ? [{ anchors: n.anchors, closed: n.closed }] : (n.children || []).map((c) => doc.get(c)).filter((c) => c?.anchors).map((c) => ({ anchors: c.anchors, closed: c.closed }));
      if (n.fill && n.fill.type !== 'solid') warnings.add('Gradient and pattern fills were exported as solid colors.');
      entities.push({ kind: 'shape', layer: layerName, subpaths, fill: paintColor(n.fill), stroke: n.strokeWidth > 0 ? paintColor(n.stroke) : null, strokeWidth: n.strokeWidth || 0, opacity: n.opacity });
      return;
    }
    if (n.children) n.children.forEach((c) => walk(c, layerName, depth + 1));
  };
  const rootLayers = doc.root.children.map((id) => doc.get(id)).filter((l) => l && !l.template);
  for (const l of rootLayers) {
    if (l.hidden) continue;
    const name = visitLayer(l);
    for (const c of l.children || []) {
      if (topIds && !topIds.includes(c) && !containsAny(doc, c, topIds)) continue;
      walk(c, name, 0);
    }
  }
  if (!layers.length) layers.push({ name: '0', color: '#000000' });

  // ---- header ----
  let ext = null;
  for (const e of entities) {
    for (const s of e.subpaths || []) for (const a of s.anchors) ext = grow(ext, X(a.x), Y(a.y));
    if (e.node) {
      const t = e.node.transform;
      ext = grow(ext, X(t[4] + e.node.x), Y(t[5] + e.node.y));
    }
  }
  if (!ext) ext = { x0: 0, y0: 0, x1: rect.w * k, y1: rect.h * k };
  const section = (name, fn) => {
    w.pair(0, 'SECTION');
    w.pair(2, name);
    fn();
    w.pair(0, 'ENDSEC');
  };
  section('HEADER', () => {
    w.pair(9, '$ACADVER');
    w.pair(1, w.r12 ? 'AC1009' : 'AC1015');
    if (!w.r12) {
      w.pair(9, '$HANDSEED');
      w.pair(5, 'FFFFF');
    }
    w.pair(9, '$INSBASE');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.pair(9, '$EXTMIN');
    w.pair(10, ext.x0);
    w.pair(20, ext.y0);
    w.pair(30, 0);
    w.pair(9, '$EXTMAX');
    w.pair(10, ext.x1);
    w.pair(20, ext.y1);
    w.pair(30, 0);
    w.pair(9, '$LIMMIN');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(9, '$LIMMAX');
    w.pair(10, rect.w * k);
    w.pair(20, rect.h * k);
    if (!w.r12) {
      w.pair(9, '$INSUNITS');
      w.pair(70, unit.code);
      w.pair(9, '$MEASUREMENT');
      w.pair(70, ['mm', 'cm', 'm'].includes(unit.value) ? 1 : 0);
      w.pair(9, '$LWDISPLAY');
      w.pair(290, 1);
    }
  });

  // ---- tables ----
  const owner = {};
  const table = (name, entries, fn) => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    let th = null;
    if (!w.r12) {
      th = w.h();
      w.pair(5, th);
      w.pair(330, 0);
      w.pair(100, 'AcDbSymbolTable');
    }
    w.pair(70, entries.length);
    for (const e of entries) {
      w.pair(0, name);
      if (!w.r12) {
        const hh = w.h();
        w.pair(5, hh);
        w.pair(330, th);
        w.pair(100, 'AcDbSymbolTableRecord');
        e.handle = hh;
      }
      fn(e);
    }
    w.pair(0, 'ENDTAB');
  };
  section('TABLES', () => {
    if (!w.r12) {
      table('VPORT', [{ name: '*ACTIVE' }], (e) => {
        w.pair(100, 'AcDbViewportTableRecord');
        w.pair(2, e.name);
        w.pair(70, 0);
        w.pair(10, 0);
        w.pair(20, 0);
        w.pair(11, 1);
        w.pair(21, 1);
        w.pair(12, (ext.x0 + ext.x1) / 2);
        w.pair(22, (ext.y0 + ext.y1) / 2);
        w.pair(40, Math.max(1, ext.y1 - ext.y0) * 1.1);
        w.pair(41, Math.max(0.1, (ext.x1 - ext.x0) / Math.max(1e-6, ext.y1 - ext.y0)));
      });
    }
    table('LTYPE', [{ name: w.r12 ? 'CONTINUOUS' : 'ByBlock' }, ...(w.r12 ? [] : [{ name: 'ByLayer' }, { name: 'Continuous' }])], (e) => {
      if (!w.r12) w.pair(100, 'AcDbLinetypeTableRecord');
      w.pair(2, e.name);
      w.pair(70, 0);
      w.pair(3, e.name === 'Continuous' || e.name === 'CONTINUOUS' ? 'Solid line' : '');
      w.pair(72, 65);
      w.pair(73, 0);
      w.pair(40, 0);
    });
    table('LAYER', [{ name: '0', color: '#000000' }, ...layers.filter((l) => l.name !== '0')], (e) => {
      if (!w.r12) w.pair(100, 'AcDbLayerTableRecord');
      w.pair(2, e.name);
      w.pair(70, e.locked ? 4 : 0);
      const aci = nearestAci(e.color);
      w.pair(62, e.hidden ? -aci : aci);
      w.pair(6, w.r12 ? 'CONTINUOUS' : 'Continuous');
      if (!w.r12) {
        w.pair(420, trueColor(e.color));
        w.pair(370, -3);
        w.pair(390, 'F');
      }
    });
    table('STYLE', [{ name: w.r12 ? 'STANDARD' : 'Standard' }], (e) => {
      if (!w.r12) w.pair(100, 'AcDbTextStyleTableRecord');
      w.pair(2, e.name);
      w.pair(70, 0);
      w.pair(40, 0);
      w.pair(41, 1);
      w.pair(50, 0);
      w.pair(71, 0);
      w.pair(42, 2.5);
      w.pair(3, 'arial.ttf');
      w.pair(4, '');
    });
    if (!w.r12) {
      table('VIEW', [], () => {});
      table('UCS', [], () => {});
      table('APPID', [{ name: 'ACAD' }], (e) => {
        w.pair(100, 'AcDbRegAppTableRecord');
        w.pair(2, e.name);
        w.pair(70, 0);
      });
      table('DIMSTYLE', [{ name: 'Standard' }], (e) => {
        w.pair(100, 'AcDbDimStyleTableRecord');
        w.pair(2, e.name);
        w.pair(70, 0);
      });
      const recs = [{ name: '*Model_Space' }, { name: '*Paper_Space' }];
      table('BLOCK_RECORD', recs, (e) => {
        w.pair(100, 'AcDbBlockTableRecord');
        w.pair(2, e.name);
      });
      owner.model = recs[0].handle;
      owner.paper = recs[1].handle;
    }
  });

  // ---- blocks ----
  section('BLOCKS', () => {
    for (const [name, rec] of [['*Model_Space', owner.model], ['*Paper_Space', owner.paper]]) {
      if (w.r12) break;
      w.pair(0, 'BLOCK');
      w.pair(5, w.h());
      w.pair(330, rec);
      w.pair(100, 'AcDbEntity');
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockBegin');
      w.pair(2, name);
      w.pair(70, 0);
      w.pair(10, 0);
      w.pair(20, 0);
      w.pair(30, 0);
      w.pair(3, name);
      w.pair(1, '');
      w.pair(0, 'ENDBLK');
      w.pair(5, w.h());
      w.pair(330, rec);
      w.pair(100, 'AcDbEntity');
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockEnd');
    }
  });

  // ---- entities ----
  const head = (type, layer, color, lw, sub) => {
    w.pair(0, type);
    if (!w.r12) {
      w.pair(5, w.h());
      w.pair(330, owner.model);
      w.pair(100, 'AcDbEntity');
    }
    w.pair(8, layer);
    if (color) {
      w.pair(62, nearestAci(color));
      if (!w.r12) w.pair(420, trueColor(color));
    }
    if (!w.r12 && lw !== undefined) w.pair(370, lw);
    if (!w.r12 && sub) w.pair(100, sub);
  };
  const polyline = (pts, closed, layer, color, lw) => {
    if (w.r12) {
      head('POLYLINE', layer, color);
      w.pair(66, 1);
      w.pair(10, 0);
      w.pair(20, 0);
      w.pair(30, 0);
      w.pair(70, closed ? 1 : 0);
      for (const p of pts) {
        w.pair(0, 'VERTEX');
        w.pair(8, layer);
        w.pair(10, p.x);
        w.pair(20, p.y);
        w.pair(30, 0);
      }
      w.pair(0, 'SEQEND');
      w.pair(8, layer);
      return;
    }
    head('LWPOLYLINE', layer, color, lw, 'AcDbPolyline');
    w.pair(90, pts.length);
    w.pair(70, closed ? 1 : 0);
    w.pair(43, 0);
    for (const p of pts) {
      w.pair(10, p.x);
      w.pair(20, p.y);
    }
  };
  const flattenSub = (s) => {
    const pts = [];
    for (const p of flattenPath(s.anchors, s.closed, flat)) {
      const q = { x: X(p.x), y: Y(p.y) };
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-9) pts.push(q);
    }
    if (s.closed && pts.length > 2) {
      const f = pts[0];
      const l = pts[pts.length - 1];
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) pts.pop();
    }
    return pts;
  };
  const isStraight = (a) => a.every((p) => Math.hypot(p.ix - p.x, p.iy - p.y) < 1e-9 && Math.hypot(p.ox - p.x, p.oy - p.y) < 1e-9);
  const writeOutline = (s, layer, color, lw) => {
    const a = s.anchors;
    if (!a || a.length < 2) return;
    const el = ellipseOf(a, s.closed);
    if (el && !w.r12) {
      const flip = { x: X(el.cx), y: Y(el.cy) };
      if (Math.abs(el.lu - el.lv) < 1e-6 * Math.max(el.lu, el.lv)) {
        head('CIRCLE', layer, color, lw, 'AcDbCircle');
        w.pair(10, flip.x);
        w.pair(20, flip.y);
        w.pair(30, 0);
        w.pair(40, el.lu * k);
        return;
      }
      const major = el.lu >= el.lv ? el.u : el.v;
      head('ELLIPSE', layer, color, lw, 'AcDbEllipse');
      w.pair(10, flip.x);
      w.pair(20, flip.y);
      w.pair(30, 0);
      w.pair(11, major.x * k);
      w.pair(21, -major.y * k);
      w.pair(31, 0);
      w.pair(210, 0);
      w.pair(220, 0);
      w.pair(230, 1);
      w.pair(40, Math.min(el.lu, el.lv) / Math.max(el.lu, el.lv));
      w.pair(41, 0);
      w.pair(42, Math.PI * 2);
      return;
    }
    if (a.length === 2 && !s.closed && isStraight(a)) {
      head('LINE', layer, color, lw, w.r12 ? null : 'AcDbLine');
      w.pair(10, X(a[0].x));
      w.pair(20, Y(a[0].y));
      w.pair(30, 0);
      w.pair(11, X(a[1].x));
      w.pair(21, Y(a[1].y));
      w.pair(31, 0);
      return;
    }
    if (isStraight(a)) {
      polyline(a.map((p) => ({ x: X(p.x), y: Y(p.y) })), s.closed, layer, color, lw);
      return;
    }
    if (curves === 'polylines') {
      polyline(flattenSub(s), s.closed, layer, color, lw);
      return;
    }
    // A piecewise cubic Bezier is a clamped B-spline with every interior knot of multiplicity 3.
    const ctrl = [{ x: a[0].x, y: a[0].y }];
    const segs = s.closed ? a.length : a.length - 1;
    for (let i = 0; i < segs; i++) {
      const p = a[i];
      const q = a[(i + 1) % a.length];
      ctrl.push({ x: p.ox, y: p.oy }, { x: q.ix, y: q.iy }, { x: q.x, y: q.y });
    }
    const knots = [0, 0, 0, 0];
    for (let i = 1; i < segs; i++) knots.push(i, i, i);
    knots.push(segs, segs, segs, segs);
    head('SPLINE', layer, color, lw, 'AcDbSpline');
    w.pair(210, 0);
    w.pair(220, 0);
    w.pair(230, 1);
    w.pair(70, 8 + (s.closed ? 1 : 0));
    w.pair(71, 3);
    w.pair(72, knots.length);
    w.pair(73, ctrl.length);
    w.pair(74, 0);
    w.pair(42, 1e-7);
    w.pair(43, 1e-7);
    for (const kn of knots) w.pair(40, kn);
    for (const c of ctrl) {
      w.pair(10, X(c.x));
      w.pair(20, Y(c.y));
      w.pair(30, 0);
    }
  };
  const writeHatch = (subpaths, layer, color) => {
    const loops = subpaths.filter((s) => s.anchors.length >= 2).map(flattenSub).filter((p) => p.length >= 3);
    if (!loops.length) return;
    head('HATCH', layer, color, undefined, 'AcDbHatch');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.pair(210, 0);
    w.pair(220, 0);
    w.pair(230, 1);
    w.pair(2, 'SOLID');
    w.pair(70, 1);
    w.pair(71, 0);
    w.pair(91, loops.length);
    for (const pts of loops) {
      w.pair(92, 3);
      w.pair(72, 0);
      w.pair(73, 1);
      w.pair(93, pts.length);
      for (const p of pts) {
        w.pair(10, p.x);
        w.pair(20, p.y);
      }
      w.pair(97, 0);
    }
    w.pair(75, 0);
    w.pair(76, 1);
    w.pair(98, 0);
  };
  section('ENTITIES', () => {
    for (const e of entities) {
      if (e.kind === 'shape') {
        if (e.fill && fills) writeHatch(e.subpaths, e.layer, e.fill);
        // Outlines carry the stroke; without fills (or for R12) a filled shape is drawn as its outline.
        const color = e.stroke || (!fills ? e.fill : null);
        if (!color) continue;
        const lw = e.stroke ? nearestLineweight(e.strokeWidth) : -1;
        for (const s of e.subpaths) writeOutline(s, e.layer, color, lw);
      } else if (e.kind === 'text') {
        writeText(w, head, e, X, Y, k);
      }
    }
  });
  if (!w.r12) {
    section('OBJECTS', () => {
      const root = w.h();
      const groups = w.h();
      w.pair(0, 'DICTIONARY');
      w.pair(5, root);
      w.pair(330, 0);
      w.pair(100, 'AcDbDictionary');
      w.pair(281, 1);
      w.pair(3, 'ACAD_GROUP');
      w.pair(350, groups);
      w.pair(0, 'DICTIONARY');
      w.pair(5, groups);
      w.pair(330, root);
      w.pair(100, 'AcDbDictionary');
      w.pair(281, 1);
    });
  }
  w.pair(0, 'EOF');
  // Fix the handle seed now that every handle is known.
  const text = w.text().replace('$HANDSEED\r\n5\r\nFFFFF', `$HANDSEED\r\n5\r\n${(w.handle + 1).toString(16).toUpperCase()}`);
  return { text, warnings: [...warnings], entityCount: entities.length };
}

function writeText(w, head, e, X, Y, k) {
  const n = e.node;
  const t = n.transform || [1, 0, 0, 1, 0, 0];
  const ch = n.char || {};
  const s = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
  const size = (ch.fontSize || 12) * s;
  const angle = (-Math.atan2(t[1], t[0]) * 180) / Math.PI;
  const text = String(n.text || '');
  const color = n.fill?.type === 'solid' ? n.fill.color : '#000000';
  // One TEXT entity per laid-out line, at its baseline start.
  let lines = null;
  try {
    const lay = layoutText(n);
    lines = lay.lines.map((ln) => {
      const p = lay.toLocal ? lay.toLocal(ln.x, ln.y) : { x: ln.x, y: ln.y };
      return { text: text.slice(ln.start, ln.contentEnd ?? ln.end), x: p.x, y: p.y };
    });
  } catch {
    lines = null;
  }
  if (!lines) {
    const leading = ch.leading || (ch.fontSize || 12) * 1.2;
    lines = text.split('\n').map((line, i) => ({ text: line, x: n.x || 0, y: (n.y || 0) + i * leading }));
  }
  for (const ln of lines) {
    const line = ln.text.replace(/[\r\n]/g, ' ');
    if (!line.trim()) continue;
    const px = t[0] * ln.x + t[2] * ln.y + t[4];
    const py = t[1] * ln.x + t[3] * ln.y + t[5];
    head('TEXT', e.layer, color, undefined, 'AcDbText');
    w.pair(10, X(px));
    w.pair(20, Y(py));
    w.pair(30, 0);
    // The height is the capital height (about 0.7 of the font size).
    w.pair(40, size * 0.7 * k);
    w.pair(1, line);
    if (Math.abs(angle) > 1e-6) w.pair(50, angle);
    if (ch.horizontalScale && ch.horizontalScale !== 100) w.pair(41, ch.horizontalScale / 100);
    w.pair(7, w.r12 ? 'STANDARD' : 'Standard');
    if (!w.r12) w.pair(100, 'AcDbText');
  }
}

function grow(r, x, y) {
  if (!r) return { x0: x, y0: y, x1: x, y1: y };
  return { x0: Math.min(r.x0, x), y0: Math.min(r.y0, y), x1: Math.max(r.x1, x), y1: Math.max(r.y1, y) };
}

function containsAny(doc, id, ids) {
  const n = doc.get(id);
  if (!n) return false;
  if (ids.includes(id)) return true;
  return (n.children || []).some((c) => containsAny(doc, c, ids));
}

export { nodeBounds };
