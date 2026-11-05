// Builds schematic drawing batches: the sheet frame and title block, parts,
// wires, junctions, labels, power ports, ports and graphics.

import { pack } from './color.js';
import { mm, mil } from '../core/units.js';
import { rotate } from '../core/geom.js';
import { textWidth } from './font.js';
import { placeSymbol, fieldPosition } from '../model/place.js';
import { sheetExtents } from '../model/project.js';
import { SCH_TEXT, PIN_TEXT, LINE_W, WIRE_W, BUS_W, JUNCTION_R, powerShape, portPolygon, fieldText } from '../model/sch.js';

const PIN_NUM_TEXT = mil(50);

/** Frame geometry shared by the renderer and the sheet exporter. */
export function sheetFrame(sheet) {
  const ext = sheetExtents(sheet);
  const W = ext.maxX, H = ext.maxY;
  const band = mm(5);
  const cols = Math.max(2, Math.round(W / mm(70)));
  const rows = Math.max(2, Math.round(H / mm(60)));
  const tbW = Math.min(mm(150), W - band * 2), tbH = mm(32);
  return { W, H, band, cols, rows, tb: { x1: W - band - tbW, y1: band, x2: W - band, y2: band + tbH } };
}

export function drawSheet(b, sheet, pal, info = {}) {
  const { W, H, band, cols, rows, tb } = sheetFrame(sheet);
  b.rect(W / 2, H / 2, W, H, 0, 0, pack(pal.paper));
  if (sheet.showBorder === false) return;
  const c = pack(pal.border), tc = pack(pal.zoneText);
  const lw = mil(10);
  b.rectOutline(0, 0, W, H, lw, c);
  b.rectOutline(band, band, W - band, H - band, lw, c);
  const zt = mm(2.5);
  for (let i = 0; i < cols; i++) {
    const x0 = band + ((W - 2 * band) * i) / cols;
    const xm = band + ((W - 2 * band) * (i + 0.5)) / cols;
    if (i > 0) { b.line(x0, 0, x0, band, lw, c); b.line(x0, H - band, x0, H, lw, c); }
    const label = String(i + 1);
    b.text(label, xm, band / 2, zt, tc, { align: { h: 'center', v: 'middle' } });
    b.text(label, xm, H - band / 2, zt, tc, { align: { h: 'center', v: 'middle' } });
  }
  for (let j = 0; j < rows; j++) {
    const y0 = H - band - ((H - 2 * band) * j) / rows;
    const ym = H - band - ((H - 2 * band) * (j + 0.5)) / rows;
    if (j > 0) { b.line(0, y0, band, y0, lw, c); b.line(W - band, y0, W, y0, lw, c); }
    const label = String.fromCharCode(65 + (j % 26));
    b.text(label, band / 2, ym, zt, tc, { align: { h: 'center', v: 'middle' } });
    b.text(label, W - band / 2, ym, zt, tc, { align: { h: 'center', v: 'middle' } });
  }
  if (sheet.showTitleBlock === false) return;
  // Title block: four rows of labelled cells.
  const { x1, y1, x2, y2 } = tb;
  b.rect((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, 0, 0, pack(pal.paper));
  b.rectOutline(x1, y1, x2, y2, lw, c);
  const rowH = (y2 - y1) / 4;
  for (let r = 1; r < 4; r++) b.line(x1, y1 + rowH * r, x2, y1 + rowH * r, lw, c);
  const w = x2 - x1;
  const split = (yA, yB, fracs) => { let x = x1; for (const f of fracs.slice(0, -1)) { x += w * f; b.line(x, yA, x, yB, lw, c); } };
  split(y1 + rowH * 2, y1 + rowH * 3, [0.25, 0.45, 0.3]);
  split(y1 + rowH, y1 + rowH * 2, [0.4, 0.6]);
  split(y1, y1 + rowH, [0.4, 0.6]);
  const lab = pack(pal.titleText), val = pack(pal.titleValue);
  const ls = mm(1.6), vs = mm(2.6);
  const cell = (x, yTop, cellW, label, value, size = vs) => {
    b.text(label, x + mm(1.2), yTop - mm(1.2), ls, lab, { align: { h: 'left', v: 'top' } });
    if (!value) return;
    // Long values shrink to stay inside their cell (and on the paper).
    const room = cellW - mm(2.4), tw = textWidth(value, size);
    b.text(value, x + mm(1.2), yTop - rowH + mm(1.4), tw > room ? (size * room) / tw : size, val);
  };
  const yT = y2;
  cell(x1, yT, w, 'Title', sheet.title || info.projectName || '', mm(3.4));
  cell(x1, y1 + rowH * 3, w * 0.25, 'Size', sheet.size || 'A4');
  cell(x1 + w * 0.25, y1 + rowH * 3, w * 0.45, 'Number', String(sheet.number ?? ''));
  cell(x1 + w * 0.7, y1 + rowH * 3, w * 0.3, 'Revision', sheet.revision || '');
  cell(x1, y1 + rowH * 2, w * 0.4, 'Date', info.date || '');
  cell(x1 + w * 0.4, y1 + rowH * 2, w * 0.6, 'File', info.fileName || '');
  cell(x1, y1 + rowH, w * 0.4, 'Sheet', info.sheetOf || '');
  cell(x1 + w * 0.4, y1 + rowH, w * 0.6, 'Drawn by', [sheet.author, sheet.company].filter(Boolean).join(', '));
}

function graphicColor(g, pal, stroke) {
  return g.fill === 'body' ? pack(pal.bodyFill) : stroke;
}

function fillBody(b, g, color) {
  switch (g.t) {
    case 'rect': b.rect((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, Math.abs(g.x2 - g.x1), Math.abs(g.y2 - g.y1), 0, 0, color); break;
    case 'circle': b.circle(g.cx, g.cy, g.r, color); break;
    case 'poly': b.poly([g.pts], color); break;
    default:
  }
}

/** Draws a world-space graphic primitive. */
export function drawGraphic(b, g, stroke, pal, defaultW = LINE_W) {
  const w = g.w || defaultW;
  switch (g.t) {
    case 'line': b.line(g.x1, g.y1, g.x2, g.y2, w, stroke); break;
    case 'polyline': b.polyline(g.pts, w, stroke); break;
    case 'poly':
      if (g.fill) b.poly([g.pts], graphicColor(g, pal, stroke));
      b.polyline(g.pts, w, stroke, true);
      break;
    case 'rect': {
      const x1 = Math.min(g.x1, g.x2), x2 = Math.max(g.x1, g.x2), y1 = Math.min(g.y1, g.y2), y2 = Math.max(g.y1, g.y2);
      if (g.fill) b.rect((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, 0, 0, graphicColor(g, pal, stroke));
      b.rectOutline(x1, y1, x2, y2, w, stroke);
      break;
    }
    case 'circle':
      if (g.fill) b.circle(g.cx, g.cy, g.r, graphicColor(g, pal, stroke));
      b.ring(g.cx, g.cy, g.r, w, stroke);
      break;
    case 'arc': b.arc(g.cx, g.cy, g.r, g.a0, g.sweep, w, stroke); break;
    case 'text': b.text(g.text, g.x, g.y, g.size || SCH_TEXT, stroke, { rot: g.rot || 0, align: g.align, mirror: false, upright: true }); break;
    default:
  }
}

function pinLabelPlacement(p) {
  // Direction into the body, with labels kept readable (no upside-down text).
  const vertical = p.rot === 90 || p.rot === 270;
  return { vertical, rot: vertical ? 90 : 0, forward: p.rot === 0 || p.rot === 90 };
}

export function drawPart(b, o, lib, pal, override) {
  const def = lib[o.comp];
  if (!def) {
    const c = pack(pal.ercError);
    b.rectOutline(o.x - mil(200), o.y - mil(200), o.x + mil(200), o.y + mil(200), LINE_W, c);
    b.text(`${o.designator}: missing`, o.x - mil(200), o.y + mil(250), SCH_TEXT, c);
    return;
  }
  const pl = placeSymbol(def, o);
  const body = override ?? pack(pal.body);
  // Body fills first so every outline and pin draws over them.
  if (!override) for (const g of pl.graphics) if (g.fill === 'body') fillBody(b, g, pack(pal.bodyFill));
  for (const g of pl.graphics) {
    if (g.fill === 'body') drawGraphic(b, { ...g, fill: undefined }, body, pal);
    else drawGraphic(b, g, body, pal);
  }

  const pinC = override ?? pack(pal.pin), nameC = override ?? pack(pal.pinName), numC = override ?? pack(pal.pinNum);
  for (const p of pl.pins) {
    if (p.hidden) continue;
    b.line(p.x, p.y, p.bx, p.by, LINE_W, pinC);
    const dx = Math.sign(p.bx - p.x), dy = Math.sign(p.by - p.y);
    if (p.shape === 'dot' || p.shape === 'dotclock') {
      const r = mil(25);
      b.ring(p.bx - dx * r, p.by - dy * r, r, LINE_W, pinC);
    }
    if (p.shape === 'clock' || p.shape === 'dotclock') {
      const s = mil(40);
      const nx = -dy, ny = dx;
      b.polyline([p.bx + nx * s, p.by + ny * s, p.bx + dx * s * 1.4, p.by + dy * s * 1.4, p.bx - nx * s, p.by - ny * s], LINE_W, pinC);
    }
    const lp = pinLabelPlacement(p);
    if (!p.hideName && p.name && def.symbol.showPinNames !== false) {
      const off = mil(50);
      const x = p.bx + dx * off, y = p.by + dy * off;
      b.text(p.name, x, y, PIN_TEXT, nameC, { rot: lp.rot, align: { h: lp.forward ? 'left' : 'right', v: 'middle' } });
    }
    if (!p.hideNum && def.symbol.showPinNumbers !== false) {
      const mx = (p.x + p.bx) / 2, my = (p.y + p.by) / 2;
      const off = mil(15);
      if (lp.vertical) b.text(p.num, mx - off, my, PIN_NUM_TEXT, numC, { rot: 90, align: { h: 'center', v: 'bottom' } });
      else b.text(p.num, mx, my + off, PIN_NUM_TEXT, numC, { align: { h: 'center', v: 'bottom' } });
    }
  }
  for (const name of ['designator', 'value']) {
    const f = fieldPosition(o, name, def);
    const txt = fieldText(o, name);
    if (f.hidden || !txt) continue;
    b.text(txt, f.x, f.y, SCH_TEXT, override ?? pack(name === 'designator' ? pal.designator : pal.value));
  }
  if (o.dnp) {
    const c = pack(pal.ercError, 0.8);
    const box = pl.pins.length ? pl.pins : [{ x: o.x, y: o.y }];
    const xs = box.map((p) => p.x), ys = box.map((p) => p.y);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    b.line(x1, y1, x2, y2, mil(12), c); b.line(x1, y2, x2, y1, mil(12), c);
  }
}

export function drawPower(b, o, pal, override) {
  const s = powerShape(o.style);
  const c = override ?? pack(pal.power);
  const T = (x, y) => { const [rx, ry] = rotate(x, y, o.rot || 0); return [o.x + rx, o.y + ry]; };
  for (const [x1, y1, x2, y2] of s.lines) { const [a, bb] = T(x1, y1), [cc, d] = T(x2, y2); b.line(a, bb, cc, d, LINE_W, c); }
  for (const pts of s.polys) {
    const out = [];
    for (let i = 0; i < pts.length; i += 2) out.push(...T(pts[i], pts[i + 1]));
    if (!s.hollow) b.poly([out], c);
    b.polyline(out, LINE_W, c, true);
  }
  for (const [cx, cy, r] of s.circles) { const [x, y] = T(cx, cy); b.ring(x, y, r, LINE_W, c); }
  if (s.wave) { const out = []; for (let i = 0; i < s.wave.length; i += 2) out.push(...T(s.wave[i], s.wave[i + 1])); b.polyline(out, LINE_W, c); }
  // Label stays horizontal; position follows the rotated symbol.
  const [tx, ty] = T(s.textPos.x, s.textPos.y);
  const r = o.rot || 0;
  let align = s.textPos.align;
  if (r === 90) align = { h: s.below ? 'left' : 'right', v: 'middle' };
  else if (r === 270) align = { h: s.below ? 'right' : 'left', v: 'middle' };
  else if (r === 180) align = { h: 'center', v: align.v === 'top' ? 'bottom' : 'top' };
  b.text(o.net, tx, ty, SCH_TEXT, c, { align });
}

export function drawPort(b, o, pal, override) {
  const { pts } = portPolygon(o);
  if (!override) b.poly([pts], pack(pal.portFill));
  const c = override ?? pack(pal.portStroke);
  b.polyline(pts, LINE_W, c, true);
  const { w } = portPolygon(o);
  const [mx, my] = rotate(w / 2, 0, o.rot || 0);
  const vertical = o.rot === 90 || o.rot === 270;
  b.text(o.name, o.x + mx, o.y + my, SCH_TEXT * 0.9, override ?? pack(pal.portText), { rot: vertical ? 90 : 0, align: { h: 'center', v: 'middle' } });
}

export function drawLabel(b, o, pal, override) {
  const c = override ?? pack(pal.label);
  const r = o.rot || 0;
  const vertical = r === 90 || r === 270;
  const back = r === 180 || r === 270;
  const off = mil(15);
  const [ox, oy] = vertical ? [-off, 0] : [0, off];
  b.text(o.text, o.x + ox, o.y + oy, SCH_TEXT, c, { rot: vertical ? 90 : 0, align: { h: back ? 'right' : 'left', v: 'bottom' } });
}

/** Draws one schematic object. override packs a single color for everything. */
export function drawSchObject(b, o, lib, pal, override) {
  switch (o.t) {
    case 'part': drawPart(b, o, lib, pal, override); break;
    case 'wire': b.polyline(o.pts, WIRE_W, override ?? pack(pal.wire)); break;
    case 'bus': b.polyline(o.pts, BUS_W, override ?? pack(pal.bus)); break;
    case 'junction': b.circle(o.x, o.y, JUNCTION_R, override ?? pack(pal.junction)); break;
    case 'label': drawLabel(b, o, pal, override); break;
    case 'power': drawPower(b, o, pal, override); break;
    case 'port': drawPort(b, o, pal, override); break;
    case 'noerc': {
      const c = override ?? pack(pal.noerc), s = mil(35);
      b.line(o.x - s, o.y - s, o.x + s, o.y + s, mil(10), c); b.line(o.x - s, o.y + s, o.x + s, o.y - s, mil(10), c);
      break;
    }
    case 'text': b.text(o.text, o.x, o.y, o.size || SCH_TEXT, override ?? pack(pal.text), { rot: o.rot || 0 }); break;
    case 'gline': b.polyline(o.pts, o.w || LINE_W, override ?? pack(pal.graphic)); break;
    case 'grect': drawGraphic(b, { t: 'rect', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: o.w, fill: o.fill ? 'body' : undefined }, override ?? pack(pal.graphic), pal); break;
    case 'gcircle': drawGraphic(b, { t: 'circle', cx: o.cx, cy: o.cy, r: o.r, w: o.w, fill: o.fill ? 'body' : undefined }, override ?? pack(pal.graphic), pal); break;
    default:
  }
}

/**
 * Builds the static sheet batch.
 * opts: { hidden?: Set<id>, junctions?: [x,y][], info?: {...} }
 */
export function buildSchematic(b, doc, lib, pal, opts = {}) {
  b.clear();
  // The paper can go in its own batch so the grid draws between paper and objects.
  const sb = opts.sheetBatch || b;
  if (opts.sheetBatch) sb.clear();
  drawSheet(sb, doc.sheet || {}, pal, opts.info);
  if (opts.sheetBatch) sb.touch();
  const hidden = opts.hidden;
  const order = { grect: 0, gcircle: 0, gline: 1, text: 1, wire: 2, bus: 2, part: 3, power: 4, port: 4, label: 5, noerc: 6, junction: 7 };
  const objs = [...doc.items()].filter((o) => !hidden?.has(o.id)).sort((a, c) => (order[a.t] ?? 9) - (order[c.t] ?? 9));
  for (const o of objs) drawSchObject(b, o, lib, pal);
  const jc = pack(pal.junction);
  for (const [x, y] of opts.junctions || []) b.circle(x, y, JUNCTION_R, jc);
  b.touch();
}
