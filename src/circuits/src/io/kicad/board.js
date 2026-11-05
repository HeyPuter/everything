// Board import: layers, nets, footprints (as component definitions plus
// placed components), tracks, arcs, vias, zones, graphics and the board
// outline from the Edge.Cuts layer.
//
// Board files have y pointing down; it is negated here. Footprints on the
// bottom side are stored already flipped, so their geometry is mirrored back
// (x negated) to give a top-side definition; the component then carries
// side 'bottom' and the original rotation.

import { parseSexpr, find, findAll, val, hasFlag, points, property } from './sexpr.js';
import { nm, norm360, slug, arcFrom3, arcPoints, flipName, fontSize, strokeWidth, LAYER_MAP } from './common.js';
import { uid } from '../../core/emitter.js';
import { arcToPoints, circleToPoly, polyArea, pointInPoly, bboxOfFlat, bboxEmpty, bboxAdd, rotate } from '../../core/geom.js';
import { defaultBoard } from '../../model/project.js';
import { copperLayers } from '../../model/layers.js';

const EDGE_TOL = 10_000; // 0.01 mm when joining outline segments

const ensureCcw = (pts) => (polyArea(pts) < 0 ? reverse(pts) : pts);
const ensureCw = (pts) => (polyArea(pts) > 0 ? reverse(pts) : pts);
function reverse(pts) {
  const out = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** Splits an arc given by three points (already in y-up nm) into a point list from p1 to p3. */
function arcPolyline(p1, p2, p3) {
  const a = arcFrom3(p1, p2, p3);
  if (!a) return [p1, p3];
  const pts = arcToPoints(a.cx, a.cy, a.r, a.a0, a.sweep, 2000);
  const list = [];
  for (let i = 0; i < pts.length; i += 2) list.push([Math.round(pts[i]), Math.round(pts[i + 1])]);
  // arcToPoints runs counter-clockwise; make it start at p1.
  const d0 = Math.hypot(list[0][0] - p1[0], list[0][1] - p1[1]);
  const d1 = Math.hypot(list[list.length - 1][0] - p1[0], list[list.length - 1][1] - p1[1]);
  return d1 < d0 ? list.reverse() : list;
}

/** Joins open outline pieces into closed loops. */
function chainLoops(pieces, closed, warnings) {
  const loops = closed.map((l) => l);
  const open = pieces.map((p) => p.slice());
  const near = (a, b) => Math.abs(a[0] - b[0]) <= EDGE_TOL && Math.abs(a[1] - b[1]) <= EDGE_TOL;
  while (open.length) {
    let chain = open.pop();
    let grew = true;
    while (grew && !near(chain[0], chain[chain.length - 1])) {
      grew = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        if (near(p[0], end)) { chain = chain.concat(p.slice(1)); open.splice(i, 1); grew = true; break; }
        if (near(p[p.length - 1], end)) { chain = chain.concat(p.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
      }
    }
    if (!near(chain[0], chain[chain.length - 1])) warnings.add('The board outline has a gap; it was closed with a straight edge.');
    else chain.pop();
    if (chain.length >= 3) loops.push(chain.flat());
  }
  return loops;
}

export function importBoard(file, warnings) {
  let root;
  try { root = parseSexpr(file.text); } catch (err) { warnings.add(`${file.name}: ${err.message}`); return null; }
  if (root[0] !== 'kicad_pcb') { warnings.add(`${file.name} is not a board file.`); return null; }

  // Nets.
  const netTable = new Map();
  for (const n of findAll(root, 'net')) netTable.set(n[1], String(n[2] ?? ''));
  const cleanNet = (s) => String(s || '').replace(/^\//, '');
  const netOf = (item) => {
    const c = find(item, 'net');
    if (!c) return '';
    if (typeof c[2] === 'string') return cleanNet(c[2]);
    if (typeof c[1] === 'string') return cleanNet(c[1]);
    return cleanNet(netTable.get(c[1]));
  };

  // Copper layers present.
  const layerNames = (find(root, 'layers') || []).slice(1).filter(Array.isArray).map((l) => String(l[1]));
  const innerCount = layerNames.filter((n) => /^In\d+\.Cu$/.test(n)).length;
  if (innerCount > 4) warnings.add(`The board has ${innerCount} inner layers; layers after the fourth were dropped.`);
  const copper = innerCount === 0 ? 2 : innerCount <= 2 ? 4 : 6;
  const allowed = new Set(copperLayers(copper));
  const mapLayer = (name) => {
    const l = LAYER_MAP[name];
    if (!l) return null;
    if (['top', 'bottom', 'in1', 'in2', 'in3', 'in4'].includes(l) && !allowed.has(l)) return null;
    return l;
  };
  const P = (x, y) => [nm(x), -nm(y)];

  const objects = [];
  const fpDefs = new Map();
  const comps = [];
  const edgePieces = [], edgeClosed = [];

  // ---- Footprints ----
  for (const fp of [...findAll(root, 'footprint'), ...findAll(root, 'module')]) {
    const fpName = String(fp[1]);
    const bottom = val(fp, 'layer') === 'B.Cu';
    const at = find(fp, 'at') || ['at', 0, 0, 0];
    const theta = Number(at[3]) || 0;
    const [X, Y] = P(at[1], at[2]);
    const toDef = (kx, ky) => (bottom ? [nm(-kx), nm(-ky)] : [nm(kx), nm(-ky)]);
    const defLayer = (name) => mapLayer(bottom ? flipName(name) : name);
    const localRot = (a) => norm360(bottom ? -(a - theta) : a - theta);

    let ref = '', value = '';
    const fields = {};
    const fieldFrom = (item, kind, text) => {
      const fat = find(item, 'at');
      if (!fat) return;
      const [lx, ly] = [nm(fat[1]), -nm(fat[2])];
      const [rx, ry] = rotate(lx, ly, theta);
      const lay = String(val(item, 'layer', 1, ''));
      const hidden = hasFlag(item, 'hide') || hasFlag(find(item, 'effects'), 'hide') || (kind === 'value' && !/Silk/.test(lay));
      fields[kind] = { dx: Math.round(rx), dy: Math.round(ry), h: nm(fontSize(item, 1)), rot: norm360(Number(fat[3]) || 0), ...(hidden ? { hidden: true } : {}) };
      if (kind === 'designator') ref = String(text);
      else value = String(text);
    };
    for (const t of findAll(fp, 'fp_text')) {
      if (t[1] === 'reference') fieldFrom(t, 'designator', t[2]);
      else if (t[1] === 'value') fieldFrom(t, 'value', t[2]);
    }
    const refProp = property(fp, 'Reference'), valProp = property(fp, 'Value');
    if (refProp) fieldFrom(refProp, 'designator', refProp[2]);
    if (valProp) fieldFrom(valProp, 'value', valProp[2]);

    const key = `${fpName}|${value}`;
    let def = fpDefs.get(key);
    const padNets = {};
    const pads = [];
    for (const pad of findAll(fp, 'pad')) {
      const num = String(pad[1] ?? '');
      const type = String(pad[2]);
      const shape = String(pad[3]);
      const pat = find(pad, 'at') || ['at', 0, 0, 0];
      const size = find(pad, 'size') || ['size', 1, 1];
      const layers = (find(pad, 'layers') || []).slice(1).map(String);
      const net = netOf(pad);
      if (num && net) padNets[num] = net;
      if (def) continue;
      const [x, y] = toDef(pat[1], pat[2]);
      const w = nm(size[1]), h = nm(size[2] ?? size[1]);
      const out = { num, x, y, w, h, rot: localRot(Number(pat[3]) || 0) };
      if (shape === 'circle') { out.shape = 'round'; out.h = w; } else if (shape === 'oval') out.shape = 'oval';
      else if (shape === 'roundrect') { out.shape = 'roundrect'; out.radius = Number(val(pad, 'roundrect_rratio', 1, 0.25)); } else if (shape === 'rect') out.shape = 'rect';
      else { out.shape = 'rect'; warnings.add(`Pads with shape ${shape} were imported as rectangles.`); }
      if (type === 'thru_hole' || type === 'np_thru_hole') {
        out.side = 'thru';
        const dr = find(pad, 'drill');
        const nums = dr ? dr.slice(1).filter((v) => typeof v === 'number') : [];
        out.drill = nm(nums.length ? Math.min(...nums) : 0.8);
        out.plated = type !== 'np_thru_hole';
        if (dr?.includes('oval')) warnings.add('Slotted holes were imported as round holes.');
      } else {
        const cu = layers.find((l) => l.endsWith('.Cu')) || 'F.Cu';
        const norm = bottom ? flipName(cu) : cu;
        out.side = norm === 'B.Cu' ? 'bottom' : 'top';
        if (!layers.some((l) => l.endsWith('.Paste'))) out.noPaste = true;
      }
      pads.push(out);
    }

    if (!def) {
      const graphics = [];
      for (const item of fp.slice(1)) {
        if (!Array.isArray(item) || !/^fp_/.test(item[0])) continue;
        const lname = String(val(item, 'layer', 1, ''));
        if (lname === 'Edge.Cuts') { warnings.add('Board edge lines inside footprints were skipped.'); continue; }
        const layer = defLayer(lname);
        if (!layer || item[0] === 'fp_text' && item[1] !== 'user') continue;
        const w = nm(strokeWidth(item));
        const filled = (f) => { const t = val(find(item, 'fill'), 'type') ?? val(item, 'fill'); return t === 'solid' || t === 'yes' || (f && t === undefined); };
        switch (item[0]) {
          case 'fp_line': {
            const s = find(item, 'start'), e = find(item, 'end');
            if (s && e) { const [x1, y1] = toDef(s[1], s[2]), [x2, y2] = toDef(e[1], e[2]); graphics.push({ t: 'line', x1, y1, x2, y2, w, layer }); }
            break;
          }
          case 'fp_rect': {
            const s = find(item, 'start'), e = find(item, 'end');
            if (s && e) { const [x1, y1] = toDef(s[1], s[2]), [x2, y2] = toDef(e[1], e[2]); graphics.push({ t: 'rect', x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), w, fill: filled(false) || undefined, layer }); }
            break;
          }
          case 'fp_circle': {
            const c = find(item, 'center'), e = find(item, 'end');
            if (c && e) { const [cx, cy] = toDef(c[1], c[2]), [ex, ey] = toDef(e[1], e[2]); graphics.push({ t: 'circle', cx, cy, r: Math.round(Math.hypot(ex - cx, ey - cy)), w, fill: filled(false) || undefined, layer }); }
            break;
          }
          case 'fp_arc': {
            const ap = arcPoints(item);
            if (ap) {
              const a = arcFrom3(...ap.map(([x, y]) => toDef(x, y)));
              if (a) graphics.push({ t: 'arc', cx: Math.round(a.cx), cy: Math.round(a.cy), r: Math.round(a.r), a0: a.a0, sweep: a.sweep, w, layer });
            } else warnings.add('Footprint arcs in an unknown format were skipped.');
            break;
          }
          case 'fp_poly': {
            const pts = points(item).flatMap(([x, y]) => toDef(x, y));
            if (pts.length >= 6) graphics.push({ t: 'poly', pts, w, fill: filled(true) || undefined, layer });
            break;
          }
          case 'fp_text': {
            const fat = find(item, 'at');
            if (!fat) break;
            const [x, y] = toDef(fat[1], fat[2]);
            graphics.push({ t: 'text', x, y, text: String(item[2] ?? ''), size: nm(fontSize(item, 1)), rot: localRot(Number(fat[3]) || 0), align: { h: 'center', v: 'middle' }, layer });
            break;
          }
          case 'fp_curve': warnings.add('Curves in footprints were skipped.'); break;
          default:
        }
      }
      // Courtyard: from courtyard drawings, else the pads plus a margin.
      let cy = bboxEmpty();
      for (const g of graphics) {
        if (g.layer !== 'courtyard') continue;
        for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2], [g.cx - (g.r || 0), g.cy - (g.r || 0)], [g.cx + (g.r || 0), g.cy + (g.r || 0)]]) if (Number.isFinite(x) && Number.isFinite(y)) bboxAdd(cy, x, y);
        for (let i = 0; i < (g.pts || []).length; i += 2) bboxAdd(cy, g.pts[i], g.pts[i + 1]);
      }
      if (!(cy.minX <= cy.maxX)) {
        cy = bboxEmpty();
        for (const p of pads) bboxAdd(cy, p.x, p.y, Math.max(p.w, p.h) / 2 + 250_000);
      }
      let fab = bboxEmpty();
      for (const g of graphics) if (g.layer === 'mech1') {
        for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) if (Number.isFinite(x)) bboxAdd(fab, x, y);
        for (let i = 0; i < (g.pts || []).length; i += 2) bboxAdd(fab, g.pts[i], g.pts[i + 1]);
      }
      if (!(fab.minX <= fab.maxX)) fab = cy;
      const thru = pads.some((p) => p.side === 'thru');
      const footprint = {
        name: fpName.split(':').pop(), description: `Imported footprint ${fpName}`, pads, graphics,
        courtyard: cy.minX <= cy.maxX ? { x1: cy.minX, y1: cy.minY, x2: cy.maxX, y2: cy.maxY } : undefined,
        body: fab.minX <= fab.maxX ? { w: fab.maxX - fab.minX, h: fab.maxY - fab.minY, height: thru ? 3_000_000 : 1_000_000, color: '#2a2a2a', x: Math.round((fab.minX + fab.maxX) / 2), y: Math.round((fab.minY + fab.maxY) / 2) } : undefined,
      };
      const prefix = (ref.match(/^[A-Za-z_]+/) || ['U'])[0];
      def = {
        id: `kicad-fp-${slug(fpName)}${value ? `-${slug(value)}` : ''}`, name: footprint.name, description: footprint.description,
        category: 'Imported', prefix, value, params: {}, keywords: [], symbol: { pins: [], graphics: [] }, footprint,
      };
      fpDefs.set(key, def);
    }

    const comp = {
      id: uid(), t: 'comp', comp: def.id, x: X, y: Y, rot: norm360(theta), side: bottom ? 'bottom' : 'top',
      designator: ref, value, uid: uid('u'), padNets, ...(hasFlag(fp, 'locked') ? { locked: true } : {}),
    };
    if (Object.keys(fields).length) comp.fields = fields;
    objects.push(comp);
    comps.push({ comp, def, ref, fpName });
  }

  // ---- Tracks, vias, zones ----
  for (const item of root.slice(1)) {
    if (!Array.isArray(item)) continue;
    switch (item[0]) {
      case 'segment': {
        const layer = mapLayer(val(item, 'layer'));
        const s = find(item, 'start'), e = find(item, 'end');
        if (!layer || !s || !e) break;
        const [x1, y1] = P(s[1], s[2]), [x2, y2] = P(e[1], e[2]);
        objects.push({ id: uid(), t: 'track', layer, x1, y1, x2, y2, w: nm(val(item, 'width', 1, 0.25)), ...(netOf(item) ? { net: netOf(item) } : {}) });
        break;
      }
      case 'arc': {
        const layer = mapLayer(val(item, 'layer'));
        const s = find(item, 'start'), m = find(item, 'mid'), e = find(item, 'end');
        if (!layer || !s || !m || !e) break;
        const a = arcFrom3(P(s[1], s[2]), P(m[1], m[2]), P(e[1], e[2]));
        if (!a) break;
        objects.push({ id: uid(), t: 'arc', layer, cx: Math.round(a.cx), cy: Math.round(a.cy), r: Math.round(a.r), a0: a.a0, sweep: a.sweep, w: nm(val(item, 'width', 1, 0.25)), ...(netOf(item) ? { net: netOf(item) } : {}) });
        break;
      }
      case 'via': {
        const at = find(item, 'at');
        if (!at) break;
        if (item.includes('blind') || item.includes('micro')) warnings.add('Blind and micro vias were imported as through vias.');
        const [x, y] = P(at[1], at[2]);
        objects.push({ id: uid(), t: 'via', x, y, d: nm(val(item, 'size', 1, 0.6)), drill: nm(val(item, 'drill', 1, 0.3)), from: 'top', to: 'bottom', ...(netOf(item) ? { net: netOf(item) } : {}) });
        break;
      }
      case 'zone': {
        const poly = find(item, 'polygon');
        const pts = poly ? points(poly).flatMap(([x, y]) => P(x, y)) : [];
        if (pts.length < 6) break;
        const ccw = ensureCcw(pts);
        if (find(item, 'keepout')) { objects.push({ id: uid(), t: 'region', layer: 'keepout', pts: ccw }); break; }
        const names = [val(item, 'layer'), ...((find(item, 'layers') || []).slice(1))].filter(Boolean).map(String);
        const layers = new Set();
        for (const n of names) {
          if (n === '*.Cu') copperLayers(copper).forEach((l) => layers.add(l));
          else if (n === 'F&B.Cu') { layers.add('top'); layers.add('bottom'); } else { const l = mapLayer(n); if (l) layers.add(l); }
        }
        const net = cleanNet(val(item, 'net_name', 1, '')) || netOf(item);
        const cp = find(item, 'connect_pads');
        const mode = cp && typeof cp[1] === 'string' ? cp[1] : null;
        if (mode === 'no') warnings.add('Zones that do not connect to pads were imported with thermal connections.');
        const clearance = nm(val(cp, 'clearance', 1, 0.5));
        for (const layer of layers) {
          objects.push({ id: uid(), t: 'pour', layer, pts: ccw, net, clearance, minWidth: nm(val(item, 'min_thickness', 1, 0)), thermals: mode !== 'yes', removeIslands: true, priority: -(Number(val(item, 'priority', 1, 0)) || 0), name: String(val(item, 'name', 1, net || 'Pour')) });
        }
        break;
      }
      case 'gr_line': case 'gr_arc': case 'gr_circle': case 'gr_rect': case 'gr_poly': {
        const lname = String(val(item, 'layer', 1, ''));
        if (lname === 'Edge.Cuts') { collectEdge(item, P, edgePieces, edgeClosed); break; }
        const layer = mapLayer(lname);
        if (!layer) break;
        objects.push(...graphicObjects(item, layer, P));
        break;
      }
      case 'gr_text': {
        const layer = mapLayer(String(val(item, 'layer', 1, '')));
        const at = find(item, 'at');
        if (!layer || !at) break;
        const [x, y] = P(at[1], at[2]);
        const h = nm(fontSize(item, 1));
        const thick = find(find(find(item, 'effects'), 'font'), 'thickness');
        const mirror = (find(find(item, 'effects'), 'justify') || []).includes('mirror');
        objects.push({ id: uid(), t: 'text', layer, x, y, text: String(item[1] ?? ''), h, w: thick ? nm(thick[1]) : Math.round(h * 0.15), rot: norm360(Number(at[3]) || 0), mirror, align: { h: 'center', v: 'middle' } });
        break;
      }
      case 'dimension': warnings.add('Dimensions were skipped.'); break;
      case 'gr_curve': warnings.add('Curves drawn on the board were skipped.'); break;
      case 'target': case 'image': warnings.add(`Board ${item[0]} objects were skipped.`); break;
      default:
    }
  }

  // ---- Outline ----
  const loops = chainLoops(edgePieces, edgeClosed, warnings).map((l) => l.map(Math.round));
  let outline, cutouts = [];
  if (loops.length) {
    loops.sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
    outline = ensureCcw(loops[0]);
    for (const l of loops.slice(1)) {
      if (pointInPoly(l[0], l[1], outline)) cutouts.push(ensureCw(l));
      else warnings.add('An outline loop outside the main board was ignored.');
    }
  } else {
    warnings.add('The board has no Edge.Cuts outline; a rectangle around the design was used.');
    const b = bboxEmpty();
    for (const c of comps) bboxAdd(b, c.comp.x, c.comp.y, 2_000_000);
    for (const o of objects) if (o.t === 'track') { bboxAdd(b, o.x1, o.y1, 1_000_000); bboxAdd(b, o.x2, o.y2, 1_000_000); }
    if (!(b.minX <= b.maxX)) { b.minX = 0; b.minY = 0; b.maxX = 50e6; b.maxY = 40e6; }
    outline = [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY].map(Math.round);
  }
  const setup = find(root, 'setup');
  const aux = find(setup, 'aux_axis_origin');
  const ob = bboxOfFlat(outline);
  const origin = aux && (aux[1] || aux[2]) ? { x: nm(aux[1]), y: -nm(aux[2]) } : { x: ob.minX, y: ob.minY };
  const board = {
    ...defaultBoard(), outline, cutouts, origin, copper,
    thickness: nm(val(find(root, 'general'), 'thickness', 1, 1.6)),
  };
  const mask = val(setup, 'pad_to_mask_clearance');
  const nets = {};
  for (const name of netTable.values()) { const n = cleanNet(name); if (n) nets[n] = {}; }
  for (const c of comps) for (const n of Object.values(c.comp.padNets)) if (n && !nets[n]) nets[n] = {};
  return {
    name: file.name.replace(/\.kicad_pcb$/i, '.pcb'), board, objects, nets, comps, fpDefs,
    rulesPatch: mask !== undefined ? { maskExpansion: nm(mask) } : {},
  };
}

function collectEdge(item, P, pieces, closed) {
  switch (item[0]) {
    case 'gr_line': {
      const s = find(item, 'start'), e = find(item, 'end');
      if (s && e) pieces.push([P(s[1], s[2]), P(e[1], e[2])]);
      break;
    }
    case 'gr_arc': {
      const ap = arcPoints(item);
      if (ap) pieces.push(arcPolyline(...ap.map(([x, y]) => P(x, y))));
      break;
    }
    case 'gr_rect': {
      const s = find(item, 'start'), e = find(item, 'end');
      if (s && e) { const [x1, y1] = P(s[1], s[2]), [x2, y2] = P(e[1], e[2]); closed.push([x1, y1, x2, y1, x2, y2, x1, y2]); }
      break;
    }
    case 'gr_circle': {
      const c = find(item, 'center'), e = find(item, 'end');
      if (c && e) { const [cx, cy] = P(c[1], c[2]), [ex, ey] = P(e[1], e[2]); closed.push(circleToPoly(cx, cy, Math.hypot(ex - cx, ey - cy), 2000)); }
      break;
    }
    case 'gr_poly': {
      const pts = points(item).flatMap(([x, y]) => P(x, y));
      if (pts.length >= 6) closed.push(pts);
      break;
    }
    default:
  }
}

function graphicObjects(item, layer, P) {
  const w = nm(strokeWidth(item)) || 150_000;
  const fill = val(find(item, 'fill'), 'type') ?? val(item, 'fill');
  const solid = fill === 'solid' || fill === 'yes';
  const track = (a, b) => ({ id: uid(), t: 'track', layer, x1: a[0], y1: a[1], x2: b[0], y2: b[1], w });
  switch (item[0]) {
    case 'gr_line': {
      const s = find(item, 'start'), e = find(item, 'end');
      return s && e ? [track(P(s[1], s[2]), P(e[1], e[2]))] : [];
    }
    case 'gr_arc': {
      const ap = arcPoints(item);
      if (!ap) return [];
      const a = arcFrom3(...ap.map(([x, y]) => P(x, y)));
      return a ? [{ id: uid(), t: 'arc', layer, cx: Math.round(a.cx), cy: Math.round(a.cy), r: Math.round(a.r), a0: a.a0, sweep: a.sweep, w }] : [];
    }
    case 'gr_circle': {
      const c = find(item, 'center'), e = find(item, 'end');
      if (!c || !e) return [];
      const [cx, cy] = P(c[1], c[2]), [ex, ey] = P(e[1], e[2]);
      const r = Math.round(Math.hypot(ex - cx, ey - cy));
      if (solid) return [{ id: uid(), t: 'region', layer, pts: circleToPoly(cx, cy, r, 2000).map(Math.round) }];
      return [{ id: uid(), t: 'arc', layer, cx, cy, r, a0: 0, sweep: 360, w }];
    }
    case 'gr_rect': {
      const s = find(item, 'start'), e = find(item, 'end');
      if (!s || !e) return [];
      const [x1, y1] = P(s[1], s[2]), [x2, y2] = P(e[1], e[2]);
      if (solid) return [{ id: uid(), t: 'region', layer, pts: ensureCcw([x1, y1, x2, y1, x2, y2, x1, y2]) }];
      return [track([x1, y1], [x2, y1]), track([x2, y1], [x2, y2]), track([x2, y2], [x1, y2]), track([x1, y2], [x1, y1])];
    }
    case 'gr_poly': {
      const pts = points(item).flatMap(([x, y]) => P(x, y));
      if (pts.length < 6) return [];
      if (fill !== 'none' && fill !== 'no') return [{ id: uid(), t: 'region', layer, pts: ensureCcw(pts) }];
      const out = [];
      for (let i = 0; i < pts.length; i += 2) {
        const j = (i + 2) % pts.length;
        out.push(track([pts[i], pts[i + 1]], [pts[j], pts[j + 1]]));
      }
      return out;
    }
    default: return [];
  }
}
