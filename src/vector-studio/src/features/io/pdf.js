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
 *   (turned with the object); strokes and type paint with a tiling pattern
 *   holding the same image.
 * - Opacity masks: a luminosity soft mask (SMask) made from the mask art,
 *   applied to the object drawn as a transparency group.
 * - Clip groups: the clipping path as a clip (W / W*).
 * - Images: JPEG passthrough (DCTDecode), anything else as Flate RGB with
 *   an SMask for alpha.
 * - Text: outlines from the type module when available, otherwise the
 *   standard Helvetica family (WinAnsi) as a fallback.
 * - Streams are FlateDecode-compressed with CompressionStream when present.
 * - Color management: CMYK output through an ICC transform (paints
 *   converted to CMYK keep their numbers, or are converted between CMYK
 *   profiles), device colors tagged with ICC profiles (ICCBased spaces and
 *   Default color spaces), an output intent carrying its profile, and the
 *   PDF/X-1a and PDF/X-4 conventions (pdfx.js checks the result).
 * - Print production options: spot inks as Separation color
 *   spaces, printer's marks in the registration color with trim and bleed
 *   boxes, layers as optional content, page thumbnails, image downsampling
 *   and JPEG compression, overprint preserved, simulated or discarded,
 *   transparency flattened into images, an output intent, and AES password
 *   protection (pdf-crypto.js).
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
import { layoutContent } from './print-layout.js';
import { securityHandler, encryptStream, newDocumentId } from './pdf-crypto.js';
import { transformBetween } from '../icc/profiles.js';
import { spotTint } from '../prepress/separations.js';
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
  constructor({ compress = true, version = '1.7' } = {}) {
    this.objects = [null]; // 1-based
    this.compress = compress;
    this.version = version;
    // { key } when streams are encrypted; the document id goes in the trailer.
    this.security = null;
    this.id = null;
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

  async build({ root, info, encrypt = null }) {
    const chunks = [];
    let offset = 0;
    const push = (b) => {
      const bytes = typeof b === 'string' ? latin1(b) : b;
      chunks.push(bytes);
      offset += bytes.length;
    };
    push(`%PDF-${this.version}\n%\xe2\xe3\xcf\xd3\n`);
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
        if (this.security) data = await encryptStream(this.security.key, id, 0, data);
        push(`${id} 0 obj\n<<${o.dict ? ` ${o.dict}` : ''}${filter ? ` /Filter ${filter}` : ''} /Length ${data.length} >>\nstream\n`);
        push(data);
        push('\nendstream\nendobj\n');
      } else push(`${id} 0 obj\n${o.body}\nendobj\n`);
    }
    const xref = offset;
    let table = `xref\n0 ${this.objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < this.objects.length; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(table);
    const idHex = this.id ? [...this.id].map((b) => b.toString(16).padStart(2, '0')).join('') : null;
    push(`trailer\n<< /Size ${this.objects.length} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''}${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''}${idHex ? ` /ID [<${idHex}> <${idHex}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
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


/** Resources of one content stream (page or form). `defaults` are Default color spaces ({ DefaultRGB: objId }). */
class Resources {
  constructor(defaults = null) {
    this.defaults = defaults;
    this.ext = new Map();
    this.pattern = new Map();
    this.shading = new Map();
    this.xobject = new Map();
    this.font = new Map();
    this.colorspace = new Map();
    this.properties = new Map();
  }

  name(map, prefix, objId) {
    for (const [name, id] of map) if (id === objId) return name;
    const name = `${prefix}${map.size + 1}`;
    map.set(name, objId);
    return name;
  }

  dict() {
    const part = (key, map) => (map.size ? ` /${key} << ${[...map].map(([n, id]) => `/${n} ${id} 0 R`).join(' ')} >>` : '');
    const cs = new Map([...Object.entries(this.defaults || {}), ...this.colorspace]);
    return `<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]${part('ExtGState', this.ext)}${part('Pattern', this.pattern)}${part('Shading', this.shading)}${part('XObject', this.xobject)}${part('Font', this.font)}${part('ColorSpace', cs)}${part('Properties', this.properties)} >>`;
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
    this.csCache = new Map();
    // Device color output: 'rgb' or 'cmyk' (through the ICC transform `cmykTransform`, else into the press model `profile`).
    this.cmyk = opts.colorSpace === 'cmyk';
    this.profile = opts.profile || 'basic';
    this.toCmyk = this.cmyk ? opts.cmykTransform || transformBetween('srgb', this.profile, { intent: 'relative', bpc: true }) : null;
    // CMYK numbers of converted paints: kept, or converted between CMYK profiles.
    this.cmykNumbers = opts.cmykNumbers || null;
    // RGB output converted between RGB profiles (absent: document RGB numbers are written as they are).
    this.rgbTransform = this.cmyk ? null : opts.rgbTransform || null;
    // ICC profile tagging the device space (Default color spaces in every resource dictionary).
    this.icc = null;
    const tag = this.cmyk ? opts.iccCMYK : opts.iccRGB;
    if (tag?.bytes) {
      const n = this.cmyk ? 4 : 3;
      this.icc = this.w.add(`[/ICCBased ${this.iccStream(tag.bytes, n)} 0 R]`);
    }
    // In CMYK output, RGB that remains (gradient mesh shadings) is described by the RGB profile.
    this.iccStray = this.cmyk && opts.iccRGB?.bytes ? this.w.add(`[/ICCBased ${this.iccStream(opts.iccRGB.bytes, 3)} 0 R]`) : null;
    // Spot inks written as Separation color spaces: swatch id -> { name, color }.
    this.spots = opts.spots || new Map();
    // Streams finishing asynchronously (JPEG encoding) before the file is built.
    this.pending = [];
    this.ocgs = new Map();
  }

  f(v) {
    return pdfNum(v);
  }

  get deviceSpace() {
    return this.cmyk ? 'DeviceCMYK' : 'DeviceRGB';
  }

  /** The output color space as written in dictionaries: the ICC-based space when tagged, else the device space. */
  get spaceRef() {
    return this.icc ? `${this.icc} 0 R` : `/${this.deviceSpace}`;
  }

  /** A new resource dictionary for a content stream (carrying the Default color space when tagged). */
  newResources() {
    const d = {};
    if (this.icc) d[this.cmyk ? 'DefaultCMYK' : 'DefaultRGB'] = this.icc;
    if (this.iccStray) d.DefaultRGB = this.iccStray;
    return new Resources(Object.keys(d).length ? d : null);
  }

  /** An ICC profile stream (one per profile data for the whole file). */
  iccStream(bytes, n) {
    this.iccCache ||= new Map();
    let id = this.iccCache.get(bytes);
    if (!id) {
      id = this.w.addStream(`/N ${n}`, bytes, { compress: true });
      this.iccCache.set(bytes, id);
    }
    return id;
  }

  /** Color components of a color (hex, or a solid paint that may carry CMYK numbers). */
  colorValues(color) {
    const hex = typeof color === 'string' ? color : color?.color || '#000000';
    if (this.cmyk) {
      // A spot color printing as process with a CMYK equivalent: the equivalent, by tint.
      const eq = typeof color === 'object' && color?.swatchId ? this.opts.spotEquivalents?.get(color.swatchId) : null;
      if (eq) {
        const t = spotTint(hex, eq.color, color.tint);
        return [eq.c, eq.m, eq.y, eq.k].map((v) => Math.max(0, Math.min(1, (v / 100) * t)));
      }
      const own = typeof color === 'object' && color?.cmyk;
      if (own) {
        const v = [own.c, own.m, own.y, own.k].map((x) => Math.max(0, Math.min(1, x / 100)));
        return this.cmykNumbers ? this.cmykNumbers.convert(v) : v;
      }
      const { r, g, b } = hexToRgb(hex);
      return this.toCmyk.convert([r / 255, g / 255, b / 255]);
    }
    if (this.rgbTransform) {
      const { r, g, b } = hexToRgb(hex);
      return this.rgbTransform.convert([r / 255, g / 255, b / 255]);
    }
    const { r, g, b } = hexToRgb(hex);
    return [r / 255, g / 255, b / 255];
  }

  /** A Separation color space for a spot ink (or 'All' for registration marks). */
  separationSpace(name, alt) {
    const key = `${name}|${alt.join(',')}`;
    let id = this.csCache.get(key);
    if (!id) {
      const esc = String(name).replace(/[^A-Za-z0-9._-]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`) || 'Spot';
      const zero = alt.map(() => 0).join(' ');
      id = this.w.add(`[/Separation /${esc} ${this.spaceRef} << /FunctionType 2 /Domain [0 1] /C0 [${zero}] /C1 [${alt.map((v) => pdfNum(v)).join(' ')}] /N 1 >>]`);
      this.csCache.set(key, id);
    }
    return id;
  }

  /** Operators setting the fill (or stroke) color for a color or solid paint. */
  colorOps(res, color, stroke = false) {
    const spot = typeof color === 'object' && color?.swatchId ? this.spots.get(color.swatchId) : null;
    if (spot) {
      const alt = spot.cmyk && this.cmyk ? [spot.cmyk.c, spot.cmyk.m, spot.cmyk.y, spot.cmyk.k].map((v) => Math.max(0, Math.min(1, v / 100))) : this.colorValues(spot.color);
      const cs = this.separationSpace(spot.name, alt);
      const tint = spotTint(color.color, spot.color, color.tint);
      return `/${res.name(res.colorspace, 'CS', cs)} ${stroke ? 'CS' : 'cs'} ${pdfNum(tint)} ${stroke ? 'SCN' : 'scn'}`;
    }
    const v = this.colorValues(color).map((x) => pdfNum(x)).join(' ');
    if (this.cmyk) return `${v} ${stroke ? 'K' : 'k'}`;
    return `${v} ${stroke ? 'RG' : 'rg'}`;
  }

  /** The registration color: every plate at 100%. */
  registrationOps(res, stroke = false) {
    const cs = this.separationSpace('All', this.cmyk ? [1, 1, 1, 1] : [0, 0, 0]);
    return `/${res.name(res.colorspace, 'CS', cs)} ${stroke ? 'CS' : 'cs'} 1 ${stroke ? 'SCN' : 'scn'}`;
  }

  // ---- shared objects ----

  /** `node` sets overprint (Attributes panel): op for its fill, OP for its stroke. */
  extGState(fillAlpha, strokeAlpha, blend, node = null) {
    let ca = Math.max(0, Math.min(1, fillAlpha));
    let CA = Math.max(0, Math.min(1, strokeAlpha));
    let bm = BLEND_PDF[blend] || null;
    // PDF/X-1a has no transparency: what flattening could not rasterize is painted opaque.
    if (this.opts.pdfx === 'x1a' && (ca < 1 || CA < 1 || bm)) {
      this.warnings.add('Some transparency could not be flattened and prints opaque.');
      ca = CA = 1;
      bm = null;
    }
    let op = Boolean(node?.overprintFill);
    let OP = Boolean(node?.overprintStroke);
    const mode = this.opts.overprint || 'preserve';
    // Simulated overprint mixes the object's inks into what is below, as Multiply does.
    if (mode === 'simulate' && (op || OP) && !bm) bm = 'Multiply';
    if (mode !== 'preserve') op = OP = false;
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
    const col = (hex) => `[${this.colorValues(hex).map((v) => pdfNum(v)).join(' ')}]`;
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
    const body = `<< /ShadingType ${paint.type === 'radial' ? 3 : 2} /ColorSpace ${this.spaceRef} /Coords ${coords} /Function ${fn} /Extend [true true] >>`;
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

  /**
   * A freeform gradient as a colored tiling pattern (one tile holding the
   * blend over the node's frame, grown by `pad` for strokes), for paint that
   * cannot clip an image: strokes and type. Returns the pattern's object id,
   * or null without a frame.
   */
  freeformPattern(ctx, paint, node, pad = 0) {
    const f = freeformFrame(this.doc, node);
    if (!f) return null;
    const pu = Math.max(0, pad) / f.w;
    const pv = Math.max(0, pad) / f.h;
    const aspect = (f.w * (1 + 2 * pu)) / (f.h * (1 + 2 * pv));
    // Image space (unit square, first row at the top) -> padded frame fractions -> document -> pattern space.
    const m = multiply(ctx.patternBase, multiply(frameFractionMatrix(f), multiply([1 + 2 * pu, 0, 0, 1 + 2 * pv, -pu, -pv], [1, 0, 0, -1, 0, 1])));
    const key = `${(f.w / f.h).toFixed(4)}|${pu.toFixed(4)}|${pv.toFixed(4)}|${m.map((v) => this.f(v)).join(' ')}`;
    this.freeformPatterns ||= new WeakMap();
    const cache = this.freeformPatterns.get(paint) || new Map();
    this.freeformPatterns.set(paint, cache);
    if (cache.has(key)) return cache.get(key);
    const k = Math.sqrt(aspect);
    const w = Math.max(8, Math.round(256 * Math.min(1, k)));
    const h = Math.max(8, Math.round(256 * Math.min(1, 1 / k)));
    const img = this.pixelsXObject({ width: w, height: h, data: freeformPixels(paint, w, h, f.w / f.h, [-pu, -pv, 1 + pu, 1 + pv]) });
    // Tiles far apart: the one tile covers everything the paint reaches.
    const id = this.w.addStream(`/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 8 /YStep 8 /Matrix [${m.map((v) => this.f(v)).join(' ')}] /Resources << /XObject << /Im1 ${img} 0 R >> >>`, '/Im1 Do\n');
    cache.set(key, id);
    return id;
  }

  /** Color operators for a freeform paint on strokes and type: its pattern, else its average color. */
  freeformOps(ctx, paint, node, stroke = false, pad = 0) {
    const pat = this.freeformPattern(ctx, paint, node, pad);
    if (!pat) return this.colorOps(ctx.res, averageColor(paint), stroke);
    return `/Pattern ${stroke ? 'CS' : 'cs'} /${ctx.res.name(ctx.res.pattern, 'P', pat)} ${stroke ? 'SCN' : 'scn'}`;
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

  /** Image XObject for an asset (cached per asset and output size). */
  imageXObject(assetId, size = null) {
    const key = size ? `${assetId}@${size.w}x${size.h}` : assetId;
    let p = this.imageCache.get(key);
    if (!p) {
      p = this.encodeImage(assetId, size).catch(() => null);
      this.imageCache.set(key, p);
    }
    return p;
  }

  async encodeImage(assetId, size = null) {
    const asset = this.doc.assets.get(assetId);
    if (!asset?.data) return null;
    const info = asset.data.startsWith('data:') ? dataUrlToBytes(asset.data) : null;
    // JPEG data passes through unless it has to change (CMYK output, downsampling, recompression).
    const keepJpeg = !this.cmyk && !this.rgbTransform && !size && this.opts.images?.compression !== 'zip';
    if (keepJpeg && info && sniffMime(info.bytes) === 'image/jpeg') {
      const j = jpegInfo(info.bytes);
      if (j && (j.components === 1 || j.components === 3)) {
        return this.w.addStream(`/Type /XObject /Subtype /Image /Width ${j.width} /Height ${j.height} /ColorSpace ${j.components === 1 ? '/DeviceGray' : this.spaceRef} /BitsPerComponent 8`, info.bytes, { filter: '/DCTDecode' });
      }
    }
    let px = await decodePixels(asset);
    if (!px) {
      this.warnings.add('Some images could not be decoded and were left out.');
      return null;
    }
    if (size) px = resamplePixels(px, size.w, size.h, this.opts.images?.downsample) || px;
    return this.pixelsXObject(px);
  }

  /**
   * Image XObject (with a soft mask when needed) from RGBA pixels: CMYK
   * through the press model for CMYK output, JPEG-compressed when chosen.
   * Returns the object id at once; JPEG data arrives before the file is built.
   */
  pixelsXObject({ width, height, data }) {
    const n = this.cmyk ? 4 : 3;
    const color = new Uint8Array(width * height * n);
    const alpha = new Uint8Array(width * height);
    const plates = new Float32Array(4);
    const px = [0, 0, 0];
    let hasAlpha = false;
    for (let i = 0, j = 0, k = 0; i < data.length; i += 4, j += n, k++) {
      const a = data[i + 3];
      // Canvas pixels are unpremultiplied already; keep color as is.
      if (this.cmyk) {
        px[0] = data[i] / 255;
        px[1] = data[i + 1] / 255;
        px[2] = data[i + 2] / 255;
        this.toCmyk.fast(px, plates);
        for (let c = 0; c < 4; c++) color[j + c] = Math.round(plates[c] * 255);
      } else if (this.rgbTransform) {
        px[0] = data[i] / 255;
        px[1] = data[i + 1] / 255;
        px[2] = data[i + 2] / 255;
        this.rgbTransform.fast(px, plates);
        for (let c = 0; c < 3; c++) color[j + c] = Math.round(plates[c] * 255);
      } else {
        color[j] = data[i];
        color[j + 1] = data[i + 1];
        color[j + 2] = data[i + 2];
      }
      alpha[k] = a;
      if (a < 255) hasAlpha = true;
    }
    let smask = '';
    if (hasAlpha) {
      const sid = this.w.addStream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha, { compress: true });
      smask = ` /SMask ${sid} 0 R`;
    }
    const dict = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${this.spaceRef} /BitsPerComponent 8${smask}`;
    const id = this.w.addStream(dict, color, { compress: true });
    if (this.opts.images?.compression === 'jpeg' && !this.cmyk) {
      this.pending.push(encodeJpeg({ width, height, data }, this.opts.images.quality ?? 0.85).then((bytes) => {
        if (bytes && bytes.length < color.length) this.w.setStream(id, dict, bytes, { filter: '/DCTDecode' });
      }).catch(() => {}));
    }
    return id;
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
    const op = node.opacity ?? 1;
    const fa = op * this.paintAlpha(fill);
    const sa = op * this.paintAlpha(stroke);
    let out = 'q\n';
    const gs = this.extGState(fill ? fa : 1, stroke ? sa : 1, node.blendMode, node);
    if (gs) out += `/${res.name(res.ext, 'GS', gs)} gs\n`;
    const W = evenOdd ? 'W*' : 'W';
    const doFill = () => {
      if (!fill) return '';
      if (fill.type === 'solid') return `${this.colorOps(res, fill)}\n${path}${evenOdd ? 'f*' : 'f'}\n`;
      if (fill.type === 'freeform') {
        const img = this.freeformImage(fill, node);
        if (!img) return `${this.colorOps(res, averageColor(fill))}\n${path}${evenOdd ? 'f*' : 'f'}\n`;
        return `q\n${path}${W} n\n${img.m.map((v) => this.f(v)).join(' ')} cm\n/${res.name(res.xobject, 'Im', img.id)} Do\nQ\n`;
      }
      return `q\n${path}${W} n\n${this.shadeOps(res, fill, node)}Q\n`;
    };
    const strokeColor = () => {
      if (stroke.type === 'solid') return `${this.colorOps(res, stroke, true)}\n`;
      // A stroke cannot clip an image: freeform strokes paint with a pattern of the blend.
      if (stroke.type === 'freeform') return `${this.freeformOps(ctx, stroke, node, true, node.strokeWidth || 0)}\n`;
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
      out += `${this.colorOps(res, fill)}\n${this.strokeState(node)}${this.colorOps(res, stroke, true)}\n${path}${evenOdd ? 'B*' : 'B'}\n`;
    } else {
      out += doFill();
      out += doStroke();
    }
    if (arrows.length && stroke) {
      const ap = this.pathOps(arrows);
      if (stroke.type === 'solid') out += `${this.colorOps(res, stroke)}\n${ap}f\n`;
      else if (stroke.type === 'freeform') out += `${this.freeformOps(ctx, stroke, node, false, node.strokeWidth || 0)}\n${ap}f\n`;
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
    // Flattening: transparent objects become images of themselves over what is below.
    if (this.opts.flatten && node.type !== 'layer' && this.isTransparent(node) && (await this.flattened(ctx, node))) return;
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
    const solid = (p) => (p ? (p.type === 'solid' ? p : [...(p.stops || [])].sort((a, b) => a.offset - b.offset)[0]?.color || '#000000') : null);
    // Freeform paints fill and stroke the glyphs with a pattern of the blend over the type's frame.
    const ops = (p, stroke, pad = 0) => (p.type === 'freeform' ? this.freeformOps(ctx, p, node, stroke, pad) : this.colorOps(res, solid(p), stroke));
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
      if (fill) out += `${ops(fill, false)}\n`;
      if (stroke) out += `${ops(stroke, true, sw)}\n${this.f(sw)} w\n`;
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
      for (const [rx, ry, rw, rh, paint] of decoRects(st, it.size, it.deco)) {
        // Bars in their own color set it for themselves.
        if (paint) out += `q\n${this.colorOps(res, solid(paint))}\n${this.f(rx)} ${this.f(ry)} ${this.f(rw)} ${this.f(rh)} re f\nQ\n`;
        else if (fill) out += `${this.f(rx)} ${this.f(ry)} ${this.f(rw)} ${this.f(rh)} re f\n`;
      }
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
    const id = await this.imageXObject(node.asset, downsampleSize(node, this.opts.images));
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
    if (this.opts.pdfx === 'x1a') {
      this.warnings.add('Some transparency could not be flattened and prints opaque.');
      await this.node(ctx, { ...node, opacityMask: undefined });
      return;
    }
    const om = node.opacityMask;
    const inner = { ops: [], res: this.newResources(), patternBase: [1, 0, 0, 1, 0, 0], cull: ctx.cull, links: ctx.links };
    await this.node(inner, { ...node, opacityMask: undefined, blendMode: 'normal' });
    if (!inner.ops.length) return;
    const b = inflate(visualBounds(this.doc, node) || ctx.cull, 2);
    const bbox = `[${this.f(b.x)} ${this.f(b.y)} ${this.f(b.x + b.w)} ${this.f(b.y + b.h)}]`;
    const form = this.w.addStream(`/Type /XObject /Subtype /Form /BBox ${bbox} /Group << /S /Transparency /CS ${this.spaceRef} /I true >> /Resources ${this.w.add(inner.res.dict())} 0 R`, inner.ops.join(''));
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
    const mctx = { ops: [], res: this.newResources(), patternBase: [1, 0, 0, 1, 0, 0], cull: inflate(b, 1e5), links: [] };
    mctx.ops.push(`${this.colorOps(mctx.res, om.clip ? '#000000' : '#ffffff')}\n${this.f(b.x)} ${this.f(b.y)} ${this.f(b.w)} ${this.f(b.h)} re f\n`);
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
    const group = this.w.addStream(`/Type /XObject /Subtype /Form /BBox ${bbox} /Group << /S /Transparency /CS ${this.spaceRef} >> /Resources ${this.w.add(mctx.res.dict())} 0 R`, mctx.ops.join(''));
    const tr = om.invert ? ' /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >>' : '';
    const bm = BLEND_PDF[node.blendMode];
    const bc = this.colorValues(om.clip ? '#000000' : '#ffffff').map((v) => pdfNum(v)).join(' ');
    const gs = this.w.add(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${group} 0 R /BC [${bc}]${tr} >>${bm ? ` /BM /${bm}` : ''} >>`);
    const res = ctx.res;
    ctx.ops.push(`q\n/${res.name(res.ext, 'GS', gs)} gs\n/${res.name(res.xobject, 'Fm', form)} Do\nQ\n`);
  }

  async group(ctx, node) {
    const op = node.opacity ?? 1;
    const blend = BLEND_PDF[node.blendMode];
    if ((op >= 1 && !blend) || this.opts.pdfx === 'x1a') {
      if (op < 1 || blend) this.warnings.add('Some transparency could not be flattened and prints opaque.');
      await this.children(ctx, node);
      return;
    }
    // Transparency group: children render into a form, which is composited once.
    const inner = { ops: [], res: this.newResources(), patternBase: [1, 0, 0, 1, 0, 0], cull: ctx.cull };
    await this.children(inner, node);
    if (!inner.ops.length) return;
    const b = inflate(visualBounds(this.doc, node) || ctx.cull, 2);
    const resId = this.w.add(inner.res.dict());
    const form = this.w.addStream(`/Type /XObject /Subtype /Form /BBox [${this.f(b.x)} ${this.f(b.y)} ${this.f(b.x + b.w)} ${this.f(b.y + b.h)}] /Group << /S /Transparency /CS ${this.spaceRef} /I true >> /Resources ${resId} 0 R`, inner.ops.join(''));
    const res = ctx.res;
    const gs = this.extGState(op, op, node.blendMode);
    ctx.ops.push(`q\n${gs ? `/${res.name(res.ext, 'GS', gs)} gs\n` : ''}/${res.name(res.xobject, 'Fm', form)} Do\nQ\n`);
  }

  async page(rect, pagesId) {
    // Bleed: one value for every side or { top, bottom, left, right } (a document's bleed).
    const b = this.opts.bleed;
    const side = (k) => Math.max(0, (typeof b === 'number' ? b : b?.[k]) || 0);
    const bleed = { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
    const hasBleed = bleed.top || bleed.bottom || bleed.left || bleed.right;
    // The page holds the bleed area plus room for printer's marks (see print-layout.js).
    const lay = layoutContent(rect, { media: 'artboard', bleed, marks: this.opts.marks || {}, markWeight: this.opts.markWeight, markOffset: this.opts.markOffset, markType: this.opts.markType }, this.opts.pageInfo ? this.opts.pageInfo(rect) : '')[0];
    const t = lay.tiles[0];
    const area = t.rect;
    const W = lay.w;
    const H = lay.h;
    const base = [1, 0, 0, -1, t.x - area.x, H - t.y + area.y];
    const marks = lay.marks || [];
    const cull = inflate(area, 1);
    const ctx = { ops: [], res: this.newResources(), patternBase: base, cull, links: [] };
    ctx.ops.push(`q\n${base.map((v) => this.f(v)).join(' ')} cm\n`);
    // With marks around it, artwork stops at the bleed.
    if (marks.length) ctx.ops.push(`${this.f(area.x)} ${this.f(area.y)} ${this.f(area.w)} ${this.f(area.h)} re W n\n`);
    if (this.opts.background) ctx.ops.push(`${this.colorOps(ctx.res, this.opts.background)}\n${this.f(area.x)} ${this.f(area.y)} ${this.f(area.w)} ${this.f(area.h)} re f\n`);
    if (this.opts.flatten && this.opts.flatten.balance <= 0) {
      // Everything rasterized: one image of the page.
      if (!(await this.rasterArea(ctx, area, () => true))) this.warnings.add('The page could not be rasterized for flattening.');
    } else if (this.opts.ids) for (const id of this.opts.ids) await this.node(ctx, this.doc.get(id));
    else {
      for (const id of this.doc.root.children) {
        const layer = this.doc.get(id);
        if (!layer || layer.hidden || layer.template || layer.print === false) continue;
        const oc = this.opts.layers && this.opts.pdfx !== 'x1a' ? this.ocg(layer) : null;
        if (oc) ctx.ops.push(`/OC /${ctx.res.name(ctx.res.properties, 'OC', oc)} BDC\n`);
        await this.node(ctx, layer);
        if (oc) ctx.ops.push('EMC\n');
      }
    }
    ctx.ops.push('Q\n');
    if (marks.length) ctx.ops.push(this.marksOps(ctx.res, marks, H));
    const content = this.w.addStream('', ctx.ops.join(''));
    const resId = this.w.add(ctx.res.dict());
    const box = (r) => {
      const x = t.x + (r.x - area.x);
      const y = H - (t.y + (r.y - area.y) + r.h);
      return `[${this.f(x)} ${this.f(y)} ${this.f(x + r.w)} ${this.f(y + r.h)}]`;
    };
    // PDF/X files name the trimmed page on every page.
    const boxes = hasBleed || marks.length || this.opts.pdfx ? ` /TrimBox ${box(rect)} /BleedBox ${box(area)}` : '';
    // Objects with a URL become link annotations over their bounds (page space is y-up); PDF/X allows none on the page.
    const annots = (this.opts.pdfx ? [] : ctx.links).map(({ b: lb, url }) => {
      const x1 = lb.x + base[4];
      const y1 = base[5] - (lb.y + lb.h);
      return this.w.add(`<< /Type /Annot /Subtype /Link /Rect [${this.f(x1)} ${this.f(y1)} ${this.f(x1 + lb.w)} ${this.f(y1 + lb.h)}] /Border [0 0 0] /A << /S /URI /URI ${pdfText(url)} >> >>`);
    });
    const annotRef = annots.length ? ` /Annots [${annots.map((x) => `${x} 0 R`).join(' ')}]` : '';
    const thumb = this.opts.thumbnails && !this.opts.pdfx ? await this.thumbnail(area) : null;
    return this.w.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.f(W)} ${this.f(H)}]${boxes} /Resources ${resId} 0 R /Contents ${content} 0 R${annotRef}${thumb ? ` /Thumb ${thumb} 0 R` : ''} >>`);
  }

  /** Optional content group of a top-level layer (one per layer for the whole file). */
  ocg(layer) {
    let id = this.ocgs.get(layer.id);
    if (!id) {
      id = this.w.add(`<< /Type /OCG /Name ${pdfText(layer.name || 'Layer')} >>`);
      this.ocgs.set(layer.id, id);
    }
    return id;
  }

  /** Printer's marks in page space (y down from the top, page height H), in the registration color. */
  marksOps(res, marks, H) {
    const f = (v) => this.f(v);
    const Y = (y) => f(H - y);
    let out = 'q\n';
    const reg = this.registrationOps(res, true);
    for (const m of marks) {
      if (m.kind === 'line') out += `${reg}\n${f(m.w)} w\n${f(m.x1)} ${Y(m.y1)} m ${f(m.x2)} ${Y(m.y2)} l S\n`;
      else if (m.kind === 'registration') {
        out += `${reg}\n${f(m.w)} w\n`;
        for (const r of [m.r, m.r / 2]) {
          const k = r * 0.5523;
          const cx = m.x;
          const cy = H - m.y;
          out += `${f(cx + r)} ${f(cy)} m ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c S\n`;
        }
        out += `${f(m.x - m.r * 1.5)} ${Y(m.y)} m ${f(m.x + m.r * 1.5)} ${Y(m.y)} l S\n${f(m.x)} ${Y(m.y - m.r * 1.5)} m ${f(m.x)} ${Y(m.y + m.r * 1.5)} l S\n`;
      } else if (m.kind === 'swatch') {
        const solid = this.cmyk ? PROCESS_BARS[m.color] : null;
        const color = solid ? `${solid.join(' ')} k` : this.colorOps(res, m.color);
        out += `${color}\n${f(m.x)} ${f(H - m.y - m.h)} ${f(m.w)} ${f(m.h)} re f\n`;
      } else if (m.kind === 'text') {
        const font = res.name(res.font, 'F', this.helvetica({}));
        out += `${this.registrationOps(res)}\nBT\n/${font} ${f(m.size)} Tf\n${f(m.x)} ${Y(m.y)} Td\n${winAnsiString(m.text)} Tj\nET\n`;
      }
    }
    return `${out}Q\n`;
  }

  /** A small RGB preview of the page (/Thumb). */
  async thumbnail(area) {
    try {
      const scale = Math.min(1, 106 / Math.max(area.w, area.h));
      const canvas = await renderRegion(this.doc, area, { scale, background: '#ffffff' });
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      if (!d || d.length !== canvas.width * canvas.height * 4) return null;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        rgb[j] = d[i];
        rgb[j + 1] = d[i + 1];
        rgb[j + 2] = d[i + 2];
      }
      return this.w.addStream(`/Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8`, rgb, { compress: true });
    } catch {
      return null;
    }
  }

  // ---- flattening ----

  /** Paint order of every node (pre-order) and the last index inside each subtree. */
  paintIndex() {
    if (this.order) return this.order;
    const index = new Map();
    const last = new Map();
    let i = 0;
    const visit = (id) => {
      const n = this.doc.get(id);
      if (!n) return i;
      index.set(id, i++);
      let end = index.get(id);
      for (const c of n.children || []) end = Math.max(end, visit(c));
      last.set(id, end);
      return end;
    };
    for (const id of this.doc.root.children) {
      const l = this.doc.get(id);
      if (l && !l.hidden && !l.template && l.print !== false) visit(id);
    }
    this.order = { index, last };
    return this.order;
  }

  /**
   * Whether an object needs flattening: opacity, blending or see-through
   * paint. PDF/X-1a allows no soft masks either: opacity masks, raster
   * effects, images that may carry alpha and gradient meshes (written as
   * RGB shadings) are flattened too.
   */
  isTransparent(node) {
    if ((node.opacity ?? 1) < 1 || (node.blendMode && node.blendMode !== 'normal')) return true;
    if (this.opts.pdfx === 'x1a') {
      if (node.opacityMask || node.type === 'mesh' || rasterEffects(node)?.length) return true;
      if (node.type === 'image') {
        const mime = String(this.doc.assets?.get(node.asset)?.mime || this.doc.assets?.get(node.asset)?.data?.slice(5, 20) || '');
        if (!/jpe?g/.test(mime)) return true;
      }
    }
    if (this.opts.overprint === 'simulate' && (node.overprintFill || node.overprintStroke)) return true;
    const see = (p) => p && ((p.opacity ?? 1) < 1 || (p.stops || []).some((s) => (s.opacity ?? 1) < 1));
    return see(node.fill) || see(node.stroke);
  }

  /** Rasterize a document area with the leaves `keep` admits, over white, and place it. */
  async rasterArea(ctx, rect, keep) {
    const ppi = this.opts.flatten?.ppi || 300;
    const scale = Math.min(ppi / 72, 6000 / Math.max(rect.w, rect.h, 1));
    try {
      const canvas = await renderRegion(this.doc, rect, { scale, background: '#ffffff', leafFilter: keep, overprint: this.opts.overprint === 'simulate' });
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      if (!data || data.length !== canvas.width * canvas.height * 4) return false;
      const id = this.pixelsXObject({ width: canvas.width, height: canvas.height, data });
      ctx.ops.push(`q\n${this.f(rect.w)} 0 0 ${this.f(-rect.h)} ${this.f(rect.x)} ${this.f(rect.y + rect.h)} cm\n/${ctx.res.name(ctx.res.xobject, 'Im', id)} Do\nQ\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Flatten a transparent object: an image of it over everything painted before it. */
  async flattened(ctx, node) {
    const vb = visualBounds(this.doc, node);
    if (!vb) return true;
    const x0 = Math.max(vb.x, ctx.cull.x);
    const y0 = Math.max(vb.y, ctx.cull.y);
    const x1 = Math.min(vb.x + vb.w, ctx.cull.x + ctx.cull.w);
    const y1 = Math.min(vb.y + vb.h, ctx.cull.y + ctx.cull.h);
    if (!(x1 > x0 && y1 > y0)) return true;
    const { index, last } = this.paintIndex();
    const end = last.get(node.id) ?? index.get(node.id);
    if (end == null) return false;
    return this.rasterArea(ctx, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (id) => (index.get(id) ?? Infinity) <= end);
  }
}

const xmlText = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

/** A UUID URN from 16 bytes. */
const uuidOf = (b) => {
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * XMP metadata of a PDF/X file: title, dates, creator tool and producer,
 * trapping, document and instance ids, version and rendition, and the
 * PDF/X version. `date` is the ISO 8601 time the info dictionary also
 * carries; `id` the file identifier bytes.
 */
export function xmpPacket({ title, version, date, id, instance }) {
  const text = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
 xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
 xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"
 xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(title)}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${date}</xmp:CreateDate>
<xmp:ModifyDate>${date}</xmp:ModifyDate>
<xmp:MetadataDate>${date}</xmp:MetadataDate>
<xmp:CreatorTool>Vector Studio</xmp:CreatorTool>
<pdf:Producer>Vector Studio</pdf:Producer>
<pdf:Trapped>False</pdf:Trapped>
<xmpMM:DocumentID>${uuidOf(id)}</xmpMM:DocumentID>
<xmpMM:InstanceID>${uuidOf(instance)}</xmpMM:InstanceID>
<xmpMM:VersionID>1</xmpMM:VersionID>
<xmpMM:RenditionClass>default</xmpMM:RenditionClass>
<pdfx:GTS_PDFXVersion>${version}</pdfx:GTS_PDFXVersion>
<pdfxid:GTS_PDFXVersion>${version}</pdfxid:GTS_PDFXVersion>
</rdf:Description>
</rdf:RDF>
<?xpacket end="w"?>`;
  return new TextEncoder().encode(text);
}

/** Solid process colors for the color bars in CMYK output. */
const PROCESS_BARS = {
  '#00ffff': [1, 0, 0, 0],
  '#ff00ff': [0, 1, 0, 0],
  '#ffff00': [0, 0, 1, 0],
  '#000000': [0, 0, 0, 1],
  '#ff0000': [0, 1, 1, 0],
  '#00ff00': [1, 0, 1, 0],
  '#0000ff': [1, 1, 0, 0],
  '#808080': [0, 0, 0, 0.5],
  '#c0c0c0': [0, 0, 0, 0.25],
  '#404040': [0, 0, 0, 0.75],
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/**
 * The pixel size to downsample a placed image to, or null to keep it:
 * images above `above` ppi (at their placed size) go to `ppi`.
 */
export function downsampleSize(node, images) {
  if (!images || images.downsample === 'none' || !(node.width > 0) || !(node.height > 0)) return null;
  const m = node.transform || [1, 0, 0, 1, 0, 0];
  const sx = Math.hypot(m[0], m[1]) || 1;
  const sy = Math.hypot(m[2], m[3]) || 1;
  const ppi = Math.min(72 / sx, 72 / sy);
  if (ppi <= images.above) return null;
  const f = images.ppi / ppi;
  return { w: Math.max(1, Math.round(node.width * f)), h: Math.max(1, Math.round(node.height * f)) };
}

/** Resample RGBA pixels to w x h (average or bicubic-quality smoothing). */
function resamplePixels(px, w, h, mode) {
  try {
    const src = makeCanvas(px.width, px.height);
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(px.width, px.height);
    img.data.set(px.data);
    sctx.putImageData(img, 0, 0);
    const dst = makeCanvas(w, h);
    const d = dst.getContext('2d');
    d.imageSmoothingEnabled = true;
    d.imageSmoothingQuality = mode === 'bicubic' ? 'high' : 'medium';
    d.drawImage(src, 0, 0, w, h);
    const out = d.getImageData(0, 0, w, h).data;
    return out && out.length === w * h * 4 ? { width: w, height: h, data: out } : null;
  } catch {
    return null;
  }
}

/** JPEG bytes of RGBA pixels (alpha ignored: it goes in the soft mask). */
async function encodeJpeg(px, quality) {
  const canvas = makeCanvas(px.width, px.height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(px.width, px.height);
  img.data.set(px.data);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality }) : await new Promise((r) => (canvas.toBlob ? canvas.toBlob(r, 'image/jpeg', quality) : r(null)));
  if (!blob || blob.type !== 'image/jpeg') return null;
  return new Uint8Array(await blob.arrayBuffer());
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
 * outlinesWanted, background, title, compress, and for print production
 * (see pdf-settings.js): version, colorSpace 'rgb'|'cmyk', profile, spots
 * (Map swatch id -> { name, color }), marks, markType, markWeight,
 * markOffset, pageInfo(rect), layers, thumbnails, images { downsample, ppi,
 * above, compression, quality }, overprint, flatten { balance, ppi },
 * security { userPassword, ownerPassword, permissions }, and for color
 * management:
 *   cmykTransform   ICC transform from document RGB to the output CMYK
 *   cmykNumbers     ICC transform for CMYK numbers paints carry (kept when absent)
 *   iccRGB/iccCMYK  { bytes } of the profile tagging RGB or CMYK output
 *   outputIntent    { name, bytes, n } (or just a name): the printing condition
 *   pdfx            'x1a' | 'x4': PDF/X identification, trim boxes, no
 *                   annotations or thumbnails, strict flattening (X-1a)
 * Returns { bytes: Uint8Array, warnings: string[] }.
 */
export async function writePDF(source, pages, opts = {}) {
  // Freeform fills are drawn natively (as images inside their shapes).
  const doc = exportView(source, { native: ['freeform'] });
  const w = new PDFWriter({ compress: opts.compress !== false, version: opts.version || '1.7' });
  w.id = newDocumentId();
  let encrypt = null;
  if (opts.security) {
    const sh = securityHandler({ ...opts.security, id: w.id });
    encrypt = w.add(sh.dict);
    w.security = { key: sh.key };
  }
  const r = new PDFRenderer(doc, w, opts);
  const catalog = w.alloc();
  const pagesId = w.alloc();
  const kids = [];
  for (const rect of pages) kids.push(await r.page(rect, pagesId));
  await Promise.all(r.pending);
  w.set(pagesId, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const ocgs = [...r.ocgs.values()].map((id) => `${id} 0 R`).join(' ');
  const ocProps = ocgs ? ` /OCProperties << /OCGs [${ocgs}] /D << /Name (Layers) /Order [${ocgs}] /ON [${ocgs}] /OFF [] >> >>` : '';
  const oi = typeof opts.outputIntent === 'string' ? { name: opts.outputIntent } : opts.outputIntent;
  let intent = '';
  if (oi?.name) {
    // A condition described by its own profile is a custom one; the profile travels in the file.
    const dest = oi.bytes ? ` /OutputConditionIdentifier (Custom) /OutputCondition ${pdfText(oi.name)} /RegistryName (http://www.color.org) /DestOutputProfile ${r.iccStream(oi.bytes, oi.n || 4)} 0 R` : ` /OutputConditionIdentifier ${pdfText(oi.name)}`;
    intent = ` /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX${dest} /Info ${pdfText(oi.name)} >>]`;
  }
  const meta = doc.root?.info || {};
  const title = meta.title || opts.title || (opts.pdfx ? 'Untitled' : '');
  const pdfxInfo = { x1a: ' /GTS_PDFXVersion (PDF/X-1:2001) /GTS_PDFXConformance (PDF/X-1a:2001)', x4: ' /GTS_PDFXVersion (PDF/X-4)' }[opts.pdfx] || '';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  // The XMP dates match the information dictionary's (ISO 8601, UTC, whole seconds).
  const isoDate = `${d.toISOString().slice(0, 19)}Z`;
  const metadata = opts.pdfx === 'x4' ? ` /Metadata ${w.addStream('/Type /Metadata /Subtype /XML', xmpPacket({ title, version: 'PDF/X-4', date: isoDate, id: w.id, instance: newDocumentId() }), { compress: false })} 0 R` : '';
  w.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R${ocProps}${intent}${metadata} >>`);
  // File Info metadata (doc.root.info) fills the document information dictionary.
  const list = (v) => (Array.isArray(v) ? v.join('; ') : v);
  const extra = [['Author', list(meta.author)], ['Subject', meta.description], ['Keywords', list(meta.keywords)]].filter(([, v]) => v).map(([k, v]) => `/${k} ${pdfText(v)} `).join('');
  const info = w.add(`<< ${title ? `/Title ${pdfText(title)} ` : ''}${extra}/Producer (Vector Studio) /Creator (Vector Studio) /CreationDate (${date}) /ModDate (${date})${opts.outputIntent || opts.pdfx ? ' /Trapped /False' : ''}${pdfxInfo} >>`);
  const bytes = await w.build({ root: catalog, info, encrypt });
  return { bytes, warnings: [...r.warnings] };
}
