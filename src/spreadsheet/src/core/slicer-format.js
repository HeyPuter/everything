import { normalizeFontColor } from './font-color.js';
import { normalizeFillColor } from './fill-color.js';
import { fontStack, XLSX_BORDER_STYLES } from './format.js';

const fail = () => { throw new Error('Invalid stored slicer paint'); };
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const borderStyles = XLSX_BORDER_STYLES;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const paint = source => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail();
  const out = {};
  if (source.bg != null) { out.bg = normalizeFillColor(source.bg); if (!out.bg) fail(); }
  if (source.bc != null) { if (!color(source.bc)) fail(); out.bc = source.bc; }
  if (source.color != null) { out.color = normalizeFontColor(source.color); if (!out.color) fail(); }
  for (const key of ['bold', 'italic', 'strike', 'bl', 'br', 'bt', 'bb', 'bh', 'bv']) if (source[key] != null) { if (typeof source[key] !== 'boolean') fail(); out[key] = source[key]; }
  if (source.font != null) { if (typeof source.font !== 'string' || source.font.length > 1024 || !fontStack(source.font)) fail(); out.font = source.font; }
  if (source.size != null) { if (!finite(source.size, 0, 409)) fail(); out.size = source.size; }
  if (source.underline != null) { if (!['none', 'single', 'double'].includes(source.underline)) fail(); out.underline = source.underline; }
  if (source.bs != null) { if (!borderStyles.includes(source.bs)) fail(); out.bs = source.bs; }
  for (const side of ['bl', 'br', 'bt', 'bb', 'bh', 'bv']) {
    const key = `${side}Border`, edge = source[key];
    if (edge === null) out[key] = null;
    else if (edge !== undefined) {
      if (!borderStyles.includes(edge?.bs) || edge.bc != null && !color(edge.bc)) fail();
      out[key] = { bs: edge.bs, bc: edge.bc || null };
    }
  }
  if (source.gradient != null) {
    const g = source.gradient;
    if (!Array.isArray(g.stops) || !g.stops.length || g.stops.length > 4096) fail();
    const stops = g.stops.map((s, i) => {
      if (!finite(s?.position, 0, 1) || !color(s.color) || i && s.position < g.stops[i - 1].position) fail();
      return { position: s.position, color: s.color };
    });
    if (g.type === 'linear') { if (!finite(g.degree, -Number.MAX_VALUE, Number.MAX_VALUE)) fail(); out.gradient = { type: g.type, degree: g.degree, stops }; }
    else if (g.type === 'path') {
      if (!['left', 'right', 'top', 'bottom'].every(k => finite(g[k], 0, 1)) || g.left > g.right || g.top > g.bottom) fail();
      out.gradient = { type: g.type, left: g.left, right: g.right, top: g.top, bottom: g.bottom, stops };
    } else fail();
  }
  return out;
};

/** Only structured paint enters saved workbook JSON; no arbitrary CSS or image URLs. */
export function normalizeSlicerFormat(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail();
  const out = { frame: {}, items: {} };
  const states = ['selected', 'unselected'].flatMap(selection => ['Data', 'NoData'].flatMap(data => {
    const name = `${selection}ItemWith${data}`; return [name, `hovered${name[0].toUpperCase()}${name.slice(1)}`];
  }));
  for (const [kind, keys] of [['frame', ['wholeTable', 'headerRow']], ['items', states]]) {
    if (raw[kind] != null && (typeof raw[kind] !== 'object' || Array.isArray(raw[kind]))) fail();
    for (const key of keys) if (raw[kind]?.[key] != null) out[kind][key] = paint(raw[kind][key]);
  }
  return out;
}
