/**
 * Ink in DOCX. Strokes drawn on a page are saved as ordinary DrawingML so every reader shows them:
 * one floating `wpg:wgp` group per inking session, each stroke a `wps:wsp` whose `a:custGeom` path is
 * the stroke's filled outline (ECMA-376 Part 1 §20.1.9.15 path list, §20.4.2.3 anchor). Pens fill
 * the outline solid, pencils with a dotted pattern fill (§20.1.8.47), and highlighters with a
 * translucent solid colour (§20.1.2.3.1 alpha) in a group placed behind the text.
 *
 * So the editor can erase, select and convert strokes later, each stroke's non-visual properties carry
 * an extension (§20.1.2.2.15 extLst / §20.1.2.2.14 ext) in this app's own namespace holding its tool,
 * colour, nominal width and centre line. Readers that do not know the extension ignore it (an
 * extension list is the schema's own preservation mechanism), and it validates as lax content.
 *
 * A drawing canvas is an inline group of the same kind whose first child is a frame rectangle; ink
 * drawn inside it is added to the group, clipped to the frame.
 */
import { strokeOutline } from './ink-geometry.js';
import { drawingFrame, NS } from './inserted-drawings.js';
import { INK_EXTENSION_URI, INK_NS, readInkExtension } from './docx-ink-extension.js';

export { INK_EXTENSION_URI, INK_NS, readInkExtension };
export const INK_NAME = 'Ink';
export const CANVAS_NAME = 'Drawing Canvas';
export const EMU_PER_PX = 9525;
/** Path coordinates are written in sixteenths of a pixel, which keeps the numbers short. */
const PATH_UNITS = 16;
const HIGHLIGHTER_ALPHA = 50000, PENCIL_GRAIN_ALPHA = 35000;

const round = (v, digits = 2) => Number(v.toFixed(digits));
const hex = color => /^[0-9A-F]{6}$/i.test(color || '') ? color.toUpperCase() : '000000';

/** The fill that paints a stroke's outline for its tool. */
export function inkFillXml(tool, color) {
  const c = hex(color);
  if (tool === 'highlighter') return `<a:solidFill><a:srgbClr val="${c}"><a:alpha val="${HIGHLIGHTER_ALPHA}"/></a:srgbClr></a:solidFill>`;
  if (tool === 'pencil') return `<a:pattFill prst="pct75"><a:fgClr><a:srgbClr val="${c}"/></a:fgClr><a:bgClr><a:srgbClr val="${c}"><a:alpha val="${PENCIL_GRAIN_ALPHA}"/></a:srgbClr></a:bgClr></a:pattFill>`;
  return `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`;
}

/** The centre line as text: "x y p" triples in group EMU and pressure hundredths. */
const encodePoints = points => points.map(p => `${Math.round(p.x * EMU_PER_PX)} ${Math.round(p.y * EMU_PER_PX)} ${Math.round(Math.max(0, Math.min(1, p.p ?? 0.5)) * 100)}`).join(' ');
/**
 * One stroke as a `wps:wsp`. Stroke coordinates are pixels in the group's frame; `id` is the shape id.
 */
export function inkStrokeXml(stroke, id, index = 0) {
  const outline = strokeOutline(stroke);
  if (outline.length < 3) return '';
  const xs = outline.map(p => p.x), ys = outline.map(p => p.y);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(1 / PATH_UNITS, Math.max(...xs) - left), height = Math.max(1 / PATH_UNITS, Math.max(...ys) - top);
  const pw = Math.max(1, Math.round(width * PATH_UNITS)), ph = Math.max(1, Math.round(height * PATH_UNITS));
  const pt = p => `<a:pt x="${Math.round((p.x - left) * PATH_UNITS)}" y="${Math.round((p.y - top) * PATH_UNITS)}"/>`;
  const path = `<a:moveTo>${pt(outline[0])}</a:moveTo>${outline.slice(1).map(p => `<a:lnTo>${pt(p)}</a:lnTo>`).join('')}<a:close/>`;
  const data = `<pdi:stroke xmlns:pdi="${INK_NS}" tool="${stroke.tool}" color="${hex(stroke.color)}" width="${round(stroke.width)}" points="${encodePoints(stroke.points)}"/>`;
  return `<wps:wsp><wps:cNvPr id="${id}" name="Ink stroke ${index + 1}"><a:extLst><a:ext uri="${INK_EXTENSION_URI}">${data}</a:ext></a:extLst></wps:cNvPr><wps:cNvSpPr/>`
    + `<wps:spPr><a:xfrm><a:off x="${Math.round(left * EMU_PER_PX)}" y="${Math.round(top * EMU_PER_PX)}"/><a:ext cx="${Math.round(width * EMU_PER_PX)}" cy="${Math.round(height * EMU_PER_PX)}"/></a:xfrm>`
    + `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="${pw}" h="${ph}">${path}</a:path></a:pathLst></a:custGeom>`
    + `${inkFillXml(stroke.tool, stroke.color)}<a:ln><a:noFill/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>`;
}

/** A drawing canvas's frame: a rectangle marked as the canvas, outlined lightly so the region shows. */
function canvasFrameXml(width, height, id) {
  return `<wps:wsp><wps:cNvPr id="${id}" name="Canvas frame"><a:extLst><a:ext uri="${INK_EXTENSION_URI}"><pdi:canvas xmlns:pdi="${INK_NS}"/></a:ext></a:extLst></wps:cNvPr><wps:cNvSpPr/>`
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width * EMU_PER_PX)}" cy="${Math.round(height * EMU_PER_PX)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>`
    + `<a:ln w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>`;
}

/**
 * The `wpg:wgp` for strokes in a frame `width` × `height` pixels (stroke points relative to the frame).
 * With `canvas`, the group is a drawing canvas and its frame rectangle comes first.
 */
export function inkGroupXml({ strokes, width, height, baseId = 1, canvas = false }) {
  const cx = Math.max(1, Math.round(width * EMU_PER_PX)), cy = Math.max(1, Math.round(height * EMU_PER_PX));
  let id = baseId;
  const shapes = [...(canvas ? [canvasFrameXml(width, height, id++)] : []), ...strokes.map((stroke, i) => inkStrokeXml(stroke, id++, i))].join('');
  return `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="0" y="0"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></wpg:grpSpPr>${shapes}</wpg:wgp>`;
}

/**
 * The whole `w:drawing` for an ink group: floating with `anchor` (the editor's anchor object) or
 * inline. Strokes are relative to the frame's top-left corner.
 */
export function inkDrawingXml({ id, strokes, width, height, anchor = null, canvas = false, name = null }) {
  const group = inkGroupXml({ strokes, width, height, canvas, baseId: 1000 * id + 1 });
  const graphic = `<a:graphic><a:graphicData uri="${NS.wpg}">${group}</a:graphicData></a:graphic>`;
  const label = name || `${canvas ? CANVAS_NAME : INK_NAME} ${id}`;
  return drawingFrame({ id, name: label, descr: canvas ? 'Drawing canvas' : strokes.some(s => s.tool !== 'highlighter') ? 'Handwritten ink' : 'Highlighter ink', width: Math.round(width * EMU_PER_PX), height: Math.round(height * EMU_PER_PX), anchor, graphic });
}

const child = (n, ns, name) => [...(n?.children || [])].find(c => c.namespaceURI === ns && c.localName === name);
const int = (n, name) => Number(n?.getAttribute(name) || 0);

/**
 * Read an ink drawing (a group of marked strokes, or a drawing canvas) from a drawing's XML shell.
 * Returns { canvas, width, height, strokes } with strokes in pixels relative to the group frame,
 * or null when the drawing is not ink this editor can edit (unmarked children, rotation, flips).
 */
export function readInkDrawing(shell) {
  if (typeof shell !== 'string' || !shell.includes(INK_EXTENSION_URI)) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(shell, 'application/xml'); } catch { return null; }
  if (doc.getElementsByTagName('parsererror').length) return null;
  const groups = doc.getElementsByTagNameNS(NS.wpg, 'wgp');
  if (groups.length !== 1) return null;
  const group = groups[0], xfrm = child(child(group, NS.wpg, 'grpSpPr'), NS.a, 'xfrm');
  if (!xfrm || ['rot', 'flipH', 'flipV'].some(a => xfrm.hasAttribute(a) && !['0', 'false'].includes(xfrm.getAttribute(a)))) return null;
  const ext = child(xfrm, NS.a, 'ext'), chOff = child(xfrm, NS.a, 'chOff'), chExt = child(xfrm, NS.a, 'chExt');
  const cx = int(ext, 'cx'), cy = int(ext, 'cy'), ccx = int(chExt, 'cx') || cx, ccy = int(chExt, 'cy') || cy;
  if (!cx || !cy) return null;
  const sx = cx / ccx, sy = cy / ccy, ox = int(chOff, 'x'), oy = int(chOff, 'y');
  let canvas = false; const strokes = [];
  for (const shape of group.children) {
    if (shape.namespaceURI === NS.wpg && shape.localName === 'cNvGrpSpPr' || shape.localName === 'grpSpPr' || shape.localName === 'cNvPr') continue;
    if (shape.namespaceURI !== NS.wps || shape.localName !== 'wsp') return null;
    const ext = [...(child(child(shape, NS.wps, 'cNvPr'), NS.a, 'extLst')?.children || [])].find(e => e.getAttribute('uri')?.toUpperCase() === INK_EXTENSION_URI);
    if (!ext) return null;
    let data;
    try { data = readInkExtension(ext); } catch { return null; }
    if (data.canvas) { canvas = true; continue; }
    strokes.push({ ...data.stroke, points: data.stroke.points.map(p => ({ x: (p.x * EMU_PER_PX - ox) * sx / EMU_PER_PX, y: (p.y * EMU_PER_PX - oy) * sy / EMU_PER_PX, p: p.p })) });
  }
  return { canvas, width: cx / EMU_PER_PX, height: cy / EMU_PER_PX, strokes };
}

/** Whether an image of the editor model is an ink drawing (floating ink or a drawing canvas). */
export const isInkImage = image => !!image?.retainedDrawing && typeof image.shell === 'string' && image.shell.includes(INK_EXTENSION_URI) && !!readInkDrawingCached(image.shell);

const cache = new Map();
/** readInkDrawing, remembered by shell text (shells are immutable). */
export function readInkDrawingCached(shell) {
  if (cache.has(shell)) return cache.get(shell);
  const result = readInkDrawing(shell);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  cache.set(shell, result);
  return result;
}

