/**
 * PDF export: a small hand-written PDF 1.7 writer.
 *
 * One page per artboard (MediaBox = artboard, optionally grown by a bleed
 * with TrimBox/BleedBox). Page content is drawn in document coordinates
 * under a flipping base matrix, so geometry is written exactly as stored.
 *
 * - Paths: fill/stroke with joins, caps, miter limit and dashes; compound
 *   paths keep their fill rule; inside/outside strokes use a clip.
 * - Colors: DeviceRGB; opacity and blend modes via ExtGState; groups and
 *   layers with opacity or blending become transparency-group form XObjects.
 * - Gradients: axial/radial shadings with stitching functions (fills paint
 *   the shading inside a clip; strokes use a shading pattern). Stop opacity
 *   is approximated by the average stop opacity.
 * - Freeform gradients: fills draw the blend as an image inside the shape
 *   (turned with the object); strokes and type use the average color.
 * - Opacity masks: a luminosity soft mask (SMask) made from the mask art,
 *   applied to the object drawn as a transparency group.
 * - Clip groups: the clipping path as a clip (W / W*).
 * - Images: JPEG passthrough (DCTDecode), anything else as Flate RGB with
 *   an SMask for alpha.
 * - Text: outlines from the type module when available, otherwise the
 *   standard Helvetica family (WinAnsi) as a fallback.
 * - Streams are FlateDecode-compressed with CompressionStream when present.
 * Live effects (shadows, blurs) are not representable as vectors: objects
 * with them are rasterized at the raster effects resolution (shadows and
 * glows go under the vector object), and failures are reported in `warnings`.
 */
import { gradientGeometry, nodeBounds, visualBounds, rectsIntersect, inflate } from '../../model/geometry.js';
import { textPieces, decoRects } from './text-segments.js';
import { segmentCount, segmentPoints, isLine } from '../../model/bezier.js';
import { hexToRgb } from '../../lib/color.js';
import { dataUrlToBytes, sniffMime, jpegInfo } from './image-info.js';
import { nodeArrowOutlines, strokedAnchors, effectiveDash, outlineSubpaths } from './outlines.js';
import { expandStops, focalPoint } from '../../model/gradients.js';
import { rasterEffects } from '../../render/effects.js';
import { renderRegion } from './raster.js';
import { multiply } from '../../lib/matrix.js';
import { renderSubpaths, isElliptical, radialFrame } from './geometry-helpers.js';
import { exportView } from './export-view.js';
import { exportWriters } from './hooks.js';
import { averageColor, freeformFrame, frameFractionMatrix, freeformPixels } from '../paint/freeform.js';



/** PDF number: fixed decimals, no exponent, trailing zeros removed. */
export function pdfNum(v, digits = 4) {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Literal string for Latin-1 text, or a UTF-16BE hex string otherwise. */
export function pdfText(s) {
  const str = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

// WinAnsi code points for the 0x80-0x9f range.
const WIN_ANSI_EXTRA = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };

/** Text for a WinAnsi-encoded Type 1 font as a literal string (unmappable characters become '?'). */
function winAnsiString(s) {
  let out = '(';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    let code = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : WIN_ANSI_EXTRA[cp] ?? 0x3f;
    if (code < 0x20) code = 0x20;
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** zlib (RFC 1950) compression for FlateDecode, or null when the platform lacks CompressionStream. */
export async function deflate(bytes, format = 'deflate') {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream(format);
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch {
    return null;
  }
}

/** Low-level object writer with a cross-reference table. */
export class PDFWriter {
  constructor({ compress = true } = {}) {
    this.objects = [null]; // 1-based
    this.compress = compress;
  }

  alloc() {
    this.objects.push(null);
    return this.objects.length - 1;
  }

  /** Store a dictionary/array/number object (string). */
  set(id, body) {
    this.objects[id] = { body };
    return id;
  }

  add(body) {
    return this.set(this.alloc(), body);
  }

  /** Store a stream object; `dict` is the dictionary body without << >> or /Length. */
  setStream(id, dict, data, { compress = this.compress, filter = null } = {}) {
    this.objects[id] = { dict, data: typeof data === 'string' ? latin1(data) : data, compress: compress && !filter, filter };
    return id;
  }

  addStream(dict, data, opts) {
    return this.setStream(this.alloc(), dict, data, opts);
  }

  async build({ root, info }) {
    const chunks = [];
    let offset = 0;
    const push = (b) => {
      const bytes = typeof b === 'string' ? latin1(b) : b;
      chunks.push(bytes);
      offset += bytes.length;
    };
    push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const offsets = [0];
    for (let id = 1; id < this.objects.length; id++) {
      const o = this.objects[id] || { body: 'null' };
      offsets[id] = offset;
      if (o.data) {
        let data = o.data;
        let filter = o.filter;
        if (o.compress && data.length > 64) {
          const z = await deflate(data);
          if (z && z.length < data.length) {
            data = z;
            filter = '/FlateDecode';
          }
        }
        push(`${id} 0 obj\n<<${o.dict ? ` ${o.dict}` : ''}${filter ? ` /Filter ${filter}` : ''} /Length ${data.length} >>\nstream\n`);
        push(data);
        push('\nendstream\nendobj\n');
      } else push(`${id} 0 obj\n${o.body}\nendobj\n`);
    }
    const xref = offset;
    let table = `xref\n0 ${this.objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < this.objects.length; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${this.objects.length} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
    return concat(chunks);
  }
}

const BLEND_PDF = {
  multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', colorDodge: 'ColorDodge',
  colorBurn: 'ColorBurn', hardLight: 'HardLight', softLight: 'SoftLight', difference: 'Difference', exclusion: 'Exclusion',
  hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2 };

function rgbOps(hex, op) {
  const { r, g, b } = hexToRgb(hex);
  return `${pdfNum(r / 255, 4)} ${pdfNum(g / 255, 4)} ${pdfNum(b / 255, 4)} ${op}`;
}

/** Resources of one content stream (page or form). */
class Resources {
  constructor() {
    this.ext = new Map();
    this.pattern = new Map();
    this.shading = new Map();
    this.xobject = new Map();
    this.font = new Map();
  }

  name(map, prefix, objId) {
    for (const [name, id] of map) if (id === objId) return name;
    const name = `${prefix}${map.size + 1}`;
    map.set(name, objId);
    return name;
  }

  dict() {
    const part = (key, map) => (map.size ? ` /${key} << ${[...map].map(([n, id]) => `/${n} ${id} 0 R`).join(' ')} >>` : '');
    return `<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]${part('ExtGState', this.ext)}${part('Pattern', this.pattern)}${part('Shading', this.shading)}${part('XObject', this.xobject)}${part('Font', this.font)} >>`;
  }
}

class PDFRenderer {
  constructor(doc, writer, opts) {
    this.doc = doc;
    this.w = writer;
    this.opts = opts;
    this.warnings = new Set();
    this.gsCache = new Map();
    this.shadingCache = new Map();
    this.imageCache = new Map();
    this.fontCache = new Map();
  }

  f(v) {
    return pdfNum(v);
  }

  // ---- shared objects ----

  /** `node` sets overprint (Attributes panel): op for its fill, OP for its stroke. */
  extGState(fillAlpha, strokeAlpha, blend, node = null) {
    const ca = Math.max(0, Math.min(1, fillAlpha));
    const CA = Math.max(0, Math.min(1, strokeAlpha));
    const bm = BLEND_PDF[blend] || null;
    const op = Boolean(node?.overprintFill);
    const OP = Boolean(node?.overprintStroke);
    if (ca >= 1 && CA >= 1 && !bm && !op && !OP) return null;
    const key = `${pdfNum(ca, 3)}|${pdfNum(CA, 3)}|${bm}|${op}|${OP}`;
    let id = this.gsCache.get(key);
    if (!id) {
      const over = op || OP ? ` /op ${op} /OP ${OP} /OPM 1` : '';
      id = this.w.add(`<< /Type /ExtGState /ca ${pdfNum(ca, 3)} /CA ${pdfNum(CA, 3)}${bm ? ` /BM /${bm}` : ''}${over} >>`);
      this.gsCache.set(key, id);
    }
    return id;
  }

  /** Function object for gradient stops (exponential or stitching). */
  stopFunction(stops) {
    const s = [...stops].sort((a, b) => a.offset - b.offset).map((x) => ({ ...x, offset: Math.max(0, Math.min(1, x.offset)) }));
    if (s[0].offset > 0) s.unshift({ ...s[0], offset: 0 });
    if (s[s.length - 1].offset < 1) s.push({ ...s[s.length - 1], offset: 1 });
    for (let i = 1; i < s.length; i++) if (s[i].offset <= s[i - 1].offset) s[i].offset = Math.min(1, s[i - 1].offset + 1e-4);
    const col = (hex) => {
      const { r, g, b } = hexToRgb(hex);
      return `[${pdfNum(r / 255)} ${pdfNum(g / 255)} ${pdfNum(b / 255)}]`;
    };
    const fns = [];
    for (let i = 0; i + 1 < s.length; i++) fns.push(`<< /FunctionType 2 /Domain [0 1] /C0 ${col(s[i].color)} /C1 ${col(s[i + 1].color)} /N 1 >>`);
    if (fns.length === 1) return fns[0];
    const bounds = s.slice(1, -1).map((x) => pdfNum(x.offset, 5));
    return `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${fns.map(() => '0 1').join(' ')}] >>`;
  }

  /**
   * Shading object for a gradient paint: { id, frame }. Elliptical radial
   * gradients are defined around the origin and placed by `frame` (a
   * matrix to concatenate before painting), like the canvas renderer.
   */
  shadingFor(paint, node) {
    const b = nodeBounds(this.doc, node) || { x: 0, y: 0, w: 1, h: 1 };
    const g = gradientGeometry(paint, b);
    // Midpoints become extra stops: PDF functions interpolate linearly.
    const fn = this.stopFunction(expandStops(paint.stops));
    let frame = null;
    let coords;
    if (paint.type === 'radial' && isElliptical(paint)) {
      const f = radialFrame(paint, b);
      const c = Math.cos(f.angle);
      const sn = Math.sin(f.angle);
      frame = [c, sn, -sn * f.aspect, c * f.aspect, f.cx, f.cy];
      const [fu, fv] = paint.focal || [0, 0];
      coords = `[${this.f(fu * f.r)} ${this.f(fv * f.r)} ${this.f((paint.focalRadius || 0) * f.r)} 0 0 ${this.f(f.r)}]`;
    } else if (paint.type === 'radial') {
      // The start circle is the focal point (radius 0 unless set), the end circle the gradient's.
      const fo = focalPoint(paint, g, 1);
      coords = `[${this.f(g.x1 + fo.x)} ${this.f(g.y1 + fo.y)} ${this.f(fo.r)} ${this.f(g.x1)} ${this.f(g.y1)} ${this.f(Math.max(g.r, 1e-4))}]`;
    } else coords = `[${this.f(g.x1)} ${this.f(g.y1)} ${this.f(g.x2)} ${this.f(g.y2)}]`;
    const body = `<< /ShadingType ${paint.type === 'radial' ? 3 : 2} /ColorSpace /DeviceRGB /Coords ${coords} /Function ${fn} /Extend [true true] >>`;
    let id = this.shadingCache.get(body);
    if (!id) {
      id = this.w.add(body);
      this.shadingCache.set(body, id);
    }
    return { id, frame };
  }

  /** Paint a gradient inside the current clip. */
  shadeOps(res, paint, node) {
    const sh = this.shadingFor(paint, node);
    return `${sh.frame ? `${sh.frame.map((v) => this.f(v)).join(' ')} cm\n` : ''}/${res.name(res.shading, 'Sh', sh.id)} sh\n`;
  }

  gradientAlpha(paint) {
    const ops = paint.stops.map((s) => s.opacity ?? 1);
    return ops.reduce((a, b) => a + b, 0) / Math.max(1, ops.length);
  }

  paintAlpha(paint) {
    if (!paint) return 1;
    if (paint.type === 'solid') return paint.opacity ?? 1;
    // A freeform fill carries its alpha in the image.
    if (paint.type === 'freeform') return 1;
    return this.gradientAlpha(paint);
  }

  /** A freeform gradient over a node's frame as an image XObject and its placement matrix (cached per paint). */
  freeformImage(paint, node) {
    const f = freeformFrame(this.doc, node);
    if (!f) return null;
    this.freeformCache ||= new WeakMap();
    let id = this.freeformCache.get(paint)?.[`${(f.w / f.h).toFixed(4)}`];
    if (!id) {
      const k = Math.sqrt(f.w / f.h);
      const w = Math.max(8, Math.round(256 * Math.min(1, k)));
      const h = Math.max(8, Math.round(256 * Math.min(1, 1 / k)));
      id = this.pixelsXObject({ width: w, height: h, data: freeformPixels(paint, w, h, f.w / f.h) });
      this.freeformCache.set(paint, { ...this.freeformCache.get(paint), [`${(f.w / f.h).toFixed(4)}`]: id });
    }
    // Image space is the unit square with its first row at the top: flip it into the frame.
    return { id, m: multiply(frameFractionMatrix(f), [1, 0, 0, -1, 0, 1]) };
  }

  helvetica(char) {
    const bold = (char.fontWeight || 400) >= 600;
    const italic = char.fontStyle === 'italic';
    const base = `Helvetica${bold || italic ? '-' : ''}${bold ? 'Bold' : ''}${italic ? 'Oblique' : ''}`;
    let id = this.fontCache.get(base);
    if (!id) {
      id = this.w.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
      this.fontCache.set(base, id);
    }
    return id;
  }

  /** Image XObject for an asset (cached per asset). */
  imageXObject(assetId) {
    let p = this.imageCache.get(assetId);
    if (!p) {
      p = this.encodeImage(assetId).catch(() => null);
      this.imageCache.set(assetId, p);
    }
    return p;
  }

  async encodeImage(assetId) {
    const asset = this.doc.assets.get(assetId);
    if (!asset?.data) return null;
    const info = asset.data.startsWith('data:') ? dataUrlToBytes(asset.data) : null;
    if (info && sniffMime(info.bytes) === 'image/jpeg') {
      const j = jpegInfo(info.bytes);
      if (j && (j.components === 1 || j.components === 3)) {
        return this.w.addStream(`/Type /XObject /Subtype /Image /Width ${j.width} /Height ${j.height} /ColorSpace /${j.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8`, info.bytes, { filter: '/DCTDecode' });
      }
    }
    const px = await decodePixels(asset);
    if (!px) {
      this.warnings.add('Some images could not be decoded and were left out.');
      return null;
    }
    return this.pixelsXObject(px);
  }

  /** Image XObject (with a soft mask when needed) from RGBA pixels. */
  pixelsXObject({ width, height, data }) {
    const rgb = new Uint8Array(width * height * 3);
    const alpha = new Uint8Array(width * height);
    let hasAlpha = false;
    for (let i = 0, j = 0, k = 0; i < data.length; i += 4, j += 3, k++) {
      const a = data[i + 3];
      // Canvas pixels are unpremultiplied already; keep color as is.
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
      alpha[k] = a;
      if (a < 255) hasAlpha = true;
    }
    let smask = '';
    if (hasAlpha) {
      const sid = this.w.addStream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha);
      smask = ` /SMask ${sid} 0 R`;
    }
    return this.w.addStream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8${smask}`, rgb);
  }

  // ---- geometry ----

  pathOps(subpaths) {
    const f = (v) => this.f(v);
    let out = '';
    for (const sp of subpaths) {
      const a = sp.anchors;
      if (!a.length) continue;
      out += `${f(a[0].x)} ${f(a[0].y)} m\n`;
      const n = segmentCount(a, sp.closed);
      for (let i = 0; i < n; i++) {
        const c = segmentPoints(a, i);
        if (isLine(c)) {
          if (!(sp.closed && i === n - 1)) out += `${f(c[6])} ${f(c[7])} l\n`;
        } else out += `${f(c[2])} ${f(c[3])} ${f(c[4])} ${f(c[5])} ${f(c[6])} ${f(c[7])} c\n`;
      }
      if (sp.closed) out += 'h\n';
    }
    return out;
  }

  subpathsOf(node) {
    return renderSubpaths(this.doc, node);
  }

  strokeState(node, widthScale = 1) {
    let s = `${this.f(node.strokeWidth * widthScale)} w ${CAP[node.strokeCap] ?? 0} J ${JOIN[node.strokeJoin] ?? 0} j ${this.f(Math.max(1, node.miterLimit ?? 10))} M\n`;
    const dash = effectiveDash(node);
    if (dash) s += `[${dash.dash.map((d) => this.f(d)).join(' ')}] ${this.f(dash.offset || 0)} d\n`;
    else s += '[] 0 d\n';
    return s;
  }

  /** Draw fill and stroke of a shape-like geometry with a node's paint. */
  paintGeometry(ctx, node, subpaths, { evenOdd = false, fill = node.fill, stroke = node.strokeWidth > 0 ? node.stroke : null, strokeAlign = 'center', arrows = [], strokeSubpaths = null } = {}) {
    const res = ctx.res;
    const path = this.pathOps(subpaths);
    if (!path) return;
    // A stroke cannot clip an image: freeform strokes take their average color.
    if (stroke?.type === 'freeform') stroke = { type: 'solid', color: averageColor(stroke) };
    const op = node.opacity ?? 1;
    const fa = op * this.paintAlpha(fill);
    const sa = op * this.paintAlpha(stroke);
    let out = 'q\n';
    const gs = this.extGState(fill ? fa : 1, stroke ? sa : 1, node.blendMode, node);
    if (gs) out += `/${res.name(res.ext, 'GS', gs)} gs\n`;
    const W = evenOdd ? 'W*' : 'W';
    const doFill = () => {
      if (!fill) return '';
      if (fill.type === 'solid') return `${rgbOps(fill.color, 'rg')}\n${path}${evenOdd ? 'f*' : 'f'}\n`;
      if (fill.type === 'freeform') {
        const img = this.freeformImage(fill, node);
        if (!img) return `${rgbOps(averageColor(fill), 'rg')}\n${path}${evenOdd ? 'f*' : 'f'}\n`;
        return `q\n${path}${W} n\n${img.m.map((v) => this.f(v)).join(' ')} cm\n/${res.name(res.xobject, 'Im', img.id)} Do\nQ\n`;
      }
      return `q\n${path}${W} n\n${this.shadeOps(res, fill, node)}Q\n`;
    };
    const strokeColor = () => {
      if (stroke.type === 'solid') return `${rgbOps(stroke.color, 'RG')}\n`;
      const sh = this.shadingFor(stroke, node);
      const m = sh.frame ? multiply(ctx.patternBase, sh.frame) : ctx.patternBase;
      const pat = this.w.add(`<< /Type /Pattern /PatternType 2 /Shading ${sh.id} 0 R /Matrix [${m.map((v) => this.f(v)).join(' ')}] >>`);
      return `/Pattern CS /${res.name(res.pattern, 'P', pat)} SCN\n`;
    };
    const strokePath = strokeSubpaths ? this.pathOps(strokeSubpaths) : path;
    const doStroke = (scale = 1) => (stroke ? `${this.strokeState(node, scale)}${strokeColor()}${strokePath}S\n` : '');
    const closedShape = subpaths.every((s) => s.closed);
    if (stroke && strokeAlign !== 'center' && closedShape) {
      out += doFill();
      if (strokeAlign === 'inside') out += `q\n${path}${W} n\n${doStroke(2)}Q\n`;
      else {
        const vb = inflate(nodeBounds(this.doc, node) || { x: 0, y: 0, w: 0, h: 0 }, node.strokeWidth * 4 + 10);
        out += `q\n${this.f(vb.x)} ${this.f(vb.y)} ${this.f(vb.w)} ${this.f(vb.h)} re\n${path}W* n\n${doStroke(2)}Q\n`;
      }
    } else if (fill?.type === 'solid' && stroke?.type === 'solid' && !strokeSubpaths) {
      out += `${rgbOps(fill.color, 'rg')}\n${this.strokeState(node)}${rgbOps(stroke.color, 'RG')}\n${path}${evenOdd ? 'B*' : 'B'}\n`;
    } else {
      out += doFill();
      out += doStroke();
    }
    if (arrows.length && stroke) {
      const ap = this.pathOps(arrows);
      if (stroke.type === 'solid') out += `${rgbOps(stroke.color, 'rg')}\n${ap}f\n`;
      else out += `q\n${ap}W n\n${this.shadeOps(res, stroke, node)}Q\n`;
    }
    out += 'Q\n';
    ctx.ops.push(out);
  }

  // ---- nodes ----

  visible(node, ctx) {
    if (!node || node.hidden) return false;
    const vb = visualBounds(this.doc, node);
    return Boolean(vb && rectsIntersect(vb, ctx.cull));
  }

  async node(ctx, node) {
    if (!this.visible(node, ctx)) return;
    if (node.url && /^(https?:|mailto:)/i.test(node.url)) {
      const b = nodeBounds(this.doc, node);
      if (b) ctx.links.push({ b, url: node.url });
    }
    if (node.opacityMask && !node.opacityMask.disabled && node.opacityMask.art) {
      await this.masked(ctx, node);
      return;
    }
    const fx = rasterEffects(node);
    if (fx) {
      // Shadows and outer glows sit behind the object, which stays vector on top; other effects change the object itself.
      const behind = fx.every((e) => e.type === 'dropShadow' || e.type === 'outerGlow') && (node.opacity ?? 1) >= 1 && (!node.blendMode || node.blendMode === 'normal');
      const placed = await this.rasterized(ctx, node, { effectsOnly: behind });
      if (!placed) this.warnings.add('Effects such as shadows and blurs could not be included in the PDF.');
      else if (!behind) return;
    }
    switch (node.type) {
      case 'path':
      case 'compound': {
        const stroked = node.stroke && node.strokeWidth > 0;
        const arrows = stroked ? nodeArrowOutlines(node) : [];
        const trimmed = stroked ? strokedAnchors(node) : null;
        this.paintGeometry(ctx, node, this.subpathsOf(node), { evenOdd: node.fillRule === 'evenodd', strokeAlign: node.strokeAlign || 'center', arrows, strokeSubpaths: trimmed ? [{ anchors: trimmed, closed: false }] : null });
        break;
      }
      case 'text':
        this.text(ctx, node);
        break;
      case 'image':
        await this.image(ctx, node);
        break;
      case 'group':
      case 'layer':
        await this.group(ctx, node);
        break;
      default:
        await exportWriters.pdf.get(node.type)?.(this, ctx, node);
        break;
    }
  }

  text(ctx, node) {
    const runs = this.opts.outlines?.get(node.id);
    if (runs?.length) {
      for (const r of runs) this.paintGeometry(ctx, { ...node, fill: r.fill, stroke: r.stroke, strokeWidth: r.strokeWidth }, r.subpaths, { fill: r.fill, stroke: r.strokeWidth > 0 ? r.stroke : null });
      return;
    }
    if (this.opts.outlinesWanted) this.warnings.add('Text was written with a standard font because outlines are not available.');
    const res = ctx.res;
    const { mode, items } = textPieces(node);
    if (!items.length) return;
    const solid = (p) => (p ? (p.type === 'solid' ? p.color : p.type === 'freeform' ? averageColor(p) : [...(p.stops || [])].sort((a, b) => a.offset - b.offset)[0]?.color || '#000000') : null);
    const op = node.opacity ?? 1;
    const m = node.transform;
    let out = `q\n${m.map((v) => this.f(v)).join(' ')} cm\n`;
    for (const it of items) {
      const st = it.style;
      const fill = st.fill === undefined ? node.fill : st.fill;
      const sw = st.strokeWidth ?? node.strokeWidth;
      const stroke = sw > 0 ? (st.stroke === undefined ? node.stroke : st.stroke) : null;
      if (!fill && !stroke) continue;
      const gs = this.extGState(op * this.paintAlpha(fill), op * this.paintAlpha(stroke), node.blendMode, node);
      out += 'q\n';
      if (gs) out += `/${res.name(res.ext, 'GS', gs)} gs\n`;
      if (fill) out += `${rgbOps(solid(fill), 'rg')}\n`;
      if (stroke) out += `${rgbOps(solid(stroke), 'RG')}\n${this.f(sw)} w\n`;
      // Glyph pieces carry their own matrix; segments are placed with the text matrix.
      if (mode === 'glyphs') out += `${it.m.map((v) => this.f(v)).join(' ')} cm\n`;
      const hs = mode === 'segments' ? it.hs : 1;
      const vs = mode === 'segments' ? it.vs : 1;
      const x = mode === 'segments' ? it.x : 0;
      const y = mode === 'segments' ? it.y : 0;
      if (it.str) {
        const font = res.name(res.font, 'F', this.helvetica(st));
        const tc = mode === 'segments' && it.track ? it.track / hs : 0;
        out += `BT\n/${font} ${this.f(it.size)} Tf\n${fill && stroke ? 2 : stroke ? 1 : 0} Tr\n${tc ? `${this.f(tc)} Tc\n` : ''}${this.f(hs)} 0 0 ${this.f(-vs)} ${this.f(x)} ${this.f(y)} Tm\n${winAnsiString(it.str)} Tj\nET\n`;
      }
      if (fill) for (const [rx, ry, rw, rh] of decoRects(st, it.size, it.deco)) out += `${this.f(rx)} ${this.f(ry)} ${this.f(rw)} ${this.f(rh)} re f\n`;
      out += 'Q\n';
    }
    out += 'Q\n';
    ctx.ops.push(out);
  }

  /**
   * Rasterize an object with live effects at the document's raster effects
   * resolution (at least 150 ppi) and place it as an image, like flattening
   * for print. Returns false when it cannot be rendered here.
   */
  async rasterized(ctx, node, { effectsOnly = false } = {}) {
    const vb = visualBounds(this.doc, node);
    if (!vb) return false;
    const x0 = Math.max(vb.x, ctx.cull.x);
    const y0 = Math.max(vb.y, ctx.cull.y);
    const x1 = Math.min(vb.x + vb.w, ctx.cull.x + ctx.cull.w);
    const y1 = Math.min(vb.y + vb.h, ctx.cull.y + ctx.cull.h);
    if (!(x1 > x0 && y1 > y0)) return true;
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    let scale = Math.max(150, this.doc.root.rasterResolution || 0) / 72;
    scale = Math.min(scale, 4096 / Math.max(rect.w, rect.h));
    const pixels = async (doc) => {
      const canvas = await renderRegion(doc, rect, { scale, ids: [node.id] });
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return data && data.length === canvas.width * canvas.height * 4 ? { width: canvas.width, height: canvas.height, data } : null;
    };
    let px;
    try {
      px = await pixels(this.doc);
      if (!px) return false;
      if (effectsOnly) {
        // The effect alone: the render with effects minus the object drawn over it.
        const plain = { ...node, effects: [] };
        const base = this.doc;
        const objPx = await pixels({ get: (id) => (id === node.id ? plain : base.get(id)), has: (id) => base.has(id), assets: base.assets, root: base.root, name: base.name, artboards: base.artboards, walk: (fn) => base.walk(fn) });
        if (!objPx || objPx.data.length !== px.data.length) return false;
        px = { ...px, data: subtractOver(px.data, objPx.data) };
      }
    } catch {
      return false;
    }
    const id = this.pixelsXObject(px);
    ctx.ops.push(`q\n${this.f(rect.w)} 0 0 ${this.f(-rect.h)} ${this.f(rect.x)} ${this.f(rect.y + rect.h)} cm\n/${ctx.res.name(ctx.res.xobject, 'Im', id)} Do\nQ\n`);
    return true;
  }

  async image(ctx, node) {
    const id = await this.imageXObject(node.asset);
    if (!id) return;
    const res = ctx.res;
    const m = node.transform;
    let out = `q\n${m.map((v) => this.f(v)).join(' ')} cm\n`;
    const gs = this.extGState(node.opacity ?? 1, 1, node.blendMode);
    if (gs) out += `/${res.name(res.ext, 'GS', gs)} gs\n`;
    out += `${this.f(node.width)} 0 0 ${this.f(-node.height)} 0 ${this.f(node.height)} cm\n/${res.name(res.xobject, 'Im', id)} Do\nQ\n`;
    ctx.ops.push(out);
  }

  clipOps(mask) {
    if (!mask) return null;
    if (mask.type === 'path' || mask.type === 'compound') {
      const p = this.pathOps(this.subpathsOf(mask));
      return p ? `${p}${mask.fillRule === 'evenodd' ? 'W*' : 'W'} n\n` : null;
    }
    if (mask.type === 'group') {
      let p = '';
      const collect = (n) => {
        if (!n) return;
        if (n.type === 'path' || n.type === 'compound') p += this.pathOps(this.subpathsOf(n));
        else if (n.type === 'group') n.children.forEach((c) => collect(this.doc.get(c)));
      };
      collect(mask);
      return p ? `${p}W n\n` : null;
    }
    const o = mask.type === 'text' ? outlineSubpaths(this.opts.outlines?.get(mask.id)) : [];
    if (o.length) return `${this.pathOps(o)}W n\n`;
    const b = nodeBounds(this.doc, mask);
    return b ? `${this.f(b.x)} ${this.f(b.y)} ${this.f(b.w)} ${this.f(b.h)} re W n\n` : null;
  }

  async children(ctx, node) {
    const kids = node.children.map((c) => this.doc.get(c)).filter(Boolean);
    if (node.type === 'group' && node.clip && kids.length) {
      const mask = kids[kids.length - 1];
      const clip = this.clipOps(mask);
      if (!clip) return;
      ctx.ops.push(`q\n${clip}`);
      for (const k of kids.slice(0, -1)) await this.node(ctx, k);
      ctx.ops.push('Q\n');
      if (!mask.hidden && mask.stroke && mask.strokeWidth > 0 && (mask.type === 'path' || mask.type === 'compound')) {
        this.paintGeometry(ctx, { ...mask, opacity: 1 }, this.subpathsOf(mask), { fill: null });
      }
      return;
    }
    for (const k of kids) await this.node(ctx, k);
  }

  /**
   * An object with an opacity mask: the object as a transparency group,
   * painted through a luminosity soft mask drawn from the mask art (on
   * black when the mask clips, white otherwise; inverted by a transfer
   * function). Blending applies to the masked result.
   */
  async masked(ctx, node) {
    const om = node.opacityMask;
    const inner = { ops: [], res: new Resources(), patternBase: [1, 0, 0, 1, 0, 0], cull: ctx.cull, links: ctx.links };
    await this.node(inner, { ...node, opacityMask: undefined, blendMode: 'normal' });
    if (!inner.ops.length) return;
    const b = inflate(visualBounds(this.doc, node) || ctx.cull, 2);
    const bbox = `[${this.f(b.x)} ${this.f(b.y)} ${this.f(b.x + b.w)} ${this.f(b.y + b.h)}]`;
    const form = this.w.addStream(`/Type /XObject /Subtype /Form /BBox ${bbox} /Group << /S /Transparency /CS /DeviceRGB /I true >> /Resources ${this.w.add(inner.res.dict())} 0 R`, inner.ops.join(''));
    // The mask art lives outside the document tree: render it from a view of its own nodes.
    const art = new Map(om.art.nodes.map((n) => [n.id, n]));
    const base = this.doc;
    const raw = {
      get: (id) => art.get(id) ?? base.get(id),
      has: (id) => art.has(id) || base.has(id),
      assets: base.assets,
      root: { ...base.root, children: [om.art.root] },
      artboards: base.artboards,
      walk(fn, id = 'root', depth = 0) {
        const n = id === 'root' ? this.root : this.get(id);
        if (!n) return;
        if (id !== 'root' && fn(n, depth) === false) return;
        for (const c of n.children || []) this.walk(fn, c, depth + 1);
      },
    };
    const view = exportView(raw, { native: ['freeform'] });
    const mctx = { ops: [], res: new Resources(), patternBase: [1, 0, 0, 1, 0, 0], cull: inflate(b, 1e5), links: [] };
    mctx.ops.push(`${om.clip ? '0 0 0' : '1 1 1'} rg\n${this.f(b.x)} ${this.f(b.y)} ${this.f(b.w)} ${this.f(b.h)} re f\n`);
    const t = om.transform || [1, 0, 0, 1, 0, 0];
    mctx.ops.push(`q\n${t.map((v) => this.f(v)).join(' ')} cm\n`);
    this.doc = view;
    try {
      const root = view.get(om.art.root);
      if (root) await this.node(mctx, { ...root, hidden: false });
    } finally {
      this.doc = base;
    }
    mctx.ops.push('Q\n');
    const group = this.w.addStream(`/Type /XObject /Subtype /Form /BBox ${bbox} /Group << /S /Transparency /CS /DeviceRGB >> /Resources ${this.w.add(mctx.res.dict())} 0 R`, mctx.ops.join(''));
    const tr = om.invert ? ' /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >>' : '';
    const bm = BLEND_PDF[node.blendMode];
    const gs = this.w.add(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${group} 0 R /BC [${om.clip ? '0 0 0' : '1 1 1'}]${tr} >>${bm ? ` /BM /${bm}` : ''} >>`);
    const res = ctx.res;
    ctx.ops.push(`q\n/${res.name(res.ext, 'GS', gs)} gs\n/${res.name(res.xobject, 'Fm', form)} Do\nQ\n`);
  }

  async group(ctx, node) {
    const op = node.opacity ?? 1;
    const blend = BLEND_PDF[node.blendMode];
    if (op >= 1 && !blend) {
      await this.children(ctx, node);
      return;
    }
    // Transparency group: children render into a form, which is composited once.
    const inner = { ops: [], res: new Resources(), patternBase: [1, 0, 0, 1, 0, 0], cull: ctx.cull };
    await this.children(inner, node);
    if (!inner.ops.length) return;
    const b = inflate(visualBounds(this.doc, node) || ctx.cull, 2);
    const resId = this.w.add(inner.res.dict());
    const form = this.w.addStream(`/Type /XObject /Subtype /Form /BBox [${this.f(b.x)} ${this.f(b.y)} ${this.f(b.x + b.w)} ${this.f(b.y + b.h)}] /Group << /S /Transparency /CS /DeviceRGB /I true >> /Resources ${resId} 0 R`, inner.ops.join(''));
    const res = ctx.res;
    const gs = this.extGState(op, op, node.blendMode);
    ctx.ops.push(`q\n${gs ? `/${res.name(res.ext, 'GS', gs)} gs\n` : ''}/${res.name(res.xobject, 'Fm', form)} Do\nQ\n`);
  }

  async page(rect, pagesId) {
    // Bleed: one value for every side or { top, bottom, left, right } (a document's bleed).
    const b = this.opts.bleed;
    const side = (k) => Math.max(0, (typeof b === 'number' ? b : b?.[k]) || 0);
    const [bt, bb, bl, br] = [side('top'), side('bottom'), side('left'), side('right')];
    const bleed = bt || bb || bl || br;
    const W = rect.w + bl + br;
    const H = rect.h + bt + bb;
    const base = [1, 0, 0, -1, bl - rect.x, rect.y + rect.h + bb];
    const cull = inflate({ x: rect.x - bl, y: rect.y - bt, w: W, h: H }, 1);
    const ctx = { ops: [], res: new Resources(), patternBase: base, cull, links: [] };
    ctx.ops.push(`${base.map((v) => this.f(v)).join(' ')} cm\n`);
    if (this.opts.background) ctx.ops.push(`${rgbOps(this.opts.background, 'rg')}\n${this.f(rect.x - bl)} ${this.f(rect.y - bt)} ${this.f(W)} ${this.f(H)} re f\n`);
    if (this.opts.ids) for (const id of this.opts.ids) await this.node(ctx, this.doc.get(id));
    else {
      for (const id of this.doc.root.children) {
        const layer = this.doc.get(id);
        if (!layer || layer.hidden || layer.template || layer.print === false) continue;
        await this.node(ctx, layer);
      }
    }
    const content = this.w.addStream('', ctx.ops.join(''));
    const resId = this.w.add(ctx.res.dict());
    const boxes = bleed ? ` /TrimBox [${this.f(bl)} ${this.f(bb)} ${this.f(bl + rect.w)} ${this.f(bb + rect.h)}] /BleedBox [0 0 ${this.f(W)} ${this.f(H)}]` : '';
    // Objects with a URL become link annotations over their bounds (page space is y-up).
    const annots = ctx.links.map(({ b, url }) => {
      const x1 = b.x + base[4];
      const y1 = base[5] - (b.y + b.h);
      return this.w.add(`<< /Type /Annot /Subtype /Link /Rect [${this.f(x1)} ${this.f(y1)} ${this.f(x1 + b.w)} ${this.f(y1 + b.h)}] /Border [0 0 0] /A << /S /URI /URI ${pdfText(url)} >> >>`);
    });
    const annotRef = annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : '';
    return this.w.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.f(W)} ${this.f(H)}]${boxes} /Resources ${resId} 0 R /Contents ${content} 0 R${annotRef} >>`);
  }
}

/**
 * Unpremultiplied RGBA of S where all = obj over S (source-over): what lies
 * under an object. Fully covered pixels come out transparent.
 */
export function subtractOver(all, obj) {
  const out = new Uint8ClampedArray(all.length);
  for (let i = 0; i < all.length; i += 4) {
    const ao = obj[i + 3] / 255;
    if (ao > 0.98) continue;
    const aa = all[i + 3] / 255;
    const as = Math.max(0, Math.min(1, (aa - ao) / (1 - ao)));
    if (as <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const prem = (all[i + c] / 255) * aa - (obj[i + c] / 255) * ao;
      out[i + c] = Math.round(Math.max(0, Math.min(1, prem / (1 - ao) / as)) * 255);
    }
    out[i + 3] = Math.round(as * 255);
  }
  return out;
}

/** RGBA pixels for an image asset via the browser's decoders. */
async function decodePixels(asset) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  const img = new Image();
  img.decoding = 'async';
  img.src = asset.data;
  try {
    await img.decode();
  } catch {
    return null;
  }
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (!w || !h) return null;
  if (asset.mime === 'image/svg+xml') {
    // Vector images are rasterized at twice their size for print.
    w *= 2;
    h *= 2;
  }
  const max = 8192;
  if (w > max || h > max) {
    const s = max / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0, w, h);
  try {
    return { width: w, height: h, data: c.getImageData(0, 0, w, h).data };
  } catch {
    return null; // tainted by a cross-origin linked image
  }
}

/**
 * Write a PDF. `pages` is a list of document rects (artboards). Options:
 * bleed, ids (only these roots), outlines (Map text id -> subpaths),
 * outlinesWanted, background, title, compress.
 * Returns { bytes: Uint8Array, warnings: string[] }.
 */
export async function writePDF(source, pages, opts = {}) {
  // Freeform fills are drawn natively (as images inside their shapes).
  const doc = exportView(source, { native: ['freeform'] });
  const w = new PDFWriter({ compress: opts.compress !== false });
  const r = new PDFRenderer(doc, w, opts);
  const catalog = w.alloc();
  const pagesId = w.alloc();
  const kids = [];
  for (const rect of pages) kids.push(await r.page(rect, pagesId));
  w.set(pagesId, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  w.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  // File Info metadata (doc.root.info) fills the document information dictionary.
  const meta = doc.root?.info || {};
  const list = (v) => (Array.isArray(v) ? v.join('; ') : v);
  const title = meta.title || opts.title;
  const extra = [['Author', list(meta.author)], ['Subject', meta.description], ['Keywords', list(meta.keywords)]].filter(([, v]) => v).map(([k, v]) => `/${k} ${pdfText(v)} `).join('');
  const info = w.add(`<< ${title ? `/Title ${pdfText(title)} ` : ''}${extra}/Producer (Vector Studio) /Creator (Vector Studio) /CreationDate (${date}) /ModDate (${date}) >>`);
  const bytes = await w.build({ root: catalog, info });
  return { bytes, warnings: [...r.warnings] };
}

