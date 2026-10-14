import { normalizeCellAnchor } from './drawing-cell-anchor.js';
/** Native DrawingML charts and embedded pictures, including separate chart sheets. */
import { readPictureRect } from './picture-geometry.js';
import { dateTimeKind, fontKeyFor, numFmtToStyle } from './format.js';
import { drawingmlColor } from './drawingml-color.js';
import { refToText } from './refs.js';
import { parseFormula } from './formula/parser.js';
import { CHART_DISPLAY_UNITS } from './charts.js';
import { excelChartAppearance } from './chart-subtypes.js';
import { nativeDrawing, drawingNodeKey } from './drawingml-native.js';
import { resolveDrawingStyle } from './drawingml-style.js';
import { drawingDecorative } from './drawingml-accessibility.js';
import { drawingIdentity, drawingBaseline } from './xlsx-drawing-reconcile.js';
import { equationAnchor, readEquationShape } from './xlsx-equation.js';
import { diagramOutline, diagramDrawingGroup, nearestLayout } from './xlsx-smartart.js';

const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, key) => {
  if (key[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()];
  const hex = /^#x/i.test(key), n = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
});

// A small, namespace-independent tree for the inflated XML parts. No DTDs or external
// entities are resolved. Keeping children separate matters: series and markers both have spPr.
function tree(xml) {
  const root = { children: [] }, stack = [root];
  for (const m of (xml || '').matchAll(/<!--[\s\S]*?-->|<\?[^>]*\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]*>|[^<]+/g)) {
    const token = m[0], parent = stack[stack.length - 1];
    if (m[1] != null) { parent.text = (parent.text || '') + m[1]; continue; }
    if (/^<[!?]/.test(token)) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token[0] !== '<') { parent.text = (parent.text || '') + decode(token); continue; }
    const name = token.match(/^<([\w:.-]+)/)?.[1];
    if (!name) continue;
    const node = { name: name.split(':').pop(), attrs: {}, children: [] };
    for (const a of token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[2] ?? a[3]);
    parent.children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  return root;
}
const child = (node, name) => node?.children.find(n => n.name === name);

// CT_Boolean defaults val to true when the element is present (ISO 29500
// 21.2.2.159). Retain omission rather than inventing an explicit source setting.
const chartBoolean = (parent, name) => {
  const node = child(parent, name);
  if (!node) return {};
  const value = node.attrs.val?.trim();
  return value == null || ['1', 'true', '0', 'false'].includes(value)
    ? { [name]: !['0', 'false'].includes(value) } : {};
};
const roundedCorners = space => chartBoolean(space, 'roundedCorners');
// Read only this label's extensions: a point override must not become the
// default for every point in its enclosing dLbls.
const rangeLabelVisibility = node => {
  for (const ext of child(node, 'extLst')?.children || []) {
    const value = chartBoolean(ext, 'showDataLabelsRange').showDataLabelsRange;
    if (typeof value === 'boolean') return { showRange: value };
  }
  return {};
};

const chartStroke = (node, fill) => {
  const line = child(node, 'ln');
  return { stroke: fill(line), strokeWidth: line?.attrs.w == null ? null : Number(line.attrs.w) / 9525,
    strokeDash: child(line, 'prstDash')?.attrs.val };
};

/** Excel permits an anchored shape to omit/zero its redundant local extents. */
function anchoredShape(node, geometry) {
  if (!node) return node;
  const name = node.name === 'grpSp' ? 'grpSpPr' : 'spPr';
  const props = child(node, name), transform = child(props, 'xfrm'), extent = child(transform, 'ext');
  if (Number(extent?.attrs.cx) >= 0 && Number(extent?.attrs.cy) >= 0
    && (node.name === 'cxnSp' || Number(extent.attrs.cx) > 0 && Number(extent.attrs.cy) > 0)) return node;
  const make = (name, attrs = {}, children = []) => ({ name, attrs, children });
  const dimensions = { cx: Number(extent?.attrs.cx) > 0 ? extent.attrs.cx : geometry.w * 9525,
    cy: Number(extent?.attrs.cy) > 0 ? extent.attrs.cy : geometry.h * 9525 };
  const xfrm = make('xfrm', { ...transform?.attrs }, [child(transform, 'off') || make('off', { x: 0, y: 0 }),
    make('ext', dimensions), ...(transform?.children || []).filter(c => !['off', 'ext'].includes(c.name))]);
  const replacement = make(name, { ...props?.attrs }, [xfrm, ...(props?.children || []).filter(c => c.name !== 'xfrm')]);
  return { ...node, children: [replacement, ...node.children.filter(c => c.name !== name)] };
}
const children = (node, name) => node?.children.filter(n => n.name === name) || [];
const path = (node, ...names) => names.reduce(child, node);
const descendants = (node, name) => (node?.children || []).flatMap(n => n.name === name ? [n] : descendants(n, name));
/**
 * A picture's Picture Format from DrawingML: a:lum (brightness and contrast), a:grayscl and
 * a:alphaModFix on its blip; a rounded or oval preset outline, an RGB frame and an outer shadow on
 * its shape; and the cells a linked picture shows (a14:cameraTool).
 */
function pictureFormatOf(picture) {
  const out = {}, blip = path(picture, 'blipFill', 'blip'), fraction = v => Number(String(v).replace(/%$/, '')) / (String(v).endsWith('%') ? 100 : 100000);
  const lum = child(blip, 'lum');
  if (lum) {
    const brightness = lum.attrs.bright != null ? fraction(lum.attrs.bright) : 0, contrast = lum.attrs.contrast != null ? fraction(lum.attrs.contrast) : 0;
    if (Number.isFinite(brightness) && Number.isFinite(contrast) && (brightness || contrast)) out.adjust = { brightness, contrast };
  }
  if (child(blip, 'grayscl')) out.recolor = 'grayscale';
  const alpha = child(blip, 'alphaModFix');
  if (alpha) {
    const amount = alpha.attrs.amt != null ? fraction(alpha.attrs.amt) : 1;
    if (Number.isFinite(amount) && amount < 1) out.transparency = Math.max(0, 1 - amount);
  }
  const shape = path(picture, 'spPr', 'prstGeom')?.attrs.prst;
  if (shape === 'roundRect' || shape === 'ellipse') out.shape = shape;
  const line = path(picture, 'spPr', 'ln'), rgb = path(line, 'solidFill', 'srgbClr')?.attrs.val;
  if (line && /^[\da-f]{6}$/i.test(rgb || '') && Number(line.attrs.w) > 0) out.outline = { width: Number(line.attrs.w) / 9525, color: `#${rgb.toLowerCase()}` };
  if (path(picture, 'spPr', 'effectLst', 'outerShdw')) out.shadow = true;
  const camera = descendants(path(picture, 'nvPicPr', 'cNvPicPr'), 'cameraTool')[0]?.attrs.cellRange;
  if (typeof camera === 'string' && camera.trim()) out.pictureRef = camera.trim().replace(/^=/, '');
  return out;
}
const val = (node, name) => child(node, name)?.attrs.val;
const number = (node, name) => { const v = val(node, name); return v != null && Number.isFinite(Number(v)) ? Number(v) : null; };
const text = node => node?.text || '';
const richText = node => descendants(node, 't').map(text).join('');

// A group's children have their own coordinate system. A chart found somewhere
// below an anchor must not consume that entire anchor and hide its siblings.
function groupedObjects(node, geometry, depth = 0) {
  if (drawingDecorative(node)) geometry = { ...geometry, decorative: true };
  if (node?.name !== 'grpSp' || depth > 16) return [{ node, geometry }];
  const t = path(node, 'grpSpPr', 'xfrm'), off = child(t, 'chOff'), ext = child(t, 'chExt');
  const cw = Number(ext?.attrs.cx), ch = Number(ext?.attrs.cy);
  // Preserve the existing vector renderer for rotated/mirrored artwork groups.
  if (!(cw > 0 && ch > 0) || Number(t?.attrs.rot) || ['1', 'true'].includes(t?.attrs.flipH) || ['1', 'true'].includes(t?.attrs.flipV)) return [{ node, geometry }];
  const objects = [];
  for (const item of node.children) {
    if (!['sp', 'cxnSp', 'pic', 'grpSp', 'graphicFrame'].includes(item.name)) continue;
    const transform = item.name === 'graphicFrame' ? child(item, 'xfrm') : path(item, item.name === 'grpSp' ? 'grpSpPr' : 'spPr', 'xfrm');
    const at = child(transform, 'off'), size = child(transform, 'ext');
    const x = Number(at?.attrs.x), y = Number(at?.attrs.y), w = Number(size?.attrs.cx), h = Number(size?.attrs.cy);
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0 || (!['sp', 'cxnSp'].includes(item.name) && (!w || !h))) continue;
    const box = { ...geometry, dx: geometry.dx + (x - Number(off?.attrs.x || 0)) * geometry.w / cw,
      dy: geometry.dy + (y - Number(off?.attrs.y || 0)) * geometry.h / ch, w: w * geometry.w / cw, h: h * geometry.h / ch };
    if (geometry.cellAnchor) {
      const [bx, by, bw, bh] = geometry.cellAnchor.box ?? [0, 0, 1, 1];
      box.cellAnchor = { ...geometry.cellAnchor, box: [bx + (x - Number(off?.attrs.x || 0)) / cw * bw,
        by + (y - Number(off?.attrs.y || 0)) / ch * bh, w / cw * bw, h / ch * bh] };
    }
    objects.push(...groupedObjects(item, box, depth + 1));
    if (objects.length > 5000) break;
  }
  return objects;
}

function resolvePart(owner, target) {
  if (!target || /[?#]|^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(p);
  }
  return parts.join('/');
}

/** Read through package relationships, rather than guessing chart/drawing part numbers. */
export async function readXlsxCharts(book, sheets = [], inventory = new Map(), { splitGroups = () => null } = {}) {
  const cache = new Map(), files = book.files || {};
  const xmlOf = part => files[part]?.content ? new TextDecoder().decode(files[part].content) : '';
  // Most imports have no drawing parts. Do not parse their worksheet cells into an XML tree.
  if (!Object.keys(files).some(p => p.endsWith('.rels') && /\/drawing["']/.test(xmlOf(p)))) return new Map();
  // The preset catalogue is an optional chunk, never part of ordinary sheet startup.
  const hasPresets = Object.keys(files).some(p => /\/(?:drawings|diagrams)\/[^/]+\.xml$/.test(p) && /<(?:\w+:)?prstGeom\b/.test(xmlOf(p)));
  const presets = hasPresets ? (await import('../vendor/drawingml-presets.js')).default : {};
  let drawShape, drawEmf;
  const imageCache = new Map();
  const read = part => {
    if (!cache.has(part)) cache.set(part, tree(xmlOf(part)));
    return cache.get(part);
  };
  const related = (owner, id, kind) => {
    const i = owner.lastIndexOf('/'), rels = `${owner.slice(0, i + 1)}_rels/${owner.slice(i + 1)}.rels`;
    const rel = descendants(read(rels), 'Relationship').find(r => r.attrs.Id === id && r.attrs.Type?.endsWith(`/${kind}`) && r.attrs.TargetMode !== 'External');
    return rel ? resolvePart(owner, rel.attrs.Target) : null;
  };
  // Hyperlink relationships are targets, not package parts. In particular,
  // workbook locations (#Sheet!A1) commonly use TargetMode="External" too.
  const drawingLink = (node, owner) => {
    const nv = node.children?.find(n => /^nv/.test(n.name));
    const click = child(child(nv, 'cNvPr'), 'hlinkClick');
    if (!click) return {};
    const i = owner.lastIndexOf('/'), rels = `${owner.slice(0, i + 1)}_rels/${owner.slice(i + 1)}.rels`;
    const rel = descendants(read(rels), 'Relationship').find(r => r.attrs.Id === click.attrs['r:id'] && r.attrs.Type?.endsWith('/hyperlink'));
    return rel?.attrs.Target ? { hyperlink: rel.attrs.Target, ...(click.attrs.tooltip ? { hyperlinkTooltip: click.attrs.tooltip } : {}) } : {};
  };
  const pictureImage = async (picture, owner) => {
    const blip = path(picture, 'blipFill', 'blip');
    // MS-ODRAWXML 2.26.3.1: Office stores the vector in svgBlip and a
    // backward-compatible raster in the main blip. Prefer the local vector;
    // missing/external extensions must not prevent loading the fallback.
    const svgPart = related(owner, descendants(blip, 'svgBlip')[0]?.attrs['r:embed'], 'image');
    const svgBytes = files[svgPart]?.content;
    const imagePart = /\.svg$/i.test(svgPart || '') && svgBytes?.length && svgBytes.length <= 16 * 1024 * 1024
      ? svgPart : related(owner, blip?.attrs['r:embed'], 'image');
    const bytes = files[imagePart]?.content, extension = imagePart?.split('.').pop().toLowerCase();
    const mime = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', emf: 'x-emf', svg: 'svg+xml' }[extension];
    if (!bytes?.length || !mime || bytes.length > 16 * 1024 * 1024) return null;
    if (!imageCache.has(imagePart)) {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const src = `data:image/${mime};base64,${btoa(binary)}`;
      if (extension === 'emf') {
        drawEmf ||= (await import('./emf.js')).emfSvg;
        const svg = drawEmf(bytes);
        imageCache.set(imagePart, svg ? { src: `data:image/svg+xml;base64,${btoa(svg)}`, nativeSrc: src } : null);
      } else imageCache.set(imagePart, { src });
    }
    return imageCache.get(imagePart);
  };
  // Export reconciliation reads already-inflated parts without reparsing cells.
  // Resolve the theme through the same package relationships in that path too.
  const themeRel = descendants(read('xl/_rels/workbook.xml.rels'), 'Relationship').find(r => r.attrs.Type?.endsWith('/theme') && r.attrs.TargetMode !== 'External');
  const rawTheme = book.Themes?.raw || xmlOf(themeRel && resolvePart('xl/workbook.xml', themeRel.attrs.Target));
  const theme = tree(rawTheme), palette = descendants(theme, 'clrScheme')[0];
  const themes = book.Themes || { raw: rawTheme, themeElements: { clrScheme: ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(k => {
    const color = child(palette, k)?.children[0]; return { rgb: color?.attrs.lastClr || color?.attrs.val };
  }) } };
  const defaultFontSize = Number(book.Styles?.Fonts?.[0]?.sz);
  const textSize = defaultFontSize > 0 && defaultFontSize <= 300 ? defaultFontSize * 4 / 3 : 11 * 4 / 3;
  const formatScheme = descendants(theme, 'fmtScheme')[0];
  const font = (typeface, fallback) => fontKeyFor(typeface === '+mj-lt' ? path(descendants(theme, 'majorFont')[0], 'latin')?.attrs.typeface
    : typeface === '+mn-lt' ? path(descendants(theme, 'minorFont')[0], 'latin')?.attrs.typeface : typeface, { literal: true }) || fallback;
  const colors = { bg1: 0, lt1: 0, tx1: 1, dk1: 1, bg2: 2, lt2: 2, tx2: 3, dk2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11 };
  const presetsRGB = { white: 'ffffff', black: '000000', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', cyan: '00ffff', magenta: 'ff00ff', gray: '808080', ltGray: 'd3d3d3', dkGray: 'a9a9a9' };
  const fill = node => {
    if (child(node, 'noFill')) return 'none';
    const solid = child(node, 'solidFill');
    const color = solid?.children.find(n => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(n.name));
    if (!color || number(color, 'alpha') === 0) return null;
    const rgb = color.name === 'schemeClr' ? themes?.themeElements?.clrScheme?.[colors[color.attrs.val]]?.rgb : color.name === 'prstClr' ? presetsRGB[color.attrs.val] : color.attrs.lastClr || color.attrs.val;
    if (!/^[a-f\d]{6}$/i.test(rgb || '')) return null;
    // Chart solids use DrawingML's ordered transforms, just like gradient
    // stops and drawing shapes; they are not SpreadsheetML cell tints.
    return drawingmlColor(`#${rgb}`, color.children);
  };
  const shapeFill = node => {
    if (child(node, 'noFill')) return 'none';
    const color = child(node, 'solidFill')?.children.find(n => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(n.name));
    if (!color) return null;
    const rgb = color.name === 'schemeClr' ? themes?.themeElements?.clrScheme?.[colors[color.attrs.val]]?.rgb : color.name === 'prstClr' ? presetsRGB[color.attrs.val] : color.attrs.lastClr || color.attrs.val;
    if (!/^[a-f\d]{6}$/i.test(rgb || '')) return null;
    let alpha = 1;
    for (const t of color.children) {
      const v = Number(t.attrs.val) / 100000;
      if (!Number.isFinite(v)) continue;
      if (t.name === 'alpha') alpha = v;
      else if (t.name === 'alphaMod') alpha *= v;
      else if (t.name === 'alphaOff') alpha += v;
      alpha = Math.max(0, Math.min(1, alpha));
    }
    if (!alpha) return 'none';
    const hex = drawingmlColor(`#${rgb}`, color.children);
    return alpha === 1 ? hex : hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
  };
  const style = (node, fallback = {}) => {
    const run = descendants(node, 'defRPr')[0] || descendants(node, 'rPr')[0];
    const flags = {};
    for (const [attr, key] of [['b', 'bold'], ['i', 'italic']]) {
      const value = run?.attrs[attr]?.trim();
      if (['0', '1', 'false', 'true'].includes(value)) flags[key] = ['1', 'true'].includes(value);
    }
    return { ...fallback, ...(run?.attrs.sz ? { size: Number(run.attrs.sz) / 75 } : {}),
      font: font(child(run, 'latin')?.attrs.typeface, fallback.font || font('+mn-lt', 'arial')),
      color: fill(run) || fallback.color || '#000000',
      ...flags };
  };
  const labelStyle = node => {
    const run = descendants(node, 'defRPr')[0] || descendants(node, 'rPr')[0];
    if (!run) return {};
    const face = child(run, 'latin')?.attrs.typeface, color = fill(run);
    return { ...(run.attrs.sz ? { size: Number(run.attrs.sz) / 75 } : {}),
      ...(face ? { font: font(face, 'arial') } : {}), ...(color ? { color } : {}),
      ...Object.fromEntries([['b', 'bold'], ['i', 'italic']].flatMap(([attr, key]) =>
        ['0', '1', 'false', 'true'].includes(run.attrs[attr]) ? [[key, ['1', 'true'].includes(run.attrs[attr])]] : [])) };
  };
  const gridlines = axis => {
    // CT_ChartLines has optional shape properties: an empty element still
    // requests gridlines, using the chart style's automatic line formatting.
    const node = child(axis, 'majorGridlines'), line = path(node, 'spPr', 'ln');
    return { visible: !!node && shapeFill(line) !== 'none',
      ...(node ? { style: { color: shapeFill(line), width: line?.attrs.w == null ? null : Number(line.attrs.w) / 9525 } } : {}) };
  };
  const axisStyle = axis => {
    const line = path(axis, 'spPr', 'ln');
    // Missing elements stay automatic; an empty CT_TickMark defaults to cross.
    const tick = name => child(axis, name) ? val(axis, name) ?? 'cross' : null;
    return { color: shapeFill(line), width: line?.attrs.w == null ? null : Number(line.attrs.w) / 9525,
      dash: val(line, 'prstDash'), majorTick: tick('majorTickMark'), minorTick: tick('minorTickMark'),
      minorUnit: number(axis, 'minorUnit'), minorTimeUnit: val(axis, 'minorTimeUnit'), tickSkip: number(axis, 'tickMarkSkip') };
  };
  const textRotation = raw => {
    const units = Number(raw);
    const auto = raw == null || String(raw).trim() === '' || !Number.isInteger(units) || units < -2147483648 || units > 2147483647
      || [-60000000, -60000001].includes(units);
    return { angle: auto ? 0 : units / 60000, auto };
  };
  const layout = node => {
    const m = path(node, 'layout', 'manualLayout');
    if (!m) return null;
    const out = Object.fromEntries(['x', 'y', 'w', 'h'].map(k => [k, number(m, k)]).filter(([, v]) => v != null));
    return Object.keys(out).length ? out : null;
  };
  // [0] is Excel's spelling for this workbook, used by chart-defined names.
  const ref = node => text(path(node, 'numRef', 'f') || path(node, 'strRef', 'f') || path(node, 'multiLvlStrRef', 'f')).replace(/^\[0\]!/, '');
  const cachedText = node => {
    const literal = child(node, 'v');
    if (literal) return text(literal);
    const point = path(node, 'strRef', 'strCache')?.children.find(n => n.name === 'pt' && /^\+?0+$/.test(n.attrs.idx?.trim() || ''));
    const value = child(point, 'v');
    return value ? text(value) : undefined;
  };
  const titleText = (node, key = 'title') => {
    const link = ref(child(node, 'tx'));
    return { [key]: richText(node), ...(link ? { [`${key}Ref`]: link, [`${key}NativeText`]: cachedText(child(node, 'tx')) } : {}) };
  };
  const categories = node => {
    const value = ref(node);
    if (!child(node, 'multiLvlStrRef')) return value;
    let range;
    try { const ast = parseFormula(value); if (ast.type === 'ref') range = ast.ref; } catch { /* Keep unsupported sources intact. */ }
    // The innermost label level is the last column (or row for a horizontal series).
    if (!range || range.kind !== 'range') return value;
    return refToText(range.r2 - range.r1 >= range.c2 - range.c1
      ? { ...range, c1: range.c2, absC1: range.absC2 } : { ...range, r1: range.r2, absR1: range.absR2 });
  };
  const format = node => text(path(node, 'numRef', 'numCache', 'formatCode') || path(node, 'numLit', 'formatCode'));
  const cachedStrings = cache => {
    if (!cache) return undefined;
    const out = [];
    for (const point of children(cache, 'pt').slice(0, 5000)) {
      const index = Number(point.attrs.idx);
      if (String(point.attrs.idx ?? '').trim() && Number.isInteger(index) && index >= 0 && index < 5000)
        out[index] = text(child(point, 'v')).slice(0, 32767);
    }
    return Array.from(out, value => value ?? null);
  };
  const categoryTexts = node => cachedStrings(path(node, 'strRef', 'strCache'));
  const pointFormats = node => {
    const cache = path(node, 'numRef', 'numCache') || child(node, 'numLit'), out = [];
    for (const point of children(cache, 'pt').slice(0, 5000)) {
      const index = Number(point.attrs.idx), code = point.attrs.formatCode;
      if (String(point.attrs.idx ?? '').trim() && Number.isInteger(index) && index >= 0 && index < 5000) out[index] = typeof code === 'string' && code ? code : null;
    }
    while (out.length && out.at(-1) == null) out.pop();
    return out.length ? Array.from(out, code => code ?? null) : undefined;
  };
  const literal = node => {
    const lit = child(node, 'numLit') || child(node, 'strLit');
    if (!lit) return null;
    const out = [], numeric = lit.name === 'numLit';
    for (const p of children(lit, 'pt').slice(0, 5000)) {
      const i = Number(p.attrs.idx), value = text(child(p, 'v'));
      if (!Number.isInteger(i) || i < 0 || i >= 5000) continue;
      out[i] = numeric ? value.trim() && Number.isFinite(Number(value)) ? Number(value) : null : value;
    }
    // Preserve holes by index; never shift a later X/Y/size into an earlier point.
    return Array.from({ length: Math.min(5000, Math.max(out.length, number(lit, 'ptCount') || 0)) }, (_, i) => out[i] ?? null);
  };
  const gradient = (node, geometry = false) => {
    const g = child(node, 'gradFill'), line = child(g, 'lin');
    if (!line) return null;
    const stops = children(child(g, 'gsLst'), 'gs').map(stop => {
      const color = stop.children.find(n => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(n.name));
      const hex = color && fill({ children: [{ name: 'solidFill', children: [{ ...color, children: [] }] }] });
      let opacity = 1;
      for (const transform of color?.children || []) {
        const value = Number(transform.attrs.val) / 100000;
        if (transform.name === 'alpha') opacity = value;
        else if (transform.name === 'alphaMod') opacity *= value;
        else if (transform.name === 'alphaOff') opacity += value;
        opacity = Math.max(0, Math.min(1, opacity));
      }
      return hex ? { offset: Number(stop.attrs.pos) / 100000, color: drawingmlColor(hex, color.children), opacity } : null;
    }).filter(Boolean);
    return stops.length ? { angle: Number(line.attrs.ang || 0) / 60000, stops,
      ...(geometry ? { scaled: ['1', 'true'].includes(line.attrs.scaled) } : {}) } : null;
  };
  const readPieChart = (space, chart, plot, group, geometry) => {
    const series = children(group, 'ser');
    // Our pie model has one ring. Do not silently discard additional rings.
    if (series.length !== 1) return null;
    const s = series[0], values = ref(child(s, 'val'));
    const literals = Object.fromEntries([['categories', child(s, 'cat')], ['values', child(s, 'val')]]
      .map(([key, node]) => [key, literal(node)]).filter(([, data]) => data != null));
    // CT_NumDataSource permits either a worksheet reference or embedded numbers.
    // Literals are authoritative data, including an explicitly empty series.
    if (!values && !literals.values) return null;
    const title = child(chart, 'title'), legend = child(chart, 'legend');
    const baseStyle = style(child(space, 'txPr'), { size: 14.67 });
    const legendPos = ({ t: 'top', r: 'right', l: 'right', tr: 'right' }[val(legend, 'legendPos')] || 'bottom');
    const labelOptions = (node, inherited, point = false) => {
      const out = { ...inherited, style: style(child(node, 'txPr') || child(node, 'tx'), inherited.style) };
      // MS-ODRAWXML 2.6.1.17: c15:layout is separate from c:layout.
      // Points use only its size; the parent labels can also specify x/y.
      // Parent coordinates must not become individual point coordinates.
      const ext = children(child(node, 'extLst'), 'ext').find(e => e.attrs.uri?.toUpperCase() === '{CE6537A1-D6FC-4F65-9D91-7224C49458BB}');
      const manual = path(ext, 'layout', 'manualLayout');
      if (manual) {
        const box = Object.fromEntries((point ? ['w', 'h'] : ['x', 'y', 'w', 'h'])
          .map(k => [k, number(manual, k)]).filter(([, v]) => Number.isFinite(v)));
        if (Object.keys(box).length) out.extensionLayout = box;
      }
      for (const [key, tag] of Object.entries({ category: 'showCatName', value: 'showVal', percent: 'showPercent', series: 'showSerName', hidden: 'delete', leaderLines: 'showLeaderLines' })) {
        if (child(node, tag)) out[key] = val(node, tag) !== '0' && val(node, tag) !== 'false';
      }
      if (child(node, 'separator')) out.separator = text(child(node, 'separator'));
      if (child(node, 'numFmt')) out.numberFormat = child(node, 'numFmt').attrs.formatCode;
      if (val(node, 'dLblPos')) out.position = val(node, 'dLblPos');
      const rich = path(node, 'tx', 'rich');
      if (rich) out.content = children(rich, 'p').flatMap((p, i) => [
        ...(i ? [{ kind: 'text', text: '\n' }] : []),
        ...p.children.flatMap(run => {
          if (run.name === 'br') return [{ kind: 'text', text: '\n' }];
          if (!['r', 'fld'].includes(run.name)) return [];
          const kind = run.name === 'fld' && ({ CATEGORYNAME: 'category', VALUE: 'value', PERCENTAGE: 'percent', SERIESNAME: 'series' }[run.attrs.type]);
          return [kind ? { kind } : { kind: 'text', text: richText(run) }];
        }),
      ]);
      return out;
    };
    const groupLabels = labelOptions(child(group, 'dLbls'), { style: baseStyle, separator: ', ', position: group.name === 'doughnutChart' ? 'ctr' : 'bestFit' });
    const seriesLabels = child(s, 'dLbls'), labels = labelOptions(seriesLabels, groupLabels);
    const pointLabels = new Map();
    for (const node of [...children(child(group, 'dLbls'), 'dLbl'), ...children(seriesLabels, 'dLbl')]) {
      const index = number(node, 'idx');
      pointLabels.set(index, { ...labelOptions(node, pointLabels.get(index) || { ...labels, extensionLayout: undefined }, true), index,
        dx: layout(node)?.x || 0, dy: layout(node)?.y || 0 });
    }
    const line = path(s, 'spPr', 'ln');
    const ofPie = group.name === 'ofPieChart' ? { kind: val(group, 'ofPieType') === 'bar' ? 'bar' : 'pie',
      // Splits other than by position keep the default count of three in the second plot.
      split: (val(group, 'splitType') ?? 'pos') === 'pos' && number(group, 'splitPos') >= 1 ? Math.round(number(group, 'splitPos')) : 3,
      secondSize: number(group, 'secondPieSize') ?? 75, gap: number(group, 'gapWidth') ?? 100 } : null;
    return { type: group.name === 'doughnutChart' ? 'donut' : 'pie', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ...geometry,
      ...(ofPie ? { ofPie } : {}), ...(number(s, 'explosion') > 0 ? { explosion: number(s, 'explosion') } : {}),
      ...titleText(title), legend: !!legend, legendPos, includeHidden: val(chart, 'plotVisOnly') === '0',
      sourceRefs: [{ name: text(path(s, 'tx', 'v')), nameRef: text(path(s, 'tx', 'strRef', 'f')), nativeNameText: cachedText(child(s, 'tx')),
        categories: categories(child(s, 'cat')), values, categoryFormat: format(child(s, 'cat')), categoryPointFormats: pointFormats(child(s, 'cat')), nativeCategoryTexts: categoryTexts(child(s, 'cat')),
        valueFormat: format(child(s, 'val')), valuePointFormats: pointFormats(child(s, 'val')), literal: literals }],
      appearance: {
        ...(child(space, 'txPr') ? { textStyle: baseStyle } : {}),
        ...roundedCorners(space), ...formatExtras(space, chart, plot, title, legend, [s]),
        background: fill(child(space, 'spPr')) || '#ffffff', border: fill(path(space, 'spPr', 'ln')) !== 'none',
        plot: layout(plot), title: layout(title), legend: layout(legend), legendPos,
        titleStyle: style(title, { ...baseStyle, size: 24 }), legendStyle: style(child(legend, 'txPr'), baseStyle),
        legendHidden: children(legend, 'legendEntry').filter(e => ['1', 'true'].includes(val(e, 'delete'))).map(e => number(e, 'idx')),
        pointColors: [children(s, 'dPt').map(p => ({ index: number(p, 'idx'), color: fill(child(p, 'spPr')) }))],
        pie: { holeSize: number(group, 'holeSize') ?? 50, firstSliceAngle: number(group, 'firstSliceAng') ?? 0,
          color: fill(child(s, 'spPr')), varyColors: !['0', 'false'].includes(val(group, 'varyColors')),
          stroke: fill(line), strokeWidth: Number(line?.attrs.w || 9525) / 9525,
          points: children(s, 'dPt').filter(p => path(p, 'spPr', 'ln')).map(p => ({ index: number(p, 'idx'), stroke: fill(path(p, 'spPr', 'ln')),
            strokeWidth: path(p, 'spPr', 'ln')?.attrs.w != null ? Number(path(p, 'spPr', 'ln').attrs.w) / 9525 : null })),
          labels: { ...labels, points: [...pointLabels.values()] },
        },
      },
    };
  };
  /** The formatting any chart may carry: the chart area's outline, the title's and
   * legend's own boxes, shadows and glows, and how blank cells plot. */
  const formatExtras = (space, chart, plot, title, legend, series = []) => {
    const ln = path(space, 'spPr', 'ln'), border = fill(ln);
    const box = node => {
      const f = fill(child(node, 'spPr')), stroke = fill(path(node, 'spPr', 'ln'));
      return f || stroke ? { fill: f, stroke } : null;
    };
    const effect = node => {
      const list = path(node, 'spPr', 'effectLst');
      const glow = child(list, 'glow'), shadow = !!child(list, 'outerShdw');
      const color = glow ? fill({ children: [{ name: 'solidFill', attrs: {}, children: glow.children }] }) : null;
      return shadow || color ? { shadow, glow: color && color !== 'none' ? color : null } : null;
    };
    const effects = Object.fromEntries([['chartArea', space], ['plotArea', plot], ['title', title], ['legend', legend],
      ...series.map((s, i) => [`series:${i}`, s])].map(([k, node]) => [k, node && effect(node)]).filter(([, e]) => e));
    const blanks = val(chart, 'dispBlanksAs');
    return { ...(border && border !== 'none' ? { borderColor: border } : {}),
      ...(ln?.attrs.w != null && Number.isFinite(Number(ln.attrs.w)) ? { borderWidth: Number(ln.attrs.w) / 9525 } : {}),
      ...(['gap', 'zero', 'span'].includes(blanks) ? { blanks } : {}),
      ...(box(title) ? { titleBox: box(title) } : {}), ...(box(legend) ? { legendBox: box(legend) } : {}),
      ...(Object.keys(effects).length ? { effects } : {}) };
  };
  /**
   * Treemap, sunburst, box and whisker and funnel layouts: their series' named or direct references,
   * their layout options, title, legend and data labels, drawn in the default chart style.
   */
  const readChartExLayout = (space, chart, plot, series, geometry) => {
    const layoutId = series[0].attrs.layoutId, type = layoutId;
    const hierarchy = type === 'treemap' || type === 'sunburst';
    const used = hierarchy || type === 'funnel' ? series.slice(0, 1) : series;
    const datas = children(child(space, 'chartData'), 'data');
    const on = v => ['1', 'true'].includes(v);
    const sourceRefs = used.map(s => {
      const data = datas.find(d => d.attrs.id === val(s, 'dataId'));
      const cat = children(data, 'strDim').find(d => d.attrs.type === 'cat') || children(data, 'numDim').find(d => d.attrs.type === 'cat');
      const num = children(data, 'numDim').find(d => ['val', 'size'].includes(d.attrs.type));
      // Cached levels stand in for references a file left out: the innermost level names the points.
      const cached = dim => children(child(dim, 'lvl'), 'pt').reduce((out, pt) => { const i = Number(pt.attrs.idx); if (Number.isInteger(i) && i >= 0 && i < 5000) out[i] = text(pt); return out; }, []);
      const levelCount = Number(child(num, 'lvl')?.attrs.ptCount) || 0;
      const literal = {};
      if (!text(child(cat, 'f')) && cat) literal.categories = Array.from({ length: Math.max(levelCount, cached(cat).length) }, (_, i) => cached(cat)[i] ?? '');
      if (!text(child(num, 'f')) && num) literal.values = Array.from({ length: Math.max(levelCount, cached(num).length) }, (_, i) => (cached(num)[i] != null && Number.isFinite(Number(cached(num)[i])) ? Number(cached(num)[i]) : null));
      return { name: text(path(s, 'tx', 'txData', 'v')), nameRef: text(path(s, 'tx', 'txData', 'f')), categories: text(child(cat, 'f')), values: text(child(num, 'f')),
        valueFormat: child(num, 'lvl')?.attrs.formatCode || '', ...(Object.keys(literal).length ? { literal } : {}) };
    });
    if (!sourceRefs.some(s => s.values || s.literal?.values)) return null;
    const axes = children(plot, 'axis'), cat = axes.find(a => child(a, 'catScaling')), valueAxis = axes.find(a => child(a, 'valScaling'));
    const gap = Number(child(cat, 'catScaling')?.attrs.gapWidth);
    const scaling = key => { const v = child(valueAxis, 'valScaling')?.attrs[key]; return v != null && v !== 'auto' && Number.isFinite(Number(v)) ? Number(v) : null; };
    const titleNode = child(chart, 'title'), legendNode = child(chart, 'legend');
    const labels = children(series[0], 'dataLabels')[0], visibility = child(labels, 'visibility');
    const baseStyle = style(child(space, 'txPr'), { size: 14.67 });
    const font = baseStyle.font || 'calibri';
    const subtype = type === 'boxWhisker' ? 'boxWhisker' : type;
    const appearance = { ...excelChartAppearance(subtype, { font }),
      background: fill(child(space, 'spPr')) || '#ffffff', border: fill(path(space, 'spPr', 'ln')) !== 'none',
      ...(fill(path(space, 'spPr', 'ln')) && fill(path(space, 'spPr', 'ln')) !== 'none' ? { borderColor: fill(path(space, 'spPr', 'ln')) } : {}),
      ...(child(titleNode, 'txPr') ? { titleStyle: style(child(titleNode, 'txPr'), excelChartAppearance(subtype, { font }).titleStyle) } : {}),
      ...(child(legendNode, 'txPr') ? { legendStyle: style(child(legendNode, 'txPr'), baseStyle) } : {}),
      ...(child(cat, 'txPr') ? { xStyle: style(child(cat, 'txPr'), baseStyle) } : {}),
      ...(child(valueAxis, 'txPr') ? { yStyle: style(child(valueAxis, 'txPr'), baseStyle) } : {}),
      ...(['1', 'true'].includes(cat?.attrs.hidden) ? { hideXAxis: true } : {}), ...(['1', 'true'].includes(valueAxis?.attrs.hidden) ? { hideYAxis: true } : {}),
      ...(type === 'funnel' && Number.isFinite(gap) ? { gapWidth: gap * 100 } : {}),
      ...(scaling('majorUnit') ? { yStep: scaling('majorUnit') } : {}),
      ...(child(valueAxis, 'numFmt')?.attrs.formatCode ? { yFormat: child(valueAxis, 'numFmt').attrs.formatCode } : {}),
      legendPos: ({ t: 'top', r: 'right', l: 'right' }[legendNode?.attrs.pos] || 'bottom') };
    const layoutPr = child(series[0], 'layoutPr'), boxVisibility = child(layoutPr, 'visibility');
    const titleRef = text(path(titleNode, 'tx', 'txData', 'f'));
    return { type, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ...geometry,
      title: titleNode ? text(path(titleNode, 'tx', 'txData', 'v')) || richText(path(titleNode, 'tx', 'rich')) : '',
      ...(titleRef ? { titleRef } : {}),
      legend: !!legendNode, legendPos: appearance.legendPos,
      labels: !!labels && !!visibility && ['value', 'categoryName', 'seriesName'].some(k => on(visibility.attrs[k])),
      gridlines: !!child(valueAxis, 'majorGridlines'), yMin: scaling('min'), yMax: scaling('max'),
      sourceRefs, colors: hierarchy ? [] : used.map(s => fill(child(s, 'spPr'))),
      ...(type === 'treemap' ? { treemapLabels: val(layoutPr, 'parentLabelLayout') || 'overlapping' } : {}),
      ...(type === 'boxWhisker' ? { box: { quartiles: child(layoutPr, 'statistics')?.attrs.quartileMethod === 'inclusive' ? 'inclusive' : 'exclusive',
        meanLine: on(boxVisibility?.attrs.meanLine), meanMarkers: boxVisibility ? on(boxVisibility.attrs.meanMarker) : true,
        innerPoints: on(boxVisibility?.attrs.nonoutliers), outliers: boxVisibility ? on(boxVisibility.attrs.outliers) : true,
        gapWidth: Number.isFinite(gap) ? gap * 100 : 100 } } : {}),
      appearance };
  };
  const readChartEx = (root, geometry) => {
    const space = child(root, 'chartSpace'), chart = child(space, 'chart'), plot = child(chart, 'plotArea');
    const all = children(child(plot, 'plotAreaRegion'), 'series');
    const hidden = s => ['1', 'true'].includes(s?.attrs.hidden);
    const layouts = all.filter(s => !hidden(s) && ['treemap', 'sunburst', 'boxWhisker', 'funnel'].includes(s.attrs.layoutId));
    if (layouts.length && layouts.every(s => s.attrs.layoutId === layouts[0].attrs.layoutId)) return readChartExLayout(space, chart, plot, layouts, geometry);
    // A Pareto line inherits visibility and data from its owner. Some templates
    // retain a second, hidden column/line pair with unrelated source ranges.
    const visible = all.filter(s => !hidden(s) && (s.attrs.layoutId !== 'paretoLine'
      || (all[Number(s.attrs.ownerIdx)] && !hidden(all[Number(s.attrs.ownerIdx)]))));
    const bars = visible.filter(s => s.attrs.layoutId === 'clusteredColumn');
    const line = visible.find(s => s.attrs.layoutId === 'paretoLine');
    if (bars.length !== 1 || !line || visible.length !== 2 || all[Number(line.attrs.ownerIdx)] !== bars[0]
      || !path(bars[0], 'layoutPr', 'aggregation')) return null;
    const bar = bars[0], data = children(child(space, 'chartData'), 'data').find(d => d.attrs.id === val(bar, 'dataId'));
    const category = children(data, 'strDim').find(d => d.attrs.type === 'cat');
    const values = children(data, 'numDim').find(d => d.attrs.type === 'val');
    const source = { name: text(path(bar, 'tx', 'txData', 'v')), nameRef: text(path(bar, 'tx', 'txData', 'f')),
      categories: text(child(category, 'f')), values: text(child(values, 'f')), valueFormat: values?.attrs.formatCode || '' };
    if (!source.categories || !source.values) return null;
    const axes = children(plot, 'axis'), cat = axes.find(a => child(a, 'catScaling'));
    const axisFor = s => axes.find(a => children(s, 'axisId').some(id => id.attrs.val === a.attrs.id));
    const axis = axisFor(bar), secondary = axisFor(line);
    const scaling = (a, key) => {
      const v = child(a, 'valScaling')?.attrs[key];
      return v != null && v !== 'auto' && Number.isFinite(Number(v)) ? Number(v) : null;
    };
    const baseStyle = style(child(space, 'txPr'), { size: 14.67 });
    const grids = { x: gridlines(cat), y: gridlines(axis), y2: gridlines(secondary) };
    const gap = Number(child(cat, 'catScaling')?.attrs.gapWidth);
    return { type: 'combo', pareto: true, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ...geometry,
      ...titleText(child(chart, 'title')), sourceRefs: [source], secondaryAxis: true,
      colors: [fill(child(bar, 'spPr')), fill(path(line, 'spPr', 'ln'))],
      legend: !!child(chart, 'legend'), gridlines: grids.y.visible,
      yMin: scaling(axis, 'min'), yMax: scaling(axis, 'max'),
      appearance: {
        ...(child(space, 'txPr') ? { textStyle: baseStyle } : {}),
        xGridlines: grids.x.visible, y2Gridlines: grids.y2.visible,
        gridlineStyles: Object.fromEntries(Object.entries(grids).filter(([, g]) => g.style).map(([k, g]) => [k, g.style])),
        background: fill(child(space, 'spPr')) || '#ffffff', border: fill(path(space, 'spPr', 'ln')) !== 'none',
        titleStyle: style(child(chart, 'title'), { ...baseStyle, size: 24 }), legendStyle: baseStyle,
        xStyle: style(child(cat, 'txPr'), baseStyle), yStyle: style(child(axis, 'txPr'), baseStyle),
        y2Style: style(child(secondary, 'txPr'), baseStyle),
        yStep: scaling(axis, 'majorUnit'), y2Min: scaling(secondary, 'min') ?? 0, y2Max: scaling(secondary, 'max') ?? 1,
        y2Step: scaling(secondary, 'majorUnit') ?? .1,
        yFormat: child(axis, 'numFmt')?.attrs.formatCode || source.valueFormat,
        y2Format: child(secondary, 'numFmt')?.attrs.formatCode || '0%',
        gapWidth: Number.isFinite(gap) ? gap * 100 : 100,
        lines: [{ marker: false }, { marker: false, width: Number(path(line, 'spPr', 'ln')?.attrs.w || 19050) / 9525 }],
      },
    };
  };
  /** Stock charts (with or without volume columns) and surfaces: their series in column order, and the subtype they make. */
  const readStockOrSurface = (space, chart, plot, groups, geometry) => {
    const stock = child(plot, 'stockChart'), bar = child(plot, 'barChart');
    const surface = child(plot, 'surface3DChart') || child(plot, 'surfaceChart');
    if (stock ? groups.some(g => g !== stock && g !== bar) || (bar && children(bar, 'ser').length !== 1) : groups.length !== 1) return null;
    const series = stock ? [...children(bar, 'ser'), ...children(stock, 'ser')] : children(surface, 'ser');
    const prices = children(stock, 'ser').length;
    if (stock && ![3, 4].includes(prices)) return null;
    const kind = stock ? `${bar ? 'v' : ''}${prices === 4 ? 'o' : ''}hlc` : null;
    const wire = ['1', 'true'].includes(val(surface, 'wireframe'));
    const view = surface ? surface.name === 'surfaceChart' ? (wire ? 'wireframeContour' : 'contour') : (wire ? 'wireframe3d' : 'surface3d') : null;
    const subtype = stock ? { hlc: 'stockHlc', ohlc: 'stockOhlc', vhlc: 'stockVhlc', vohlc: 'stockVohlc' }[kind]
      : { surface3d: 'surface3d', wireframe3d: 'surfaceWireframe3d', contour: 'contour', wireframeContour: 'contourWireframe' }[view];
    const sourceRefs = series.map(s => ({ name: text(path(s, 'tx', 'v')) || text(path(s, 'tx', 'strRef', 'strCache', 'pt', 'v')),
      nameRef: text(path(s, 'tx', 'strRef', 'f')), nativeNameText: cachedText(child(s, 'tx')), categories: categories(child(s, 'cat')), values: ref(child(s, 'val')),
      categoryFormat: format(child(s, 'cat')), valueFormat: format(child(s, 'val')),
      literal: Object.fromEntries([['categories', child(s, 'cat')], ['values', child(s, 'val')]].map(([key, node]) => [key, literal(node)]).filter(([, v]) => v != null)) }));
    if (!sourceRefs.length || sourceRefs.some(s => !s.values && !s.literal.values?.length)) return null;
    for (const s of sourceRefs) if (!s.categories && !s.literal.categories) s.categories = sourceRefs.find(r => r.categories)?.categories || '';
    const title = child(chart, 'title'), legend = child(chart, 'legend');
    const axes = plot.children.filter(n => ['catAx', 'dateAx', 'valAx'].includes(n.name));
    const cat = axes.find(a => a.name !== 'valAx'), values = axes.filter(a => a.name === 'valAx');
    // With volume, the prices read on the second value axis; the first scales the volume.
    const axis = values[0];
    const baseStyle = style(child(space, 'txPr'), { size: 14.67 });
    const appearance = { ...excelChartAppearance(subtype, { font: baseStyle.font || 'calibri' }),
      background: fill(child(space, 'spPr')) || '#ffffff', border: fill(path(space, 'spPr', 'ln')) !== 'none',
      ...formatExtras(space, chart, plot, title, legend, series),
      titleStyle: style(title, { ...baseStyle, size: 18.67 }), legendStyle: style(child(legend, 'txPr'), baseStyle),
      xStyle: style(child(cat, 'txPr'), baseStyle), yStyle: style(child(axis, 'txPr'), baseStyle),
      hideXAxis: ['1', 'true'].includes(val(cat, 'delete')), hideYAxis: ['1', 'true'].includes(val(axis, 'delete')),
      ...(number(axis, 'majorUnit') ? { yStep: number(axis, 'majorUnit') } : {}),
      ...(values[1] ? { y2Min: number(child(values[1], 'scaling'), 'min'), y2Max: number(child(values[1], 'scaling'), 'max') } : {}),
      legendPos: ({ t: 'top', r: 'right', l: 'right', tr: 'right' }[val(legend, 'legendPos')] || 'bottom') };
    return { type: stock ? 'stock' : 'surface', ...(stock ? { stock: kind } : { surfaceView: view }), range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ...geometry,
      ...titleText(title), legend: !!legend, legendPos: appearance.legendPos, sourceRefs, includeHidden: val(chart, 'plotVisOnly') === '0',
      gridlines: gridlines(axis).visible, yMin: number(child(axis, 'scaling'), 'min'), yMax: number(child(axis, 'scaling'), 'max'),
      labels: series.some(s => chartBoolean(child(s, 'dLbls'), 'showVal').showVal === true), appearance };
  };
  const readChart = (root, geometry) => {
    const space = child(root, 'chartSpace'), chart = child(space, 'chart'), plot = child(chart, 'plotArea');
    const groups = plot?.children.filter(n => n.name.endsWith('Chart')) || [];
    if (groups.length === 1 && ['pieChart', 'doughnutChart', 'ofPieChart'].includes(groups[0].name)) return readPieChart(space, chart, plot, groups[0], geometry);
    if (groups.some(g => ['stockChart', 'surfaceChart', 'surface3DChart'].includes(g.name))) return readStockOrSurface(space, chart, plot, groups, geometry);
    const line = child(plot, 'lineChart'), bar = child(plot, 'barChart');
    const area = child(plot, 'areaChart'), scatter = child(plot, 'scatterChart'), bubble = child(plot, 'bubbleChart');
    const areaOnly = groups.length === 1 && !!area;
    const lineOnly = groups.length === 1 && !!line;
    const grouping = val(bar || (areaOnly ? area : lineOnly ? line : null), 'grouping') || (areaOnly ? 'standard' : null);
    const scatterOnly = groups.length === 1 && !!scatter;
    const bubbleOnly = groups.length === 1 && !!bubble, numeric = scatterOnly || bubbleOnly;
    const radar = child(plot, 'radarChart'), radarOnly = groups.length === 1 && !!radar;
    // Designed charts layer areas or lines with scatter outlines and labels.
    // Keep every series and its own coordinates on the shared axes.
    const base = area || line;
    const layered = groups.length === 2 && base && scatter && val(base, 'grouping') === 'standard'
      && children(base, 'axId').length === 2 && children(scatter, 'axId').length === 2
      && children(base, 'axId').every(id => children(scatter, 'axId').some(other => other.attrs.val === id.attrs.val));
    const grouped = !layered && !!area && groups.every(g =>
      (g.name === 'areaChart' && ['standard', 'stacked', 'percentStacked'].includes(val(g, 'grouping') || 'standard')
        || g.name === 'barChart' && val(g, 'barDir') === 'col' && val(g, 'grouping') === 'clustered'
        || g.name === 'lineChart' && val(g, 'grouping') === 'standard' || g.name === 'scatterChart')
      && children(g, 'axId').length === 2 && children(area, 'axId').length === 2
      && children(g, 'axId').every(id => children(area, 'axId').some(other => other.attrs.val === id.attrs.val)));
    const mixed = layered || grouped;
    // The combo model has columns followed by one line. Never silently import only
    // part of a chart with other series types or unsupported axis arrangements.
    if (!mixed && !numeric && !radarOnly && (!groups.length || groups.some(g => g !== line && g !== bar)
      || (bar && (!['col', 'bar'].includes(val(bar, 'barDir')) || !['clustered', 'stacked', 'percentStacked'].includes(grouping)))
      || (line && bar && val(bar, 'barDir') === 'bar')
      || (line && bar && children(line, 'ser').length !== 1))) return null;
    const type = radarOnly ? 'radar' : bubbleOnly ? 'bubble' : scatterOnly ? 'scatter' : areaOnly ? 'area' : mixed ? 'combo' : bar ? line ? 'combo' : val(bar, 'barDir') === 'bar' ? 'bar' : 'column' : 'line';
    const title = child(chart, 'title'), legend = child(chart, 'legend');
    const axes = plot.children.filter(n => ['dateAx', 'catAx', 'valAx'].includes(n.name));
    const groupAxis = (group, kinds) => axes.find(a => kinds.includes(a.name) && children(group, 'axId').some(id => id.attrs.val === val(a, 'axId')));
    const cat = numeric ? axes.find(a => ['b', 't'].includes(val(a, 'axPos'))) || axes[0]
      : groupAxis(radar || area || bar || line, ['dateAx', 'catAx']) || child(plot, 'dateAx') || child(plot, 'catAx');
    const axis = numeric ? axes.find(a => a !== cat && ['l', 'r'].includes(val(a, 'axPos'))) || axes.find(a => a !== cat)
      : groupAxis(radar || area || bar || line, ['valAx']) || child(plot, 'valAx');
    const lineAxis = groupAxis(line, ['valAx']);
    const secondary = type === 'combo' && lineAxis && lineAxis !== axis ? lineAxis : null;
    const dateOffset = cat?.name === 'dateAx' && book.Workbook?.WBProps?.date1904 ? 1462 : 0;
    const dateBound = value => Number.isFinite(value) ? value + dateOffset : value;
    const series = mixed || numeric || radarOnly ? groups.flatMap(g => children(g, 'ser')) : [...children(bar, 'ser'), ...children(line, 'ser')];
    const seriesTypes = mixed ? groups.flatMap(g => children(g, 'ser').map(() => ({ areaChart: 'area', barChart: 'column', lineChart: 'line', scatterChart: 'scatter' })[g.name])) : null;
    const sourceRefs = series.map((s, i) => ({ name: text(path(s, 'tx', 'v')) || text(path(s, 'tx', 'strRef', 'strCache', 'pt', 'v')),
      nameRef: text(path(s, 'tx', 'strRef', 'f')), nativeNameText: cachedText(child(s, 'tx')), categories: categories(child(s, 'xVal') || child(s, 'cat')), values: ref(child(s, 'yVal') || child(s, 'val')),
      ...((scatterOnly || grouped && seriesTypes[i] === 'scatter') && !child(child(s, 'xVal'), 'numRef') && !child(child(s, 'xVal'), 'numLit') ? { categoryMode: 'ordinal' } : {}),
      categoryFormat: format(child(s, 'xVal') || child(s, 'cat')), categoryPointFormats: pointFormats(child(s, 'xVal') || child(s, 'cat')), nativeCategoryTexts: categoryTexts(child(s, 'xVal') || child(s, 'cat')), valueFormat: format(child(s, 'yVal') || child(s, 'val')), valuePointFormats: pointFormats(child(s, 'yVal') || child(s, 'val')),
      ...(bubbleOnly ? { sizes: ref(child(s, 'bubbleSize')), sizeFormat: format(child(s, 'bubbleSize')), sizePointFormats: pointFormats(child(s, 'bubbleSize')) } : {}),
      literal: Object.fromEntries([['categories', child(s, 'xVal') || child(s, 'cat')], ['values', child(s, 'yVal') || child(s, 'val')], ['sizes', child(s, 'bubbleSize')]]
        .map(([key, node]) => [key, literal(node)]).filter(([, values]) => values != null)),
      ...(mixed ? { labels: text(child(descendants(s, 'datalabelsRange')[0], 'f')),
        nativeLabelTexts: cachedStrings(child(descendants(s, 'datalabelsRange')[0], 'dlblRangeCache')) } : {}) }));
    // PivotChart references include the final total row, while their point count
    // explicitly excludes it. Trim that row from the live reference, not by
    // replacing the series with its potentially stale cached values.
    if (child(space, 'pivotSource')) sourceRefs.forEach((source, i) => {
      for (const [key, node] of [['categories', child(series[i], 'cat')], ['values', child(series[i], 'val')]]) {
        const count = Number(descendants(node, 'ptCount')[0]?.attrs.val);
        if (!Number.isInteger(count) || count <= 0 || !source[key]) continue;
        try {
          const ast = parseFormula(source[key]), r = ast.ref;
          if (ast.type !== 'ref' || r.kind !== 'range') continue;
          if (r.c1 === r.c2 && r.r2 - r.r1 === count) source[key] = refToText({ ...r, r2: r.r2 - 1 });
          else if (r.r1 === r.r2 && r.c2 - r.c1 === count) source[key] = refToText({ ...r, c2: r.c2 - 1 });
        } catch { /* A named formula keeps its original reference. */ }
      }
    });
    if (!sourceRefs.length || sourceRefs.some(s => !s.values && !s.literal.values?.length)
      || bubbleOnly && sourceRefs.some(s => (!s.categories && !s.literal.categories?.length) || (!s.sizes && !s.literal.sizes?.length))) return null;
    // Excel omits the line's categories when it shares the columns' categories.
    for (const [i, s] of sourceRefs.entries()) if ((!mixed || grouped && seriesTypes[i] !== 'scatter') && !numeric && !s.categories && !s.literal.categories) {
      s.categories = sourceRefs.find(ref => ref.categories)?.categories || '';
      s.categoryFormat ||= sourceRefs.find(ref => ref.categoryFormat)?.categoryFormat || '';
    }
    // Worksheet dates already use the app's calendar. Excel also converts
    // date-formatted literals, but leaves General/time-only numbers unchanged,
    // even on a date axis. Never shift referenced cells or their caches twice.
    if (dateOffset) for (const source of sourceRefs) if (source.literal.categories) {
      const style = numFmtToStyle(source.categoryFormat);
      source.literal.categories = source.literal.categories.map(value => Number.isFinite(value)
        && ['date', 'datetime'].includes(dateTimeKind(style, value)) ? value + dateOffset : value);
    }
    const baseStyle = style(child(space, 'txPr'), { size: 14.67 });
    const displayUnits = axis => {
      const units = child(axis, 'dispUnits');
      if (!units) return null;
      const builtIn = val(units, 'builtInUnit'), label = child(units, 'dispUnitsLbl');
      return { builtIn, divisor: number(units, 'custUnit'),
        label: label ? richText(label) || (Object.hasOwn(CHART_DISPLAY_UNITS, builtIn) ? builtIn.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()) : String(number(units, 'custUnit') || '')) : '',
        style: style(label, baseStyle), layout: layout(label),
        rotation: textRotation(path(label, 'txPr', 'bodyPr')?.attrs.rot ?? path(label, 'tx', 'rich', 'bodyPr')?.attrs.rot).angle };
    };
    const legendLayout = layout(legend), plotLayout = layout(plot);
    const dataTable = child(plot, 'dTable');
    // CT_DTable's flags are optional; a present CT_Boolean defaults to true.
    const tableFlag = name => !!child(dataTable, name) && !['0', 'false'].includes(val(dataTable, name));
    const legendPos = legendLayout && legendLayout.w > legendLayout.h && legendLayout.y < (plotLayout?.y ?? .25) ? 'top'
      : ({ t: 'top', b: 'bottom', r: 'right', l: 'right', tr: 'right' }[val(legend, 'legendPos')] || 'bottom');
    const grids = { x: gridlines(cat), y: gridlines(axis), y2: gridlines(secondary) };
    const columnCount = children(bar, 'ser').length;
    const hiddenLegend = new Set(children(legend, 'legendEntry').filter(e => ['1', 'true'].includes(val(e, 'delete'))).map(e => number(e, 'idx')));
    const bubbleLabels = s => {
      const own = child(s, 'dLbls'), shared = child(bubble, 'dLbls');
      const setting = key => val(own, key) ?? val(shared, key);
      return { style: style(child(own, 'txPr') || child(shared, 'txPr'), { ...baseStyle, size: 12 }), position: setting('dLblPos') || 'ctr',
        ...Object.fromEntries([['value', 'showVal'], ['size', 'showBubbleSize'], ['category', 'showCatName'], ['series', 'showSerName']]
          .map(([key, flag]) => [key, ['1', 'true'].includes(setting(flag))])),
        points: [...children(shared, 'dLbl'), ...children(own, 'dLbl')].map(l => ({ index: number(l, 'idx'), hidden: ['1', 'true'].includes(val(l, 'delete')) })) };
    };
    return { type, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ...geometry,
      stacked: grouping === 'stacked' || grouping === 'percentStacked', stack100: grouping === 'percentStacked',
      ...titleText(title), ...titleText(child(cat, 'title'), 'xTitle'), ...titleText(child(axis, 'title'), 'yTitle'), ...titleText(child(secondary, 'title'), 'y2Title'),
      sourceRefs, colors: series.map((s, i) => radarOnly ? shapeFill(val(radar, 'radarStyle') === 'filled' ? child(s, 'spPr') : path(s, 'spPr', 'ln')) : fill(bubbleOnly || (mixed ? ['area', 'column'].includes(seriesTypes[i]) : i < columnCount) ? child(s, 'spPr') : path(s, 'spPr', 'ln'))),
      legend: !!legend, legendPos, gridlines: grids.y.visible,
      smooth: series.some(s => val(s, 'smooth') === '1'), includeHidden: val(chart, 'plotVisOnly') === '0',
      labels: bubbleOnly ? series.some(s => { const l = bubbleLabels(s); return l.value || l.size || l.category || l.series; })
        : series.some(s => (chartBoolean(child(s, 'dLbls'), 'showVal').showVal ?? chartBoolean(child(groups.find(g => g.children.includes(s)), 'dLbls'), 'showVal').showVal) === true
          || children(child(s, 'dLbls'), 'dLbl').some(p => chartBoolean(p, 'showVal').showVal === true)),
      secondaryAxis: !!secondary,
      yMin: number(child(axis, 'scaling'), 'min'), yMax: number(child(axis, 'scaling'), 'max'),
      appearance: {
        ...(radarOnly ? { radar: { style: val(radar, 'radarStyle') || 'standard', blanks: val(chart, 'dispBlanksAs') || 'gap',
          series: series.map(s => ({ fill: shapeFill(child(s, 'spPr')), gradient: gradient(child(s, 'spPr')),
            stroke: shapeFill(path(s, 'spPr', 'ln')), dash: val(path(s, 'spPr', 'ln'), 'prstDash'),
            markerSymbol: val(child(s, 'marker'), 'symbol') || 'circle' })),
        } } : {}),
        ...(child(space, 'txPr') ? { textStyle: baseStyle } : {}),
        xGridlines: grids.x.visible, y2Gridlines: grids.y2.visible,
        gridlineStyles: Object.fromEntries(Object.entries(grids).filter(([, g]) => g.style).map(([k, g]) => [k, g.style])),
        background: fill(child(space, 'spPr')) || '#ffffff', border: fill(path(space, 'spPr', 'ln')) !== 'none',
        ...roundedCorners(space), ...formatExtras(space, chart, plot, title, legend, series),
        ...(numeric && displayUnits(cat) ? { xUnits: displayUnits(cat) } : {}),
        ...(displayUnits(axis) ? { yUnits: displayUnits(axis) } : {}),
        ...(displayUnits(secondary) ? { y2Units: displayUnits(secondary) } : {}),
        plot: plotLayout, title: layout(title), legend: legendLayout, legendPos,
        ...(dataTable ? { dataTable: {
          horizontal: tableFlag('showHorzBorder'), vertical: tableFlag('showVertBorder'),
          outline: tableFlag('showOutline'), keys: tableFlag('showKeys'),
          style: style(child(dataTable, 'txPr'), baseStyle), fill: fill(child(dataTable, 'spPr')),
          stroke: fill(path(dataTable, 'spPr', 'ln')),
          width: Number(path(dataTable, 'spPr', 'ln')?.attrs.w ?? 9525) / 9525,
        } } : {}),
        legendHidden: series.flatMap((s, i) => number(s, 'idx') != null && hiddenLegend.has(number(s, 'idx')) ? [i] : []),
        titleStyle: style(title, { ...baseStyle, size: 24 }), legendStyle: style(child(legend, 'txPr'), baseStyle),
        xStyle: style(child(cat, 'txPr'), baseStyle), yStyle: style(child(axis, 'txPr'), baseStyle),
        axisStyles: Object.fromEntries(Object.entries({ x: cat, y: axis, y2: secondary }).filter(([, node]) => node).map(([key, node]) => [key, axisStyle(node)])),
        // Office measures crossesAt on the perpendicular axis, rather than
        // inferring units from the parent axis (MS-OE376 §2.1.1464).
        axisCrossings: Object.fromEntries(Object.entries({ x: cat, y: axis, y2: secondary }).filter(([, node]) => node)
          .map(([key, node]) => [key, (val(node, 'crossesAt')?.trim() ? number(node, 'crossesAt') : null) ?? val(node, 'crosses')])
          .map(([key, value]) => [key, key === 'x' ? value : dateBound(value)])
          .filter(([, value]) => Number.isFinite(value) || ['autoZero', 'min', 'max'].includes(value))),
        hideXAxis: ['1', 'true'].includes(val(cat, 'delete')), hideYAxis: ['1', 'true'].includes(val(axis, 'delete')),
        hideY2Axis: ['1', 'true'].includes(val(secondary, 'delete')),
        xLabelPosition: val(cat, 'tickLblPos'),
        yPosition: val(axis, 'axPos'), yLabelPosition: val(axis, 'tickLblPos'),
        y2LabelPosition: val(secondary, 'tickLblPos'),
        reverseCategories: val(child(cat, 'scaling'), 'orientation') === 'maxMin', valueTicks: val(axis, 'majorTickMark') === 'out',
        reverseValues: val(child(axis, 'scaling'), 'orientation') === 'maxMin',
        reverseSecondaryValues: val(child(secondary, 'scaling'), 'orientation') === 'maxMin',
        plotFill: shapeFill(child(plot, 'spPr')), plotStroke: shapeFill(path(plot, 'spPr', 'ln')),
        plotStrokeWidth: path(plot, 'spPr', 'ln')?.attrs.w == null ? null : Number(path(plot, 'spPr', 'ln').attrs.w) / 9525,
        plotStrokeDash: val(path(plot, 'spPr', 'ln'), 'prstDash'),
        pointColors: series.map(s => children(s, 'dPt').map(p => ({ index: number(p, 'idx'), color: fill(child(p, 'spPr')) }))),
        ...(bar ? { bars: series.map(s => groups.some(g => g.name === 'barChart' && g.children.includes(s)) ? {
          ...chartBoolean(s, 'invertIfNegative'), ...chartStroke(child(s, 'spPr'), fill),
          gradient: gradient(child(s, 'spPr'), true),
          negativeColor: fill(child(descendants(child(s, 'extLst'), 'invertSolidFillFmt')[0], 'spPr')),
          points: children(s, 'dPt').map(p => ({ index: number(p, 'idx'), shape: !!child(p, 'spPr'), ...chartBoolean(p, 'invertIfNegative'),
            ...chartStroke(child(p, 'spPr'), fill), gradient: gradient(child(p, 'spPr'), true) })),
        } : null) } : {}),
        dateAxis: cat?.name === 'dateAx', xStep: number(cat, 'majorUnit'), yStep: number(axis, 'majorUnit'),
        categoryBetween: val(axis, 'crossBetween') !== 'midCat',
        xTimeUnit: val(cat, 'majorTimeUnit'), xBaseTimeUnit: val(cat, 'baseTimeUnit'),
        // Excel treats these non-angle values as automatic axis-label rotation,
        // just like an omitted rot. Explicit zero instead locks labels horizontal.
        // Verified with independent long-label charts in desktop Excel.
        xRotation: textRotation(path(cat, 'txPr', 'bodyPr')?.attrs.rot).angle,
        xRotationAuto: textRotation(path(cat, 'txPr', 'bodyPr')?.attrs.rot).auto,
        xWrap: path(cat, 'txPr', 'bodyPr')?.attrs.wrap,
        xLabelSkip: number(cat, 'tickLblSkip'),
        ...(numeric || cat?.name === 'dateAx' ? { xMin: dateBound(number(child(cat, 'scaling'), 'min')), xMax: dateBound(number(child(cat, 'scaling'), 'max')) } : {}),
        gapWidth: number(bar, 'gapWidth'),
        overlap: number(bar, 'overlap'),
        valueLabels: series.map(s => {
          const shared = child(groups.find(g => g.children.includes(s)), 'dLbls'), own = child(s, 'dLbls'), labels = own || shared;
          // Individual settings inherit through chart group -> series -> point.
          // A series with only point exceptions must not reset group defaults.
          const setting = tag => child(own, tag) || child(shared, tag);
          return { show: (chartBoolean(own, 'showVal').showVal ?? chartBoolean(shared, 'showVal').showVal) === true,
            style: style(child(own, 'txPr'), style(child(shared, 'txPr'), baseStyle)),
            position: setting('dLblPos')?.attrs.val || null, numberFormat: setting('numFmt')?.attrs.formatCode || '',
            hidden: children(labels, 'dLbl').filter(l => ['1', 'true'].includes(val(l, 'delete'))).map(l => number(l, 'idx')),
            ...(children(labels, 'dLbl').length ? { points: children(labels, 'dLbl').map(p => ({ index: number(p, 'idx'),
              ...(child(p, 'txPr') ? { style: labelStyle(child(p, 'txPr')) } : {}),
              ...(child(p, 'numFmt') ? { numberFormat: child(p, 'numFmt').attrs.formatCode || '' } : {}),
              ...(child(p, 'dLblPos') ? { position: val(p, 'dLblPos') } : {}),
              ...Object.fromEntries([['showVal', 'show'], ['delete', 'hidden']].flatMap(([tag, key]) =>
                typeof chartBoolean(p, tag)[tag] === 'boolean' ? [[key, chartBoolean(p, tag)[tag]]] : [])),
            })) } : {}) };
        }),
        y2Min: number(child(secondary, 'scaling'), 'min'), y2Max: number(child(secondary, 'scaling'), 'max'),
        y2Step: number(secondary, 'majorUnit'), y2Style: style(child(secondary, 'txPr'), baseStyle),
        y2Format: child(secondary, 'numFmt')?.attrs.formatCode || sourceRefs.at(-1).valueFormat,
        xFormat: child(cat, 'numFmt')?.attrs.formatCode || sourceRefs[0].categoryFormat,
        ...(child(cat, 'numFmt') && (child(cat, 'numFmt').attrs.sourceLinked == null
          || ['1', 'true'].includes(child(cat, 'numFmt').attrs.sourceLinked)) ? { xSourceLinked: true } : {}),
        yFormat: child(axis, 'numFmt')?.attrs.formatCode || sourceRefs[0].valueFormat,
        ...(bubbleOnly ? { bubble: { scale: number(bubble, 'bubbleScale') ?? 100, sizeRepresents: val(bubble, 'sizeRepresents') || 'area',
          showNegative: ['1', 'true'].includes(val(bubble, 'showNegBubbles')),
          xGrid: grids.x.visible, xGridColor: grids.x.style?.color, yGridColor: grids.y.style?.color,
          xAxisColor: fill(path(cat, 'spPr', 'ln')), yAxisColor: fill(path(axis, 'spPr', 'ln')),
          series: series.map(s => {
            return { gradient: gradient(child(s, 'spPr')), stroke: fill(path(s, 'spPr', 'ln')), strokeWidth: Number(path(s, 'spPr', 'ln')?.attrs.w || 9525) / 9525,
              labels: bubbleLabels(s),
              errors: children(s, 'errBars').map(e => ({ axis: val(e, 'errDir'), type: val(e, 'errValType'), direction: val(e, 'errBarType'), value: number(e, 'val') ?? 1,
                caps: !['1', 'true'].includes(val(e, 'noEndCap')), color: fill(path(e, 'spPr', 'ln')), width: Number(path(e, 'spPr', 'ln')?.attrs.w || 9525) / 9525 })),
            };
          }),
        } } : {}),
        ...(grouped && !areaOnly ? { seriesGroups: groups.flatMap((g, id) => children(g, 'ser').map(() => ({ id, grouping: val(g, 'grouping') || 'standard' }))) } : {}),
        ...(mixed && !areaOnly ? { seriesTypes,
          dataLabels: series.map(s => {
            const labels = child(s, 'dLbls');
            return { style: style(child(labels, 'txPr'), baseStyle), position: val(labels, 'dLblPos') || 'ctr', ...rangeLabelVisibility(labels),
              points: children(labels, 'dLbl').map(label => ({ index: number(label, 'idx'), position: val(label, 'dLblPos'),
                ...rangeLabelVisibility(label), hidden: val(label, 'delete') === '1', dx: layout(label)?.x || 0, dy: layout(label)?.y || 0 })) };
          }) } : {}),
        lines: series.map((s, i) => {
          const marker = child(s, 'marker');
          return { width: Number(path(s, 'spPr', 'ln')?.attrs.w || 19050) / 9525,
            visible: !(scatterOnly && ['marker', 'none'].includes(val(scatter, 'scatterStyle'))) && fill(path(s, 'spPr', 'ln')) !== 'none' && path(s, 'spPr', 'ln')?.attrs.w !== '0',
            ...(mixed && seriesTypes[i] !== 'line' ? { color: fill(path(s, 'spPr', 'ln')) } : {}),
            ...(grouped || scatterOnly ? { smooth: val(s, 'smooth') === '1' } : {}),
            ...(val(path(s, 'spPr', 'ln'), 'prstDash') && val(path(s, 'spPr', 'ln'), 'prstDash') !== 'solid' ? { dash: val(path(s, 'spPr', 'ln'), 'prstDash') } : {}),
            ...(!radarOnly && val(marker, 'symbol') ? { markerSymbol: val(marker, 'symbol') } : {}),
            marker: val(marker, 'symbol') !== 'none' && (!radarOnly || !!marker || val(radar, 'radarStyle') === 'marker'), markerSize: number(marker, 'size') ?? 5, markerSizeUnit: 'pt',
            markerFill: shapeFill(path(marker, 'spPr')), markerStroke: shapeFill(path(marker, 'spPr', 'ln')) };
        }),
      },
    };
  };
  const out = new Map();
  for (const sheet of book.Workbook?.Sheets || []) {
    const part = related('xl/workbook.xml', sheet.id, 'worksheet') || related('xl/workbook.xml', sheet.id, 'chartsheet');
    if (!part) continue;
    const charts = [];
    const identities = []; inventory.set(sheet.name, identities);
    const dimensions = sheets.find(s => s.name === sheet.name);
    const formatPr = child(tree(xmlOf(part).replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?sheetFormatPr\b[^>]*>/)?.[0]), 'sheetFormatPr');
    const defaultHeight = Number(formatPr?.attrs.defaultRowHeight) * 4 / 3;
    const rowSizes = { ...dimensions?.rowHeights };
    // Missing row records use Excel's sheet default, and an explicit height
    // equal to the app default may have been omitted from its sparse map.
    (book.Sheets?.[sheet.name]?.['!rows'] || []).forEach((row, i) => {
      if (!Object.hasOwn(rowSizes, i) && Number.isFinite(row?.hpt)) rowSizes[i] = Math.max(1, Math.min(546, row.hpt * 4 / 3));
    });
    const span = (from, to, axis) => {
      const start = Number(text(child(from, axis))), end = Number(text(child(to, axis)));
      const limit = axis === 'row' ? 1048575 : 16383;
      if (![start, end].every(n => Number.isInteger(n) && n >= 0 && n <= limit) || end < start) return null;
      const sizes = axis === 'row' ? rowSizes : dimensions?.colWidths || {};
      const hidden = new Set(dimensions?.[axis === 'row' ? 'hiddenRows' : 'hiddenCols'] || []);
      const fallback = axis === 'row' ? Number.isFinite(defaultHeight) && defaultHeight > 0 ? Math.max(1, Math.min(546, defaultHeight)) : 26 : dimensions?.defaultColWidth || 100;
      let pixels = (end - start) * fallback;
      // Work proportional to stored dimensions, even for an anchor spanning a million rows.
      for (const [index, size] of Object.entries(sizes)) if (+index >= start && +index < end) pixels += hidden.has(+index) ? -fallback : size - fallback;
      for (const index of hidden) if (index >= start && index < end && !Object.hasOwn(sizes, index)) pixels -= fallback;
      return pixels + (Number(text(child(to, `${axis}Off`))) - Number(text(child(from, `${axis}Off`)))) / 9525;
    };
    const drawingTags = xmlOf(part).replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?drawing\b[^>]*>/g) || [];
    for (const tag of drawingTags) {
      const drawing = child(tree(tag), 'drawing');
      const drawingPart = related(part, drawing.attrs['r:id'], 'drawing');
      if (!drawingPart) continue;
      const scope = /<(?:\w+:)?(?:stCxn|endCxn)\b/.test(xmlOf(drawingPart)) ? (await drawingBaseline(`${drawingPart}\0${xmlOf(drawingPart)}`)).hash : null;
      let anchorIndex = 0;
      for (const anchor of (child(read(drawingPart), 'wsDr')?.children || []).map(equationAnchor)) {
        anchorIndex++;
        const root = anchor.children.find(n => ['sp', 'cxnSp', 'pic', 'grpSp', 'graphicFrame'].includes(n.name))
          || descendants(child(anchor, 'AlternateContent'), 'graphicFrame').find(n => descendants(n, 'chart').length);
        if (!root) continue;
        identities.push(drawingIdentity(root));
        const from = child(anchor, 'from'), to = child(anchor, 'to'), ext = child(anchor, 'ext'), pos = child(anchor, 'pos');
        const anchorGeometry = { anchor: { r: Number(text(child(from, 'row'))) || 0, c: Number(text(child(from, 'col'))) || 0 },
          // Two-cell markers describe initial geometry; editAs controls whether
          // later cell edits move it. Workbook normalization resolves absolute
          // markers into sheet pixels using the imported visible dimensions.
          ...(anchor.name === 'absoluteAnchor' || (anchor.name === 'twoCellAnchor' && anchor.attrs.editAs === 'absolute') ? { anchorMode: 'absolute' } : {}),
          dx: Number(pos?.attrs.x || text(child(from, 'colOff')) || 0) / 9525, dy: Number(pos?.attrs.y || text(child(from, 'rowOff')) || 0) / 9525,
          w: to ? span(from, to, 'col') ?? 640 : ext?.attrs.cx != null ? Number(ext.attrs.cx) / 9525 : 640,
          h: to ? span(from, to, 'row') ?? 400 : ext?.attrs.cy != null ? Number(ext.attrs.cy) / 9525 : 400 };
        if (anchor.name === 'twoCellAnchor' && (!anchor.attrs.editAs || ['twoCell', 'oneCell', 'absolute'].includes(anchor.attrs.editAs))) {
          const marker = node => ({ r: Number(text(child(node, 'row'))), c: Number(text(child(node, 'col'))),
            dx: Number(text(child(node, 'colOff'))) / 9525, dy: Number(text(child(node, 'rowOff'))) / 9525 });
          const cellAnchor = from && to && normalizeCellAnchor({ from: marker(from), to: marker(to), editAs: anchor.attrs.editAs });
          if (cellAnchor) anchorGeometry.cellAnchor = cellAnchor;
        }
        // A group this app wrote of its own objects (named in its record) comes apart into them again, as one holding a chart does.
        const split = descendants(root, 'chart').length || descendants(root, 'fld').some(f => f.attrs.type === 'TxLink')
          || root.name === 'grpSp' && !!splitGroups(sheet.name)?.has(drawingIdentity(root).key);
        for (const { node, geometry: placement } of split ? groupedObjects(root, anchorGeometry) : [{ node: root, geometry: anchorGeometry }]) {
          const identity = drawingIdentity(node);
          if (node !== root) {
            const parent = drawingIdentity(root);
            identity.parentKey = parent.key;
            // The objects of a group that came apart stay a group (Arrange ▸ Group), keyed by the group's own identity.
            identity.groupId = parent.key || `g${out.size}d${drawingTags.indexOf(tag)}a${anchorIndex}`;
            if (parent.hidden) identity.parentHidden = true;
            identities.push(identity);
          }
          const geometry = { ...placement, ...drawingLink(node, drawingPart), ...(scope ? { drawingKey: drawingNodeKey(node, scope) } : {}), xlsxDrawingIdentity: identity, ...(drawingDecorative(root) || drawingDecorative(node) ? { decorative: true } : {}) };
          const chartRef = node.name === 'graphicFrame' ? descendants(node, 'chart')[0] : null;
          const picture = node.name === 'pic' ? node : null, shape = ['sp', 'cxnSp'].includes(node.name) ? node : null, group = node.name === 'grpSp' ? node : null;
          // A diagram another program made (SmartArt): its outline, and the shapes it drew for it, shown until it is changed.
          const diagram = node.name === 'graphicFrame' && !chartRef && /\/diagram$/.test(path(node, 'graphic', 'graphicData')?.attrs.uri || '') ? descendants(node, 'relIds')[0] : null;
          if (diagram) {
            const dataPart = related(drawingPart, diagram.attrs['r:dm'], 'diagramData');
            const layoutPart = related(drawingPart, diagram.attrs['r:lo'], 'diagramLayout');
            const model = dataPart ? child(read(dataPart), 'dataModel') : null;
            const docPoint = children(child(model, 'ptLst'), 'pt').find(p => p.attrs.type === 'doc');
            const layoutId = (layoutPart && child(read(layoutPart), 'layoutDef')?.attrs.uniqueId) || child(docPoint, 'prSet')?.attrs.loTypeId || '';
            const drawPart = related(drawingPart, descendants(model, 'dataModelExt')[0]?.attrs.relId, 'diagramDrawing');
            const frame = path(node, 'xfrm', 'ext')?.attrs;
            const fw = Number(frame?.cx) > 0 ? Number(frame.cx) : geometry.w * 9525, fh = Number(frame?.cy) > 0 ? Number(frame.cy) : geometry.h * 9525;
            let fallback = null;
            const group = drawPart ? diagramDrawingGroup(read(drawPart), fw, fh) : null;
            if (group) {
              drawShape ||= (await import('./xlsx-shapes.js')).drawingShapeImage;
              let drawable = group;
              try { drawable = resolveDrawingStyle(group, formatScheme); } catch { /* unresolved style links: the shapes' own colours */ }
              const vector = drawShape(drawable, shapeFill, { presets, font, textSize });
              const native = vector && nativeDrawing(drawable, vector.viewport, { fill: shapeFill, font, textSize, formatScheme, scope });
              if (vector) fallback = { src: vector.src, pad: [vector.padding.x, vector.padding.y], ...(native ? { nativeDrawing: native } : {}) };
            }
            const props = path(node, 'nvGraphicFramePr', 'cNvPr');
            charts.push({ type: 'smartart', ...geometry, nativeSize: true, layout: nearestLayout(layoutId), items: diagramOutline(model),
              ...(layoutId ? { sourceLayout: layoutId } : {}), ...(fallback ? { fallback } : {}),
              ...(props?.attrs.descr ? { description: props.attrs.descr } : {}) });
            continue;
          }
          if (picture) {
            // Use raster fallbacks for Office SVGs; decode supported native EMF
            // vectors for display while retaining their original export bytes.
            const image = await pictureImage(picture, drawingPart);
            if (!image) continue;
            const props = path(picture, 'nvPicPr', 'cNvPr'), transform = path(picture, 'spPr', 'xfrm');
            charts.push({ type: 'image', ...geometry, ...image, nativeSize: true,
              title: props?.attrs.descr || props?.attrs.name || '', border: false,
              srcRect: readPictureRect(path(picture, 'blipFill', 'srcRect')?.attrs),
              fillRect: readPictureRect(path(picture, 'blipFill', 'stretch', 'fillRect')?.attrs),
              rotation: Number(transform?.attrs.rot || 0) / 60000,
              flipH: ['1', 'true'].includes(transform?.attrs.flipH), flipV: ['1', 'true'].includes(transform?.attrs.flipV),
              ...pictureFormatOf(picture) });
          } else if (chartRef) {
            // cNvPr@descr belongs to the drawing, not c:chart/c:title. XML
            // entity decoding has already occurred; ST_Xstring escapes do not apply.
            const description = path(node, 'nvGraphicFramePr', 'cNvPr')?.attrs.descr;
            if (description !== undefined) geometry.description = description;
            const chartPart = related(drawingPart, chartRef.attrs['r:id'], 'chart');
            const extendedPart = related(drawingPart, chartRef.attrs['r:id'], 'chartEx');
            const imported = chartPart ? readChart(read(chartPart), geometry) : extendedPart && readChartEx(read(extendedPart), geometry);
            if (imported) {
              const space = chartPart && child(read(chartPart), 'chartSpace');
              const pivot = child(space, 'pivotSource') || descendants(child(space, 'extLst'), 'pivotSource')[0];
              if (pivot && text(child(pivot, 'name'))) {
                imported.pivotSource = { name: text(child(pivot, 'name')),
                  formatId: Number(child(pivot, 'fmtId')?.attrs.val || 0), standalone: !child(space, 'pivotSource') };
                // Pivot series captions can differ from the report's data-field
                // alias at tx/strRef/f. Excel retains the series caption when
                // saving that report; keep its string independently of the cell.
                for (const source of imported.sourceRefs || []) if (typeof source.nativeNameText === 'string')
                  source.pivotName = source.nativeNameText;
              }
              const shapesPart = related(chartPart || '', child(space, 'userShapes')?.attrs['r:id'], 'chartUserShapes');
              const annotations = children(child(read(shapesPart), 'userShapes'), 'relSizeAnchor').flatMap(a => {
                const shape = child(a, 'sp'), body = child(shape, 'txBody');
                if (!body) return [];
                const x = Number(text(path(a, 'from', 'x'))), y = Number(text(path(a, 'from', 'y')));
                return [{ text: children(body, 'p').map(richText).join('\n'), box: { x, y, w: Number(text(path(a, 'to', 'x'))) - x, h: Number(text(path(a, 'to', 'y'))) - y },
                  style: style(body, { size: 14 }), align: ({ ctr: 'center', r: 'right' }[path(body, 'p', 'pPr')?.attrs.algn] || 'left'),
                  fill: fill(child(shape, 'spPr')), stroke: fill(path(shape, 'spPr', 'ln')) }];
              });
              if (annotations.length) imported.appearance.annotations = annotations;
              charts.push(imported);
            }
          } else if (shape && readEquationShape(shape)) {
            // An equation (Office Math in a text box) stays an editable equation.
            charts.push({ type: 'text', ...geometry, nativeSize: true, ...readEquationShape(shape) });
          } else {
            // Retain the editable model of decorative rectangles already supported.
            const props = child(shape, 'spPr'), bg = fill(props);
            const fields = descendants(shape, 'fld').filter(f => f.attrs.type === 'TxLink');
            const body = child(shape, 'txBody'), runs = children(body, 'p').flatMap(p => p.children.filter(n => ['r', 'fld'].includes(n.name)));
            const linked = shape?.attrs.textlink && fields.length === 1;
            const transform = child(props, 'xfrm');
            // A solid rectangular fill is representable by the live text-box
            // model too. Rasterizing it would freeze the TxLink field's cache.
            const linkedFill = shapeFill(props);
            let linkedEffects = true;
            if (linked && child(props, 'solidFill')) {
              try {
                const resolved = child(resolveDrawingStyle(shape, formatScheme), 'spPr');
                linkedEffects = !!(child(resolved, 'effectLst')?.children.length || child(resolved, 'effectDag')
                  || child(resolved, 'scene3d') || child(resolved, 'sp3d'));
              } catch { /* Unresolved style effects need the complete drawing renderer. */ }
            }
            const linkedBackground = child(props, 'prstGeom')?.attrs.prst === 'rect'
              && child(props, 'solidFill') && linkedFill && !linkedEffects;
            if (linked && (bg === 'none' || linkedBackground) && fill(child(props, 'ln')) === 'none'
              && !Number(transform?.attrs.rot || 0) && !['1', 'true'].includes(transform?.attrs.flipH) && !['1', 'true'].includes(transform?.attrs.flipV)) {
              const at = runs.indexOf(fields[0]), bodyPr = child(body, 'bodyPr');
              const nativeHeight = Number(child(transform, 'ext')?.attrs.cy) / 9525;
              const scale = nativeHeight > 0 ? geometry.h / nativeHeight : 1;
              const st = style(fields[0], { size: textSize });
              charts.push({ type: 'text', ...geometry, nativeSize: true, text: children(body, 'p').map(richText).join('\n').replace(/\n+$/, ''),
                textRef: shape.attrs.textlink, textPrefix: runs.slice(0, at).map(richText).join(''), textSuffix: runs.slice(at + 1).map(richText).join(''),
                style: { ...st, size: st.size * scale, border: false, ...(linkedBackground && linkedFill !== 'none' ? { bg: linkedFill } : {}),
                  align: ({ ctr: 'center', r: 'right' }[path(body, 'p', 'pPr')?.attrs.algn] || 'left'),
                  valign: ({ ctr: 'middle', b: 'bottom' }[bodyPr?.attrs.anchor] || 'top'),
                  padding: ['tIns', 'rIns', 'bIns', 'lIns'].map((k, i) => Number(bodyPr?.attrs[k] ?? (i % 2 ? 91440 : 45720)) / 9525 * scale),
                } });
              continue;
            }
            if (child(props, 'prstGeom')?.attrs.prst === 'rect' && !richText(shape).trim() && bg && bg !== 'none'
              && fill(child(props, 'ln')) === 'none' && !Number(child(props, 'xfrm')?.attrs.rot || 0)) {
              charts.push({ type: 'text', ...geometry, text: '', style: { bg, border: false } });
              continue;
            }
            drawShape ||= (await import('./xlsx-shapes.js')).drawingShapeImage;
            const pictures = new Map();
            for (const pic of descendants(group, 'pic')) pictures.set(pic, await pictureImage(pic, drawingPart));
            let drawable = anchoredShape(group || shape, geometry);
            try { drawable = resolveDrawingStyle(drawable, formatScheme); } catch { /* A malformed style link must not prevent reading the existing shape or sheet. */ }
            const vector = drawShape(drawable, shapeFill, { presets, font, textSize, picture: pic => pictures.get(pic)?.src });
            if (vector) {
              const props = path(group || shape, group ? 'nvGrpSpPr' : shape?.name === 'cxnSp' ? 'nvCxnSpPr' : 'nvSpPr', 'cNvPr');
              const { padding: _padding, viewport, frame, ...image } = vector;
              const sx = frame.w ? geometry.w / frame.w : frame.h ? geometry.h / frame.h : 1 / 9525;
              const sy = frame.h ? geometry.h / frame.h : sx;
              const native = nativeDrawing(drawable, viewport, { fill: shapeFill, font, textSize, formatScheme, scope });
              const box = geometry.cellAnchor?.box ?? [0, 0, 1, 1];
              const cellAnchor = geometry.cellAnchor && frame.w && frame.h ? { ...geometry.cellAnchor, box: [
                box[0] + (viewport[0] - frame.x) / frame.w * box[2], box[1] + (viewport[1] - frame.y) / frame.h * box[3],
                viewport[2] / frame.w * box[2], viewport[3] / frame.h * box[3]] } : geometry.cellAnchor;
              charts.push({ type: 'image', ...geometry, ...image, ...(cellAnchor ? { cellAnchor } : {}),
                ...(native ? { nativeDrawing: native } : {}),
                dx: geometry.dx + (viewport[0] - frame.x) * sx, dy: geometry.dy + (viewport[1] - frame.y) * sy,
                w: viewport[2] * sx, h: viewport[3] * sy,
                title: props?.attrs.descr || props?.attrs.name || '', border: false, drawingShape: true });
              continue;
            }
          }
        }
      }
    }
    for (const obj of charts) arrangeState(obj);
    if (charts.length) out.set(sheet.name, charts);
  }
  return out;
}

// cNvPr's own names for an object another program left unnamed (Chart 3, Text Box 2, Group 7): those are
// the Selection Pane's defaults, not names anyone gave.
const DEFAULT_NAME = /^[A-Za-z][A-Za-z ]*\s\d+$/;
/**
 * An object's Arrange state from its drawing: hidden (cNvPr@hidden, its group's too), a name someone gave it,
 * and, for a group that came apart into its objects, the group they belong to.
 */
function arrangeState(obj) {
  const identity = obj.xlsxDrawingIdentity;
  if (!identity) return;
  if (identity.hidden || identity.parentHidden) obj.hidden = true;
  if (identity.name && !DEFAULT_NAME.test(identity.name) && identity.name !== obj.title) obj.name = identity.name.slice(0, 255);
  if (identity.groupId) obj.group = identity.groupId;
}
