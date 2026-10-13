/**
 * EPS export (PostScript Level 2 or 3).
 *
 * The artwork is first drawn by the PDF writer (so every feature the PDF
 * export supports - live effects rasterized where needed, text outlines,
 * gradients, clipping, arrowheads, stroke alignment - comes out the same),
 * then the page's content stream is translated operator by operator into
 * PostScript with a small procedure set:
 *
 *   paths and painting   moveto/lineto/curveto, fill/eofill/stroke, clip
 *   colors               separate fill and stroke colors (PDF) are set
 *                        before each paint; RGB or CMYK output
 *   gradients            Level 3 shfill / shading patterns; on Level 2
 *                        drawn as fine bands
 *   images               Level 2 image dictionaries with ASCII85 data
 *                        (JPEG passed through with DCTDecode), alpha
 *                        flattened on white
 *   groups               form XObjects inlined in gsave/grestore
 *
 * PostScript has no transparency: opacity and blend modes are dropped (and
 * reported). An optional TIFF preview makes a binary (DOS) EPS file.
 */
import { writePDF } from '../../io/pdf.js';
import { PDFDocument } from '../pdf/document.js';
import { Lexer, Parser, EOF } from '../pdf/lexer.js';
import { PDFDict, PDFStream, Name, Cmd, Ref } from '../pdf/primitives.js';
import { decodeStream } from '../pdf/filters.js';
import { decodeImage } from '../pdf/images.js';
import { parseColorSpace, rgbHex } from '../pdf/colors.js';
import { compileFunction } from '../pdf/functions.js';
import { cmykEngine } from '../../../lib/color.js';

const num = (v) => {
  if (!Number.isFinite(v)) return '0';
  let s = (Math.round(v * 10000) / 10000).toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/** ASCII85 with ~> terminator, wrapped at 76 columns. */
export function ascii85(bytes) {
  let out = '';
  let line = 0;
  const push = (s) => {
    for (const ch of s) {
      out += ch;
      if (++line >= 76) {
        out += '\n';
        line = 0;
      }
    }
  };
  let i = 0;
  for (; i + 4 <= bytes.length; i += 4) {
    const v = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    if (v === 0) {
      push('z');
      continue;
    }
    let s = '';
    let x = v;
    for (let k = 0; k < 5; k++) {
      s = String.fromCharCode((x % 85) + 33) + s;
      x = Math.floor(x / 85);
    }
    push(s);
  }
  const rest = bytes.length - i;
  if (rest) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < rest ? bytes[i + k] : 0);
    let s = '';
    for (let k = 0; k < 5; k++) {
      s = String.fromCharCode((v % 85) + 33) + s;
      v = Math.floor(v / 85);
    }
    push(s.slice(0, rest + 1));
  }
  return `${out}~>`;
}

function psString(s) {
  let out = '(';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) & 255;
    if (c === 40 || c === 41 || c === 92) out += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(c);
  }
  return `${out})`;
}

/** A PDF object written as PostScript (dictionaries become << >> literals). */
function psObject(v, xref, depth = 0) {
  if (depth > 20) return 'null';
  if (v instanceof Ref) return psObject(xref.fetch(v), xref, depth + 1);
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return psString(v);
  if (v instanceof Name) return `/${v.name}`;
  if (Array.isArray(v)) return `[${v.map((x) => psObject(x, xref, depth + 1)).join(' ')}]`;
  if (v instanceof PDFStream) return psObject(v.dict, xref, depth + 1);
  if (v instanceof PDFDict) return `<<${v.keys().map((k) => ` /${k} ${psObject(v.getRaw(k), xref, depth + 1)}`).join('')} >>`;
  return 'null';
}

const PROLOG = `/VSdict 80 dict def VSdict begin
/bd {bind def} bind def
/m {moveto} bd /l {lineto} bd /c {curveto} bd
/v {currentpoint 6 2 roll curveto} bd /y {2 copy curveto} bd
/h {closepath} bd /n {newpath} bd
/re {4 2 roll moveto 1 index 0 rlineto 0 exch rlineto neg 0 rlineto closepath} bd
/q {gsave} bd /Q {grestore} bd /cm {6 array astore concat} bd
/w {setlinewidth} bd /J {setlinecap} bd /j {setlinejoin} bd /M {setmiterlimit} bd /d {setdash} bd
/F {fill} bd /F* {eofill} bd /S {stroke} bd
/W {clip newpath} bd /W* {eoclip newpath} bd
/rgb {setrgbcolor} bd /cmyk {setcmykcolor} bd /gr {setgray} bd
end
`;

class Translator {
  constructor(pdf, opts) {
    this.pdf = pdf;
    this.level = opts.level === 2 ? 2 : 3;
    this.cmyk = opts.colorMode === 'cmyk';
    this.out = [];
    this.warnings = new Set();
    this.depth = 0;
  }

  emit(s) {
    this.out.push(s);
  }

  color(rgb) {
    if (!rgb) return '0 gr';
    const [r, g, b] = rgb;
    if (this.cmyk) {
      const c = cmykEngine.toCmyk({ r: r * 255, g: g * 255, b: b * 255 });
      return `${num(c.c / 100)} ${num(c.m / 100)} ${num(c.y / 100)} ${num(c.k / 100)} cmyk`;
    }
    if (Math.abs(r - g) < 1e-6 && Math.abs(g - b) < 1e-6) return `${num(r)} gr`;
    return `${num(r)} ${num(g)} ${num(b)} rgb`;
  }

  /** Content stream of a page or form. */
  run(bytes, resources) {
    if (++this.depth > 20) {
      this.depth--;
      return;
    }
    const parser = new Parser(new Lexer(bytes), this.pdf, { allowStreams: false });
    let ops = [];
    let clip = null;
    const state = [];
    let st = { fill: [0, 0, 0], stroke: [0, 0, 0], fillPat: null, strokePat: null, fillSpace: null, strokeSpace: null, font: null, size: 12 };
    const paint = (fill, stroke, eo) => {
      const clipOp = clip ? (clip === 'W*' ? 'eoclip' : 'clip') : null;
      const fillOps = () => {
        if (st.fillPat) return `gsave ${this.patternFill(st.fillPat, eo)} grestore`;
        return `${this.color(st.fill)} ${eo ? 'eofill' : 'fill'}`;
      };
      const strokeOps = () => {
        if (st.strokePat) return `${this.patternStroke(st.strokePat)}`;
        return `${this.color(st.stroke)} stroke`;
      };
      let s = '';
      if (fill && stroke) s = `gsave ${fillOps()} grestore ${strokeOps()}`;
      else if (fill) s = fillOps();
      else if (stroke) s = strokeOps();
      if (clipOp) s = s ? `gsave ${s} grestore ${clipOp} newpath` : `${clipOp} newpath`;
      else if (!s) s = 'newpath';
      this.emit(s);
      clip = null;
    };
    for (;;) {
      let obj;
      try {
        obj = parser.getObj();
      } catch {
        break;
      }
      if (obj === EOF) break;
      if (!(obj instanceof Cmd)) {
        ops.push(obj);
        continue;
      }
      const a = ops;
      ops = [];
      const nums = () => a.filter((x) => typeof x === 'number').map(num).join(' ');
      switch (obj.cmd) {
        case 'q':
          state.push({ ...st });
          this.emit('q');
          break;
        case 'Q':
          if (state.length) st = state.pop();
          this.emit('Q');
          break;
        case 'cm':
        case 'w':
        case 'J':
        case 'j':
        case 'M':
        case 'm':
        case 'l':
        case 'c':
        case 'v':
        case 'y':
        case 're':
          this.emit(`${nums()} ${obj.cmd}`);
          break;
        case 'h':
          this.emit('h');
          break;
        case 'd':
          this.emit(`[${(Array.isArray(a[0]) ? a[0] : []).map(num).join(' ')}] ${num(a[1] || 0)} d`);
          break;
        case 'f':
        case 'F':
          paint(true, false, false);
          break;
        case 'f*':
          paint(true, false, true);
          break;
        case 'S':
          paint(false, true, false);
          break;
        case 's':
          this.emit('h');
          paint(false, true, false);
          break;
        case 'B':
          paint(true, true, false);
          break;
        case 'B*':
          paint(true, true, true);
          break;
        case 'b':
          this.emit('h');
          paint(true, true, false);
          break;
        case 'b*':
          this.emit('h');
          paint(true, true, true);
          break;
        case 'n':
          paint(false, false, false);
          break;
        case 'W':
        case 'W*':
          clip = obj.cmd;
          break;
        case 'rg':
        case 'RG':
        case 'g':
        case 'G':
        case 'k':
        case 'K': {
          const comps = a.filter((x) => typeof x === 'number');
          const lower = obj.cmd.toLowerCase();
          const rgb = lower === 'rg' ? comps : lower === 'g' ? [comps[0], comps[0], comps[0]] : (() => {
            const r = cmykEngine.toRgb({ c: comps[0] * 100, m: comps[1] * 100, y: comps[2] * 100, k: comps[3] * 100 });
            return [r.r / 255, r.g / 255, r.b / 255];
          })();
          if (obj.cmd === lower) {
            st.fill = rgb;
            st.fillPat = null;
          } else {
            st.stroke = rgb;
            st.strokePat = null;
          }
          break;
        }
        case 'cs':
        case 'CS': {
          const space = parseColorSpace(this.pdf, a[0], resources);
          if (obj.cmd === 'cs') st.fillSpace = space;
          else st.strokeSpace = space;
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const fill = obj.cmd === 'sc' || obj.cmd === 'scn';
          const last = a[a.length - 1];
          if (last instanceof Name) {
            const pd = resources.get('Pattern');
            const pat = pd instanceof PDFDict ? pd.get(last.name) : null;
            if (fill) st.fillPat = pat;
            else st.strokePat = pat;
          } else {
            const space = (fill ? st.fillSpace : st.strokeSpace) || parseColorSpace(this.pdf, Name.get('DeviceGray'), null);
            const rgb = space.toRGB(a.filter((x) => typeof x === 'number'));
            if (fill) {
              st.fill = rgb;
              st.fillPat = null;
            } else {
              st.stroke = rgb;
              st.strokePat = null;
            }
          }
          break;
        }
        case 'gs': {
          const eg = resources.get('ExtGState');
          const e = eg instanceof PDFDict && a[0] instanceof Name ? eg.get(a[0].name) : null;
          if (e instanceof PDFDict) {
            if ((e.has('ca') && e.get('ca') < 1) || (e.has('CA') && e.get('CA') < 1) || (e.has('BM') && e.name('BM') !== 'Normal')) this.warnings.add('PostScript has no transparency: opacity and blending modes were not kept.');
            if (e.has('LW')) this.emit(`${num(e.get('LW'))} w`);
          }
          break;
        }
        case 'sh': {
          const shd = resources.get('Shading');
          const sh = shd instanceof PDFDict && a[0] instanceof Name ? shd.get(a[0].name) : null;
          if (sh) this.emit(this.shading(sh, 'clippath'));
          break;
        }
        case 'Do': {
          const xo = resources.get('XObject');
          const x = xo instanceof PDFDict && a[0] instanceof Name ? xo.get(a[0].name) : null;
          if (x instanceof PDFStream) {
            const sub = x.dict.name('Subtype');
            if (sub === 'Form') {
              const fm = x.dict.array('Matrix') || [1, 0, 0, 1, 0, 0];
              const bb = x.dict.array('BBox');
              this.emit(`q ${fm.map(num).join(' ')} cm${bb ? ` ${num(bb[0])} ${num(bb[1])} ${num(bb[2] - bb[0])} ${num(bb[3] - bb[1])} re W` : ''}`);
              const saved = st;
              const res = x.dict.get('Resources');
              this.run(x.decoded(), res instanceof PDFDict ? res : resources);
              st = saved;
              this.emit('Q');
            } else if (sub === 'Image') this.image(x, resources, st.fill);
          }
          break;
        }
        case 'BT':
          this.emit('q');
          this.tm = [1, 0, 0, 1, 0, 0];
          break;
        case 'ET':
          this.emit('Q');
          break;
        case 'Tf': {
          const fonts = resources.get('Font');
          const f = fonts instanceof PDFDict && a[0] instanceof Name ? fonts.get(a[0].name) : null;
          const base = f instanceof PDFDict ? f.name('BaseFont', 'Helvetica') : 'Helvetica';
          st.font = base.replace(/^[A-Z]{6}\+/, '');
          st.size = typeof a[1] === 'number' ? a[1] : 12;
          break;
        }
        case 'Tm':
          this.tm = a.filter((x) => typeof x === 'number');
          break;
        case 'Td':
          this.tm = [this.tm[0], this.tm[1], this.tm[2], this.tm[3], this.tm[4] + this.tm[0] * a[0] + this.tm[2] * a[1], this.tm[5] + this.tm[1] * a[0] + this.tm[3] * a[1]];
          break;
        case 'Tj':
        case 'TJ': {
          const parts = obj.cmd === 'TJ' ? (Array.isArray(a[0]) ? a[0].filter((x) => typeof x === 'string') : []) : [a[0]];
          const text = parts.join('');
          if (text) {
            this.emit(`q ${(this.tm || [1, 0, 0, 1, 0, 0]).map(num).join(' ')} cm /${st.font || 'Helvetica'} findfont ${num(st.size)} scalefont setfont 0 0 m ${this.color(st.fill)} ${psString(text)} show Q`);
          }
          break;
        }
        case 'Tr':
        case 'Tc':
        case 'Tw':
        case 'Tz':
        case 'TL':
        case 'Ts':
        case 'BDC':
        case 'BMC':
        case 'EMC':
        case 'MP':
        case 'DP':
        case 'ri':
        case 'i':
          break;
        default:
          break;
      }
    }
    this.depth--;
  }

  functionPS(fnObj) {
    return psObject(fnObj, this.pdf);
  }

  /** Paint a shading inside the current clip. */
  shading(sh, mode) {
    const dict = sh instanceof PDFStream ? sh.dict : sh;
    if (this.level === 3) return `${psObject(dict, this.pdf)} shfill`;
    return this.bands(dict);
  }

  /** Level 2 gradient: bands of interpolated color clipped to the current path. */
  bands(dict) {
    const type = dict.num('ShadingType', 2);
    const space = parseColorSpace(this.pdf, dict.get('ColorSpace'), null);
    const fn = compileFunction(this.pdf, dict.get('Function'));
    const coords = dict.array('Coords') || [];
    const domain = dict.array('Domain') || [0, 1];
    const at = (t) => space.toRGB(fn ? fn([domain[0] + t * (domain[1] - domain[0])]) : [t]);
    const N = 128;
    const out = [];
    if (type === 2) {
      const [x0, y0, x1, y1] = coords;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      // In the gradient's frame: x along the axis; extend far beyond both ends.
      out.push(`q ${num(x0)} ${num(y0)} translate ${num(ang)} rotate`);
      const big = 1e5;
      out.push(`${this.color(at(0))} ${num(-big)} ${num(-big)} ${num(big)} ${num(2 * big)} re F`);
      for (let i = 0; i < N; i++) out.push(`${this.color(at((i + 0.5) / N))} ${num((i * len) / N)} ${num(-big)} ${num(len / N + 0.01)} ${num(2 * big)} re F`);
      out.push(`${this.color(at(1))} ${num(len)} ${num(-big)} ${num(big)} ${num(2 * big)} re F Q`);
    } else if (type === 3) {
      const [x0, y0, r0, x1, y1, r1] = coords;
      out.push(`${this.color(at(1))} clippath F`);
      for (let i = N; i >= 0; i--) {
        const t = i / N;
        const cx = x0 + (x1 - x0) * t;
        const cy = y0 + (y1 - y0) * t;
        const r = r0 + (r1 - r0) * t;
        out.push(`${this.color(at(t))} newpath ${num(cx)} ${num(cy)} ${num(Math.max(0, r))} 0 360 arc F`);
      }
    } else {
      out.push(`${this.color(at(0.5))} clippath F`);
    }
    return out.join('\n');
  }

  patternFill(pat, eo) {
    const d = pat instanceof PDFStream ? pat.dict : pat;
    if (!(d instanceof PDFDict) || d.num('PatternType', 1) !== 2) return `0.5 gr ${eo ? 'eofill' : 'fill'}`;
    const m = d.array('Matrix') || [1, 0, 0, 1, 0, 0];
    // The pattern matrix maps to the page's default space: undo the current transform first.
    return `${eo ? 'eoclip' : 'clip'} newpath VSpage setmatrix ${m.map(num).join(' ')} cm\n${this.shading(d.get('Shading'))}`;
  }

  patternStroke(pat) {
    const d = pat instanceof PDFStream ? pat.dict : pat;
    if (!(d instanceof PDFDict) || d.num('PatternType', 1) !== 2) return '0.5 gr stroke';
    if (this.level === 3) {
      const m = d.array('Matrix') || [1, 0, 0, 1, 0, 0];
      return `gsave VSpage setmatrix << /PatternType 2 /Shading ${psObject(d.get('Shading'), this.pdf)} >> [${m.map(num).join(' ')}] makepattern grestore setpattern stroke`;
    }
    // Level 2: the gradient's middle color.
    const sh = d.get('Shading');
    const sd = sh instanceof PDFStream ? sh.dict : sh;
    const space = parseColorSpace(this.pdf, sd?.get?.('ColorSpace'), null);
    const fn = compileFunction(this.pdf, sd?.get?.('Function'));
    return `${this.color(space.toRGB(fn ? fn([0.5]) : [0.5]))} stroke`;
  }

  image(x, resources, fill) {
    const d = x.dict;
    let img;
    try {
      img = decodeImage(this.pdf, x, resources, { fillRGB: fill });
    } catch {
      img = null;
    }
    if (!img || img.kind === 'unsupported') return;
    const W = img.width;
    const H = img.height;
    if (img.kind === 'jpeg' && !img.alpha) {
      const cs = d.get('ColorSpace');
      const n = cs instanceof Name ? (cs.name === 'DeviceCMYK' ? 4 : cs.name === 'DeviceGray' ? 1 : 3) : parseColorSpace(this.pdf, cs, resources).n || 3;
      const space = n === 4 ? '/DeviceCMYK' : n === 1 ? '/DeviceGray' : '/DeviceRGB';
      const own = d.array('Decode');
      const decode = own ? `[${own.map(num).join(' ')}]` : `[${new Array(n).fill('0 1').join(' ')}]`;
      this.emit(`q ${space} setcolorspace\n<< /ImageType 1 /Width ${W} /Height ${H} /BitsPerComponent 8 /ImageMatrix [${W} 0 0 -${H} 0 ${H}] /Decode ${decode} /DataSource currentfile /ASCII85Decode filter /DCTDecode filter >> image\n${ascii85(img.bytes)}\nQ`);
      return;
    }
    // RGBA pixels: alpha flattened on white.
    let rgba;
    if (img.kind === 'jpeg') {
      this.warnings.add('A JPEG image with transparency was skipped (PostScript cannot mask it).');
      return;
    }
    rgba = img.data;
    const gray = !this.cmyk && isGray(rgba);
    const n = this.cmyk ? 4 : gray ? 1 : 3;
    const data = new Uint8Array(W * H * n);
    let anyAlpha = false;
    for (let i = 0; i < W * H; i++) {
      const a = rgba[i * 4 + 3] / 255;
      if (a < 1) anyAlpha = true;
      const r = rgba[i * 4] * a + 255 * (1 - a);
      const g = rgba[i * 4 + 1] * a + 255 * (1 - a);
      const b = rgba[i * 4 + 2] * a + 255 * (1 - a);
      if (n === 1) data[i] = Math.round(r);
      else if (n === 3) {
        data[i * 3] = r;
        data[i * 3 + 1] = g;
        data[i * 3 + 2] = b;
      } else {
        const c = cmykEngine.toCmyk({ r, g, b });
        data[i * 4] = Math.round((c.c / 100) * 255);
        data[i * 4 + 1] = Math.round((c.m / 100) * 255);
        data[i * 4 + 2] = Math.round((c.y / 100) * 255);
        data[i * 4 + 3] = Math.round((c.k / 100) * 255);
      }
    }
    if (anyAlpha && !img.stencil) this.warnings.add('Image transparency was flattened on white.');
    if (img.stencil) {
      // A stencil: imagemask in the fill color.
      const bits = new Uint8Array(Math.ceil(W / 8) * H);
      const rb = Math.ceil(W / 8);
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) if (rgba[(y * W + xx) * 4 + 3] < 128) bits[y * rb + (xx >> 3)] |= 0x80 >> (xx & 7);
      this.emit(`q ${this.color(fill)}\n<< /ImageType 1 /Width ${W} /Height ${H} /BitsPerComponent 1 /ImageMatrix [${W} 0 0 -${H} 0 ${H}] /Decode [0 1] /DataSource currentfile /ASCII85Decode filter >> imagemask\n${ascii85(bits)}\nQ`);
      return;
    }
    const space = n === 4 ? '/DeviceCMYK' : n === 1 ? '/DeviceGray' : '/DeviceRGB';
    const decode = new Array(n).fill('0 1').join(' ');
    this.emit(`q ${space} setcolorspace\n<< /ImageType 1 /Width ${W} /Height ${H} /BitsPerComponent 8 /ImageMatrix [${W} 0 0 -${H} 0 ${H}] /Decode [${decode}] /DataSource currentfile /ASCII85Decode filter >> image\n${ascii85(data)}\nQ`);
  }
}

function isGray(rgba) {
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) return false;
  return true;
}

/**
 * PostScript text for one region of a document.
 * opts: { rect, ids, level 2|3, colorMode 'rgb'|'cmyk', outlines (Map), title }
 * Returns { text, warnings }.
 */
export async function writeEPS(doc, opts = {}) {
  const rect = opts.rect;
  const { bytes, warnings } = await writePDF(doc, [rect], { ids: opts.ids || null, outlines: opts.outlines, outlinesWanted: Boolean(opts.outlines), title: opts.title, compress: false });
  const out = pdfToPostScript(bytes, { ...opts, title: opts.title || doc.name });
  return { ...out, warnings: [...warnings, ...out.warnings] };
}

/** EPS text for the first page of a PDF file (see writeEPS for options). */
export function pdfToPostScript(bytes, opts = {}) {
  const pdf = new PDFDocument(bytes);
  const page = pdf.pages[0];
  const t = new Translator(pdf, opts);
  t.run(page.contents(), page.resources);
  const box = page.mediaBox;
  const W = box.w;
  const H = box.h;
  const date = new Date().toISOString();
  const title = String(opts.title || 'Untitled').replace(/[\r\n()]/g, ' ');
  const level = t.level;
  const header = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`,
    `%%HiResBoundingBox: 0 0 ${num(W)} ${num(H)}`,
    '%%Creator: Vector Studio',
    `%%Title: (${title})`,
    `%%CreationDate: (${date})`,
    `%%LanguageLevel: ${level}`,
    '%%DocumentData: Clean7Bit',
    '%%Pages: 1',
    '%%EndComments',
    '%%BeginProlog',
    PROLOG.trim(),
    '%%EndProlog',
    '%%BeginSetup',
    '%%EndSetup',
    '%%Page: 1 1',
    'save VSdict begin /VSpage matrix currentmatrix def',
    ...(box.x || box.y ? [`${num(-box.x)} ${num(-box.y)} translate`] : []),
  ];
  const text = `${header.join('\n')}\n${t.out.join('\n')}\nend restore\nshowpage\n%%Trailer\n%%EOF\n`;
  // Keep the file 7-bit clean.
  return { text: text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?'), warnings: [...t.warnings], width: W, height: H };
}

/** Wrap PostScript and a TIFF preview in a binary (DOS) EPS header. */
export function dosEPS(psText, tiff) {
  const ps = new TextEncoder().encode(psText);
  const out = new Uint8Array(30 + ps.length + (tiff ? tiff.length : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xc5d0d3c6, false);
  dv.setUint32(4, 30, true);
  dv.setUint32(8, ps.length, true);
  dv.setUint32(12, 0, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, tiff ? 30 + ps.length : 0, true);
  dv.setUint32(24, tiff ? tiff.length : 0, true);
  dv.setUint16(28, 0xffff, true);
  out.set(ps, 30);
  if (tiff) out.set(tiff, 30 + ps.length);
  return out;
}

export { decodeStream, rgbHex };
