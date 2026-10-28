import { W14 } from './text-outline.js';
import { childElements, parseXml } from './docx-xml.js';
import { serializeFragment } from './docx-compatibility.js';

const names = { text3d: 'props3d', textScene: 'scene3d' };
const parsed = new Map();
function declaration(value, key) {
  if (value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(names, key)) throw new Error('Invalid text 3D declaration.');
  const cacheKey = key + value;
  if (!parsed.has(cacheKey)) {
    const node = parseXml(value).documentElement;
    if (node.namespaceURI !== W14 || node.localName !== names[key]) throw new Error('Invalid text 3D declaration.');
    parsed.set(cacheKey, node);
  }
  return parsed.get(cacheKey);
}
export function checkedText3d(value, key) { declaration(value, key); return value; }
export function readText3d(rPr) {
  const result = {};
  for (const [key, name] of Object.entries(names)) {
    const nodes = childElements(rPr, W14, name);
    // An ambiguous malformed declaration must not accidentally expose an
    // inherited effect. Original run XML remains available for preservation.
    if (nodes.length) result[key] = nodes.length === 1 ? serializeFragment(nodes[0]) : null;
  }
  return result;
}
export function writeText3d(properties, value, key) {
  const node = declaration(value, key);
  for (const child of [...properties.children]) if (child.namespaceURI === W14 && child.localName === names[key]) child.remove();
  if (!node) return;
  const doc = properties.ownerDocument;
  const next = [...properties.children].find(n => n.namespaceURI === W14 &&
    (key === 'textScene' && n.localName === 'props3d' || ['ligatures', 'numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'].includes(n.localName)));
  properties.insertBefore(doc.importNode(node, true), next || null);
  const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:w14', W14);
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:mc', mc);
  const ignored = new Set((properties.getAttributeNS(mc, 'Ignorable') || '').split(/\s+/).filter(Boolean));
  ignored.add('w14'); properties.setAttributeNS(mc, 'mc:Ignorable', [...ignored].join(' '));
}

const attr = (n, key, fallback) => n?.getAttributeNS(W14, key) ?? fallback;
const children = (n, name) => childElements(n, W14, name);
const number = (n, key, fallback = 0) => {
  const value = attr(n, key, String(fallback));
  return /^\+?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
};
// Unsupported camera/material declarations retain their complete XML and the
// existing flat preview. Do not infer an angle bevel from another preset.
export function text3dSurface(style) {
  if (!style.text3d) return null;
  const props = declaration(style.text3d, 'text3d');
  const bevels = children(props, 'bevelT'), bevel = bevels[0];
  if (bevels.length > 1 || bevel && attr(bevel, 'prst', 'circle') !== 'angle') return null;
  const depth = number(props, 'extrusionH'), width = bevel ? number(bevel, 'w', 76200) : 0;
  const height = bevel ? number(bevel, 'h', 76200) : 0;
  const material = attr(props, 'prstMaterial', 'warmMatte');
  if (![depth, width, height].every(Number.isFinite) || !(depth || width && height) || !['warmMatte', 'matte', 'flat'].includes(material)) return null;
  let rig = 'threePt', direction = 't', revolution;
  if (style.textScene) {
    const scene = declaration(style.textScene, 'textScene');
    const cameras = children(scene, 'camera'), lights = children(scene, 'lightRig');
    if (cameras.length !== 1 || lights.length !== 1 || attr(cameras[0], 'prst') !== 'orthographicFront') return null;
    const camera = cameras[0], light = lights[0];
    if (children(camera, 'rot').some(n => ['lat', 'lon', 'rev'].some(k => number(n, k) !== 0))) return null;
    if (number(camera, 'zoom', 100000) !== 100000) return null;
    rig = attr(light, 'rig'); direction = attr(light, 'dir');
    const rotation = children(light, 'rot');
    if (rotation.length > 1 || rotation.some(n => number(n, 'lat') || number(n, 'lon'))) return null;
    if (rotation.length) revolution = number(rotation[0], 'rev') / 60000;
    if (!['threePt', 'twoPt'].includes(rig) || !['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl'].includes(direction) ||
      revolution === undefined && direction !== 't' || revolution !== undefined && (!Number.isFinite(revolution) || revolution < 0 || revolution >= 360)) return null;
  }
  return { depth, width, height, material, rig, direction, revolution };
}
