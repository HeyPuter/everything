import { UnsupportedDocumentError } from './errors.js';
import { drawingEffectColor } from './docx-drawing-style.js';

/**
 * Glow, soft edge and reflection in a drawing's effect list (ECMA-376 §20.1.8.26 a:effectLst,
 * §20.1.8.32 a:glow, §20.1.8.53 a:softEdge, §20.1.8.50 a:reflection). The outer shadow in the same
 * list is read by docx-picture-shadow.js. Values become physical CSS pixels (EMU / 9525) and alpha
 * fractions; the source XML stays in the drawing's shell, so saving keeps the effects as authored.
 */
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
/** CT_EffectList's sequence. */
export const EFFECT_ORDER = ['blur', 'fillOverlay', 'glow', 'innerShdw', 'outerShdw', 'prstShdw', 'reflection', 'softEdge'];
/** The members this editor reads and paints; any other effect keeps the drawing unsupported. */
const SUPPORTED = new Set(['glow', 'outerShdw', 'reflection', 'softEdge']);
const fail = why => { throw new UnsupportedDocumentError(`drawing effects with ${why}`); };
const MAX_COORDINATE = 27273042316900;

function attributes(node, allowed) {
  for (const a of node.attributes) if (a.namespaceURI !== XMLNS && (a.namespaceURI || !allowed.includes(a.localName))) fail(`unsupported ${node.localName} attribute ${a.localName}`);
}
function integer(node, key, fallback, min, max) {
  const raw = node.getAttribute(key)?.trim();
  if (raw === undefined || raw === null) return fallback;
  if (!/^[+-]?\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) fail(`invalid ${key}`);
  return Number(raw) || 0;
}
/** ST_PositiveFixedPercentage or ST_FixedPercentage: thousandths of a percent, or a percentage string. */
function percent(node, key, fallback, min = 0, max = 100000) {
  const raw = node.getAttribute(key)?.trim();
  if (raw === undefined || raw === null) return fallback;
  const value = raw.endsWith('%') && /^[+-]?\d+(?:\.\d+)?%$/.test(raw) ? Number(raw.slice(0, -1)) * 1000 : /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < min || value > max) fail(`invalid ${key}`);
  return value;
}
function text(node) {
  if ([...node.childNodes].some(n => [3, 4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('text in effect properties');
}

/** The effect list's members in order, validated; null without a list. */
export function effectListMembers(shape) {
  const list = [...shape.children].find(n => n.namespaceURI === A && n.localName === 'effectLst');
  if (!list) return null;
  let at = -1;
  for (const node of list.children) {
    const index = node.namespaceURI === A ? EFFECT_ORDER.indexOf(node.localName) : -1;
    if (index < 0) fail(`unknown effect ${node.localName}`);
    if (index <= at) fail('duplicate or misordered effects');
    at = index;
  }
  return [...list.children];
}

/**
 * Glow, soft edge and reflection of a drawing's shape properties: { glow?, softEdge?, reflection? }
 * or null. Throws for effects this editor cannot paint.
 */
export function readDrawingEffects(shape, scheme) {
  const members = effectListMembers(shape);
  if (!members) return null;
  for (const node of members) if (!SUPPORTED.has(node.localName)) fail(`unsupported ${node.localName}`);
  const result = {};
  for (const node of members) {
    if (node.localName === 'glow') {
      attributes(node, ['rad']); text(node);
      if (node.children.length !== 1) fail('missing or conflicting glow colors');
      const radius = integer(node, 'rad', 0, 0, MAX_COORDINATE) / 9525;
      if (radius > 0) result.glow = { radius, color: drawingEffectColor(node.children[0], scheme) };
    } else if (node.localName === 'softEdge') {
      attributes(node, ['rad']); text(node);
      if (node.children.length) fail('soft edge contents');
      const radius = integer(node, 'rad', 0, 0, MAX_COORDINATE) / 9525;
      if (radius > 0) result.softEdge = { radius };
    } else if (node.localName === 'reflection') {
      attributes(node, ['blurRad', 'stA', 'stPos', 'endA', 'endPos', 'dist', 'dir', 'fadeDir', 'sx', 'sy', 'kx', 'ky', 'algn', 'rotWithShape']); text(node);
      if (node.children.length) fail('reflection contents');
      const blur = integer(node, 'blurRad', 0, 0, MAX_COORDINATE) / 9525, distance = integer(node, 'dist', 0, 0, MAX_COORDINATE) / 9525;
      const startAlpha = percent(node, 'stA', 100000) / 100000, endAlpha = percent(node, 'endA', 0) / 100000;
      const startPosition = percent(node, 'stPos', 0) / 100000, endPosition = percent(node, 'endPos', 100000) / 100000;
      const direction = integer(node, 'dir', 0, 0, 21599999), fade = integer(node, 'fadeDir', 5400000, 0, 21599999);
      const sx = percent(node, 'sx', 100000, -2147483648, 2147483647), sy = percent(node, 'sy', 100000, -2147483648, 2147483647);
      const kx = integer(node, 'kx', 0, -5400000, 5400000), ky = integer(node, 'ky', 0, -5400000, 5400000);
      const align = node.getAttribute('algn') ?? 'b';
      if (!['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(align)) fail('invalid reflection alignment');
      if (node.hasAttribute('rotWithShape') && !['0', '1', 'true', 'false'].includes(node.getAttribute('rotWithShape').trim())) fail('invalid reflection rotation flag');
      // The subset painted here: a mirror image below the shape, fading downward.
      if (sx !== 100000 || sy !== -100000 || kx || ky || !['bl', 'b'].includes(align) || fade !== 5400000 || distance && direction !== 5400000) fail('reflections other than a vertical mirror below the shape');
      if (endPosition <= startPosition) fail('empty reflection fades');
      result.reflection = { blur, distance, startAlpha, endAlpha, startPosition, endPosition };
    }
  }
  return Object.keys(result).length ? result : null;
}
