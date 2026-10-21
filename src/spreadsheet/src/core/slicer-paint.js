import { modelChildren, parseModelXml, standaloneModelXml } from './data-model-metadata.js';
import { readXlsxDifferentialStyle, xlsxColor } from './xlsx-styles.js';
import { builtInSlicerStyle } from './slicer-builtin-styles.js';
import { XLSX_BORDER_STYLES } from './format.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const children = (node, name) => modelChildren(node, name, MAIN);
const fail = message => { throw new Error(`Invalid slicer paint: ${message}`); };
const single = (node, name) => { const all = children(node, name); if (all.length > 1) fail(`duplicate ${name}`); return all[0]; };
const number = (node, name, fallback, min = -Infinity, max = Infinity) => {
  if (!node.hasAttribute(name)) return fallback;
  const raw = node.getAttribute(name).trim(), n = Number(raw);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(n) || n < min || n > max) fail(name);
  return n;
};
const flag = node => {
  const val = node.hasAttribute('val') ? node.getAttribute('val').trim() : '1';
  if (!['1', '0', 'true', 'false'].includes(val)) fail('font flag');
  return val === '1' || val === 'true';
};

/** Decode a differential format for slicer paint, retaining gradient geometry.
 * The raw DXF remains in the style definition for lossless native serialization.
 */
export function readSlicerPaint(xml, themes) {
  if (xml == null) return {};
  const root = parseModelXml(xml);
  if (root.namespaceURI !== MAIN || root.localName !== 'dxf') fail('dxf root');
  // The shared DXF decoder predates namespace-aware parsing. Do not let a
  // foreign extension's font/fill names become actual differential paint.
  const native = root.cloneNode(true);
  const prune = node => {
    for (const child of Array.from(node.childNodes || [])) if (child.nodeType === 1) {
      if (child.namespaceURI !== MAIN || child.localName === 'extLst') node.removeChild(child);
      else prune(child);
    }
  };
  prune(native);
  const emphasis = {}, font = single(root, 'font');
  for (const [tag, key] of [['b', 'bold'], ['i', 'italic'], ['strike', 'strike']]) {
    const node = single(font, tag); if (node) emphasis[key] = flag(node);
  }
  const out = { ...readXlsxDifferentialStyle(standaloneModelXml(native), themes), ...emphasis };
  const sz = single(font, 'sz');
  if (sz) { out.size = number(sz, 'val', null, 0, 409); if (out.size == null) fail('font size'); }
  const underline = single(font, 'u');
  if (underline) {
    const value = underline.hasAttribute('val') ? underline.getAttribute('val') : 'single';
    if (!['none', 'single', 'double', 'singleAccounting', 'doubleAccounting'].includes(value)) fail('underline');
    out.underline = value;
  }
  // Refuse currently unsupported paint rather than replacing it by a thin
  // solid border or dropping special font effects.
  for (const tag of ['outline', 'shadow', 'condense', 'extend']) {
    const node = single(font, tag);
    if (node && flag(node)) throw new Error(`Slicer font ${tag} rendering is not implemented yet`);
  }
  const vertical = single(font, 'vertAlign');
  if (vertical && vertical.getAttribute('val') !== 'baseline') throw new Error('Slicer vertical font alignment is not implemented yet');
  if (out.underline?.endsWith('Accounting')) throw new Error('Slicer accounting underline rendering is not implemented yet');
  const border = single(root, 'border');
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const edge = single(border, side), style = edge?.getAttribute('style');
    if (style && style !== 'none' && !XLSX_BORDER_STYLES.includes(style)) throw new Error(`Slicer border ${style} rendering is not implemented yet`);
  }
  for (const direction of ['diagonalUp', 'diagonalDown']) if (border && ['1', 'true'].includes(border.getAttribute(direction))) throw new Error('Slicer diagonal borders are not implemented yet');
  const fill = single(root, 'fill'), gradient = single(fill, 'gradientFill'), pattern = single(fill, 'patternFill');
  if (gradient && pattern) fail('multiple fill types');
  if (pattern && !['', 'none', 'solid'].includes(pattern.getAttribute('patternType') || '')) throw new Error('Slicer pattern-fill rendering is not implemented yet');
  if (!gradient) return out;
  const type = gradient.hasAttribute('type') ? gradient.getAttribute('type') : 'linear';
  if (!['linear', 'path'].includes(type)) fail('gradient type');
  const stops = children(gradient, 'stop').map(stop => {
    const position = number(stop, 'position', null, 0, 1), colorNode = single(stop, 'color');
    const color = colorNode && xlsxColor(standaloneModelXml(colorNode), themes);
    if (position == null || !color) fail('gradient stop');
    return { position, color };
  });
  if (!stops.length || stops.some((s, i) => i && s.position < stops[i - 1].position)) fail('gradient stop order');
  if (type === 'linear') out.gradient = { type, degree: number(gradient, 'degree', 0), stops };
  else {
    const rect = Object.fromEntries(['left', 'right', 'top', 'bottom'].map(k => [k, number(gradient, k, 0, 0, 1)]));
    if (rect.left > rect.right || rect.top > rect.bottom) fail('gradient convergence rectangle');
    out.gradient = { type, ...rect, stops };
  }
  delete out.bg;
  return out;
}

export function resolveSlicerPaint(style, themes) {
  if (!style) throw new Error('Missing slicer style definition');
  if (style.builtIn) {
    const definition = builtInSlicerStyle(style.name);
    if (!definition) throw new Error(`Unknown built-in slicer style ${style.name}`);
    style = definition;
  }
  return Object.fromEntries(['frame', 'items'].map(kind => [kind,
    Object.fromEntries(Object.entries(style[kind] || {}).map(([name, xml]) => [name, readSlicerPaint(xml, themes)]))]));
}

/** CSS angles start upwards; SpreadsheetML zero starts left-to-right.
 * Path gradients converge on a rectangle, not an ellipse. Four trapezoids
 * interpolate perpendicularly from that rectangle to the corresponding edge.
 */
export function slicerGradientBackground(gradient, width, height) {
  if (!gradient) return '';
  const stops = gradient.stops;
  if (!Array.isArray(stops) || !stops.length || stops.some(s => !/^#[0-9a-f]{6}$/i.test(s.color) || !Number.isFinite(s.position) || s.position < 0 || s.position > 1) || stops.some((s, i) => i && s.position < stops[i - 1].position)) fail('gradient paint stops');
  if (gradient.type === 'linear') {
    if (!Number.isFinite(gradient.degree)) fail('gradient angle');
    const angle = ((gradient.degree + 90) % 360 + 360) % 360;
    return `linear-gradient(${angle}deg, ${stops.map(s => `${s.color} ${s.position * 100}%`).join(', ')})`;
  }
  if (gradient.type !== 'path') fail('gradient paint type');
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) fail('gradient bounds');
  const { left, right, top, bottom } = gradient;
  if (![left, right, top, bottom].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || left > right || top > bottom) fail('gradient paint rectangle');
  const l = left * width, r = right * width, t = top * height, b = bottom * height;
  const sides = [
    [t > 0, 'top', [0, t, 0, 0], `0,0 ${width},0 ${r},${t} ${l},${t}`],
    [r < width, 'right', [r, 0, width, 0], `${width},0 ${width},${height} ${r},${b} ${r},${t}`],
    [b < height, 'bottom', [0, b, 0, height], `${width},${height} 0,${height} ${l},${b} ${r},${b}`],
    [l > 0, 'left', [l, 0, 0, 0], `0,${height} 0,0 ${l},${t} ${l},${b}`],
  ].filter(s => s[0]);
  const stopXml = stops.map(s => `<stop offset="${s.position}" stop-color="${s.color}"/>`).join('');
  const defs = sides.map(([, id, [x1, y1, x2, y2]]) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopXml}</linearGradient>`).join('');
  const shapes = sides.map(([, id, , points]) => `<polygon points="${points}" fill="url(#${id})"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" color-interpolation="sRGB"><defs>${defs}</defs><rect width="${width}" height="${height}" fill="${stops[0].color}"/>${shapes}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
