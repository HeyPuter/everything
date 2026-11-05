// SVG export of schematic sheets and boards. Text is drawn as stroked paths
// from the same stroke font the canvas uses, so prints match the screen.

import { textStrokes, strokeWidthFor } from '../render/font.js';
import { copperLayers, spanLayers, LAYERS } from '../model/layers.js';
import { bboxEmpty, bboxAdd, bboxValid, norm360 } from '../core/geom.js';
import { sheetSize, sheetFrame, schObjectPrims, JUNCTION_R } from './schgraphics.js';
import { resolveBoard, fieldTexts } from './gerber.js';
import { fillOf } from './common.js';

const n4 = (v) => {
  const s = (Math.round(v * 1e4) / 1e4).toString();
  return s === '-0' ? '0' : s;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const SCH_THEMES = {
  light: {
    paper: '#ffffff', frame: '#8a8270', frameLabel: '#8a8270', frameText: '#202020',
    wire: '#1f4bd1', bus: '#1f4bd1', junction: '#1f4bd1',
    body: '#8b1a10', fill: '#fff4c4', bodyText: '#202020',
    pin: '#303030', pinName: '#303030', pinNum: '#555555', designator: '#1f3f99', value: '#1f3f99',
    label: '#202020', power: '#202020', powerText: '#202020', port: '#8b1a10', portFill: '#fff4c4', portText: '#202020',
    noerc: '#d42020', text: '#202020', graphic: '#303030', graphicFill: '#ececec',
  },
  print: {
    paper: '#ffffff', fill: '#ffffff', portFill: '#ffffff', graphicFill: '#f0f0f0',
  },
};

function themeColors(theme) {
  if (theme === 'print') {
    const out = {};
    for (const k of Object.keys(SCH_THEMES.light)) out[k] = '#000000';
    return { ...out, ...SCH_THEMES.print };
  }
  return SCH_THEMES[theme] || SCH_THEMES.light;
}

/** Maps world nanometres to SVG millimetres. */
function makeMapper(minX, maxY, mirror = false, maxX = 0) {
  return {
    x: (x) => n4((mirror ? maxX - x : x - minX) / 1e6),
    y: (y) => n4((maxY - y) / 1e6),
    w: (w) => n4(w / 1e6),
    mirror,
  };
}

function pointsAttr(m, pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 2) out.push(`${m.x(pts[i])},${m.y(pts[i + 1])}`);
  return out.join(' ');
}

function pathFromPolylines(m, polylines) {
  let d = '';
  for (const s of polylines) {
    if (s.length < 2) continue;
    d += `M${m.x(s[0])} ${m.y(s[1])}`;
    if (s.length === 2) d += 'h0';
    for (let i = 2; i < s.length; i += 2) d += `L${m.x(s[i])} ${m.y(s[i + 1])}`;
  }
  return d;
}

function arcPath(m, cx, cy, r, a0, sweep) {
  const s = (a0 * Math.PI) / 180, e = ((a0 + sweep) * Math.PI) / 180;
  const sx = cx + r * Math.cos(s), sy = cy + r * Math.sin(s);
  const ex = cx + r * Math.cos(e), ey = cy + r * Math.sin(e);
  const large = sweep > 180 ? 1 : 0;
  const flag = m.mirror ? 1 : 0;
  return `M${m.x(sx)} ${m.y(sy)}A${m.w(r)} ${m.w(r)} 0 ${large} ${flag} ${m.x(ex)} ${m.y(ey)}`;
}

/** One primitive to SVG markup. */
function primSvg(m, p, color) {
  const sw = p.w > 0 ? m.w(p.w) : null;
  const stroke = (w = sw) => (w ? ` stroke="${color}" stroke-width="${w}"` : '');
  switch (p.t) {
    case 'line':
      return `<line x1="${m.x(p.x1)}" y1="${m.y(p.y1)}" x2="${m.x(p.x2)}" y2="${m.y(p.y2)}"${stroke(sw || '0.1')}/>`;
    case 'polyline':
      if (!p.pts || p.pts.length < 4) return '';
      return p.closed
        ? `<polygon points="${pointsAttr(m, p.pts)}" fill="none"${stroke(sw || '0.1')}/>`
        : `<polyline points="${pointsAttr(m, p.pts)}" fill="none"${stroke(sw || '0.1')}/>`;
    case 'poly':
      if (!p.pts || p.pts.length < 6) return '';
      return `<polygon points="${pointsAttr(m, p.pts)}" fill="${p.fill ? color : 'none'}"${stroke(p.fill ? sw : sw || '0.1')}/>`;
    case 'rect': {
      const x = Math.min(p.x1, p.x2), y = Math.max(p.y1, p.y2);
      return `<rect x="${m.x(m.mirror ? Math.max(p.x1, p.x2) : x)}" y="${m.y(y)}" width="${m.w(Math.abs(p.x2 - p.x1))}" height="${m.w(Math.abs(p.y2 - p.y1))}" fill="${p.fill ? color : 'none'}"${stroke(p.fill ? sw : sw || '0.1')}/>`;
    }
    case 'circle':
      return `<circle cx="${m.x(p.cx)}" cy="${m.y(p.cy)}" r="${m.w(p.r)}" fill="${p.fill ? color : 'none'}"${stroke(p.fill ? sw : sw || '0.1')}/>`;
    case 'arc':
      if (p.sweep >= 360) return `<circle cx="${m.x(p.cx)}" cy="${m.y(p.cy)}" r="${m.w(p.r)}" fill="none"${stroke(sw || '0.1')}/>`;
      return `<path d="${arcPath(m, p.cx, p.cy, p.r, p.a0, p.sweep)}" fill="none"${stroke(sw || '0.1')}/>`;
    case 'text': {
      if (!p.text || !(p.size > 0)) return '';
      const d = pathFromPolylines(m, textStrokes(p.text, p.x, p.y, p.size, p.rot || 0, p.align, !!p.mirror));
      return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${m.w(p.w > 0 ? p.w : strokeWidthFor(p.size))}"/>` : '';
    }
    default:
      return '';
  }
}

/**
 * Exports a schematic sheet.
 * @param {object} schDoc
 * @param {Map|object} library
 * @param {{theme?:'light'|'print', junctions?:{x:number,y:number}[], frame?:boolean, info?:object}} opts
 */
export function schematicToSvg(schDoc, library, opts = {}) {
  const colors = themeColors(opts.theme || 'light');
  const { w, h } = sheetSize(schDoc.sheet);
  const m = makeMapper(0, h);
  const parts = [];
  const emit = (p) => {
    const color = colors[p.role] || colors.text;
    const s = primSvg(m, p, color);
    if (s) parts.push(s);
  };
  if (opts.frame !== false) for (const p of sheetFrame(schDoc.sheet || {}, { fileName: schDoc.name, ...(opts.info || {}) })) emit(p);
  const objects = schDoc.objects || [];
  // Fills first, then wiring and symbols, so outlines sit on top of fills.
  const prims = [];
  for (const o of objects) for (const p of schObjectPrims(o, library)) prims.push(p);
  for (const p of prims) if (p.fill && /Fill$|^fill$/.test(p.role)) emit(p);
  for (const p of prims) if (!(p.fill && /Fill$|^fill$/.test(p.role))) emit(p);
  for (const j of opts.junctions || []) emit({ t: 'circle', cx: j.x, cy: j.y, r: JUNCTION_R, fill: true, w: 0, role: 'junction' });
  const W = n4(w / 1e6), H = n4(h / 1e6);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" stroke-linecap="round" stroke-linejoin="round">`,
    `<title>${esc(schDoc.sheet?.title || schDoc.name || 'Schematic')}</title>`,
    `<rect width="${W}" height="${H}" fill="${colors.paper}"/>`,
    ...parts,
    '</svg>',
  ].join('\n') + '\n';
}

function padSvg(m, pad, color, expansion = 0) {
  const shape = pad.shape || 'rect';
  const w = pad.w + 2 * expansion;
  const h = (shape === 'round' ? pad.w : pad.h) + 2 * expansion;
  if (w <= 0 || h <= 0) return '';
  if (shape === 'round') return `<circle cx="${m.x(pad.x)}" cy="${m.y(pad.y)}" r="${m.w(w / 2)}" fill="${color}"/>`;
  let r = 0;
  if (shape === 'oval') r = Math.min(w, h) / 2;
  else if (shape === 'roundrect') r = Math.max(0, Math.min(0.5, pad.radius ?? 0.25) * Math.min(pad.w, pad.h) + expansion);
  const cx = m.x(pad.x), cy = m.y(pad.y);
  const rot = norm360(pad.rot || 0);
  const svgRot = m.mirror ? rot : -rot;
  const tr = rot ? ` transform="rotate(${n4(svgRot)} ${cx} ${cy})"` : '';
  const rx = r ? ` rx="${m.w(r)}"` : '';
  return `<rect x="${n4(Number(cx) - w / 2e6)}" y="${n4(Number(cy) - h / 2e6)}" width="${m.w(w)}" height="${m.w(h)}"${rx} fill="${color}"${tr}/>`;
}

function polygonSetPath(m, polygons) {
  let d = '';
  for (const rings of polygons || []) {
    for (const ring of rings || []) {
      if (!ring || ring.length < 6) continue;
      d += `M${m.x(ring[0])} ${m.y(ring[1])}`;
      for (let i = 2; i < ring.length; i += 2) d += `L${m.x(ring[i])} ${m.y(ring[i + 1])}`;
      d += 'Z';
    }
  }
  return d;
}

/**
 * Exports board layers as SVG (top view, or bottom view with mirror).
 * @param {object} boardDoc
 * @param {Map|object} library
 * @param {{layers?:string[], pourFills?:Map|object, mirror?:boolean, colors?:Record<string,string>, background?:string, boardColor?:string, holeColor?:string}} opts
 */
export function boardToSvg(boardDoc, library, opts = {}) {
  const ctx = resolveBoard(boardDoc, library);
  const { board, objects, comps, copper, rules } = ctx;
  const mirror = !!opts.mirror;
  const inner = copperLayers(copper).filter((l) => l !== 'top' && l !== 'bottom').reverse();
  let layers = opts.layers || ['bottomOverlay', 'bottom', ...inner, 'top', 'topOverlay'];
  if (mirror && !opts.layers) layers = layers.slice().reverse();
  const colorOf = (l) => opts.colors?.[l] || LAYERS[l]?.color || '#888888';

  const b = bboxEmpty();
  const outline = board.outline || [];
  for (let i = 0; i < outline.length; i += 2) bboxAdd(b, outline[i], outline[i + 1]);
  if (!bboxValid(b)) {
    for (const o of objects) {
      if ('x' in o) bboxAdd(b, o.x, o.y);
      if ('x1' in o) { bboxAdd(b, o.x1, o.y1); bboxAdd(b, o.x2, o.y2); }
    }
  }
  if (!bboxValid(b)) bboxAdd(b, 0, 0);
  const margin = 2_000_000;
  const minX = b.minX - margin, maxX = b.maxX + margin, minY = b.minY - margin, maxY = b.maxY + margin;
  const m = makeMapper(minX, maxY, mirror, maxX);
  const W = n4((maxX - minX) / 1e6), H = n4((maxY - minY) / 1e6);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" stroke-linecap="round" stroke-linejoin="round">`,
    `<title>${esc(boardDoc.name || 'Board')}</title>`,
    `<rect width="${W}" height="${H}" fill="${opts.background || '#1c1c1c'}"/>`,
  ];
  if (outline.length >= 6) {
    const rings = [outline, ...(board.cutouts || [])];
    out.push(`<path d="${polygonSetPath(m, [rings])}" fill="${opts.boardColor || '#000000'}" fill-rule="evenodd"/>`);
  }
  for (const layer of layers) {
    const color = colorOf(layer);
    const els = [];
    const isCu = LAYERS[layer]?.kind === 'copper';
    const prim = (p) => { const s = primSvg(m, p, color); if (s) els.push(s); };
    for (const o of objects) {
      if (o.t === 'pour' && o.layer === layer) {
        const d = polygonSetPath(m, fillOf(opts.pourFills, o.id));
        if (d) els.push(`<path d="${d}" fill="${color}" fill-rule="evenodd"/>`);
      }
    }
    for (const o of objects) {
      if (o.layer !== layer) continue;
      if (o.t === 'fill') prim({ t: 'rect', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, fill: true, w: 0 });
      else if (o.t === 'region') prim({ t: 'poly', pts: o.pts, fill: true, w: 0 });
      else if (o.t === 'track') prim({ t: 'line', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: o.w || rules.silkWidth });
      else if (o.t === 'arc') prim({ t: 'arc', cx: o.cx, cy: o.cy, r: o.r, a0: o.a0, sweep: o.sweep, w: o.w || rules.silkWidth });
      else if (o.t === 'text') prim({ t: 'text', x: o.x, y: o.y, text: o.text, size: o.h, rot: o.rot || 0, mirror: !!o.mirror, w: o.w });
      else if (o.t === 'dim') {
        prim({ t: 'line', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, w: rules.silkWidth });
      }
    }
    for (const { comp, def, placed } of comps) {
      for (const g of placed.graphics) if (g.layer === layer) prim({ ...g, w: g.w || rules.silkWidth });
      for (const pad of placed.pads) {
        const on = isCu ? pad.layers.copper.includes(layer) : pad.layers.mask.includes(layer) || pad.layers.paste.includes(layer);
        if (!on) continue;
        const exp = isCu ? 0 : pad.layers.mask.includes(layer) ? (pad.maskExpansion ?? rules.maskExpansion) : rules.pasteExpansion;
        const s = padSvg(m, pad, color, exp);
        if (s) els.push(s);
      }
      for (const f of fieldTexts(comp, def)) {
        // Centered, so turning upside-down text upright is a half turn.
        const rot = norm360(f.rot) > 90 && norm360(f.rot) <= 270 ? norm360(f.rot + 180) : f.rot;
        if (f.layer !== layer) continue;
        prim({ t: 'text', x: f.x, y: f.y, text: f.text, size: f.h, rot, align: { h: 'center', v: 'middle' }, mirror: f.mirror, w: f.w });
      }
    }
    if (isCu) {
      for (const o of objects) {
        if (o.t === 'via' && spanLayers(o.from || 'top', o.to || 'bottom', copper).includes(layer)) prim({ t: 'circle', cx: o.x, cy: o.y, r: o.d / 2, fill: true, w: 0 });
        else if (o.t === 'pad') {
          const side = o.side || 'top';
          if (side === 'thru' || side === layer) { const s = padSvg(m, o, color); if (s) els.push(s); }
        }
      }
    }
    if (els.length) out.push(`<g id="layer-${esc(layer)}" opacity="${opts.opacity ?? 0.85}">`, ...els, '</g>');
  }
  // Holes on top of everything.
  const hole = opts.holeColor || '#3a3a3a';
  const holes = [];
  for (const { placed } of comps) for (const p of placed.pads) if (p.side === 'thru' && p.drill > 0) holes.push(`<circle cx="${m.x(p.x)}" cy="${m.y(p.y)}" r="${m.w(p.drill / 2)}" fill="${hole}"/>`);
  for (const o of objects) {
    if ((o.t === 'via' || (o.t === 'pad' && o.side === 'thru')) && o.drill > 0) holes.push(`<circle cx="${m.x(o.x)}" cy="${m.y(o.y)}" r="${m.w(o.drill / 2)}" fill="${hole}"/>`);
  }
  if (holes.length) out.push('<g id="holes">', ...holes, '</g>');
  if (outline.length >= 6) {
    out.push(`<path d="${polygonSetPath(m, [[outline, ...(board.cutouts || [])]])}" fill="none" stroke="${opts.outlineColor || '#e8e8e8'}" stroke-width="0.1"/>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
