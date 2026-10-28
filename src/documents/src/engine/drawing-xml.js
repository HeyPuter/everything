import { parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';
import { xmlAttributeText } from './text-limits.js';

/**
 * DrawingML edits for Picture Format, Shape Format and Arrange: small functions that rewrite one part of
 * a drawing's XML in schema order (ECMA-376 Part 1 §20.1 DrawingML, §20.4 WordprocessingML drawing
 * positioning). Each works on the live DOM of a drawing written by drawing-format.js and leaves
 * everything it does not address as it was. Reading the current formatting back for menus and panes
 * is in describeDrawing below.
 */
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
export const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
export const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
export const ADEC = 'http://schemas.microsoft.com/office/drawing/2017/decorative';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const PREFIX = { [A]: 'a', [WP]: 'wp', [PIC]: 'pic', [WPS]: 'wps', [WPG]: 'wpg', [A14]: 'a14', [ADEC]: 'adec', [R]: 'r' };
/** Extension URIs (MS-ODRAWXML): decorative flag, original picture layer. */
export const DECORATIVE_URI = '{C183D7F6-B498-43B3-948B-1728B52AA6E4}';
export const IMAGE_PROPERTIES_URI = '{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}';

export const child = (node, ns, name) => [...(node?.children || [])].find(c => c.namespaceURI === ns && c.localName === name) || null;
export const childrenOf = (node, ns, names) => [...(node?.children || [])].filter(c => c.namespaceURI === ns && (!names || names.includes(c.localName)));

/** A new element with the conventional prefix of its namespace, in the drawing's document. */
export function make(doc, ns, name, attrs = {}, ...kids) {
  const node = doc.createElementNS(ns, PREFIX[ns] ? `${PREFIX[ns]}:${name}` : name);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

/** Put `node` among `parent`'s children where the schema sequence `order` (local names) wants it. */
export function place(parent, node, order) {
  const rank = name => { const at = order.indexOf(name); return at < 0 ? order.length : at; };
  const after = [...parent.children].find(c => rank(c.localName) > rank(node.localName));
  parent.insertBefore(node, after || null);
  return node;
}
const remove = (parent, ns, names) => { for (const node of childrenOf(parent, ns, names)) node.remove(); };

// CT_ShapeProperties (§20.1.2.2.35) and CT_LineProperties (§20.1.2.2.24) sequences.
const SHAPE_ORDER = ['xfrm', 'custGeom', 'prstGeom', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'];
const LINE_ORDER = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'prstDash', 'custDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd', 'extLst'];
const EFFECT_ORDER = ['blur', 'fillOverlay', 'glow', 'innerShdw', 'outerShdw', 'prstShdw', 'reflection', 'softEdge'];
const FILLS = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];
const BODY_ORDER = ['prstTxWarp', 'noAutofit', 'normAutofit', 'spAutoFit', 'scene3d', 'sp3d', 'flatTx', 'extLst'];

/**
 * A color: 'RRGGBB', { rgb, alpha? } or { scheme: 'accent1', lumMod?, lumOff?, alpha? } (alpha 0..1,
 * modifiers in 1/1000 % like the file). Written as a:srgbClr or a:schemeClr (§20.1.2.3).
 */
export function colorNode(doc, color) {
  const value = typeof color === 'string' ? { rgb: color } : color;
  const node = value.scheme ? make(doc, A, 'schemeClr', { val: value.scheme }) : make(doc, A, 'srgbClr', { val: String(value.rgb).replace(/^#/, '').toUpperCase() });
  if (value.lumMod !== undefined && value.lumMod !== 100000) node.append(make(doc, A, 'lumMod', { val: Math.round(value.lumMod) }));
  if (value.lumOff) node.append(make(doc, A, 'lumOff', { val: Math.round(value.lumOff) }));
  if (value.alpha !== undefined && value.alpha < 1) node.append(make(doc, A, 'alpha', { val: Math.round(value.alpha * 100000) }));
  return node;
}

/** Read a color element back into the form colorNode takes (scheme colors keep their name). */
export function readColorNode(node) {
  if (!node) return null;
  const mod = name => { const n = child(node, A, name); return n ? Number(n.getAttribute('val')) : undefined; };
  const alpha = mod('alpha');
  if (node.localName === 'schemeClr') return { scheme: node.getAttribute('val'), ...(mod('lumMod') !== undefined ? { lumMod: mod('lumMod') } : {}), ...(mod('lumOff') !== undefined ? { lumOff: mod('lumOff') } : {}), ...(alpha !== undefined ? { alpha: alpha / 100000 } : {}) };
  if (node.localName === 'srgbClr') return { rgb: node.getAttribute('val').toUpperCase(), ...(alpha !== undefined ? { alpha: alpha / 100000 } : {}) };
  if (node.localName === 'sysClr') return { rgb: (node.getAttribute('lastClr') || '000000').toUpperCase() };
  if (node.localName === 'prstClr') return { preset: node.getAttribute('val') };
  return null;
}
const firstColor = node => [...(node?.children || [])].find(c => c.namespaceURI === A && /Clr$/.test(c.localName)) || null;

/**
 * The fill of shape properties. fill: null (keep the style's), { type: 'none' }, { type: 'solid', color },
 * { type: 'gradient', stops: [{ position (0..100000), color }], angle (degrees) | path: 'circle'|'rect'|'shape' },
 * { type: 'pattern', preset, foreground, background }, { type: 'picture', relId, tile? }.
 */
export function setFill(props, fill) {
  const doc = props.ownerDocument;
  remove(props, A, FILLS);
  if (!fill) return;
  let node;
  if (fill.type === 'none') node = make(doc, A, 'noFill');
  else if (fill.type === 'solid') node = make(doc, A, 'solidFill', {}, colorNode(doc, fill.color));
  else if (fill.type === 'gradient') {
    node = make(doc, A, 'gradFill', { rotWithShape: 1 });
    const list = make(doc, A, 'gsLst');
    for (const stop of fill.stops) list.append(make(doc, A, 'gs', { pos: Math.round(stop.position) }, colorNode(doc, stop.color)));
    node.append(list);
    if (fill.path) node.append(make(doc, A, 'path', { path: fill.path }, make(doc, A, 'fillToRect', { l: 50000, t: 50000, r: 50000, b: 50000 })));
    else node.append(make(doc, A, 'lin', { ang: Math.round(((fill.angle || 0) % 360 + 360) % 360 * 60000), scaled: 1 }));
  } else if (fill.type === 'pattern') {
    node = make(doc, A, 'pattFill', { prst: fill.preset }, make(doc, A, 'fgClr', {}, colorNode(doc, fill.foreground)), make(doc, A, 'bgClr', {}, colorNode(doc, fill.background)));
  } else if (fill.type === 'picture') {
    const blip = make(doc, A, 'blip'); blip.setAttributeNS(R, 'r:embed', fill.relId);
    node = make(doc, A, 'blipFill', { dpi: 0, rotWithShape: 1 }, blip, fill.tile
      ? make(doc, A, 'tile', { tx: 0, ty: 0, sx: Math.round((fill.tile.scale ?? 1) * 100000), sy: Math.round((fill.tile.scale ?? 1) * 100000), flip: 'none', algn: 'tl' })
      : make(doc, A, 'stretch', {}, make(doc, A, 'fillRect')));
  } else throw new Error('Choose a fill.');
  place(props, node, SHAPE_ORDER);
}

/** The fill described in shape properties, in setFill's form (undefined when the style provides it). */
export function readFill(props) {
  const node = childrenOf(props, A, FILLS)[0];
  if (!node) return undefined;
  if (node.localName === 'noFill') return { type: 'none' };
  if (node.localName === 'solidFill') return { type: 'solid', color: readColorNode(firstColor(node)) };
  if (node.localName === 'gradFill') {
    const stops = childrenOf(child(node, A, 'gsLst'), A, ['gs']).map(gs => ({ position: Number(gs.getAttribute('pos')), color: readColorNode(firstColor(gs)) }));
    const lin = child(node, A, 'lin'), path = child(node, A, 'path');
    return { type: 'gradient', stops, ...(path ? { path: path.getAttribute('path') } : { angle: Number(lin?.getAttribute('ang') || 0) / 60000 }) };
  }
  if (node.localName === 'pattFill') return { type: 'pattern', preset: node.getAttribute('prst'), foreground: readColorNode(firstColor(child(node, A, 'fgClr'))), background: readColorNode(firstColor(child(node, A, 'bgClr'))) };
  if (node.localName === 'blipFill') return { type: 'picture', relId: child(node, A, 'blip')?.getAttributeNS(R, 'embed'), tile: !!child(node, A, 'tile') };
  return { type: node.localName };
}

/**
 * Merge outline settings into shape properties' a:ln. patch: { color: color | 'none', width (EMU),
 * dash (preset), compound ('sng'|'dbl'|'thickThin'|'thinThick'|'tri'), cap, join, headEnd, tailEnd
 * ({ type, w, len } | null) }. `null` removes the outline element (the style's outline applies).
 */
export function setOutline(props, patch) {
  const doc = props.ownerDocument;
  if (patch === null) { remove(props, A, ['ln']); return; }
  let line = child(props, A, 'ln');
  if (!line) line = place(props, make(doc, A, 'ln'), SHAPE_ORDER);
  if (patch.color !== undefined) {
    remove(line, A, ['noFill', 'solidFill', 'gradFill', 'pattFill']);
    place(line, patch.color === 'none' ? make(doc, A, 'noFill') : make(doc, A, 'solidFill', {}, colorNode(doc, patch.color)), LINE_ORDER);
  }
  if (patch.width !== undefined) line.setAttribute('w', String(Math.round(patch.width)));
  if (patch.compound !== undefined) { if (patch.compound === 'sng') line.removeAttribute('cmpd'); else line.setAttribute('cmpd', patch.compound); }
  if (patch.cap !== undefined) { if (patch.cap === 'flat') line.removeAttribute('cap'); else line.setAttribute('cap', patch.cap); }
  if (patch.dash !== undefined) {
    remove(line, A, ['prstDash', 'custDash']);
    if (patch.dash && patch.dash !== 'solid') place(line, make(doc, A, 'prstDash', { val: patch.dash }), LINE_ORDER);
  }
  if (patch.join !== undefined) {
    remove(line, A, ['round', 'bevel', 'miter']);
    if (patch.join) place(line, make(doc, A, patch.join, patch.join === 'miter' ? { lim: 800000 } : {}), LINE_ORDER);
  }
  for (const end of ['headEnd', 'tailEnd']) if (patch[end] !== undefined) {
    remove(line, A, [end]);
    if (patch[end] && patch[end].type !== 'none') place(line, make(doc, A, end, { type: patch[end].type, w: patch[end].w || 'med', len: patch[end].len || 'med' }), LINE_ORDER);
  }
  // A line with no fill of its own takes a solid default so a width or dash change shows.
  if (!childrenOf(line, A, ['noFill', 'solidFill', 'gradFill', 'pattFill']).length && patch.color === undefined) place(line, make(doc, A, 'solidFill', {}, colorNode(doc, '000000')), LINE_ORDER);
}

/** The outline described in shape properties (undefined when there is none of its own). */
export function readOutline(props) {
  const line = child(props, A, 'ln');
  if (!line) return undefined;
  const fill = childrenOf(line, A, ['noFill', 'solidFill', 'gradFill', 'pattFill'])[0];
  const end = name => { const n = child(line, A, name); return n ? { type: n.getAttribute('type') || 'none', w: n.getAttribute('w') || 'med', len: n.getAttribute('len') || 'med' } : null; };
  return {
    color: !fill ? undefined : fill.localName === 'noFill' ? 'none' : readColorNode(firstColor(fill)),
    width: line.hasAttribute('w') ? Number(line.getAttribute('w')) : 9525,
    dash: child(line, A, 'prstDash')?.getAttribute('val') || 'solid',
    compound: line.getAttribute('cmpd') || 'sng', cap: line.getAttribute('cap') || 'flat',
    join: childrenOf(line, A, ['round', 'bevel', 'miter'])[0]?.localName || null,
    headEnd: end('headEnd'), tailEnd: end('tailEnd'),
  };
}

/**
 * Effects (§20.1.8.26 effectLst). patch keys, each an object or null to remove:
 * shadow { blur, distance (EMU), direction (degrees), color, alpha, scale?, align? },
 * glow { radius (EMU), color, alpha }, softEdge { radius (EMU) },
 * reflection { blur, startAlpha, endAlpha, endPosition (0..100000), distance }.
 */
export function setEffects(props, patch) {
  const doc = props.ownerDocument;
  let list = child(props, A, 'effectLst');
  if (!list) list = place(props, make(doc, A, 'effectLst'), SHAPE_ORDER);
  const set = (name, node) => { remove(list, A, [name]); if (node) place(list, node, EFFECT_ORDER); };
  const angle = degrees => Math.round(((degrees % 360) + 360) % 360 * 60000);
  if (patch.shadow !== undefined) set('outerShdw', patch.shadow && make(doc, A, 'outerShdw', {
    blurRad: Math.round(patch.shadow.blur ?? 50800), dist: Math.round(patch.shadow.distance ?? 38100), dir: angle(patch.shadow.direction ?? 45),
    ...(patch.shadow.scale && patch.shadow.scale !== 1 ? { sx: Math.round(patch.shadow.scale * 100000), sy: Math.round(patch.shadow.scale * 100000) } : {}),
    algn: patch.shadow.align || (patch.shadow.scale && patch.shadow.scale !== 1 ? 'ctr' : 'tl'), rotWithShape: 0,
  }, colorNode(doc, { ...(typeof patch.shadow.color === 'string' ? { rgb: patch.shadow.color } : patch.shadow.color || { rgb: '000000' }), alpha: patch.shadow.alpha ?? 0.4 })));
  if (patch.glow !== undefined) set('glow', patch.glow && make(doc, A, 'glow', { rad: Math.round(patch.glow.radius) },
    colorNode(doc, { ...(typeof patch.glow.color === 'string' ? { rgb: patch.glow.color } : patch.glow.color), alpha: patch.glow.alpha ?? 0.6 })));
  if (patch.softEdge !== undefined) set('softEdge', patch.softEdge && make(doc, A, 'softEdge', { rad: Math.round(patch.softEdge.radius) }));
  if (patch.reflection !== undefined) set('reflection', patch.reflection && make(doc, A, 'reflection', {
    blurRad: Math.round(patch.reflection.blur ?? 6350), stA: Math.round((patch.reflection.startAlpha ?? 0.5) * 100000), stPos: 0,
    endA: Math.round((patch.reflection.endAlpha ?? 0.003) * 100000), endPos: Math.round(patch.reflection.endPosition ?? 35000), dist: Math.round(patch.reflection.distance ?? 0),
    dir: 5400000, sy: -100000, algn: 'bl', rotWithShape: 0 }));
  if (!list.children.length) list.remove();
}

/** The effects described in shape properties. */
export function readEffects(props) {
  const list = child(props, A, 'effectLst');
  const num = (node, name, fallback = 0) => node?.hasAttribute(name) ? Number(node.getAttribute(name)) : fallback;
  const shadow = child(list, A, 'outerShdw'), glow = child(list, A, 'glow'), soft = child(list, A, 'softEdge'), reflection = child(list, A, 'reflection');
  const color = node => { const value = readColorNode(firstColor(node)); return value ? { color: { ...value, alpha: undefined }, alpha: value.alpha ?? 1 } : {}; };
  return {
    shadow: shadow ? { blur: num(shadow, 'blurRad'), distance: num(shadow, 'dist'), direction: num(shadow, 'dir') / 60000, scale: num(shadow, 'sx', 100000) / 100000, ...color(shadow) } : null,
    glow: glow ? { radius: num(glow, 'rad'), ...color(glow) } : null,
    softEdge: soft ? { radius: num(soft, 'rad') } : null,
    reflection: reflection ? { blur: num(reflection, 'blurRad'), startAlpha: num(reflection, 'stA', 100000) / 100000, endAlpha: num(reflection, 'endA') / 100000, endPosition: num(reflection, 'endPos', 100000), distance: num(reflection, 'dist') } : null,
  };
}

/**
 * Bevel and 3-D rotation (§20.1.5 scene3d, sp3d). bevel: { preset, width, height (EMU) } | null;
 * camera: preset name ('orthographicFront', 'perspectiveRight', …) | null.
 */
export function set3d(props, { bevel, camera } = {}) {
  const doc = props.ownerDocument;
  let scene = child(props, A, 'scene3d'), solid = child(props, A, 'sp3d');
  if (camera !== undefined || (bevel && !scene)) {
    if (!scene) scene = place(props, make(doc, A, 'scene3d'), SHAPE_ORDER);
    scene.replaceChildren(make(doc, A, 'camera', { prst: camera || 'orthographicFront' }), make(doc, A, 'lightRig', { rig: 'threePt', dir: 't' }));
  }
  if (bevel !== undefined) {
    if (!solid) solid = place(props, make(doc, A, 'sp3d'), SHAPE_ORDER);
    remove(solid, A, ['bevelT']);
    if (bevel) solid.prepend(make(doc, A, 'bevelT', { w: Math.round(bevel.width ?? 63500), h: Math.round(bevel.height ?? 25400), prst: bevel.preset || 'circle' }));
  }
  // Nothing left to project: drop the empty scene so the drawing reads as flat again.
  if (solid && !solid.children.length && !solid.attributes.length) solid.remove();
  const flat = !child(props, A, 'sp3d') && (!scene || child(scene, A, 'camera')?.getAttribute('prst') === 'orthographicFront');
  if (flat) child(props, A, 'scene3d')?.remove();
}

/** Bevel and camera read back from shape properties. */
export function read3d(props) {
  const scene = child(props, A, 'scene3d'), bevel = child(child(props, A, 'sp3d'), A, 'bevelT');
  return { camera: child(scene, A, 'camera')?.getAttribute('prst') || null, bevel: bevel ? { preset: bevel.getAttribute('prst') || 'circle', width: Number(bevel.getAttribute('w') || 76200), height: Number(bevel.getAttribute('h') || 76200) } : null };
}

/** Preset geometry (§20.1.9.18) with optional adjust values { name: value }. */
export function setGeometry(props, preset, adjustments = {}) {
  const doc = props.ownerDocument;
  remove(props, A, ['custGeom', 'prstGeom']);
  const list = make(doc, A, 'avLst');
  for (const [name, value] of Object.entries(adjustments)) list.append(make(doc, A, 'gd', { name, fmla: `val ${Math.round(value)}` }));
  place(props, make(doc, A, 'prstGeom', { prst: preset }, list), SHAPE_ORDER);
}
export function readGeometry(props) {
  const preset = child(props, A, 'prstGeom');
  if (!preset) return child(props, A, 'custGeom') ? { custom: true } : null;
  const adjustments = Object.fromEntries(childrenOf(child(preset, A, 'avLst'), A, ['gd']).map(gd => [gd.getAttribute('name'), Number(/^val\s+(-?\d+)$/.exec(gd.getAttribute('fmla') || '')?.[1])]));
  return { preset: preset.getAttribute('prst'), adjustments };
}

/** Rotation (degrees) and flips on the shape transform (§20.1.7.6 xfrm). */
export function setTransform(props, { rotation, flipH, flipV }) {
  const doc = props.ownerDocument;
  let xfrm = child(props, A, 'xfrm');
  if (!xfrm) xfrm = place(props, make(doc, A, 'xfrm'), SHAPE_ORDER);
  if (rotation !== undefined) {
    const value = Math.round(((rotation % 360) + 360) % 360 * 60000);
    if (value) xfrm.setAttribute('rot', String(value)); else xfrm.removeAttribute('rot');
  }
  for (const [key, value] of [['flipH', flipH], ['flipV', flipV]]) if (value !== undefined) { if (value) xfrm.setAttribute(key, '1'); else xfrm.removeAttribute(key); }
}
export function readTransform(props) {
  const xfrm = child(props, A, 'xfrm');
  const flag = name => ['1', 'true'].includes(xfrm?.getAttribute(name));
  return { rotation: Number(xfrm?.getAttribute('rot') || 0) / 60000, flipH: flag('flipH'), flipV: flag('flipV') };
}

/**
 * Picture color effects on a:blip (§20.1.8.13 and the effects it lists). patch keys:
 * luminance { brightness, contrast } (−1..1) | null, grayscale bool, duotone [dark, light] | null,
 * biLevel threshold (0..1) | null, colorChange { from, to } | null (to.alpha 0 for a transparent color),
 * alpha (0..1, 1 removes).
 */
export function setBlipEffects(blip, patch) {
  const doc = blip.ownerDocument;
  const before = node => place(blip, node, ['alphaBiLevel', 'alphaCeiling', 'alphaFloor', 'alphaInv', 'alphaMod', 'alphaModFix', 'alphaRepl', 'biLevel', 'blur', 'clrChange', 'clrRepl', 'duotone', 'fillOverlay', 'grayscl', 'hsl', 'lum', 'tint', 'extLst']);
  const percent = value => Math.round(value * 100000);
  if (patch.colorChange !== undefined) {
    remove(blip, A, ['clrChange']);
    if (patch.colorChange) {
      const node = make(doc, A, 'clrChange', {}, make(doc, A, 'clrFrom', {}, colorNode(doc, patch.colorChange.from)), make(doc, A, 'clrTo', {}, colorNode(doc, patch.colorChange.to)));
      blip.insertBefore(node, blip.firstChild);
    }
  }
  if (patch.grayscale !== undefined || patch.duotone !== undefined || patch.biLevel !== undefined) {
    // Recolor presets replace each other.
    remove(blip, A, ['grayscl', 'duotone', 'biLevel']);
    if (patch.grayscale) before(make(doc, A, 'grayscl'));
    if (patch.duotone) before(make(doc, A, 'duotone', {}, ...patch.duotone.map(color => colorNode(doc, color))));
    if (patch.biLevel !== undefined && patch.biLevel !== null) before(make(doc, A, 'biLevel', { thresh: percent(patch.biLevel) }));
  }
  if (patch.luminance !== undefined) {
    remove(blip, A, ['lum']);
    if (patch.luminance && (patch.luminance.brightness || patch.luminance.contrast)) before(make(doc, A, 'lum', { bright: percent(patch.luminance.brightness || 0), contrast: percent(patch.luminance.contrast || 0) }));
  }
  if (patch.alpha !== undefined) {
    remove(blip, A, ['alphaModFix']);
    if (patch.alpha < 1) blip.insertBefore(make(doc, A, 'alphaModFix', { amt: percent(Math.max(0, patch.alpha)) }), childrenOf(blip, A, ['extLst'])[0] || null);
  }
}

/** Picture color effects read back from a:blip, in setBlipEffects' form. */
export function readBlipEffects(blip) {
  const lum = child(blip, A, 'lum'), duotone = child(blip, A, 'duotone'), change = child(blip, A, 'clrChange'), alpha = child(blip, A, 'alphaModFix'), bi = child(blip, A, 'biLevel');
  const pct = (node, name) => node?.hasAttribute(name) ? (/%$/.test(node.getAttribute(name)) ? parseFloat(node.getAttribute(name)) / 100 : Number(node.getAttribute(name)) / 100000) : 0;
  return {
    luminance: lum ? { brightness: pct(lum, 'bright'), contrast: pct(lum, 'contrast') } : null,
    grayscale: !!child(blip, A, 'grayscl'),
    duotone: duotone ? [...duotone.children].map(readColorNode) : null,
    biLevel: bi ? pct(bi, 'thresh') : null,
    colorChange: change ? { from: readColorNode(firstColor(child(change, A, 'clrFrom'))), to: readColorNode(firstColor(child(change, A, 'clrTo'))) } : null,
    alpha: alpha ? (alpha.hasAttribute('amt') ? pct(alpha, 'amt') : 1) : 1,
  };
}

/** Source crop (§20.1.8.55 srcRect) in 1/1000 % per side; zero crop removes the element. */
export function setCrop(blipFill, crop) {
  const doc = blipFill.ownerDocument;
  remove(blipFill, A, ['srcRect']);
  const sides = { l: crop.left || 0, t: crop.top || 0, r: crop.right || 0, b: crop.bottom || 0 };
  if (!Object.values(sides).some(Boolean)) return;
  const rect = make(doc, A, 'srcRect', Object.fromEntries(Object.entries(sides).filter(([, v]) => v).map(([k, v]) => [k, Math.round(v)])));
  blipFill.insertBefore(rect, childrenOf(blipFill, A, ['tile', 'stretch'])[0] || null);
}

/**
 * The picture's original layer (MS-ODRAWXML a14:imgProps): the blip shows the processed picture and the
 * extension keeps the original with the edits applied to it, so other applications show the result and
 * the original can be restored. effects: [{ name: a14 element, attrs }].
 */
export function setPictureLayer(blip, originalRelId, effects) {
  const doc = blip.ownerDocument;
  let list = child(blip, A, 'extLst');
  for (const ext of childrenOf(list, A, ['ext'])) if (ext.getAttribute('uri')?.toUpperCase() === IMAGE_PROPERTIES_URI) ext.remove();
  if (originalRelId) {
    if (!list) list = blip.appendChild(make(doc, A, 'extLst'));
    const layer = make(doc, A14, 'imgLayer');
    layer.setAttributeNS(R, 'r:embed', originalRelId);
    for (const effect of effects) layer.append(make(doc, A14, 'imgEffect', {}, make(doc, A14, effect.name, effect.attrs || {}, ...(effect.children || []).map(c => make(doc, A14, c.name, c.attrs)))));
    const props = make(doc, A14, 'imgProps', {}, layer);
    props.setAttributeNS(XMLNS, 'xmlns:a14', A14);
    list.insertBefore(make(doc, A, 'ext', { uri: IMAGE_PROPERTIES_URI }, props), list.firstChild);
  }
  if (list && !list.children.length) list.remove();
}

/** The original layer of a processed picture: { relId, effects: [{ name, attrs }] } or null. */
export function readPictureLayer(blip) {
  const ext = childrenOf(child(blip, A, 'extLst'), A, ['ext']).find(e => e.getAttribute('uri')?.toUpperCase() === IMAGE_PROPERTIES_URI);
  const layer = child(child(ext, A14, 'imgProps'), A14, 'imgLayer');
  if (!layer) return null;
  return { relId: layer.getAttributeNS(R, 'embed'), effects: childrenOf(layer, A14, ['imgEffect']).map(e => e.firstElementChild).filter(Boolean)
    .map(node => ({ name: node.localName, attrs: Object.fromEntries([...node.attributes].filter(a => !a.namespaceURI).map(a => [a.localName, a.value])) })) };
}

/** Text body properties (§20.1.2.1.1 bodyPr): anchor t|ctr|b, insets (EMU), wrap bool, autofit 'none'|'shape', vert. */
export function setBodyProperties(body, patch) {
  const doc = body.ownerDocument;
  if (patch.anchor !== undefined) body.setAttribute('anchor', patch.anchor);
  for (const [key, attr] of [['left', 'lIns'], ['top', 'tIns'], ['right', 'rIns'], ['bottom', 'bIns']]) if (patch.insets?.[key] !== undefined) body.setAttribute(attr, String(Math.round(patch.insets[key])));
  if (patch.wrap !== undefined) body.setAttribute('wrap', patch.wrap ? 'square' : 'none');
  if (patch.vert !== undefined) { if (patch.vert === 'horz') body.removeAttribute('vert'); else body.setAttribute('vert', patch.vert); }
  if (patch.autofit !== undefined) {
    remove(body, A, ['noAutofit', 'normAutofit', 'spAutoFit']);
    place(body, make(doc, A, patch.autofit === 'shape' ? 'spAutoFit' : 'noAutofit'), BODY_ORDER);
  }
}
export function readBodyProperties(body) {
  if (!body) return null;
  const inset = (attr, fallback) => body.hasAttribute(attr) ? Number(body.getAttribute(attr)) : fallback;
  return { anchor: body.getAttribute('anchor') || 't', vert: body.getAttribute('vert') || 'horz', wrap: body.getAttribute('wrap') !== 'none',
    autofit: child(body, A, 'spAutoFit') ? 'shape' : child(body, A, 'normAutofit') ? 'text' : 'none',
    insets: { left: inset('lIns', 91440), top: inset('tIns', 45720), right: inset('rIns', 91440), bottom: inset('bIns', 45720) } };
}

/** Non-visual properties (§20.4.2.5 docPr): name, descr (alt text), title, decorative flag. */
export function setDocProperties(docPr, { name, description, title, decorative } = {}) {
  const doc = docPr.ownerDocument;
  if (name !== undefined) docPr.setAttribute('name', xmlAttributeText(name));
  for (const [key, value] of [['descr', description], ['title', title]]) if (value !== undefined) { const text = xmlAttributeText(value); if (text) docPr.setAttribute(key, text); else docPr.removeAttribute(key); }
  if (decorative !== undefined) {
    let list = child(docPr, A, 'extLst');
    for (const ext of childrenOf(list, A, ['ext'])) if (ext.getAttribute('uri')?.toUpperCase() === DECORATIVE_URI) ext.remove();
    if (decorative) {
      if (!list) list = docPr.appendChild(make(doc, A, 'extLst'));
      const flag = make(doc, ADEC, 'decorative', { val: 1 });
      flag.setAttributeNS(XMLNS, 'xmlns:adec', ADEC);
      list.append(make(doc, A, 'ext', { uri: DECORATIVE_URI }, flag));
    }
    if (list && !list.children.length) list.remove();
  }
}

/* ---- Frame: in line with text, or floating with a position and text wrapping (§20.4.2.3, §20.4.2.8) ---- */

const ANCHOR_ORDER = ['simplePos', 'positionH', 'positionV', 'extent', 'effectExtent', 'wrapNone', 'wrapSquare', 'wrapTight', 'wrapThrough', 'wrapTopAndBottom', 'docPr', 'cNvGraphicFramePr', 'graphic'];

/**
 * Rewrite the drawing's frame. spec: { inline: true } or { horizontal: { relativeFrom, align? | offset? },
 * vertical: { relativeFrom, align? | offset? }, wrap: { type: 'square'|'tight'|'through'|'topAndBottom'|'none',
 * side?, distances?: { T, B, L, R } }, behind, order, locked, layoutInCell, allowOverlap }.
 * Extent, effect extent, properties and graphic move across unchanged; omitted settings keep their values.
 */
export function writeFrame(drawing, spec) {
  const doc = drawing.ownerDocument;
  const old = [...drawing.children].find(n => n.namespaceURI === WP && ['inline', 'anchor'].includes(n.localName));
  if (!old) throw new Error('The drawing has no frame.');
  const pick = name => child(old, WP, name);
  const keep = [...old.children].filter(n => !(n.namespaceURI === WP && ['simplePos', 'positionH', 'positionV', 'wrapNone', 'wrapSquare', 'wrapTight', 'wrapThrough', 'wrapTopAndBottom'].includes(n.localName)));
  const wp = (name, attrs, ...kids) => make(doc, WP, name, attrs, ...kids);
  if (spec.inline) {
    const frame = wp('inline', { distT: 0, distB: 0, distL: 0, distR: 0 });
    // Relative sizes and other floating-only extensions do not apply in line.
    for (const node of keep) if (node.namespaceURI === WP || node.namespaceURI === A) frame.append(node);
    if (!child(frame, WP, 'effectExtent')) frame.insertBefore(wp('effectExtent', { l: 0, t: 0, r: 0, b: 0 }), child(frame, WP, 'extent').nextSibling);
    old.replaceWith(frame);
    return frame;
  }
  const was = old.localName === 'anchor' ? old : null;
  const attr = (name, fallback) => was?.hasAttribute(name) ? was.getAttribute(name) : fallback;
  const flag = (value, name, fallback) => value === undefined ? attr(name, fallback) : value ? '1' : '0';
  const wrap = spec.wrap || readWrap(was) || { type: 'none' };
  const distances = { T: 0, B: 0, L: 114300, R: 114300, ...(readWrap(was)?.distances || {}), ...(wrap.distances || {}) };
  // Top-and-bottom wrapping measures its gap from the paragraph flow; its top and bottom distances stay zero.
  if (wrap.type === 'topAndBottom') distances.T = distances.B = 0;
  const frame = wp('anchor', {
    distT: distances.T, distB: distances.B, distL: distances.L, distR: distances.R,
    simplePos: 0, relativeHeight: spec.order ?? attr('relativeHeight', 1), behindDoc: flag(spec.behind, 'behindDoc', '0'),
    locked: flag(spec.locked, 'locked', '0'), layoutInCell: flag(spec.layoutInCell, 'layoutInCell', '1'), allowOverlap: flag(spec.allowOverlap, 'allowOverlap', '1') });
  frame.append(wp('simplePos', { x: 0, y: 0 }));
  for (const [name, axis] of [['positionH', 'horizontal'], ['positionV', 'vertical']]) {
    const value = spec[axis] || readPosition(pick(name)) || { relativeFrom: axis === 'horizontal' ? 'column' : 'paragraph', offset: 0 };
    const node = wp(name, { relativeFrom: value.relativeFrom });
    if (value.align) node.append(Object.assign(wp('align'), { textContent: value.align }));
    else node.append(Object.assign(wp('posOffset'), { textContent: String(Math.round(value.offset || 0)) }));
    frame.append(node);
  }
  for (const node of keep) frame.append(node);
  const wrapNode = wrap.type === 'square' ? wp('wrapSquare', { wrapText: wrap.side || 'bothSides' })
    : wrap.type === 'tight' || wrap.type === 'through' ? wp(wrap.type === 'tight' ? 'wrapTight' : 'wrapThrough', { wrapText: wrap.side || 'bothSides' }, wrapPolygon(doc, wrap.polygon))
    : wrap.type === 'topAndBottom' ? wp('wrapTopAndBottom') : wp('wrapNone');
  frame.append(wrapNode);
  // Re-sort the kept children around the new ones in schema order; anything unknown stays at the end in its order.
  const rank = n => { const at = n.namespaceURI === WP || n.namespaceURI === A ? ANCHOR_ORDER.indexOf(n.localName) : -1; return at < 0 ? ANCHOR_ORDER.length : at; };
  const sorted = [...frame.children].map((n, i) => [n, rank(n), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([n]) => n);
  for (const node of sorted) frame.append(node);
  if (!child(frame, WP, 'effectExtent')) frame.insertBefore(wp('effectExtent', { l: 0, t: 0, r: 0, b: 0 }), child(frame, WP, 'extent').nextSibling);
  if (!child(frame, WP, 'cNvGraphicFramePr')) frame.insertBefore(wp('cNvGraphicFramePr'), child(frame, A, 'graphic'));
  old.replaceWith(frame);
  return frame;
}

function wrapPolygon(doc, polygon) {
  // A rectangular contour around the drawing in the 21600-unit wrap space (§20.4.2.16).
  const points = polygon || [[0, 0], [0, 21600], [21600, 21600], [21600, 0], [0, 0]];
  const node = make(doc, WP, 'wrapPolygon', { edited: 0 }, make(doc, WP, 'start', { x: points[0][0], y: points[0][1] }));
  for (const [x, y] of points.slice(1)) node.append(make(doc, WP, 'lineTo', { x, y }));
  return node;
}

function readPosition(node) {
  if (!node) return null;
  const align = child(node, WP, 'align'), offset = child(node, WP, 'posOffset');
  return { relativeFrom: node.getAttribute('relativeFrom'), ...(align ? { align: align.textContent.trim() } : { offset: Number(offset?.textContent.trim() || 0) }) };
}
function readWrap(frame) {
  if (!frame) return null;
  const node = [...frame.children].find(n => n.namespaceURI === WP && n.localName.startsWith('wrap'));
  if (!node) return null;
  const type = { wrapNone: 'none', wrapSquare: 'square', wrapTight: 'tight', wrapThrough: 'through', wrapTopAndBottom: 'topAndBottom' }[node.localName];
  const distance = side => Number(node.getAttribute(`dist${side}`) ?? frame.getAttribute(`dist${side}`) ?? 0);
  return { type, side: node.getAttribute('wrapText') || 'bothSides', distances: { T: distance('T'), B: distance('B'), L: distance('L'), R: distance('R') } };
}

/** The frame read back: { inline, horizontal, vertical, wrap, behind, order, locked, layoutInCell, allowOverlap }. */
export function readFrame(drawing) {
  const frame = [...drawing.children].find(n => n.namespaceURI === WP && ['inline', 'anchor'].includes(n.localName));
  if (!frame || frame.localName === 'inline') return { inline: true };
  const flag = name => ['1', 'true'].includes(frame.getAttribute(name));
  return { inline: false, horizontal: readPosition(child(frame, WP, 'positionH')), vertical: readPosition(child(frame, WP, 'positionV')), wrap: readWrap(frame),
    behind: flag('behindDoc'), order: Number(frame.getAttribute('relativeHeight') || 0), locked: flag('locked'),
    layoutInCell: frame.getAttribute('layoutInCell') !== '0' && frame.getAttribute('layoutInCell') !== 'false',
    allowOverlap: frame.getAttribute('allowOverlap') !== '0' && frame.getAttribute('allowOverlap') !== 'false' };
}

/** Everything the Format panes and menus show about a drawing, from its XML. */
export function describeDrawing(shell) {
  const drawing = parseXml(shell).documentElement;
  const frame = [...drawing.children].find(n => n.namespaceURI === WP && ['inline', 'anchor'].includes(n.localName));
  const docPr = child(frame, WP, 'docPr'), data = child(child(frame, A, 'graphic'), A, 'graphicData'), root = data?.firstElementChild;
  const picture = root?.namespaceURI === PIC ? root : null, shape = root?.namespaceURI === WPS ? root : null, group = root?.namespaceURI === WPG ? root : null;
  const props = picture ? child(picture, PIC, 'spPr') : shape ? child(shape, WPS, 'spPr') : group ? child(group, WPG, 'grpSpPr') : null;
  const blipFill = picture && child(picture, PIC, 'blipFill'), blip = child(blipFill, A, 'blip');
  const decorative = childrenOf(child(docPr, A, 'extLst'), A, ['ext']).some(ext => ext.getAttribute('uri')?.toUpperCase() === DECORATIVE_URI && ['1', 'true'].includes(child(ext, ADEC, 'decorative')?.getAttribute('val')));
  const extent = child(frame, WP, 'extent');
  return {
    kind: picture ? 'picture' : shape ? (child(shape, WPS, 'txbx') ? 'textBox' : 'shape') : group ? 'group' : 'other',
    name: docPr?.getAttribute('name') || '', description: docPr?.getAttribute('descr') || '', title: docPr?.getAttribute('title') || '', decorative, hidden: ['1', 'true'].includes(docPr?.getAttribute('hidden')),
    width: Number(extent?.getAttribute('cx') || 0), height: Number(extent?.getAttribute('cy') || 0),
    frame: readFrame(drawing),
    fill: props ? readFill(props) : undefined, outline: props ? readOutline(props) : undefined, effects: props ? readEffects(props) : null,
    threeD: props ? read3d(props) : null, geometry: props ? readGeometry(props) : null, transform: props ? readTransform(props) : null,
    blip: blip ? { ...readBlipEffects(blip), layer: readPictureLayer(blip), relId: blip.getAttributeNS(R, 'embed') } : null,
    crop: blipFill ? Object.fromEntries(['l', 't', 'r', 'b'].map((k, i) => [['left', 'top', 'right', 'bottom'][i], Number(child(blipFill, A, 'srcRect')?.getAttribute(k) || 0)])) : null,
    body: shape ? readBodyProperties(child(shape, WPS, 'bodyPr')) : null,
    styled: !!(shape && child(shape, WPS, 'style')),
  };
}

/** The document theme's colors by scheme name (accent1…6, dk1, lt1, dk2, lt2), or null without a theme. */
// Each theme part's colors, read once for each version of the part (its bytes, replaced when it is written):
// the drawing controls ask for them after every keystroke.
const readThemeColors = new WeakMap();
export function themeColors(parts) {
  try {
    const path = relatedPartPath(parts, 'theme'), bytes = path && parts[path];
    if (!bytes) return null;
    let colors = typeof bytes === 'object' ? readThemeColors.get(bytes) : undefined;
    if (colors === undefined) {
      colors = schemeColors(parseXml(bytes).documentElement);
      if (typeof bytes === 'object') readThemeColors.set(bytes, colors);
    }
    return colors && { ...colors };
  } catch { return null; }
}
function schemeColors(root) {
  const scheme = root.getElementsByTagNameNS(A, 'clrScheme')[0];
  if (!scheme) return null;
  const colors = {};
  for (const entry of scheme.children) {
    const node = entry.firstElementChild;
    if (node) colors[entry.localName] = (node.getAttribute('lastClr') || node.getAttribute('val') || '').toUpperCase();
  }
  return /^[0-9A-F]{6}$/.test(colors.accent1 || '') ? colors : null;
}
