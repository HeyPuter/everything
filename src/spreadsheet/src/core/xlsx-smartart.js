/**
 * SmartArt in .xlsx files.
 *
 * Writing: a diagram is saved as what any spreadsheet program can show and edit — one group (xdr:grpSp) of
 * ordinary shapes with their text, exactly as the app draws it — while the app's own record keeps the
 * diagram itself (its outline, layout, colours and style), so the app opens it again as a diagram.
 *
 * Reading: a diagram another program saved is a graphic frame pointing at its diagram parts (data, layout,
 * style, colours) and, usually, at the shapes that program drew for it (a dsp:drawing part). Those shapes are
 * what the app shows and saves again; the outline in the data part becomes the diagram's text, so changing
 * it here redraws it with the nearest of the app's layouts.
 */
import { xmlTag as tag, xmlText } from './xlsx-export-styles.js';
import { smartArtShapes, smartArtPaint, smartArtShapeCommands, smartArtParaMetrics, themePalette, smartArtAltText, normalizeSmartArtItems } from './smartart.js';
import { decorativeXml } from './drawingml-accessibility.js';

const emu = (px) => Math.round(px * 9525);
const hex = (c) => c.slice(1, 7).toUpperCase();
const color = (c, alpha = null) => tag('a:srgbClr', { val: hex(c) }, alpha != null && alpha < 1 ? tag('a:alpha', { val: Math.round(alpha * 100000) }) : undefined);
const solid = (c, alpha) => tag('a:solidFill', {}, color(c, alpha));

/** A shape's outline as a custom geometry in EMUs (its own box), or a preset when one draws it the same. */
function geometryXml(s) {
  if (s.kind === 'rect' && !s.flipH) return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
  if (s.kind === 'ellipse') return tag('a:prstGeom', { prst: 'ellipse' }, tag('a:avLst'));
  const w = Math.max(1, emu(s.w)), h = Math.max(1, emu(s.h)), open = s.kind === 'line';
  const body = smartArtShapeCommands(s).map(([op, ...n]) => {
    const pts = [];
    for (let i = 0; i < n.length; i += 2) pts.push(tag('a:pt', { x: emu(n[i]), y: emu(n[i + 1]) }));
    return op === 'M' ? tag('a:moveTo', {}, pts.join('')) : op === 'L' ? tag('a:lnTo', {}, pts.join('')) : op === 'C' ? tag('a:cubicBezTo', {}, pts.join('')) : tag('a:close');
  }).join('');
  return tag('a:custGeom', {}, tag('a:avLst') + tag('a:gdLst') + tag('a:ahLst') + tag('a:cxnLst') + tag('a:rect', { l: 0, t: 0, r: 'r', b: 'b' })
    + tag('a:pathLst', {}, tag('a:path', { w, h, ...(open ? { fill: 'none' } : {}) }, body)));
}

function fillXml(p) {
  if (!p.fill) return tag('a:noFill');
  const stops = p.gloss || p.gradient;
  if (stops) {
    const at = stops.length === 3 ? [0, 50000, 100000] : [0, 100000];
    return tag('a:gradFill', { rotWithShape: 1 }, tag('a:gsLst', {}, stops.map((c, i) => tag('a:gs', { pos: at[i] }, color(c, p.fillOpacity))).join(''))
      + tag('a:lin', { ang: 5400000, scaled: 0 }));
  }
  return solid(p.fill, p.fillOpacity);
}

function lineXml(s, p) {
  if (!p.line) return tag('a:ln', {}, tag('a:noFill'));
  return tag('a:ln', { w: emu(p.lineWidth || 1.5), ...(s.kind === 'line' ? { cap: 'rnd' } : {}) },
    solid(p.line) + tag('a:round') + (s.kind === 'line' && s.arrow ? tag('a:tailEnd', { type: 'triangle', w: 'med', len: 'med' }) : ''));
}

const effectXml = (p) => (p.shadow ? tag('a:effectLst', {}, tag('a:outerShdw', { blurRad: emu(p.shadow.blur * 2), dist: emu(p.shadow.dy), dir: 5400000, algn: 't', rotWithShape: 0 },
  color('#000000', p.shadow.alpha))) : '');

/** A shape's text: one paragraph for each of its items, with the size, colour, face and bullets the app draws. */
function textXml(s, p, font, rtl) {
  if (!s.paras?.length) return '';
  const box = s.textBox;
  const inset = { lIns: emu(Math.max(0, box.x - s.x)), tIns: emu(Math.max(0, box.y - s.y)), rIns: emu(Math.max(0, s.x + s.w - box.x - box.w)), bIns: emu(Math.max(0, s.y + s.h - box.y - box.h)) };
  const anchor = { top: 't', bottom: 'b' }[s.valign] || 'ctr';
  const algn = { left: 'l', right: 'r' }[s.align] || 'ctr';
  const paras = s.paras.map((q) => {
    const m = smartArtParaMetrics(s.paras, q, s.fontSize);
    const sz = Math.max(100, Math.round(m.size * 75));
    const run = tag('a:rPr', { lang: 'en-US', sz, b: 0, dirty: 0 }, solid(p.text || '#000000') + tag('a:latin', { typeface: font }) + tag('a:cs', { typeface: font }));
    const pPr = q.bullet
      ? tag('a:pPr', { marL: emu(m.indent), indent: -emu(m.indent - m.bulletX), algn: rtl ? 'r' : 'l', ...(rtl ? { rtl: 1 } : {}) }, tag('a:buFont', { typeface: 'Arial' }) + tag('a:buChar', { char: '•' }))
      : tag('a:pPr', { algn, ...(rtl ? { rtl: 1 } : {}) }, tag('a:buNone'));
    const end = tag('a:endParaRPr', { lang: 'en-US', sz, dirty: 0 }, solid(p.text || '#000000'));
    return tag('a:p', {}, pPr + (q.text ? tag('a:r', {}, run + tag('a:t', {}, xmlText(q.text))) : '') + end);
  }).join('');
  return tag('xdr:txBody', {}, tag('a:bodyPr', { wrap: 'square', ...inset, anchor, anchorCtr: 0, rtlCol: 0 }, tag('a:noAutofit')) + tag('a:lstStyle') + paras);
}

/**
 * The diagram as a group of shapes for a drawing part: its own frame, then every shape the app draws, in
 * order, each in the group's coordinates. `allocateId` gives each shape its drawing id. The group carries the
 * diagram's name and its alt text (its own, or one read from its text).
 */
export function smartArtGroupXml(obj, id, allocateId, { colors, font = 'Calibri' } = {}) {
  const P = themePalette(colors);
  const { shapes, colorPlaces } = smartArtShapes(obj, obj.w, obj.h);
  const W = emu(obj.w), H = emu(obj.h);
  const nv = (sid, name) => tag('xdr:nvSpPr', {}, tag('xdr:cNvPr', { id: sid, name }) + tag('xdr:cNvSpPr'));
  // A frame the size of the diagram, drawing nothing, so the group keeps its full size wherever it is read.
  const frame = tag('xdr:sp', { macro: '', textlink: '' }, nv(allocateId(), 'Diagram frame')
    + tag('xdr:spPr', {}, tag('a:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: W, cy: H })) + tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) + tag('a:noFill') + tag('a:ln', {}, tag('a:noFill'))));
  const children = shapes.map((s) => {
    const p = smartArtPaint(s, obj, P, colorPlaces);
    if (!p.fill && !p.line && !s.paras?.length) return '';
    const sid = allocateId();
    const xfrm = tag('a:xfrm', { ...(s.rot ? { rot: Math.round((((s.rot % 360) + 360) % 360) * 60000) } : {}), ...(s.flipH ? { flipH: 1 } : {}) },
      tag('a:off', { x: emu(s.x), y: emu(s.y) }) + tag('a:ext', { cx: Math.max(1, emu(s.w)), cy: Math.max(1, emu(s.h)) }));
    const name = s.paras?.find((q) => q.level === 0)?.text || `Shape ${sid}`;
    return tag('xdr:sp', { macro: '', textlink: '' }, nv(sid, name.slice(0, 255))
      + tag('xdr:spPr', {}, xfrm + geometryXml(s) + fillXml(s.kind === 'line' ? { fill: null } : p) + lineXml(s, p) + effectXml(p))
      + textXml(s, p, font, !!obj.rtl));
  }).join('');
  const descr = obj.decorative ? null : obj.description || smartArtAltText(obj);
  return tag('xdr:grpSp', {}, tag('xdr:nvGrpSpPr', {}, tag('xdr:cNvPr', { id, name: obj.name || `Diagram ${id}`, descr }, decorativeXml(obj.decorative) || undefined) + tag('xdr:cNvGrpSpPr'))
    + tag('xdr:grpSpPr', {}, tag('a:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: W, cy: H }) + tag('a:chOff', { x: 0, y: 0 }) + tag('a:chExt', { cx: W, cy: H })))
    + frame + children);
}

/* ---------- Reading another program's diagram ---------- */

const child = (node, name) => node?.children?.find((c) => c.name === name);
const children = (node, name) => node?.children?.filter((c) => c.name === name) || [];
const textOf = (node) => (node?.text || '') + (node?.children || []).map(textOf).join('');

/**
 * The outline in a diagram's data part (dgm:dataModel): its points of type node (the default) placed under
 * their parents by the parent-of connections, in each parent's order. The document point is the root.
 */
export function diagramOutline(dataModel) {
  const points = children(child(dataModel, 'ptLst'), 'pt');
  const kids = new Map();
  for (const c of children(child(dataModel, 'cxnLst'), 'cxn')) {
    if (c.attrs.type && c.attrs.type !== 'parOf') continue;
    const list = kids.get(c.attrs.srcId) || [];
    list.push({ id: c.attrs.destId, ord: Number(c.attrs.srcOrd) || 0 });
    kids.set(c.attrs.srcId, list);
  }
  const byId = new Map(points.map((p) => [p.attrs.modelId, p]));
  const doc = points.find((p) => p.attrs.type === 'doc');
  if (!doc) return [];
  const items = [], seen = new Set();
  const visit = (pid, level) => {
    if (seen.has(pid) || items.length >= 300 || level > 6) return;
    seen.add(pid);
    for (const k of (kids.get(pid) || []).sort((a, b) => a.ord - b.ord)) {
      const pt = byId.get(k.id);
      if (!pt || (pt.attrs.type && pt.attrs.type !== 'node')) continue;
      const body = child(pt, 't');
      items.push({ text: children(body, 'p').map(textOf).join(' ').replace(/\s+/g, ' ').trim(), level });
      visit(k.id, level + 1);
    }
  };
  visit(doc.attrs.modelId, 0);
  return normalizeSmartArtItems(items);
}

/** The app's layout nearest to another program's layout, by the words of its identifier. */
export function nearestLayout(uniqueId = '') {
  const id = String(uniqueId).toLowerCase().replace(/^.*\//, '');
  const rules = [
    [/horizontalorg|hierarchy2|horizontalhierarchy|horizontalmultilevel/, 'horizontalHierarchy'], [/orgchart|hierarchy\d*$|^hierarchy|namedhierarchy/, 'orgChart'],
    [/hierarchylist|lined|^hlist/, 'hierarchyList'], [/table/, 'tableHierarchy'],
    [/radial|cycle4|cycle5|cycle6/, 'radialCycle'], [/segmented|cycle3|pie/, 'segmentedCycle'], [/cycle/, 'basicCycle'],
    [/venn/, 'basicVenn'], [/target/, 'target'], [/balance/, 'balance'], [/equation/, 'equation'], [/arrow2|arrow4|opposing|counterbalance/, 'opposingArrows'],
    [/matrix/, 'basicMatrix'], [/invertedpyramid/, 'invertedPyramid'], [/pyramid/, 'basicPyramid'],
    [/chevron|hchevron|vchevron/, 'chevronProcess'], [/timeline/, 'timeline'], [/stepup/, 'stepUpProcess'], [/bending|snake/, 'bendingProcess'],
    [/process2|vprocess|vertical.*process/, 'verticalProcess'], [/arrow|process/, 'basicProcess'],
    [/vlist|vertical/, 'verticalBulletList'], [/hlist|horizontal/, 'horizontalBulletList'], [/list|default/, 'blockList'],
  ];
  return rules.find(([re]) => re.test(id))?.[1] || 'blockList';
}

/**
 * The shapes another program drew for its diagram (dsp:drawing's spTree) as an ordinary group of shapes,
 * placed in a frame of the diagram's size: what the app reads like any other group of shapes.
 */
export function diagramDrawingGroup(drawing, frameW, frameH) {
  const tree = child(child(drawing, 'drawing'), 'spTree') || child(drawing, 'spTree');
  if (!tree) return null;
  const shapes = children(tree, 'sp').map((sp) => ({ ...sp, children: sp.children.filter((c) => c.name !== 'txXfrm') }));
  if (!shapes.length) return null;
  const ext = { name: 'ext', attrs: { cx: String(frameW), cy: String(frameH) }, children: [] };
  return { name: 'grpSp', attrs: {}, children: [
    { name: 'nvGrpSpPr', attrs: {}, children: [{ name: 'cNvPr', attrs: { id: '1', name: 'Diagram' }, children: [] }, { name: 'cNvGrpSpPr', attrs: {}, children: [] }] },
    { name: 'grpSpPr', attrs: {}, children: [{ name: 'xfrm', attrs: {}, children: [
      { name: 'off', attrs: { x: '0', y: '0' }, children: [] }, ext,
      { name: 'chOff', attrs: { x: '0', y: '0' }, children: [] }, { ...ext, name: 'chExt' }] }] },
    // An invisible frame keeps the group the diagram's whole size, as the app writes its own.
    { name: 'sp', attrs: {}, children: [{ name: 'nvSpPr', attrs: {}, children: [{ name: 'cNvPr', attrs: { id: '2', name: 'Frame' }, children: [] }, { name: 'cNvSpPr', attrs: {}, children: [] }] },
      { name: 'spPr', attrs: {}, children: [{ name: 'xfrm', attrs: {}, children: [{ name: 'off', attrs: { x: '0', y: '0' }, children: [] }, ext] },
        { name: 'prstGeom', attrs: { prst: 'rect' }, children: [{ name: 'avLst', attrs: {}, children: [] }] }, { name: 'noFill', attrs: {}, children: [] },
        { name: 'ln', attrs: {}, children: [{ name: 'noFill', attrs: {}, children: [] }] }] }] },
    ...shapes.map((sp, i) => ({ ...sp, name: 'sp', children: [
      { name: 'nvSpPr', attrs: {}, children: [{ name: 'cNvPr', attrs: { id: String(i + 3), name: `Shape ${i + 3}` }, children: [] }, { name: 'cNvSpPr', attrs: {}, children: [] }] },
      ...sp.children.filter((c) => c.name !== 'nvSpPr')] })),
  ] };
}
