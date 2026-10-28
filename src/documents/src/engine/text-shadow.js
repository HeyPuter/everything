import { UnsupportedDocumentError } from './errors.js';
import { normalizeColor } from './colors.js';
import { drawingEffectColor } from './docx-drawing-style.js';
import { W14 } from './text-outline.js';
import { childElements } from './docx-xml.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const anchors = { none: [.5, .5], tl: [0, 0], t: [.5, 0], tr: [1, 0], l: [0, .5], ctr: [.5, .5], r: [1, .5], bl: [0, 1], b: [.5, 1], br: [1, 1] };
const fail = () => { throw new UnsupportedDocumentError('unsupported text shadow properties'); };
const defaults = { blurRadius: 0, distance: 0, direction: 0, scaleX: 0, scaleY: 0, skewX: 0, skewY: 0, alignment: 'none', color: '000000', alpha: 1 };
export function checkedTextShadow(value) {
  if (value === null) return null;
  if (!value || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) fail();
  const result = { ...defaults, ...value };
  for (const key of ['blurRadius', 'distance']) if (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 2147483646) fail();
  if (!Number.isInteger(result.direction) || result.direction < 0 || result.direction >= 21600000) fail();
  for (const key of ['scaleX', 'scaleY']) if (!Number.isFinite(result[key]) || Math.abs(result[key]) > 2147483647 / 100000) fail();
  for (const key of ['skewX', 'skewY']) if (!Number.isInteger(result[key]) || Math.abs(result[key]) >= 5400000) fail();
  if (!Object.hasOwn(anchors, result.alignment) || !Number.isFinite(result.alpha) || result.alpha < 0 || result.alpha > 1) fail();
  try { result.color = normalizeColor(result.color); } catch { fail(); }
  if (result.color === 'auto') fail();
  return result;
}

export function readTextShadow(properties, readColor) {
  const nodes = childElements(properties, W14, 'shadow');
  if (!nodes.length) return {};
  if (nodes.length !== 1) fail();
  const node = nodes[0], names = { blurRad: 'blurRadius', dist: 'distance', dir: 'direction', sx: 'scaleX', sy: 'scaleY', kx: 'skewX', ky: 'skewY', algn: 'alignment' };
  const value = {};
  for (const attr of node.attributes) {
    if (attr.namespaceURI === XMLNS) continue;
    if (attr.namespaceURI !== W14 || !Object.hasOwn(names, attr.localName)) fail();
    const key = names[attr.localName], raw = attr.value.trim();
    if (key === 'alignment') value[key] = raw;
    else if (key === 'scaleX' || key === 'scaleY') {
      if (!/^[+-]?\d+$|^[+-]?\d+(?:\.\d+)?%$/.test(raw)) fail();
      value[key] = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw) / 100000;
    } else {
      if (!/^[+-]?\d+$/.test(raw)) fail();
      value[key] = Number(raw);
    }
  }
  if (node.children.length !== 1 || !['srgbClr', 'schemeClr'].includes(node.children[0].localName)) fail();
  // The extension uses the DrawingML color model with qualified w14 attributes.
  const colorNode = source => {
    if (source.namespaceURI !== W14) fail();
    const target = source.ownerDocument.createElementNS(A, 'a:' + source.localName);
    for (const attr of source.attributes) {
      if (attr.namespaceURI === XMLNS) continue;
      if (attr.namespaceURI !== W14) fail();
      target.setAttribute(attr.localName, attr.value);
    }
    for (const child of source.children) target.append(colorNode(child));
    return target;
  };
  const color = drawingEffectColor(colorNode(node.children[0]), readColor?.drawingScheme);
  return { textShadow: checkedTextShadow({ ...value, color: color.rgb, alpha: color.alpha }) };
}

export function writeTextShadow(properties, value) {
  const shadow = checkedTextShadow(value) || { ...defaults, alpha: 0 };
  const doc = properties.ownerDocument, mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  properties.setAttributeNS(XMLNS, 'xmlns:w14', W14);
  properties.setAttributeNS(XMLNS, 'xmlns:mc', mc);
  const ignored = new Set((properties.getAttributeNS(mc, 'Ignorable') || '').split(/\s+/).filter(Boolean));
  ignored.add('w14'); properties.setAttributeNS(mc, 'mc:Ignorable', [...ignored].join(' '));
  for (const node of [...properties.children]) if (node.namespaceURI === W14 && node.localName === 'shadow') node.remove();
  const make = name => doc.createElementNS(W14, 'w14:' + name), node = make('shadow');
  const attrs = { blurRad: shadow.blurRadius, dist: shadow.distance, dir: shadow.direction, sx: Math.round(shadow.scaleX * 100000), sy: Math.round(shadow.scaleY * 100000), kx: shadow.skewX, ky: shadow.skewY, algn: shadow.alignment };
  for (const [key, val] of Object.entries(attrs)) node.setAttributeNS(W14, 'w14:' + key, String(val));
  const color = make('srgbClr'); color.setAttributeNS(W14, 'w14:val', shadow.color);
  if (shadow.alpha !== 1) { const alpha = make('alpha'); alpha.setAttributeNS(W14, 'w14:val', String(Math.round(shadow.alpha * 100000))); color.append(alpha); }
  node.append(color);
  properties.insertBefore(node, [...properties.children].find(child => child.namespaceURI === W14 && ['reflection', 'textOutline', 'textFill', 'scene3d', 'props3d', 'ligatures', 'numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'].includes(child.localName)) || null);
}

// Independent native controls establish the nonlinear effect scale. The
// authored distances remain EMUs; this compatibility rule is only geometric.
export function textShadowGeometry(shadow, size, width, ascent, descent) {
  const scale = (Math.floor(size) / 72) ** .7 / 9525;
  const angle = shadow.direction * Math.PI / 10800000;
  const x = shadow.distance * scale * Math.cos(angle), y = shadow.distance * scale * Math.sin(angle);
  const blur = shadow.blurRadius * scale;
  const [ax, ay] = anchors[shadow.alignment];
  const px = ax * width, py = -ascent + ay * (ascent + descent);
  const a = shadow.scaleX, d = shadow.scaleY;
  const b = Math.tan(shadow.skewY * Math.PI / 10800000), c = Math.tan(shadow.skewX * Math.PI / 10800000);
  const e = px * (1 - a) - py * c + x, f = py * (1 - d) - px * b + y;
  const xs = [], ys = [];
  for (const u of [0, width]) for (const v of [-ascent, descent]) { xs.push(a * u + c * v + e); ys.push(b * u + d * v + f); }
  return { a, b, c, d, e, f, blur, left: Math.min(...xs) - blur, right: Math.max(...xs) + blur, top: Math.min(...ys) - blur, bottom: Math.max(...ys) + blur };
}
