/**
 * Ink to Shape output: a recognised stroke (see ink-recognizer.js) as an ordinary DrawingML shape —
 * a preset line, arrow, rectangle, oval or triangle (ECMA-376 Part 1 §20.1.9.18 prstGeom), or a
 * three-point custom path for a triangle no preset fits — outlined in the pen's colour and width
 * with no fill, so it edits like any shape from Insert → Shapes.
 */
import { drawingFrame, NS } from './inserted-drawings.js';

const EMU = 9525;
const round = v => Math.round(v);

/** The frame of a recognised shape in page pixels: { left, top, width, height }. */
export function recognizedBounds(shape) {
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const left = Math.min(shape.from.x, shape.to.x), top = Math.min(shape.from.y, shape.to.y);
    return { left, top, width: Math.abs(shape.to.x - shape.from.x), height: Math.abs(shape.to.y - shape.from.y), right: left + Math.abs(shape.to.x - shape.from.x), bottom: top + Math.abs(shape.to.y - shape.from.y) };
  }
  if (shape.kind === 'triangle') {
    const xs = shape.vertices.map(p => p.x), ys = shape.vertices.map(p => p.y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  return { left: shape.cx - shape.width / 2, top: shape.cy - shape.height / 2, width: shape.width, height: shape.height, right: shape.cx + shape.width / 2, bottom: shape.cy + shape.height / 2 };
}

/** How a triangle is written: an isosceles or right-angled preset (with flips), or a custom path. */
export function triangleGeometry(vertices) {
  const b = recognizedBounds({ kind: 'triangle', vertices });
  const tolX = Math.max(3, b.width * 0.14), tolY = Math.max(3, b.height * 0.14);
  for (let i = 0; i < 3; i++) {
    const apex = vertices[i], [p, q] = vertices.filter((_, j) => j !== i);
    // A horizontal base with the apex over its middle.
    if (Math.abs(p.y - q.y) < tolY && Math.abs(apex.x - (p.x + q.x) / 2) < tolX) return { preset: 'triangle', flipV: apex.y > p.y };
  }
  for (let i = 0; i < 3; i++) {
    const corner = vertices[i], others = vertices.filter((_, j) => j !== i);
    const vertical = others.find(p => Math.abs(p.x - corner.x) < tolX), horizontal = others.find(p => p !== vertical && Math.abs(p.y - corner.y) < tolY);
    // The preset's right angle is at the lower left; flips move it to the corner drawn.
    if (vertical && horizontal) return { preset: 'rtTriangle', flipH: horizontal.x < corner.x, flipV: vertical.y > corner.y };
  }
  return { custom: vertices.map(p => ({ x: p.x - b.left, y: p.y - b.top })) };
}

/**
 * The `w:drawing` for a recognised shape with an anchor (the editor's anchor object, whose offsets
 * give the frame's position), outlined in `color` at `widthPx`.
 */
export function recognizedShapeXml(shape, { id, anchor, color = '000000', widthPx = 2 }) {
  const b = recognizedBounds(shape), cx = round(b.width * EMU), cy = round(b.height * EMU);
  const arrow = shape.kind === 'arrow', line = arrow || shape.kind === 'line';
  let preset = { rect: 'rect', ellipse: 'ellipse' }[shape.kind] || (line ? 'line' : null), flipH = false, flipV = false, rotation = 0, custom = null;
  if (line) { flipH = shape.to.x < shape.from.x; flipV = shape.to.y < shape.from.y; }
  if (shape.kind === 'triangle') { const t = triangleGeometry(shape.vertices); preset = t.preset || null; flipH = !!t.flipH; flipV = !!t.flipV; custom = t.custom || null; }
  if (shape.angle) rotation = ((round(shape.angle * 180 / Math.PI * 60000) % 21600000) + 21600000) % 21600000;
  const xfrm = `<a:xfrm${rotation ? ` rot="${rotation}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const geometry = custom
    ? `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="${Math.max(1, cx)}" h="${Math.max(1, cy)}"><a:moveTo><a:pt x="${round(custom[0].x * EMU)}" y="${round(custom[0].y * EMU)}"/></a:moveTo>${custom.slice(1).map(p => `<a:lnTo><a:pt x="${round(p.x * EMU)}" y="${round(p.y * EMU)}"/></a:lnTo>`).join('')}<a:close/></a:path></a:pathLst></a:custGeom>`
    : `<a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>`;
  const outline = `<a:ln w="${Math.max(3175, round(widthPx * EMU))}" cap="rnd"><a:solidFill><a:srgbClr val="${/^[0-9A-F]{6}$/i.test(color) ? color.toUpperCase() : '000000'}"/></a:solidFill><a:round/>${arrow ? '<a:tailEnd type="triangle"/>' : ''}</a:ln>`;
  const names = { line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Oval', triangle: 'Triangle' };
  const graphic = `<a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp><wps:cNvSpPr/><wps:spPr>${xfrm}${geometry}${line ? '' : '<a:noFill/>'}${outline}</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>`;
  return { bounds: b, xml: drawingFrame({ id, name: `${names[shape.kind]} ${id}`, descr: `${names[shape.kind]} drawn from ink`, width: cx, height: cy, anchor, graphic }) };
}
