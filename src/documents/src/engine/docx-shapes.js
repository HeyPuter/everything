import { projectRetainedTextBoxControls } from './docx-content-controls.js';
import { readLinearGradient } from './drawing-gradients.js';
import { readPatternFill } from './drawing-patterns.js';
import { pictureOutlineScene } from './picture-outline.js';
import { readPictureBackingFill } from './picture-backing-fill.js';
import { sketchLinePreview, neutralSketchLine, readSketchGeometry, supportedSketchLine } from './sketch-line-preview.js';
import { DRAWING_DASHES } from './drawing-line-dashes.js';
import { COMPOUND_LINES, closedOutlinePath } from './compound-outlines.js';
// Original reader for the drawing extensions published in [MS-ODRAWXML].
// Scene data is immutable; the source drawing (including MCE alternatives) is
// retained as one atomic object. No XML is interpreted by the canvas painter.
import { UnsupportedDocumentError } from './errors.js';
import { PRESET_GEOMETRIES } from './preset-geometries.js';
import { WPG, WPS } from './docx-compatibility.js';
import { readDrawingMetadata } from './docx-drawing-metadata.js';
import { drawingColor, drawingPaintColor, mergeDrawingLine } from './docx-drawing-style.js';
import { geometryGuides } from './geometry-guides.js';
import { cloudGeometry } from './cloud-geometry.js';
import { ribbonGeometry } from './ribbon-geometry.js';
import { readShapeExtensions } from './docx-shape-extensions.js';
import { readPictureShadow } from './docx-picture-shadow.js';
import { readDrawingEffects } from './docx-drawing-effects.js';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const children = n => [...(n?.children || [])];
const child = (n, ns, name) => children(n).find(c => c.namespaceURI === ns && c.localName === name);
const fail = why => { throw new UnsupportedDocumentError(`grouped drawings with ${why}`); };
function check(node, allowed) {
  if (!node) fail('missing properties');
  for (const n of children(node)) if (!allowed.some(([ns, name]) => n.namespaceURI === ns && n.localName === name)) fail(`unsupported ${n.localName}`);
  for (const [ns, name] of allowed) if (!['p', 'wsp', 'grpSp', 'pic', 'path', 'moveTo', 'lnTo', 'quadBezTo', 'cubicBezTo', 'close'].includes(name) && children(node).filter(n => n.namespaceURI === ns && n.localName === name).length > 1) fail(`duplicate ${name}`);
}
function number(n, key, fallback) {
  const raw = n?.getAttribute(key);
  if (raw === null || raw === undefined) { if (fallback !== undefined) return fallback; fail(`missing ${key}`); }
  if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(+raw) || Math.abs(+raw) > 20116800) fail(`invalid ${key}`);
  return +raw;
}
function groupLocks(properties) {
  check(properties, [[A, 'grpSpLocks']]);
  const locks = child(properties, A, 'grpSpLocks');
  for (const n of [properties, locks].filter(Boolean)) {
    if ([...n.childNodes].some(c => [3, 4].includes(c.nodeType) && /[^ \t\r\n]/.test(c.textContent))) fail('text in group locks');
    for (const attr of n.attributes) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (n === properties || attr.namespaceURI || !['noGrp', 'noUngrp', 'noMove', 'noResize', 'noRot', 'noChangeAspect', 'noSelect'].includes(attr.localName)) fail('unsupported group lock attributes');
      const value = attr.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      if (!['0', '1', 'false', 'true'].includes(value)) fail('invalid group lock flags');
      // ECMA-376 §20.1.2.2.21. Geometry and group structure are already
      // immutable for retained drawings, enforcing all transformation locks.
      // Selection is supported, so its prohibition still needs implementation.
      if (attr.localName === 'noSelect' && ['1', 'true'].includes(value)) fail('selection-locked groups');
    }
  }
  if (locks) check(locks, []);
}
function shapeLocks(properties, connector = false) {
  const lockName = connector ? 'cxnSpLocks' : 'spLocks';
  check(properties, (connector ? [lockName, 'stCxn', 'endCxn'] : [lockName]).map(name => [A, name]));
  if (connector) {
    if ([...properties.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') ||
        [...properties.childNodes].some(n => [3, 4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('invalid connector properties');
    let order = -1;
    for (const n of children(properties)) {
      const next = [lockName, 'stCxn', 'endCxn'].indexOf(n.localName);
      if (next <= order) fail('misordered connector properties');
      order = next;
      if (n.localName === lockName) continue;
      check(n, []);
      if ([...n.childNodes].some(c => [3, 4].includes(c.nodeType) && /[^ \t\r\n]/.test(c.textContent)) ||
          [...n.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI || !['id', 'idx'].includes(a.localName)))) fail('invalid connector endpoint');
      for (const key of ['id', 'idx']) {
        const value = n.getAttribute(key)?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
        if (!/^[+-]?\d+$/.test(value || '') || Number(value) < 0 || Number(value) > 4294967295) fail('invalid connector endpoint');
      }
    }
    // The authored transform defines the retained ink. Endpoint references
    // are routing/editing metadata; internal shapes are never moved separately.
  }
  const locks = child(properties, A, lockName);
  if (!locks) return;
  check(locks, []);
  if ([...locks.childNodes].some(c => [3, 4].includes(c.nodeType) && /[^ \t\r\n]/.test(c.textContent))) fail('text in shape locks');
  for (const attr of locks.attributes) {
    if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    if (attr.namespaceURI || !['noGrp', 'noSelect', 'noRot', 'noChangeAspect', 'noMove', 'noResize', 'noEditPoints', 'noAdjustHandles', 'noChangeArrowheads', 'noChangeShapeType', ...(connector ? [] : ['noTextEdit'])].includes(attr.localName)) fail('unsupported shape lock attributes');
    const value = attr.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    if (!['0', '1', 'false', 'true'].includes(value)) fail('invalid shape lock flags');
    // Retained shapes are atomic: geometry, handles and internal text cannot
    // be edited. Selection remains available, so preserve its existing guard.
    if (attr.localName === 'noSelect' && ['1', 'true'].includes(value)) fail('selection-locked shapes');
  }
}
function transform(props, group, picture = false, allowFlat = false) {
  const n = child(props, A, 'xfrm'); check(n, ['off', 'ext', ...(group ? ['chOff', 'chExt'] : [])].map(k => [A, k]));
  const preset = child(props, A, 'prstGeom')?.getAttribute('prst');
  const line = allowFlat && !group && !picture && (preset === 'line' || preset === 'straightConnector1');
  const custom = allowFlat && !group && !picture && child(props, A, 'custGeom');
  let rotation = 0;
  for (const attr of n.attributes) if (!attr.namespaceURI) {
    if (attr.localName === 'rot') {
      const raw = attr.value.trim(), value = Number(raw);
      if (!/^[+-]?\d+$/.test(raw) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail('rotated or flipped shape transforms');
      rotation = ((value % 21600000) + 21600000) % 21600000;
    } else if (!['flipH', 'flipV'].includes(attr.localName) || !['0', '1', 'false', 'true'].includes(attr.value.trim())) fail('rotated or flipped shape transforms');
  }
  const off = child(n, A, 'off'), ext = child(n, A, 'ext');
  const result = { x: number(off, 'x'), y: number(off, 'y'), width: number(ext, 'cx'), height: number(ext, 'cy') };
  if (!picture) for (const key of ['flipH', 'flipV']) if (['1', 'true'].includes(n.getAttribute(key)?.trim())) result[key] = true;
  if (rotation) result[group ? 'groupRotation' : picture ? 'pictureRotation' : line ? 'lineRotation' : 'shapeRotation'] = rotation;
  if (result.width < 0 || result.height < 0 || !custom && ((!result.width && !result.height) || !line && !group && (!result.width || !result.height))) fail('empty shape extents');
  if (group) {
    const co = child(n, A, 'chOff'), ce = child(n, A, 'chExt');
    Object.assign(result, { childX: number(co, 'x'), childY: number(co, 'y'), childWidth: number(ce, 'cx'), childHeight: number(ce, 'cy') });
    if (result.childWidth < 0 || result.childHeight < 0) fail('negative child extents');
  }
  return result;
}

function fill(props, readSchemeColor) {
  const pattern = child(props, A, 'pattFill');
  if (pattern) return readPatternFill(pattern, readSchemeColor);
  const gradient = child(props, A, 'gradFill');
  if (gradient) return readLinearGradient(gradient, readSchemeColor);
  if (child(props, A, 'noFill')) { if (child(props, A, 'solidFill')) fail('conflicting fills'); return null; }
  const solid = child(props, A, 'solidFill');
  if (!solid) return null;
  check(solid, [[A, 'srgbClr'], [A, 'schemeClr'], [A, 'scrgbClr'], [A, 'sysClr']]);
  if (children(solid).length !== 1) fail('missing or conflicting solid colors');
  return drawingPaintColor(children(solid)[0], readSchemeColor);
}
function validateGroupFill(props) {
  if (['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'].filter(k => child(props, A, k)).length > 1) fail('conflicting shape fills');
  for (const name of ['grpFill', 'noFill']) {
    const empty = child(props, A, name); if (!empty) continue;
    check(empty, []);
    if ([...empty.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') || [...empty.childNodes].some(n => [3, 4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('invalid empty fill');
  }
}
export function readDrawingOutline(props, readSchemeColor, { preview = false } = {}) {
  const sourceLine = child(props,A,'ln'), neutral = sourceLine && neutralSketchLine(sourceLine);
  const supported = !neutral && supportedSketchLine(props);
  const cached = !neutral && !supported && preview ? sketchLinePreview(props) : null;
  const line = neutral || supported || cached || sourceLine; if (!line) return null;
  check(line, ['noFill', 'solidFill', 'prstDash', 'round', 'miter', 'bevel', 'headEnd', 'tailEnd'].map(k => [A, k]));
  validateGroupFill(line);
  for (const a of line.attributes) if (!a.namespaceURI && !['w', 'cmpd', 'cap', 'algn'].includes(a.localName)) fail('unsupported outline attributes');
  const color = fill(line, readSchemeColor); if (!color) return null;
  const compound = line.hasAttribute('cmpd') ? line.getAttribute('cmpd') : 'sng';
  if (!COMPOUND_LINES.includes(compound)) fail('invalid compound outline');
  const width = number(line, 'w', 9525);
  if (width < 0) fail('negative outline width');
  if (compound !== 'sng' && width === 0) fail('zero-width compound outlines');
  const cap = line.hasAttribute('cap') ? line.getAttribute('cap') : 'flat';
  if (!['flat', 'rnd', 'sq'].includes(cap)) fail('invalid outline cap');
  if (line.hasAttribute('algn') && line.getAttribute('algn') !== 'ctr') fail('non-centered outlines');
  const dash = child(line, A, 'prstDash');
  if (dash) { check(dash, []); if (!Object.hasOwn(DRAWING_DASHES, dash.getAttribute('val')) || [...dash.attributes].some(a => !a.namespaceURI && a.localName !== 'val')) fail('invalid preset line dash'); }
  const ends = {};
  for (const name of ['headEnd', 'tailEnd']) {
    const end = child(line, A, name); if (!end) continue;
    check(end, []);
    for (const attr of end.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['type','w','len'].includes(attr.localName))) fail('unknown line-end attributes');
    if ([...end.childNodes].some(n => [3,4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('text in line-end properties');
    const type = end.hasAttribute('type') ? end.getAttribute('type') : 'none';
    if (!['none','oval','triangle','stealth','diamond','arrow'].includes(type)) fail('arrowheads');
    for (const attr of ['w','len']) if (end.hasAttribute(attr) && !['sm','med','lg'].includes(end.getAttribute(attr))) fail('invalid line-end size');
    if (type !== 'none') ends[name] = {type, width:end.getAttribute('w') || 'med', length:end.getAttribute('len') || 'med'};
  }
  const joins = children(line).filter(n => ['round','miter','bevel'].includes(n.localName));
  if (joins.length > 1) fail('conflicting outline joins');
  const join = joins[0]; if (join) check(join, []);
  const limit = join?.localName === 'miter' ? number(join, 'lim', 800000) / 100000 : undefined;
  if (limit !== undefined && limit <= 0) fail('invalid outline miter limit');
  // Explicit single-outline widths are clamped to .14pt, including zero.
  // Preserve the source declaration in its XML shell; this is display geometry.
  const displayWidth = compound === 'sng' ? Math.max(width, 1778) : width;
  return { color, width: displayWidth, ...ends, ...(displayWidth !== width ? { declaredWidth: width } : {}), ...(cached || supported ? { cachedSketch: true } : {}), ...(compound !== 'sng' ? { compound } : {}), ...(cap !== 'flat' ? { cap } : {}), ...(dash && dash.getAttribute('val') !== 'solid' ? { dash: dash.getAttribute('val') } : {}), ...(join && join.localName !== 'round' ? { join: join.localName, ...(limit !== undefined ? { miterLimit: limit } : {}) } : {}) };
}
export function readShapeGeometry(props, t, options = {}) {
  const preset = child(props, A, 'prstGeom'), custom = child(props, A, 'custGeom');
  if (!!preset === !!custom) fail('missing or conflicting geometry');
  if (preset) {
    check(preset, [[A, 'avLst']]);
    const kind = preset.getAttribute('prst');
    if (kind === 'star5') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj', 'hf', 'vf'].includes(n.getAttribute('name'))) fail('unsupported star adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown star adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      const w = t.width, h = t.height;
      let a, hf, vf;
      try {
        const resolve = geometryGuides(w, h, [{ name: 'adj', formula: 'val 19098' }, { name: 'hf', formula: 'val 105146' }, { name: 'vf', formula: 'val 110557' }, ...adjustments]);
        a = Math.max(0, Math.min(50000, resolve('adj'))); hf = resolve('hf'); vf = resolve('vf');
      } catch (error) { fail(error.message); }
      // ECMA-376 star5 uses scaled outer/inner radii, with its top point fixed
      // at y=0. The text box uses the inner 18-degree X and 54-degree Y guides.
      const rx = w * hf / 200000, ry = h * vf / 200000, cy = ry;
      const cos = degrees => Math.cos(degrees * Math.PI / 180), sin = degrees => Math.sin(degrees * Math.PI / 180);
      const dx1 = rx * cos(18), dx2 = rx * cos(306), y1 = cy - ry * sin(18), y2 = cy - ry * sin(306);
      const ix = rx * a / 50000, iy = ry * a / 50000;
      const sx1 = w/2 - ix*cos(342), sx2 = w/2 - ix*cos(54), sx3 = w/2 + ix*cos(54), sx4 = w/2 + ix*cos(342);
      const sy1 = cy - iy*sin(54), sy2 = cy - iy*sin(342), sy3 = cy + iy;
      return {
        paths: [{ width: w, height: h, points: [['M',w/2-dx1,y1],['L',sx2,sy1],['L',w/2,0],['L',sx3,sy1],['L',w/2+dx1,y1],['L',sx4,sy2],['L',w/2+dx2,y2],['L',w/2,sy3],['L',w/2-dx2,y2],['L',sx1,sy2],['Z']], fill: true, stroke: true }],
        textRect: { left:sx1/w, top:sy1/h, right:sx4/w, bottom:sy3/h },
      };
    }
    if (kind === 'round2SameRect') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj1', 'adj2'].includes(n.getAttribute('name'))) fail('unsupported paired-corner adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown paired-corner adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      const w = t.width, h = t.height;
      let top, bottom;
      try {
        const resolve = geometryGuides(w, h, [{ name: 'adj1', formula: 'val 16667' }, { name: 'adj2', formula: 'val 0' }, ...adjustments]);
        const radius = name => Math.min(w, h) * Math.max(0, Math.min(50000, resolve(name))) / 100000;
        top = radius('adj1'); bottom = radius('adj2');
      } catch (error) { fail(error.message); }
      // ECMA-376 round2SameRect has independent top and bottom corner pairs.
      // Its side text inset uses the larger radius; vertical insets use each
      // pair's own radius. Both adjustments are relative to the shorter side.
      const points = [['M', top, 0], ['L', w - top, 0]];
      const arc = (cx, cy, r, start) => {
        for (let i = 0; i < 2; i++) {
          const a = start + Math.PI * i / 4, b = a + Math.PI / 4, k = 4 / 3 * Math.tan((b - a) / 4);
          points.push(['C', cx + r * (Math.cos(a) - k * Math.sin(a)), cy + r * (Math.sin(a) + k * Math.cos(a)), cx + r * (Math.cos(b) + k * Math.sin(b)), cy + r * (Math.sin(b) - k * Math.cos(b)), cx + r * Math.cos(b), cy + r * Math.sin(b)]);
        }
      };
      arc(w - top, top, top, -Math.PI / 2); points.push(['L', w, h - bottom]);
      arc(w - bottom, h - bottom, bottom, 0); points.push(['L', bottom, h]);
      arc(bottom, h - bottom, bottom, Math.PI / 2); points.push(['L', 0, top]);
      arc(top, top, top, Math.PI); points.push(['Z']);
      const inset = Math.max(top, bottom) * .29289;
      return { paths: [{ width: w, height: h, points, fill: true, stroke: true }], textRect: { left: inset / w, top: top * .29289 / h, right: 1 - inset / w, bottom: 1 - bottom * .29289 / h } };
    }
    if (kind === 'donut') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || n.getAttribute('name') !== 'adj') fail('unsupported donut adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown donut adjustment attributes');
        return { name: 'adj', formula: n.getAttribute('fmla') };
      });
      const w = t.width, h = t.height;
      let thickness;
      if (!(w > 0 && h > 0)) fail('invalid donut dimensions');
      try {
        const resolve = geometryGuides(w, h, [{ name: 'adj', formula: 'val 25000' }, ...adjustments]);
        thickness = Math.min(w, h) * Math.max(0, Math.min(50000, resolve('adj'))) / 100000;
      } catch (error) { fail(error.message); }
      const points = [];
      // Opposite winding leaves a transparent hole with the existing nonzero
      // fill rule. Two cubic segments per quadrant also cover degenerate radii.
      for (const [rx, ry, direction] of [[w / 2, h / 2, 1], [w / 2 - thickness, h / 2 - thickness, -1]]) {
        points.push(['M', w / 2 - rx, h / 2]);
        for (let i = 0; i < 8; i++) {
          const a = Math.PI + direction * i * Math.PI / 4, b = a + direction * Math.PI / 4;
          const k = 4 / 3 * Math.tan((b - a) / 4);
          points.push(['C', w / 2 + rx * (Math.cos(a) - k * Math.sin(a)), h / 2 + ry * (Math.sin(a) + k * Math.cos(a)), w / 2 + rx * (Math.cos(b) + k * Math.sin(b)), h / 2 + ry * (Math.sin(b) - k * Math.cos(b)), w / 2 + rx * Math.cos(b), h / 2 + ry * Math.sin(b)]);
        }
        points.push(['Z']);
      }
      const inset = (1 - Math.SQRT1_2) / 2;
      return { paths: [{ width: w, height: h, points, fill: true, stroke: true }], textRect: { left: inset, top: inset, right: 1 - inset, bottom: 1 - inset } };
    }
    if (['octagon', 'plaque', 'roundRect'].includes(kind)) {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || n.getAttribute('name') !== 'adj') fail('unsupported corner preset adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown corner preset adjustment attributes');
        return { name: 'adj', formula: n.getAttribute('fmla') };
      });
      let radius;
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj', formula: `val ${kind === 'octagon' ? 29289 : 16667}` }, ...adjustments]);
        radius = Math.min(t.width, t.height) * Math.max(0, Math.min(50000, resolve('adj'))) / 100000;
      } catch (error) { fail(error.message); }
      const w = t.width, h = t.height, r = radius;
      // ECMA-376 preset definitions use the shorter side for corner depth.
      // Their text insets differ for straight, concave and convex corners.
      const inset = r * (kind === 'octagon' ? .5 : kind === 'plaque' ? .70711 : .29289);
      const points = [['M', 0, r]];
      if (kind === 'octagon') points.push(['L', r, 0], ['L', w-r, 0], ['L', w, r], ['L', w, h-r], ['L', w-r, h], ['L', r, h], ['L', 0, h-r]);
      else {
        // Two cubic segments per quarter circle keep the radial error below
        // 0.000005 of the radius and reuse the existing path/outline pipeline.
        const arc = (cx, cy, start, sweep) => {
          for (let i = 0; i < 2; i++) {
            const a = start + sweep * i / 2, b = a + sweep / 2, k = 4 / 3 * Math.tan((b-a) / 4);
            points.push(['C', cx+r*(Math.cos(a)-k*Math.sin(a)), cy+r*(Math.sin(a)+k*Math.cos(a)), cx+r*(Math.cos(b)+k*Math.sin(b)), cy+r*(Math.sin(b)-k*Math.cos(b)), cx+r*Math.cos(b), cy+r*Math.sin(b)]);
          }
        };
        const convex = kind === 'roundRect', c = convex ? r : 0, start = convex ? Math.PI : Math.PI/2, sweep = (convex ? 1 : -1)*Math.PI/2;
        arc(c, c, start, sweep); points.push(['L', w-r, 0]);
        arc(w-c, c, start+Math.PI/2, sweep); points.push(['L', w, h-r]);
        arc(w-c, h-c, start+Math.PI, sweep); points.push(['L', r, h]);
        arc(c, h-c, start+3*Math.PI/2, sweep);
      }
      points.push(['Z']);
      return { paths: [{ width: w, height: h, points, fill: true, stroke: true }], textRect: { left: inset/w, top: inset/h, right: 1-inset/w, bottom: 1-inset/h } };
    }
    if (kind === 'hexagon') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj', 'vf'].includes(n.getAttribute('name'))) fail('unsupported hexagon adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown hexagon adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      let depth, halfHeight, inset;
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj', formula: 'val 25000' }, { name: 'vf', formula: 'val 115470' }, ...adjustments]);
        const shorter = Math.min(t.width, t.height), max = 50000 * t.width / shorter;
        const adjustment = Math.max(0, Math.min(max, resolve('adj'))), fraction = adjustment / max;
        depth = shorter * adjustment / 100000;
        halfHeight = t.height / 2 * resolve('vf') / 100000 * Math.sin(Math.PI / 3);
        // ECMA-376 hexagon's q1..q8 guides give this piecewise text inset.
        inset = (fraction > .5 ? 1 + 6 * fraction : 2 + 4 * fraction) / 24;
      } catch (error) { fail(error.message); }
      const middle = t.height / 2, right = t.width - depth;
      return {
        paths: [{ width: t.width, height: t.height, points: [
          ['M', 0, middle], ['L', depth, middle - halfHeight], ['L', right, middle - halfHeight],
          ['L', t.width, middle], ['L', right, middle + halfHeight], ['L', depth, middle + halfHeight], ['Z'],
        ], fill: true, stroke: true }],
        textRect: { left: inset, top: inset, right: 1 - inset, bottom: 1 - inset },
      };
    }
    if (kind === 'downArrow') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj1', 'adj2'].includes(n.getAttribute('name'))) fail('unsupported down-arrow adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown down-arrow adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      let shaft, head;
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj1', formula: 'val 50000' }, { name: 'adj2', formula: 'val 50000' }, ...adjustments]);
        shaft = Math.max(0, Math.min(100000, resolve('adj1'))) / 100000;
        head = Math.max(0, Math.min(t.height, Math.min(t.width, t.height) * resolve('adj2') / 100000));
      } catch (error) { fail(error.message); }
      // ECMA-376 downArrow: shaft width is relative to w; head depth is
      // relative to the shorter side, capped at h. The text box extends into
      // the head only as far as the shaft's vertical sides remain inside it.
      const left = t.width * (1 - shaft) / 2, right = t.width - left, shoulder = t.height - head;
      return {
        paths: [{ width: t.width, height: t.height, points: [['M', 0, shoulder], ['L', left, shoulder], ['L', left, 0], ['L', right, 0], ['L', right, shoulder], ['L', t.width, shoulder], ['L', t.width / 2, t.height], ['Z']], fill: true, stroke: true }],
        textRect: { left: left / t.width, top: 0, right: right / t.width, bottom: (shoulder + head * (1 - shaft)) / t.height },
      };
    }
    if (kind === 'triangle' || kind === 'rtTriangle') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (kind !== 'triangle' || n.namespaceURI !== A || n.localName !== 'gd' || n.getAttribute('name') !== 'adj') fail('unsupported triangle adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown triangle adjustment attributes');
        return { name: 'adj', formula: n.getAttribute('fmla') };
      });
      let apex = 0;
      if (kind === 'triangle') {
        try {
          const resolve = geometryGuides(t.width, t.height, [{ name: 'adj', formula: 'val 50000' }, ...adjustments]);
          apex = Math.max(0, Math.min(100000, resolve('adj'))) / 100000;
        } catch (error) { fail(error.message); }
      }
      // ECMA-376 preset definitions: the text rectangle is inside the lower
      // portion of each triangle, not the full rectangular shape bounds.
      return {
        paths: [{ width: t.width, height: t.height, points: [['M', 0, t.height], ['L', apex * t.width, 0], ['L', t.width, t.height], ['Z']], fill: true, stroke: true }],
        textRect: kind === 'triangle'
          ? { left: apex / 2, top: .5, right: apex / 2 + .5, bottom: 1 }
          : { left: 1 / 12, top: 7 / 12, right: 7 / 12, bottom: 11 / 12 },
      };
    }
    if (kind === 'homePlate' || kind === 'chevron') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || n.getAttribute('name') !== 'adj') fail('unsupported arrow preset adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown arrow preset adjustment attributes');
        return { name: 'adj', formula: n.getAttribute('fmla') };
      });
      let depth;
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj', formula: 'val 50000' }, ...adjustments]);
        depth = Math.max(0, Math.min(t.width, Math.min(t.width, t.height) * resolve('adj') / 100000));
      } catch (error) { fail(error.message); }
      const shoulder = t.width - depth;
      // ECMA-376 preset definitions measure the head/notch from the shorter
      // side. Chevron switches to full-width text bounds when its two sloped
      // regions meet; homePlate extends its text bounds halfway into the tip.
      return {
        paths: [{ width: t.width, height: t.height, points: [
          ['M', 0, 0], ['L', shoulder, 0], ['L', t.width, t.height / 2],
          ['L', shoulder, t.height], ['L', 0, t.height],
          ...(kind === 'chevron' ? [['L', depth, t.height / 2]] : []), ['Z'],
        ], fill: true, stroke: true }],
        textRect: kind === 'homePlate'
          ? { left: 0, top: 0, right: (shoulder + t.width) / (2 * t.width), bottom: 1 }
          : { left: shoulder > depth ? depth / t.width : 0, top: 0, right: shoulder > depth ? shoulder / t.width : 1, bottom: 1 },
      };
    }
    if (kind === 'frame') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || n.getAttribute('name') !== 'adj1') fail('unsupported frame adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown frame adjustment attributes');
        return { name: 'adj1', formula: n.getAttribute('fmla') };
      });
      let inset;
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj1', formula: 'val 12500' }, ...adjustments]);
        inset = Math.min(t.width, t.height) * Math.max(0, Math.min(50000, resolve('adj1'))) / 100000;
      } catch (error) { fail(error.message); }
      const right = t.width - inset, bottom = t.height - inset;
      // ECMA-376's frame preset uses oppositely wound contours in one path;
      // the opening is transparent, and its edges also bound the text area.
      return {
        paths: [{ width: t.width, height: t.height, points: [
          ['M', 0, 0], ['L', t.width, 0], ['L', t.width, t.height], ['L', 0, t.height], ['Z'],
          ['M', inset, inset], ['L', inset, bottom], ['L', right, bottom], ['L', right, inset], ['Z'],
        ], fill: true, stroke: true }],
        textRect: { left: inset / t.width, top: inset / t.height, right: right / t.width, bottom: bottom / t.height },
      };
    }
    if (kind === 'halfFrame') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj1', 'adj2'].includes(n.getAttribute('name'))) fail('unsupported half-frame adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown half-frame adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      const w = t.width, h = t.height, short = Math.min(w, h);
      if (!(w > 0 && h > 0)) fail('invalid half-frame dimensions');
      let x, y;
      try {
        const resolve = geometryGuides(w, h, [{ name: 'adj1', formula: 'val 33333' }, { name: 'adj2', formula: 'val 33333' }, ...adjustments]);
        x = Math.max(0, Math.min(w, short * resolve('adj2') / 100000));
        // The vertical arm limits the horizontal arm: their inner corner
        // cannot cross the diagonal joining the frame's two outer tips.
        y = Math.max(0, Math.min(h * (1 - x / w), short * resolve('adj1') / 100000));
      } catch (error) { fail(error.message); }
      return {
        paths: [{ width: w, height: h, points: [
          ['M', 0, 0], ['L', w, 0], ['L', w - y * w / h, y],
          ['L', x, y], ['L', x, h - x * h / w], ['L', 0, h], ['Z'],
        ], fill: true, stroke: true }],
        textRect: { left: 0, top: 0, right: 1, bottom: 1 },
      };
    }
    if (kind === 'ribbon2') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !['adj1', 'adj2'].includes(n.getAttribute('name'))) fail('unsupported ribbon adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown ribbon adjustment attributes');
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      try {
        const resolve = geometryGuides(t.width, t.height, [{ name: 'adj1', formula: 'val 16667' }, { name: 'adj2', formula: 'val 50000' }, ...adjustments]);
        return ribbonGeometry(t.width, t.height, resolve('adj1'), resolve('adj2'));
      } catch (error) { fail(error.message); }
    }
    if (kind === 'cloud' || kind === 'cloudCallout') {
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (kind === 'cloud' || n.namespaceURI !== A || n.localName !== 'gd' || !['adj1','adj2'].includes(n.getAttribute('name'))) fail('unsupported cloud adjustment');
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name','fmla'].includes(attr.localName))) fail('unknown cloud adjustment attributes');
        return {name:n.getAttribute('name'),formula:n.getAttribute('fmla')};
      });
      try {
        const resolve = geometryGuides(t.width,t.height,[{name:'adj1',formula:'val -20833'},{name:'adj2',formula:'val 62500'},...adjustments]);
        return cloudGeometry(t.width,t.height,kind === 'cloudCallout',resolve('adj1'),resolve('adj2'));
      } catch (error) { fail(error.message); }
    }
    if (Object.hasOwn(PRESET_GEOMETRIES, kind)) {
      const definition = PRESET_GEOMETRIES[kind], names = Object.keys(definition.defaults);
      const adjustments = children(child(preset, A, 'avLst')).map(n => {
        if (n.namespaceURI !== A || n.localName !== 'gd' || !names.includes(n.getAttribute('name'))) fail(`unsupported ${kind} adjustment`);
        check(n, []);
        for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail(`unknown ${kind} adjustment attributes`);
        return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
      });
      let geometry;
      try {
        const resolve = geometryGuides(t.width, t.height, [...names.map(name => ({ name, formula: `val ${definition.defaults[name]}` })), ...adjustments]);
        geometry = definition.build(t.width, t.height, resolve);
      } catch (error) { fail(error.message); }
      const [left, top, right, bottom] = geometry.text;
      // Multi-path presets carry per-path fill/stroke flags, fill modes and optional fixed grids.
      const paths = geometry.paths ? geometry.paths.map(p => ({ width: p.width ?? t.width, height: p.height ?? t.height, points: p.points, fill: p.fill !== false, stroke: p.stroke !== false, ...(p.fillMode ? { fillMode: p.fillMode } : {}) }))
        : [{ width: t.width, height: t.height, points: geometry.points, fill: true, stroke: true }];
      return { paths,
        textRect: { left: t.width ? left / t.width : 0, top: t.height ? top / t.height : 0, right: t.width ? right / t.width : 1, bottom: t.height ? bottom / t.height : 1 } };
    }
    if (children(child(preset, A, 'avLst')).length || !['rect', 'ellipse', 'line', 'straightConnector1', 'flowChartOffpageConnector'].includes(kind)) fail('unsupported preset geometry');
    if (kind === 'flowChartOffpageConnector') return {
      // ECMA-376's fixed ten-unit grid places the shoulders at 4/5 height.
      // Text uses only the rectangular body above the downward point.
      paths: [{ width: 10, height: 10, points: [['M', 0, 0], ['L', 10, 0], ['L', 10, 8], ['L', 5, 10], ['L', 0, 8], ['Z']], fill: true, stroke: true }],
      textRect: { left: 0, top: 0, right: 1, bottom: .8 },
    };
    // Both line and straightConnector1 run from top-left to bottom-right
    // in the ECMA-376 preset definitions. A unit path grid
    // also represents horizontal/vertical lines without dividing by zero.
    if (kind === 'line' || kind === 'straightConnector1') return { paths: [{ width: 1, height: 1, points: [['M', 0, 0], ['L', 1, 1]], fill: false, stroke: true, physicalStroke: true }] };
    return { paths: [{ width: t.width, height: t.height, points: kind === 'ellipse' ? [['E'], ['Z']] : [['M', 0, 0], ['L', t.width, 0], ['L', t.width, t.height], ['L', 0, t.height], ['Z']], fill: true, stroke: true }] };
  }
  check(custom, ['avLst', 'gdLst', 'ahLst', 'cxnLst', 'rect', 'pathLst'].map(k => [A, k]));
  const guideList = name => children(child(custom, A, name)).map(n => {
    if (n.namespaceURI !== A || n.localName !== 'gd') fail('unknown geometry guide');
    check(n, []);
    for (const attr of n.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !['name', 'fmla'].includes(attr.localName))) fail('unknown geometry guide attributes');
    return { name: n.getAttribute('name'), formula: n.getAttribute('fmla') };
  });
  let resolve;
  try { resolve = geometryGuides(t.width, t.height, guideList('avLst'), guideList('gdLst')); }
  catch (error) { fail(error.message); }
  const coordinate = (node, name) => {
    try { return resolve(node?.getAttribute(name)); } catch (error) { fail(error.message); }
  };
  if (children(child(custom, A, 'ahLst')).length) fail('geometry adjustment handles');
  // Connection sites affect editing/routing, not a retained shape's ink. Validate
  // their guide references in shape coordinates and preserve the original XML.
  const sites = children(child(custom, A, 'cxnLst'));
  // CT_ConnectionSiteList permits unbounded sites; package limits still apply.
  for (const site of sites) {
    if (site.namespaceURI !== A || site.localName !== 'cxn') fail('unknown connection site');
    check(site, [[A, 'pos']]); coordinate(site, 'ang');
    const pos = child(site, A, 'pos'); check(pos, []);
    coordinate(pos, 'x'); coordinate(pos, 'y');
  }
  const rect = child(custom, A, 'rect');
  let textRect;
  if (rect) {
    check(rect, []);
    const l = coordinate(rect, 'l'), top = coordinate(rect, 't'), r = coordinate(rect, 'r'), b = coordinate(rect, 'b');
    if (t.width && t.height) textRect = { left: l / t.width, top: top / t.height, right: r / t.width, bottom: b / t.height };
  }
  const list = child(custom, A, 'pathLst'); check(list, [[A, 'path']]);
  if (!children(list).length || children(list).length > 100) fail('missing or excessive paths');
  const paths = children(list).map(path => {
    check(path, ['moveTo', 'lnTo', 'quadBezTo', 'cubicBezTo', 'close'].map(k => [A, k]));
    const width = number(path, 'w', t.width), height = number(path, 'h', t.height);
    if (width < 0 || height < 0 || path.hasAttribute('w') && !width || path.hasAttribute('h') && !height || path.hasAttribute('fill') && !['none', 'norm'].includes(path.getAttribute('fill'))) fail('unsupported path fill or dimensions');
    // CT_Path2D permits an unbounded command sequence. Package byte limits
    // and drawing/bitmap bounds apply independently of how paths are split.
    const points = children(path).map(op => {
      if (op.localName === 'close') { check(op, []); return ['Z']; }
      const vertices = children(op), count = op.localName === 'cubicBezTo' ? 3 : op.localName === 'quadBezTo' ? 2 : 1;
      if (vertices.length !== count || vertices.some(pt => pt.namespaceURI !== A || pt.localName !== 'pt')) fail('invalid path point count');
      // Resolved guide coordinates are rounded to the path's integer grid,
      // after guide evaluation and before scaling to the physical shape.
      const rounded = value => Math.sign(value) * Math.round(Math.abs(value));
      const command = { moveTo: 'M', lnTo: 'L', quadBezTo: 'Q', cubicBezTo: 'C' }[op.localName];
      return [command, ...vertices.flatMap(pt => { check(pt, []); return [rounded(coordinate(pt, 'x')), rounded(coordinate(pt, 'y'))]; })];
    });
    // CT_Path2D permits zero commands. An empty path contributes no ink, but
    // must not discard its shape's other paths or siblings in a drawing group.
    if (points.length && points[0][0] !== 'M') fail('paths without an initial move');
    // The whole path is suppressed when a close is followed by anything
    // except a fresh moveTo. This differs from Part 1 section 20.1.9.6 (ignore
    // subsequent lines/curves); the original XML remains untouched on export.
    const invalidContinuation = points.some((op, i) => op[0] === 'Z' && i + 1 < points.length && points[i + 1][0] !== 'M');
    // Both-zero custom frames are suppressed. A single zero dimension still
    // permits absolute path coordinates when its optional viewport is absent.
    return { width, height, points: invalidContinuation || !t.width && !t.height ? [] : points, fill: path.getAttribute('fill') !== 'none', stroke: !['0', 'false'].includes(path.getAttribute('stroke')) };
  });
  return readSketchGeometry(props, t, options) || { paths, ...(textRect ? { textRect } : {}) };
}
export function textBox(shape, readParagraph, defaults, readTextBlocks) {
  const tx = child(shape, WPS, 'txbx'), body = child(shape, WPS, 'bodyPr');
  if (!body) fail('missing text body properties');
  check(body, [[A, 'noAutofit'], [A, 'spAutoFit'], [A, 'normAutofit'], [A, 'prstTxWarp']]);
  const autoFit = child(body, A, 'spAutoFit'), noAutofit = child(body, A, 'noAutofit'), normalFit = child(body, A, 'normAutofit');
  if ([autoFit, noAutofit, normalFit].filter(Boolean).length > 1) fail('conflicting text autofit modes');
  if (normalFit) {
    if (children(normalFit).length || /\S/.test(normalFit.textContent)) fail('malformed normal text autofit');
    for (const attr of normalFit.attributes) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (attr.namespaceURI || !['fontScale','lnSpcReduction'].includes(attr.localName)) fail('unknown normal text autofit attribute');
      const raw = attr.value.trim(), value = Number(raw);
      const percent = /^-?\d+(\.\d+)?%$/.test(raw);
      const minimum = attr.localName === 'fontScale' ? 1000 : 0, maximum = attr.localName === 'fontScale' ? 100000 : 13200000;
      if (!percent && (!/^[+-]?\d+$/.test(raw) || value < minimum || value > maximum)) fail('invalid normal text autofit percentage');
    }
    // Without a text box there are no glyphs or line spacings to scale. Keep
    // these dormant settings in the original XML; active fitting stays guarded.
    if (tx) fail('normal autofit in text-bearing shapes');
  }
  for (const fit of [autoFit, noAutofit].filter(Boolean)) {
    if (children(fit).length || [...fit.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') || /\S/.test(fit.textContent)) fail('malformed text autofit');
  }
  const warp = child(body, A, 'prstTxWarp');
  if (warp) {
    check(warp, [[A, 'avLst']]);
    if (warp.getAttribute('prst') !== 'textNoShape' || children(child(warp, A, 'avLst')).length) fail('warped text bodies');
  }
  // Wordprocessing-shape text retains WordprocessingML paragraph spacing for both values;
  // unlike DrawingML a:p text it is laid out as WordprocessingML paragraphs.
  // With one column there is no inter-column gap to lay out.
  if (body.hasAttribute('spcCol')) {
    const gap = body.getAttribute('spcCol').trim();
    if (!/^[+]?\d+$/.test(gap) || Number(gap) > 2147483647) fail('invalid text column spacing');
  }
  // Validate the boolean here; support depends on whether the parsed text box
  // has anything to orient (checked below).
  const identity = { upright: ['0', '1', 'false', 'true'], rot: ['0'], numCol: ['1'], spcCol: [body.getAttribute('spcCol')], rtlCol: ['0', 'false'], fromWordArt: ['0', 'false'], forceAA: ['0', 'false'], compatLnSpc: ['0', '1', 'false', 'true'] };
  for (const a of body.attributes) if (!a.namespaceURI && !['lIns', 'rIns', 'tIns', 'bIns', 'anchor', 'anchorCtr', 'wrap', 'spcFirstLastPara', 'horzOverflow', 'vertOverflow', 'vert'].includes(a.localName) && !identity[a.localName]?.includes(a.value)) fail(`unsupported text body ${a.localName}`);
  if (body.hasAttribute('wrap') && body.getAttribute('wrap') !== 'square' || body.hasAttribute('anchor') && !['t', 'ctr', 'b'].includes(body.getAttribute('anchor')) || body.hasAttribute('anchorCtr') && !['0', 'false'].includes(body.getAttribute('anchorCtr'))) fail('unsupported text body alignment');
  for (const name of ['horzOverflow', 'vertOverflow']) if (body.hasAttribute(name) && body.getAttribute(name) !== 'overflow') fail('clipped text bodies');
  if (body.hasAttribute('vert') && !['horz', 'vert', 'vert270', 'wordArtVert', 'eaVert', 'mongolianVert', 'wordArtVertRtl'].includes(body.getAttribute('vert'))) fail('invalid vertical text mode');
  if (tx && body.hasAttribute('vert') && body.getAttribute('vert') !== 'horz') fail('vertical text bodies');
  if (body.hasAttribute('spcFirstLastPara') && !['0', '1', 'false', 'true'].includes(body.getAttribute('spcFirstLastPara'))) fail('invalid text body paragraph spacing');
  if (!tx) return null;
  check(tx, [[W, 'txbxContent']]); if ([...tx.attributes].some(a => !a.namespaceURI && !(a.localName === 'id' && a.value === '0'))) fail('linked text boxes');
  const sourceContent = child(tx, W, 'txbxContent');
  const content = sourceContent?.getElementsByTagNameNS(W, 'sdt').length ? sourceContent.cloneNode(true) : sourceContent;
  if (content !== sourceContent) projectRetainedTextBoxControls(content);
  check(content, [[W, 'p'], ...(readTextBlocks ? [[W, 'tbl']] : [])]);
  if ([...content.getElementsByTagNameNS(W, 'pPr')].some(p => child(p, W, 'framePr'))) fail('text frames inside shapes');
  // Keep the table model local to the retained drawing. Cell paragraphs use
  // the same style resolver and table reader as body text, but never become
  // editable main-story positions or participate in body table serialization.
  const blocks = children(content).some(p => p.localName === 'tbl') ? readTextBlocks(children(content), defaults) : null;
  const paragraphs = blocks?.paragraphs || children(content).map(p => readParagraph(p, defaults));
  if (blocks?.tables.some(t => t.floating)) fail('floating tables inside shapes');
  const upright = ['1', 'true'].includes(body.getAttribute('upright')) && paragraphs.some(p => p.runs.some(r => r.text || r.field));
  if (!paragraphs.length || paragraphs.some(p => p.list || p.runs.some(r => r.image?.anchor || r.link) || p.bookmarks || p.sectionEnd || p.runs.some(r => /[\f\u000e]/.test(r.text)))) fail('complex text box contents');
  for (const p of paragraphs) {
    // Positional tab stops have no effect until a tab character uses them.
    // The paragraph reader still validates their types and values; preserve
    // dormant declarations in the source XML.
    // Bar tabs draw a rule without any tab character; the shape painter does not draw them.
    const activeTabs = p.format.tabs.some(t => t.alignment === 'bar') || p.format.tabs.length && p.runs.some(r => r.text.includes('\t'));
    if (p.format.paragraphShading !== 'auto' || Object.values(p.format.paragraphBorders).some(b => !['nil', 'none'].includes(b.style)) || activeTabs) fail('decorated text box paragraphs');
    // Script, position and width transforms share body text's measurement and
    // glyph painter. Decorations still need their own retained-shape painter.
    for (const r of p.runs) if (r.underline || r.strikethrough !== 'none' || r.highlight !== 'none' || r.shading !== 'auto') fail('decorated text box runs');
  }
  return { paragraphs, ...(upright ? { upright: true } : {}), ...(blocks ? { tables: blocks.tables, compatibilityMode: blocks.compatibilityMode } : {}), ...(autoFit ? { autoFit: true } : {}), edgeSpacing: ['1', 'true'].includes(body.getAttribute('spcFirstLastPara')), left: number(body, 'lIns', 91440), right: number(body, 'rIns', 91440), top: number(body, 'tIns', 45720), bottom: number(body, 'bIns', 45720), anchor: body.getAttribute('anchor') || 't' };
}

// Materialize appearance only in the scene reader. Retained source references
// and direct-property overrides remain unchanged in the DOCX package.
function styledProperties(shape, props, readDrawingStyle, readSchemeColor) {
  const style = child(shape, WPS, 'style'); if (!style) return props;
  check(style, ['lnRef', 'fillRef', 'effectRef', 'fontRef'].map(k => [A, k]));
  for (const name of ['lnRef', 'fillRef', 'effectRef', 'fontRef']) {
    const ref = child(style, A, name), index = ref?.getAttribute('idx');
    if (name === 'fontRef' ? !['major', 'minor', 'none'].includes(index) : !/^\d+$/.test(index || '') || Number(index) > 4294967295) fail('invalid shape style references');
    check(ref, [[A, 'srgbClr'], [A, 'schemeClr'], [A, 'scrgbClr'], [A, 'sysClr']]);
    if (name === 'fontRef' && !children(ref).length) continue;
    if (children(ref).length !== 1) fail('invalid shape style colors');
    // Validate even unused references; phClr is resolved by the theme consumer.
    drawingPaintColor(children(ref)[0], readSchemeColor, '000000');
  }
  const result = props.cloneNode(true);
  const resolve = kind => {
    if (!readDrawingStyle) fail('unresolved theme shape styles');
    return readDrawingStyle(kind, child(style, A, kind === 'effect' ? 'effectRef' : kind === 'line' ? 'lnRef' : 'fillRef'));
  };
  if (!['noFill','solidFill','gradFill','pattFill','blipFill','grpFill'].some(name => child(result, A, name))) {
    const inherited = resolve('fill');
    if (inherited && !['solidFill','noFill','gradFill','pattFill'].includes(inherited.localName)) fail('unsupported theme fills');
    if (inherited) result.append(inherited);
  }
  const direct = child(result, A, 'ln');
  // An invisible line still contributes its inherited width to a WPS text
  // frame. Keep the noFill paint override while merging those dimensions.
  if (!child(direct, A, 'noFill') || child(shape, WPS, 'txbx')) {
    const inherited = resolve('line');
    if (inherited && inherited.localName !== 'ln') fail('invalid theme line styles');
    const merged = mergeDrawingLine(inherited, direct);
    if (merged && merged !== direct) { direct?.remove(); result.append(merged); }
  }
  if (!child(result, A, 'effectLst') && Number(child(style, A, 'effectRef').getAttribute('idx'))) {
    const inherited = resolve('effect');
    if (!inherited || inherited.localName !== 'effectStyle') fail('invalid theme effect styles');
    check(inherited, [[A, 'effectLst']]);
    const effects = child(inherited, A, 'effectLst');
    if (effects) result.append(effects.cloneNode(true));
  }
  return result;
}
export function readShapeScene(root, readPicture, readParagraph, readPictureFill, readSchemeColor, readShapeFont, readDrawingStyle, options = {}) {
  // CT_WordprocessingGroup permits unbounded children. Package byte limits
  // bound input size; sibling count must not discard otherwise supported ink.
  const read = (node, depth = 0, groupFill = null) => {
    if (depth > 12) fail('excessive drawing complexity');
    const group = node.namespaceURI === WPG && ['wgp', 'grpSp'].includes(node.localName);
    if (group) {
      check(node, [[WPG, 'cNvPr'], [WPG, 'cNvGrpSpPr'], [WPG, 'grpSpPr'], [WPG, 'grpSp'], [WPS, 'wsp'], [PIC, 'pic']]);
      groupLocks(child(node, WPG, 'cNvGrpSpPr'));
      const nonvisual = child(node, WPG, 'cNvPr');
      if (nonvisual) readDrawingMetadata(nonvisual);
      const visibility = nonvisual?.getAttribute('hidden')?.trim();
      if (visibility != null && !['0', '1', 'false', 'true'].includes(visibility)) fail('invalid group hidden flag');
      const hidden = visibility === '1' || visibility === 'true';
      const props = child(node, WPG, 'grpSpPr'); check(props, ['xfrm', 'solidFill', 'pattFill', 'noFill', 'grpFill'].map(k => [A, k]));
      validateGroupFill(props);
      // grpFill resolves through groups with absent/noFill/group fills.
      // Only a concrete group paint overrides the enclosing group's paint.
      const inheritedFill = child(props, A, 'solidFill') || child(props, A, 'pattFill') ? fill(props, readSchemeColor) : groupFill;
      // Hidden groups suppress their entire subtree. Keep the frame, but do not
      // load or paint descendants. The untouched drawing XML retains all of them.
      const scene = { type: 'group', ...transform(props, true), children: hidden ? [] : children(node).filter(n => [WPS, PIC].includes(n.namespaceURI) || n.namespaceURI === WPG && n.localName === 'grpSp').map(n => read(n, depth + 1, inheritedFill)) };
      const hasText = n => !!n.text || n.children?.some(hasText);
      if ((!scene.width || !scene.height) && hasText(scene)) fail('text in collapsed groups');
      return scene;
    }
    if (node.namespaceURI === PIC && node.localName === 'pic') {
      const props = child(node, PIC, 'spPr'), t = transform(props, false, true);
      const preset = child(props, A, 'prstGeom')?.getAttribute('prst');
      const clipped = child(props, A, 'custGeom') || preset && preset !== 'rect';
      const clipPaths = clipped ? readShapeGeometry(props, t, options).paths : null;
      const pen = readDrawingOutline(props, readSchemeColor, options);
      const backingFill = readPictureBackingFill(props, readSchemeColor);
      const shadow = readPictureShadow(props, readSchemeColor);
      if (shadow) {
        if (shadow.scaleX !== undefined || shadow.obscured) fail('scaled or obscured grouped picture shadows');
        shadow.rotateWithShape = !['0', 'false'].includes(child(child(props, A, 'effectLst'), A, 'outerShdw').getAttribute('rotWithShape')?.trim());
      }
      const picture = { type: 'picture', ...t, ...(clipPaths ? { clipPaths } : {}), image: readPicture(node, t) };
      const paths = pen || backingFill || shadow ? readShapeGeometry(props, t, options).paths : [];
      const scene = pictureOutlineScene(picture, paths, pen, backingFill);
      return shadow ? { ...scene, shadow, shadowGeometry: { width: t.width, height: t.height, paths,
        outline: pen, pictureOutline: !!pen, flipH: picture.image.flipH, flipV: picture.image.flipV,
        ...(t.pictureRotation ? { shapeRotation: t.pictureRotation } : {}) } } : scene;
    }
    if (node.namespaceURI !== WPS || node.localName !== 'wsp') fail(`unknown ${node.localName}`);
    check(node, ['cNvPr', 'cNvSpPr', 'cNvCnPr', 'spPr', 'style', 'txbx', 'bodyPr'].map(k => [WPS, k]));
    if (node.hasAttribute('normalEastAsianFlow') && !['0', 'false'].includes(node.getAttribute('normalEastAsianFlow'))) fail('East Asian text flow');
    const shapeProperties = child(node, WPS, 'cNvSpPr'), connectorProperties = child(node, WPS, 'cNvCnPr');
    if (!!shapeProperties === !!connectorProperties) fail('missing or conflicting nonvisual shape properties');
    shapeLocks(shapeProperties || connectorProperties, !!connectorProperties);
    const nonvisual = child(node, WPS, 'cNvPr');
    if (nonvisual) { readDrawingMetadata(nonvisual); if (nonvisual.hasAttribute('hidden') && !['0', 'false'].includes(nonvisual.getAttribute('hidden'))) fail('hidden shapes'); }
    let props = child(node, WPS, 'spPr'); check(props, ['xfrm', 'prstGeom', 'custGeom', 'noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill', 'ln', 'effectLst', 'sp3d', 'extLst'].map(k => [A, k]));
    // Empty solid declarations add no 3D geometry. Effects are parsed after
    // resolving their theme reference and direct-property precedence.
    for (const name of ['sp3d']) {
      const empty = child(props, A, name);
      if (empty && (children(empty).length || [...empty.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') || /\S/.test(empty.textContent))) fail(`nonempty ${name}`);
    }
    readShapeExtensions(props);
    validateGroupFill(props);
    props = styledProperties(node, props, readDrawingStyle, readSchemeColor);
    // A standalone shape may also glow, soften its edges or show a reflection; grouped shapes may not yet.
    const shadow = readPictureShadow(props, readSchemeColor, depth === 0);
    const effects = depth === 0 ? readDrawingEffects(props, readSchemeColor) : null;
    if (shadow) {
      if (shadow.scaleX !== undefined || shadow.obscured) fail('scaled or obscured shape shadows');
      const effect = child(child(props, A, 'effectLst'), A, 'outerShdw');
      shadow.rotateWithShape = !['0', 'false'].includes(effect.getAttribute('rotWithShape')?.trim());
    }
    let textDefaults;
    const fontRef = child(child(node, WPS, 'style'), A, 'fontRef');
    if (fontRef && child(node, WPS, 'txbx')) {
      if (!readShapeFont) fail('unresolved shape fonts');
      const color = children(fontRef)[0];
      textDefaults = { ...readShapeFont(fontRef.getAttribute('idx')), ...(color ? { color: drawingColor(color, readSchemeColor) } : {}) };
    }
    const t = transform(props, false, false, true);
    // A standalone preset is evaluated in its WordprocessingML frame, not
    // in a conflicting inner transform followed by an anisotropic stretch.
    // Group children retain their own coordinate systems; flat lines retain
    // the dedicated zero-extent handling below.
    if (depth === 0 && child(props, A, 'prstGeom') && t.width && t.height && options.frame?.width && options.frame?.height) {
      t.width = options.frame.width; t.height = options.frame.height;
    }
    if (shadow && t.lineRotation) fail('shadows on rotated lines');
    if ((depth === 0 || child(props, A, 'custGeom')) && (!t.width || !t.height) && child(node, WPS, 'txbx')) fail('text on flat shapes');
    const text = textBox(node, readParagraph, textDefaults, options.readTextBlocks);
    if (text?.upright && t.flipV) fail('upright text on vertically reflected shapes');
    // Flat preset lines use a separate rotation path without a text frame.
    if (t.lineRotation && text?.paragraphs.some(p => p.runs.some(r => r.text || r.field))) fail('text on rotated lines');
    const pictureFill = child(props, A, 'blipFill');
    // The ellipse preset's text rectangle is inscribed at 45 degrees.
    const ellipse = child(props, A, 'prstGeom')?.getAttribute('prst') === 'ellipse';
    const inset = (1 - Math.SQRT1_2) / 2;
    const geometry = readShapeGeometry(props, t, options), pen = readDrawingOutline(props, readSchemeColor, options);
    if (text && !pen) {
      const line = child(props, A, 'ln');
      const width = line ? number(line, 'w', 0) : 0;
      if (width < 0) fail('negative text-frame outline width');
      if (width) text.outlineWidth = width;
    }
    if (pen?.compound && (pen.headEnd || pen.tailEnd) && geometry.paths.some(p => p.stroke && !closedOutlinePath(p))) fail('line-end markers on open compound paths');
    return { type: 'shape', ...t, ...(shadow ? { shadow } : {}), ...(effects ? { effects } : {}), ...(ellipse ? { textRect: { left: inset, top: inset, right: 1 - inset, bottom: 1 - inset } } : {}), ...geometry, fill: pictureFill ? readPictureFill(pictureFill, t) : child(props, A, 'grpFill') ? groupFill : fill(props, readSchemeColor), outline: pen, text };
  };
  return read(root);
}
