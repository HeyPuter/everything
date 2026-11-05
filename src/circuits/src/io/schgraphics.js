// Turns schematic objects into world-space drawing primitives tagged with a
// role ('wire', 'body', 'pin', ...) that a renderer maps to colors. Used by
// SVG export and printing; the canvas renderer can share it for identical
// output.
//
// Primitive shapes (all in nanometres):
//   {t:'line', x1,y1,x2,y2, w}  {t:'polyline', pts, w, closed?}  {t:'poly', pts, fill, w}
//   {t:'circle', cx,cy,r, w, fill}  {t:'arc', cx,cy,r,a0,sweep, w}
//   {t:'rect', x1,y1,x2,y2, w, fill}  {t:'text', x,y, text, size, rot, align}

import { mil, mm } from '../core/units.js';
import { rotate, norm360 } from '../core/geom.js';
import { placeSymbol, fieldPosition } from '../model/place.js';
import { GROUND_STYLES } from '../model/schema.js';
import { textWidth, uprightText } from '../render/font.js';
import { defOf } from './common.js';

export const SCH_LINE = mil(10);
export const BUS_LINE = mil(30);
export const JUNCTION_R = mil(20);
export const FIELD_SIZE = mil(50);
export const PIN_NAME_SIZE = mil(50);
export const PIN_NUM_SIZE = mil(40);
export const LABEL_SIZE = mil(50);

/** Paper sizes in millimetres, landscape (width >= height). */
export const SHEET_SIZES = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], Letter: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
};

/** Sheet width and height in nanometres. The sheet spans (0,0) to (w,h). */
export function sheetSize(sheet = {}) {
  const [a, b] = SHEET_SIZES[sheet.size] || SHEET_SIZES.A4;
  const portrait = sheet.orientation === 'portrait';
  return { w: mm(portrait ? b : a), h: mm(portrait ? a : b) };
}

const BORDER = mm(5); // paper edge to outer frame
const ZONE = mm(5); // zone label strip width

/** Border, zone markers and title block. */
export function sheetFrame(sheet = {}, info = {}) {
  const out = [];
  const { w, h } = sheetSize(sheet);
  if (sheet.showBorder !== false) {
    const o1 = BORDER, i1 = BORDER + ZONE;
    out.push({ t: 'rect', x1: o1, y1: o1, x2: w - o1, y2: h - o1, w: mm(0.3), role: 'frame' });
    out.push({ t: 'rect', x1: i1, y1: i1, x2: w - i1, y2: h - i1, w: mm(0.2), role: 'frame' });
    const cols = Math.max(4, Math.round((w - 2 * i1) / mm(70)));
    const rows = Math.max(4, Math.round((h - 2 * i1) / mm(55)));
    const cw = (w - 2 * i1) / cols, rh = (h - 2 * i1) / rows;
    const size = mm(2.5);
    for (let c = 0; c < cols; c++) {
      const x = i1 + c * cw;
      if (c > 0) {
        out.push({ t: 'line', x1: x, y1: o1, x2: x, y2: i1, w: mm(0.2), role: 'frame' });
        out.push({ t: 'line', x1: x, y1: h - i1, x2: x, y2: h - o1, w: mm(0.2), role: 'frame' });
      }
      const label = String(c + 1);
      out.push({ t: 'text', x: x + cw / 2, y: h - o1 - ZONE / 2, text: label, size, align: { h: 'center', v: 'middle' }, role: 'frame' });
      out.push({ t: 'text', x: x + cw / 2, y: o1 + ZONE / 2, text: label, size, align: { h: 'center', v: 'middle' }, role: 'frame' });
    }
    for (let r = 0; r < rows; r++) {
      const y = h - i1 - r * rh;
      if (r > 0) {
        out.push({ t: 'line', x1: o1, y1: y, x2: i1, y2: y, w: mm(0.2), role: 'frame' });
        out.push({ t: 'line', x1: w - i1, y1: y, x2: w - o1, y2: y, w: mm(0.2), role: 'frame' });
      }
      const label = String.fromCharCode(65 + (r % 26));
      out.push({ t: 'text', x: o1 + ZONE / 2, y: y - rh / 2, text: label, size, align: { h: 'center', v: 'middle' }, role: 'frame' });
      out.push({ t: 'text', x: w - o1 - ZONE / 2, y: y - rh / 2, text: label, size, align: { h: 'center', v: 'middle' }, role: 'frame' });
    }
  }
  if (sheet.showTitleBlock !== false) out.push(...titleBlock(sheet, info, w));
  return out;
}

function titleBlock(sheet, info, w) {
  const out = [];
  const inset = sheet.showBorder === false ? BORDER : BORDER + ZONE;
  const bw = mm(130), rowH = mm(7.5);
  const x2 = w - inset, x1 = x2 - bw, y1 = inset, y2 = y1 + 4 * rowH;
  const lw = mm(0.2);
  out.push({ t: 'rect', x1, y1, x2, y2, w: mm(0.3), role: 'frame' });
  for (let i = 1; i < 4; i++) out.push({ t: 'line', x1, y1: y1 + i * rowH, x2, y2: y1 + i * rowH, w: lw, role: 'frame' });
  const label = (x, y, text) => out.push({ t: 'text', x: x + mm(1.2), y: y - mm(1.2), text, size: mm(1.4), align: { h: 'left', v: 'top' }, role: 'frameLabel' });
  const value = (x, y, text, size = mm(2.2)) => text && out.push({ t: 'text', x: x + mm(1.2), y: y + mm(1.4), text: String(text), size, align: { h: 'left', v: 'bottom' }, role: 'frameText' });
  const split = (row, xs) => {
    for (const x of xs) out.push({ t: 'line', x1: x, y1: y1 + row * rowH, x2: x, y2: y1 + (row + 1) * rowH, w: lw, role: 'frame' });
  };
  // Row 3 (top): title
  label(x1, y2, 'Title');
  value(x1, y1 + 3 * rowH, sheet.title || info.title || '', mm(3));
  // Row 2: company and author
  const mid = x1 + bw * 0.55;
  split(2, [mid]);
  label(x1, y1 + 3 * rowH, 'Company'); value(x1, y1 + 2 * rowH, sheet.company);
  label(mid, y1 + 3 * rowH, 'Drawn by'); value(mid, y1 + 2 * rowH, sheet.author);
  // Row 1: size, revision, sheet number
  const c1 = x1 + bw * 0.25, c2 = x1 + bw * 0.55;
  split(1, [c1, c2]);
  label(x1, y1 + 2 * rowH, 'Size'); value(x1, y1 + rowH, sheet.size || 'A4');
  label(c1, y1 + 2 * rowH, 'Revision'); value(c1, y1 + rowH, sheet.revision);
  const sheetNo = info.sheetNumber ? `${info.sheetNumber} of ${info.sheetCount || info.sheetNumber}` : '';
  label(c2, y1 + 2 * rowH, 'Sheet'); value(c2, y1 + rowH, sheetNo);
  // Row 0: date and file
  split(0, [c1]);
  label(x1, y1 + rowH, 'Date'); value(x1, y1, info.date || '');
  label(c1, y1 + rowH, 'File'); value(c1, y1, info.fileName || '');
  return out;
}

const dirVec = (rot) => {
  const r = norm360(rot);
  return r === 0 ? [1, 0] : r === 90 ? [0, 1] : r === 180 ? [-1, 0] : r === 270 ? [0, -1] : [Math.cos(r * Math.PI / 180), Math.sin(r * Math.PI / 180)];
};

/**
 * Readable text placement for something pointing along direction (dx, dy):
 * text runs horizontally for horizontal directions and vertically (rot 90)
 * for vertical ones, aligned so it grows away from the anchor.
 */
function textAlong(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return { rot: 0, align: { h: dx >= 0 ? 'left' : 'right', v: 'middle' } };
  return { rot: 90, align: { h: dy >= 0 ? 'left' : 'right', v: 'middle' } };
}

/** Primitives for a placed part: body graphics, pins, pin texts, fields. */
export function partPrims(part, def) {
  const out = [];
  if (!def) {
    const s = mil(100);
    out.push({ t: 'rect', x1: part.x - s, y1: part.y - s, x2: part.x + s, y2: part.y + s, w: SCH_LINE, role: 'body' });
    out.push({ t: 'text', x: part.x, y: part.y, text: '?', size: FIELD_SIZE, align: { h: 'center', v: 'middle' }, role: 'body' });
    return out;
  }
  const placed = placeSymbol(def, part);
  for (const g of placed.graphics) {
    if (g.t === 'text') {
      const { rot, align } = uprightText(g.rot || 0, g.align);
      out.push({ t: 'text', x: g.x, y: g.y, text: g.text, size: g.size, rot, align, role: 'bodyText' });
    } else {
      if (g.fill && g.t !== 'line' && g.t !== 'polyline' && g.t !== 'arc') out.push({ ...g, w: 0, role: 'fill', fill: true });
      out.push({ ...g, w: g.w || SCH_LINE, fill: false, role: 'body' });
    }
  }
  for (const p of placed.pins) {
    if (p.hidden) continue;
    const [dx, dy] = dirVec(p.rot);
    out.push({ t: 'line', x1: p.x, y1: p.y, x2: p.bx, y2: p.by, w: SCH_LINE, role: 'pin' });
    const shape = p.shape || 'none';
    const br = mil(15);
    if (shape === 'dot' || shape === 'dotclock') {
      out.push({ t: 'circle', cx: p.bx - dx * br, cy: p.by - dy * br, r: br, w: SCH_LINE, role: 'pin' });
    }
    if (shape === 'clock' || shape === 'dotclock') {
      const px = -dy, py = dx, s = mil(25);
      out.push({ t: 'polyline', pts: [p.bx + px * s, p.by + py * s, p.bx + dx * mil(40), p.by + dy * mil(40), p.bx - px * s, p.by - py * s], w: SCH_LINE, role: 'pin' });
    }
    if (!p.hideName && p.name) {
      const gap = mil(30) + (shape === 'clock' || shape === 'dotclock' ? mil(40) : 0);
      const { rot, align } = textAlong(dx, dy);
      out.push({ t: 'text', x: p.bx + dx * gap, y: p.by + dy * gap, text: p.name, size: PIN_NAME_SIZE, rot, align, role: 'pinName' });
    }
    if (!p.hideNum && p.num) {
      const mx = (p.x + p.bx) / 2, my = (p.y + p.by) / 2;
      const off = mil(8);
      if (Math.abs(dx) >= Math.abs(dy)) out.push({ t: 'text', x: mx, y: my + off, text: p.num, size: PIN_NUM_SIZE, rot: 0, align: { h: 'center', v: 'bottom' }, role: 'pinNum' });
      else out.push({ t: 'text', x: mx - off, y: my, text: p.num, size: PIN_NUM_SIZE, rot: 90, align: { h: 'center', v: 'bottom' }, role: 'pinNum' });
    }
  }
  const des = fieldPosition(part, 'designator', def);
  if (!des.hidden && part.designator) out.push({ t: 'text', x: des.x, y: des.y, text: part.designator, size: FIELD_SIZE, rot: 0, align: { h: 'left', v: 'bottom' }, role: 'designator' });
  const value = part.value ?? def.value;
  const val = fieldPosition(part, 'value', def);
  if (!val.hidden && value) out.push({ t: 'text', x: val.x, y: val.y, text: value, size: FIELD_SIZE, rot: 0, align: { h: 'left', v: 'bottom' }, role: 'value' });
  return out;
}

/** Power port drawing. Supply styles point up at rot 0; ground styles point down. */
export function powerPrims(o) {
  const out = [];
  const style = o.style || (GROUND_STYLES.has(o.net) ? 'gnd' : 'bar');
  const ground = GROUND_STYLES.has(style);
  const s = (v) => mil(v);
  const local = [];
  const L = (x1, y1, x2, y2) => local.push({ t: 'line', x1: s(x1), y1: s(y1), x2: s(x2), y2: s(y2) });
  let textAt;
  switch (style) {
    case 'arrow':
      L(0, 0, 0, 50);
      local.push({ t: 'poly', pts: [s(-35), s(50), s(35), s(50), 0, s(100)], fill: true });
      textAt = 120; break;
    case 'circle':
      L(0, 0, 0, 50);
      local.push({ t: 'circle', cx: 0, cy: s(70), r: s(20) });
      textAt = 110; break;
    case 'wave': {
      L(0, 0, 0, 50);
      const pts = [];
      for (let i = 0; i <= 16; i++) { const x = -50 + (100 * i) / 16; pts.push(s(x), s(70 + 15 * Math.sin((i / 16) * Math.PI * 2))); }
      local.push({ t: 'polyline', pts });
      textAt = 110; break;
    }
    case 'gnd':
      L(0, 0, 0, -50); L(-50, -50, 50, -50); L(-30, -70, 30, -70); L(-10, -90, 10, -90);
      textAt = -120; break;
    case 'signalgnd':
      L(0, 0, 0, -50);
      local.push({ t: 'poly', pts: [s(-50), s(-50), s(50), s(-50), 0, s(-100)], fill: false });
      textAt = -125; break;
    case 'earth':
      L(0, 0, 0, -50); L(-50, -50, 50, -50); L(-50, -50, -70, -80); L(0, -50, -20, -80); L(50, -50, 30, -80);
      textAt = -110; break;
    default: // bar
      L(0, 0, 0, 70); L(-50, 70, 50, 70);
      textAt = 100; break;
  }
  const rot = norm360(o.rot || 0);
  const tp = (x, y) => { const [rx, ry] = rotate(x, y, rot); return [o.x + Math.round(rx), o.y + Math.round(ry)]; };
  for (const g of local) {
    if (g.t === 'line') {
      const [x1, y1] = tp(g.x1, g.y1), [x2, y2] = tp(g.x2, g.y2);
      out.push({ t: 'line', x1, y1, x2, y2, w: SCH_LINE, role: 'power' });
    } else if (g.t === 'circle') {
      const [cx, cy] = tp(g.cx, g.cy);
      out.push({ t: 'circle', cx, cy, r: g.r, w: SCH_LINE, role: 'power' });
    } else {
      const pts = [];
      for (let i = 0; i < g.pts.length; i += 2) pts.push(...tp(g.pts[i], g.pts[i + 1]));
      out.push({ t: g.t, pts, w: SCH_LINE, fill: !!g.fill, closed: g.t === 'poly', role: 'power' });
    }
  }
  if (o.net) {
    const [tx, ty] = tp(0, s(textAt));
    const [dx, dy] = rotate(0, ground ? -1 : 1, rot);
    const align = Math.abs(dx) >= Math.abs(dy)
      ? { h: dx >= 0 ? 'left' : 'right', v: 'middle' }
      : { h: 'center', v: dy >= 0 ? 'bottom' : 'top' };
    out.push({ t: 'text', x: tx, y: ty, text: o.net, size: LABEL_SIZE, rot: 0, align, role: 'powerText' });
  }
  return out;
}

/** Port shape, extending along +x at rot 0 from the connection point. */
export function portPrims(o) {
  const size = LABEL_SIZE;
  const hh = mil(50);
  const len = Math.max(mil(200), Math.round((textWidth(o.name || '', size) + mil(80)) / mil(50)) * mil(50));
  let local;
  switch (o.io) {
    case 'out': local = [0, -hh, len - hh, -hh, len, 0, len - hh, hh, 0, hh]; break;
    case 'in': local = [0, 0, hh, -hh, len, -hh, len, hh, hh, hh]; break;
    case 'bidir': local = [0, 0, hh, -hh, len - hh, -hh, len, 0, len - hh, hh, hh, hh]; break;
    default: local = [0, -hh, len, -hh, len, hh, 0, hh];
  }
  const rot = norm360(o.rot || 0);
  const pts = [];
  for (let i = 0; i < local.length; i += 2) {
    const [rx, ry] = rotate(local[i], local[i + 1], rot);
    pts.push(o.x + Math.round(rx), o.y + Math.round(ry));
  }
  const [cx, cy] = rotate(len / 2, 0, rot);
  return [
    { t: 'poly', pts, fill: true, w: 0, role: 'portFill' },
    { t: 'polyline', pts, closed: true, w: SCH_LINE, role: 'port' },
    { t: 'text', x: o.x + Math.round(cx), y: o.y + Math.round(cy), text: o.name || '', size, rot: rot % 180 === 0 ? 0 : 90, align: { h: 'center', v: 'middle' }, role: 'portText' },
  ];
}

/** Net label text sitting just above its anchor point. */
export function labelPrims(o) {
  const rot = norm360(o.rot || 0);
  const vertical = rot === 90 || rot === 270;
  const flipped = rot === 180 || rot === 270;
  const off = mil(8);
  const x = vertical ? o.x - off : o.x, y = vertical ? o.y : o.y + off;
  return [{ t: 'text', x, y, text: o.text || '', size: LABEL_SIZE, rot: vertical ? 90 : 0, align: { h: flipped ? 'right' : 'left', v: 'bottom' }, role: 'label' }];
}

/**
 * Primitives for any schematic object.
 * @param {object} o schematic object
 * @param {Map|object} library component definitions
 */
export function schObjectPrims(o, library) {
  switch (o.t) {
    case 'part': return partPrims(o, defOf(library, o.comp));
    case 'wire': return [{ t: 'polyline', pts: o.pts, w: SCH_LINE, role: 'wire' }];
    case 'bus': return [{ t: 'polyline', pts: o.pts, w: BUS_LINE, role: 'bus' }];
    case 'junction': return [{ t: 'circle', cx: o.x, cy: o.y, r: JUNCTION_R, w: 0, fill: true, role: 'junction' }];
    case 'label': return labelPrims(o);
    case 'power': return powerPrims(o);
    case 'port': return portPrims(o);
    case 'noerc': {
      const a = mil(30);
      return [
        { t: 'line', x1: o.x - a, y1: o.y - a, x2: o.x + a, y2: o.y + a, w: SCH_LINE, role: 'noerc' },
        { t: 'line', x1: o.x - a, y1: o.y + a, x2: o.x + a, y2: o.y - a, w: SCH_LINE, role: 'noerc' },
      ];
    }
    case 'text': {
      const { rot, align } = uprightText(o.rot || 0, { h: 'left', v: 'bottom' });
      return [{ t: 'text', x: o.x, y: o.y, text: o.text || '', size: o.size || LABEL_SIZE, rot, align, role: 'text' }];
    }
    case 'gline': return [{ t: 'polyline', pts: o.pts, w: o.w || SCH_LINE, role: 'graphic' }];
    case 'grect': {
      const out = [];
      if (o.fill) out.push({ t: 'rect', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: 0, fill: true, role: 'graphicFill' });
      out.push({ t: 'rect', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: o.w || SCH_LINE, fill: false, role: 'graphic' });
      return out;
    }
    case 'gcircle': {
      const out = [];
      if (o.fill) out.push({ t: 'circle', cx: o.cx, cy: o.cy, r: o.r, w: 0, fill: true, role: 'graphicFill' });
      out.push({ t: 'circle', cx: o.cx, cy: o.cy, r: o.r, w: o.w || SCH_LINE, fill: false, role: 'graphic' });
      return out;
    }
    default: return [];
  }
}
