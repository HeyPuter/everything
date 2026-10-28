import { UnsupportedDocumentError } from './errors.js';
import { drawingColor } from './docx-drawing-style.js';
import { neutralSketchLine } from './sketch-line-preview.js';
import { elementChildren } from './docx-xml.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const fail = why => { throw new UnsupportedDocumentError(`3D pictures with ${why}`); };
const children = n => n?.children ? elementChildren(n) : [];
const child = (n, name) => children(n).find(c => c.namespaceURI === A && c.localName === name);
function check(node, attrs, names) {
  if (!node) return;
  for (const a of node.attributes) if (a.namespaceURI !== XMLNS && (a.namespaceURI || !attrs.includes(a.localName))) fail(`unsupported ${node.localName} attribute ${a.localName}`);
  const seen = new Set();
  for (const c of children(node)) {
    if (c.namespaceURI !== A || !names.includes(c.localName) || seen.has(c.localName)) fail(`unsupported or duplicate ${c.localName}`);
    seen.add(c.localName);
  }
}
function coordinate(node, attr) {
  const raw = node?.getAttribute(attr)?.trim() ?? '0';
  if (!/^[+]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) fail(`invalid ${attr}`);
  return Number(raw) / 12700;
}
function colorValue(holder, scheme) {
  check(holder, [], ['srgbClr', 'schemeClr']);
  if (children(holder).length !== 1) fail('missing or conflicting surface colors');
  const value = children(holder)[0];
  for (const attr of value.attributes) if (attr.namespaceURI !== XMLNS && (attr.namespaceURI || attr.localName !== 'val')) fail('unsupported color attributes');
  return drawingColor(value, scheme);
}
function readBevel(node) {
  if (!node) return null;
  check(node, ['w', 'h', 'prst'], []);
  const preset = (node.getAttribute('prst') ?? 'circle').trim();
  if (!['circle', 'angle'].includes(preset)) fail('unsupported bevel preset');
  const size = name => {
    const raw = node.getAttribute(name)?.trim() ?? '76200';
    if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0 || Number(raw) > 27273042316900) fail(`invalid bevel ${name}`);
    return (Number(raw) || 0) / 12700;
  };
  return { width: size('w'), height: size('h'), preset };
}
function readOutline(line, scheme) {
  if (!line) return null;
  line = neutralSketchLine(line) || line;
  check(line, ['w', 'cap', 'cmpd', 'algn'], ['solidFill', 'noFill', 'round', 'miter', 'bevel', 'prstDash', 'headEnd', 'tailEnd']);
  const raw = line.getAttribute('w')?.trim() ?? '9525', width = Number(raw);
  if (!/^[+-]?\d+$/.test(raw) || !Number.isInteger(width) || width < 0 || width > 20116800) fail('invalid outline width');
  if (line.hasAttribute('cmpd') && line.getAttribute('cmpd') !== 'sng' || line.hasAttribute('algn') && line.getAttribute('algn') !== 'ctr' || line.hasAttribute('cap') && !['flat','sq','rnd'].includes(line.getAttribute('cap'))) fail('unsupported outline style');
  check(child(line, 'round'), [], []);
  check(child(line, 'bevel'), [], []);
  const joins=children(line).filter(n=>['round','miter','bevel'].includes(n.localName));
  if(joins.length>1)fail('conflicting outline joins');
  const miter=child(line,'miter');check(miter,['lim'],[]);
  let miterLimit;
  if(miter){
    const value=miter.getAttribute('lim')?.trim() ?? '800000';
    if(!/^[+]?\d+(?:\.\d+)?%$/.test(value) && !/^[+]?\d+$/.test(value))fail('invalid miter limit');
    miterLimit=value.endsWith('%')?Number(value.slice(0,-1))/100:Number(value)/100000;
    if(!Number.isFinite(miterLimit)||miterLimit<0||miterLimit>2147483647/100000)fail('invalid miter limit');
  }
  const dash = child(line, 'prstDash'); check(dash, ['val'], []);
  if (dash && dash.getAttribute('val') !== 'solid') fail('dashed outlines');
  for (const name of ['headEnd', 'tailEnd']) {
    const arrow = child(line, name); check(arrow, ['type', 'w', 'len'], []);
    if (arrow && arrow.hasAttribute('type') && arrow.getAttribute('type') !== 'none') fail('outline arrowheads');
    for (const attr of ['w', 'len']) if (arrow?.hasAttribute(attr) && !['sm', 'med', 'lg'].includes(arrow.getAttribute(attr))) fail('invalid outline arrow dimensions');
  }
  const fill = child(line, 'solidFill'), none = child(line, 'noFill'); check(none, [], []);
  if (fill && none) fail('conflicting outline fills');
  const color = fill ? colorValue(fill, scheme) : null;
  if (!none && !fill && (line.attributes.length || children(line).length)) fail('implicit outline fills');
  return color && width ? { width: width / 12700, color, ...(miter?{join:'miter',miterLimit}:child(line,'bevel')?{join:'bevel'}:{}) } : null;
}
export function readPicture3d(shape, scheme) {
  const scene = child(shape, 'scene3d'), solid = child(shape, 'sp3d');
  if (!scene && !solid) return null;
  if (!scene) fail('missing scene');
  check(scene, [], ['camera', 'lightRig']);
  const camera = child(scene, 'camera'), light = child(scene, 'lightRig');
  check(camera, ['prst'], []); check(light, ['rig', 'dir'], ['rot']);
  const preset = camera?.getAttribute('prst');
  if (!['orthographicFront', 'perspectiveRight', 'perspectiveLeft'].includes(preset)) fail('unsupported camera');
  const rig = light?.getAttribute('rig'), direction = light?.getAttribute('dir');
  const rotation = child(light, 'rot'); check(rotation, ['lat', 'lon', 'rev'], []);
  if (!['threePt', 'twoPt'].includes(rig) || !['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl'].includes(direction) || !rotation && direction !== 't') fail('unsupported lighting');
  let revolution;
  if (rotation) {
    const angles = ['lat', 'lon', 'rev'].map(attr => {
      const raw = rotation.getAttribute(attr)?.trim();
      if (!/^[+-]?\d+$/.test(raw || '') || !Number.isInteger(Number(raw)) || Number(raw) < 0 || Number(raw) >= 21600000) fail(`invalid light rotation ${attr}`);
      return Number(raw) || 0; // XML integer permits the lexical spelling -0.
    });
    if (angles[0] || angles[1]) fail('unsupported light latitude or longitude');
    revolution = angles[2] / 60000;
  }
  check(solid, ['z', 'extrusionH', 'contourW', 'prstMaterial'], ['bevelT', 'contourClr', 'extrusionClr']);
  const bevel = readBevel(child(solid, 'bevelT'));
  const material = solid?.getAttribute('prstMaterial') ?? 'warmMatte';
  if (coordinate(solid, 'z') !== 0 || !['warmMatte', 'matte'].includes(material)) fail('unsupported depth position or material');
  const color = name => {
    const holder = child(solid, name); if (!holder) return undefined;
    return colorValue(holder, scheme);
  };
  const geometry = child(shape, 'prstGeom')?.getAttribute('prst');
  if (!['rect', 'ellipse'].includes(geometry)) fail('unsupported geometry');
  const outline=readOutline(child(shape,'ln'),scheme);
  if(geometry==='rect' && bevel?.height && (outline?.join==='bevel'||outline?.join==='miter'&&outline.miterLimit<Math.SQRT2))fail('beveled surfaces with clipped outline joins');
  return { geometry, ...(bevel ? { bevel } : {}), lighting: { rig, direction, ...(material === 'matte' ? { material } : {}), ...(rotation ? { revolution } : {}) }, turn: preset === 'perspectiveRight' ? 20 : preset === 'perspectiveLeft' ? -20 : 0, perspective: preset !== 'orthographicFront', depth: coordinate(solid, 'extrusionH'), contour: coordinate(solid, 'contourW'), contourColor: color('contourClr') || '000000', extrusionColor: color('extrusionClr'), outline };
}
