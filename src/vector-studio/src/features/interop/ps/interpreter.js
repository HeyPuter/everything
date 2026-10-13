/**
 * A PostScript interpreter for importing EPS and PS artwork.
 *
 * It runs the program (procedure sets included) with the language's
 * stacks, dictionaries, control flow, strings and arrays, and turns the
 * graphics operators into document nodes: paths with fills, strokes and
 * dashes, clipping (clip groups), gray/RGB/CMYK and separation colors,
 * Level 3 smooth shading (shfill) as gradients, sampled images
 * (image, colorimage, imagemask) with data from procedures, strings or
 * currentfile filters, and text as editable type (fonts are matched by
 * name to the families the app has).
 *
 * Execution is bounded (operation count and nesting) so a hostile or
 * looping file cannot hang the app.
 */
import { PSName, PSString, PSArray, PSDict, PSOp, PSFile, MARK, Scanner, nameOf, hexv, decodeA85 } from './objects.js';
import { Builder } from '../pdf/build.js';
import { createPath, createCompound, createText, createImage, DEFAULT_CHAR } from '../../../model/nodes.js';
import { multiply, invert } from '../../../lib/matrix.js';
import { cmykEngine } from '../../../lib/color.js';
import { rgbHex, parseColorSpace } from '../pdf/colors.js';
import { PDFDict, PDFStream, Name } from '../pdf/primitives.js';
import { shadingToPaint, familyMatcher } from '../pdf/interpret.js';
import { parseFontName } from '../pdf/fonts.js';
import { inflate } from '../codec/zlib.js';
import { lzw as lzwDecode } from '../pdf/filters.js';
import { uid } from '../../../lib/ids.js';

export class PSError extends Error {
  constructor(name, op = '') {
    super(`${name}${op ? ` in ${op}` : ''}`);
    this.psName = name;
  }
}
class Exit {}
class Stop {}
class Quit {}

const app = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const dapp = (m, x, y) => ({ x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y });
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const anchorAt = (p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });

function approxWidth(code) {
  const ch = String.fromCharCode(code);
  if (ch === ' ') return 0.278;
  if (/[il.,:;'!|]/.test(ch)) return 0.25;
  if (/[fjrt()\[\]\-]/.test(ch)) return 0.333;
  if (/[mwMW]/.test(ch)) return 0.833;
  if (/[A-Z]/.test(ch)) return 0.667;
  if (/[0-9]/.test(ch)) return 0.556;
  return 0.52;
}

class GS {
  constructor(ctm) {
    this.ctm = ctm;
    this.path = [];
    this.cur = null;
    this.color = { space: 'gray', comps: [0] };
    this.lw = 1;
    this.cap = 0;
    this.join = 0;
    this.miter = 10;
    this.dash = [];
    this.dashOffset = 0;
    this.font = null;
    this.wraps = [];
    this.clipPath = null;
  }

  clone() {
    const g = Object.create(GS.prototype);
    Object.assign(g, this);
    g.path = this.path.map((s) => ({ anchors: s.anchors.map((a) => ({ ...a })), closed: s.closed }));
    g.cur = this.cur && { ...this.cur };
    g.color = { ...this.color };
    return g;
  }
}

/** Convert a PostScript object to the PDF object model (for shadings and functions). */
function toPDF(v, depth = 0) {
  if (depth > 12) return null;
  if (v instanceof PSName) return Name.get(v.name);
  if (v instanceof PSString) return v.text();
  if (v instanceof PSArray) return v.list().map((x) => toPDF(x, depth + 1));
  if (v instanceof PSDict) {
    const d = new PDFDict(null);
    for (const [k, x] of v.map) d.set(k, toPDF(x, depth + 1));
    const ds = v.get('DataSource');
    if (ds instanceof PSString) return new PDFStream(d, ds.data().slice());
    return d;
  }
  return v;
}

export class PSInterpreter {
  /**
   * opts: { families, base (matrix PS user space -> document), maxOps }
   */
  constructor(bytes, opts = {}) {
    this.bytes = bytes;
    this.opts = opts;
    this.os = [];
    this.out = new Builder();
    this.warnings = new Set();
    this.images = [];
    this.spots = new Map();
    this.families = familyMatcher(opts.families);
    this.ops = 0;
    this.maxOps = opts.maxOps || 3_000_000;
    this.depth = 0;
    this.pages = 0;
    this.gs = new GS(opts.base || [1, 0, 0, -1, 0, 792]);
    this.gstack = [];
    this.base = this.gs.ctm;
    this.systemdict = new PSDict();
    this.userdict = new PSDict();
    this.globaldict = new PSDict();
    this.ds = [this.systemdict, this.globaldict, this.userdict];
    this.fonts = new PSDict();
    this.installOps();
    this.unknown = new Set();
  }

  warn(m) {
    this.warnings.add(m);
  }

  // ---- stacks ----

  push(...v) {
    for (const x of v) this.os.push(x);
    if (this.os.length > 100000) throw new PSError('stackoverflow');
  }

  pop() {
    if (!this.os.length) throw new PSError('stackunderflow');
    return this.os.pop();
  }

  num() {
    const v = this.pop();
    if (typeof v !== 'number') throw new PSError('typecheck');
    return v;
  }

  int() {
    return Math.trunc(this.num());
  }

  bool() {
    const v = this.pop();
    if (typeof v !== 'boolean') throw new PSError('typecheck');
    return v;
  }

  lookup(name) {
    for (let i = this.ds.length - 1; i >= 0; i--) {
      const d = this.ds[i];
      if (d.map.has(name)) return d.map.get(name);
    }
    return undefined;
  }

  // ---- execution ----

  run() {
    const sc = new Scanner(this.bytes);
    this.scanner = sc;
    this.currentfile = new PSFile(sc);
    try {
      for (;;) {
        const t = sc.next();
        if (t === undefined) break;
        this.execToken(t);
      }
    } catch (err) {
      if (!(err instanceof Quit)) {
        if (err instanceof Stop || err instanceof Exit) {
          /* stray stop/exit at top level ends the job */
        } else {
          this.error = err;
        }
      }
    }
    this.out.closeAll();
    return this;
  }

  execToken(t) {
    if (t instanceof PSName && t.exec) this.execName(t.name);
    else if (t && t.immediate !== undefined) {
      const v = this.lookup(t.immediate);
      if (v === undefined) throw new PSError('undefined', t.immediate);
      this.push(v);
    } else this.push(t);
  }

  execName(name) {
    const v = this.lookup(name);
    if (v === undefined) {
      this.unknown.add(name);
      throw new PSError('undefined', name);
    }
    this.exec(v);
  }

  /** Execute an object (as the interpreter would when it meets it executably). */
  exec(v) {
    if (++this.ops > this.maxOps) throw new PSError('limitcheck', 'too many operations');
    if (v instanceof PSOp) return v.fn();
    if (v instanceof PSArray && v.exec) return this.execProc(v);
    if (v instanceof PSName && v.exec) return this.execName(v.name);
    if (v instanceof PSString && v.exec) {
      const sc = new Scanner(v.data());
      for (;;) {
        const t = sc.next();
        if (t === undefined) break;
        this.execToken(t);
      }
      return;
    }
    if (v instanceof PSFile && v.exec) return;
    this.push(v);
  }

  execProc(p) {
    if (++this.depth > 400) {
      this.depth--;
      throw new PSError('execstackoverflow');
    }
    try {
      for (let i = 0; i < p.len; i++) {
        const t = p.get(i);
        if (t instanceof PSName && t.exec) this.execName(t.name);
        else if (t instanceof PSOp) t.fn();
        else if (t && t.immediate !== undefined) this.execToken(t);
        else this.push(t);
      }
    } finally {
      this.depth--;
    }
  }

  // ---- operators ----

  def(name, fn) {
    this.systemdict.set(name, new PSOp(name, fn));
  }

  installOps() {
    const d = (n, f) => this.def(n, f);
    const S = this;
    // stack
    d('pop', () => S.pop());
    d('exch', () => {
      const b = S.pop();
      const a = S.pop();
      S.push(b, a);
    });
    d('dup', () => {
      const a = S.pop();
      S.push(a, a);
    });
    d('copy', () => {
      const top = S.pop();
      if (typeof top === 'number') {
        if (top > S.os.length) throw new PSError('rangecheck');
        S.push(...S.os.slice(S.os.length - top));
      } else {
        const src = S.pop();
        if (src instanceof PSArray && top instanceof PSArray) {
          for (let i = 0; i < src.len; i++) top.set(i, src.get(i));
          S.push(new PSArray(top.items, top.exec, top.off, src.len));
        } else if (src instanceof PSString && top instanceof PSString) {
          for (let i = 0; i < src.len; i++) top.set(i, src.get(i));
          S.push(new PSString(top.bytes, top.off, src.len));
        } else if (src instanceof PSDict && top instanceof PSDict) {
          for (const [k, v] of src.map) top.map.set(k, v);
          S.push(top);
        } else S.push(top);
      }
    });
    d('index', () => {
      const n = S.int();
      if (n < 0 || n >= S.os.length) throw new PSError('rangecheck');
      S.push(S.os[S.os.length - 1 - n]);
    });
    d('roll', () => {
      const j = S.int();
      const n = S.int();
      if (n < 0 || n > S.os.length) throw new PSError('rangecheck');
      if (!n) return;
      const part = S.os.splice(S.os.length - n, n);
      const k = ((j % n) + n) % n;
      S.os.push(...part.slice(n - k), ...part.slice(0, n - k));
    });
    d('clear', () => (S.os.length = 0));
    d('count', () => S.push(S.os.length));
    d('mark', () => S.push(MARK));
    d('[', () => S.push(MARK));
    d('<<', () => S.push(MARK));
    const toMark = () => {
      const i = S.os.lastIndexOf(MARK);
      if (i < 0) throw new PSError('unmatchedmark');
      const items = S.os.splice(i + 1);
      S.os.pop();
      return items;
    };
    d(']', () => S.push(new PSArray(toMark())));
    d('>>', () => {
      const items = toMark();
      const dict = new PSDict();
      for (let i = 0; i + 1 < items.length; i += 2) dict.set(items[i], items[i + 1]);
      S.push(dict);
    });
    d('cleartomark', () => toMark());
    d('counttomark', () => {
      const i = S.os.lastIndexOf(MARK);
      if (i < 0) throw new PSError('unmatchedmark');
      S.push(S.os.length - i - 1);
    });
    // arithmetic
    const bin = (n, f) => d(n, () => {
      const b = S.num();
      const a = S.num();
      S.push(f(a, b));
    });
    bin('add', (a, b) => a + b);
    bin('sub', (a, b) => a - b);
    bin('mul', (a, b) => a * b);
    bin('div', (a, b) => {
      if (!b) throw new PSError('undefinedresult');
      return a / b;
    });
    bin('idiv', (a, b) => {
      if (!b) throw new PSError('undefinedresult');
      return Math.trunc(a / b);
    });
    bin('mod', (a, b) => {
      if (!b) throw new PSError('undefinedresult');
      return Math.trunc(a) % Math.trunc(b);
    });
    bin('atan', (a, b) => {
      let r = (Math.atan2(a, b) * 180) / Math.PI;
      if (r < 0) r += 360;
      return r;
    });
    bin('exp', (a, b) => Math.pow(a, b));
    const un = (n, f) => d(n, () => S.push(f(S.num())));
    un('neg', (a) => -a);
    un('abs', Math.abs);
    un('ceiling', Math.ceil);
    un('floor', Math.floor);
    un('round', (a) => Math.floor(a + 0.5));
    un('truncate', Math.trunc);
    un('sqrt', Math.sqrt);
    un('sin', (a) => Math.sin((a * Math.PI) / 180));
    un('cos', (a) => Math.cos((a * Math.PI) / 180));
    un('ln', Math.log);
    un('log', Math.log10);
    un('cvi', Math.trunc);
    un('cvr', (a) => a);
    let seed = 1;
    d('rand', () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      S.push(seed);
    });
    d('srand', () => (seed = S.int()));
    d('rrand', () => S.push(seed));
    // relational and logic
    const eq = (a, b) => {
      if (a instanceof PSName || a instanceof PSString) a = a instanceof PSName ? a.name : a.text();
      if (b instanceof PSName || b instanceof PSString) b = b instanceof PSName ? b.name : b.text();
      return a === b;
    };
    d('eq', () => {
      const b = S.pop();
      S.push(eq(S.pop(), b));
    });
    d('ne', () => {
      const b = S.pop();
      S.push(!eq(S.pop(), b));
    });
    const cmp = (n, f) => d(n, () => {
      let b = S.pop();
      let a = S.pop();
      if (a instanceof PSString) a = a.text();
      if (b instanceof PSString) b = b.text();
      S.push(f(a, b));
    });
    cmp('gt', (a, b) => a > b);
    cmp('ge', (a, b) => a >= b);
    cmp('lt', (a, b) => a < b);
    cmp('le', (a, b) => a <= b);
    const logic = (n, fb, fi) => d(n, () => {
      const b = S.pop();
      const a = S.pop();
      S.push(typeof a === 'boolean' ? fb(a, b) : fi(a, b));
    });
    logic('and', (a, b) => a && b, (a, b) => a & b);
    logic('or', (a, b) => a || b, (a, b) => a | b);
    logic('xor', (a, b) => a !== b, (a, b) => a ^ b);
    d('not', () => {
      const a = S.pop();
      S.push(typeof a === 'boolean' ? !a : ~a);
    });
    d('bitshift', () => {
      const s = S.int();
      const a = S.int();
      S.push(s >= 0 ? a << s : a >> -s);
    });
    d('true', () => S.push(true));
    d('false', () => S.push(false));
    d('null', () => S.push(null));
    // control
    d('exec', () => S.exec(S.pop()));
    d('if', () => {
      const p = S.pop();
      if (S.bool()) S.exec(p);
    });
    d('ifelse', () => {
      const p2 = S.pop();
      const p1 = S.pop();
      S.exec(S.bool() ? p1 : p2);
    });
    const loopBody = (fn) => {
      try {
        fn();
      } catch (e) {
        if (!(e instanceof Exit)) throw e;
      }
    };
    d('for', () => {
      const p = S.pop();
      const limit = S.num();
      const inc = S.num();
      let i = S.num();
      loopBody(() => {
        let guard = 0;
        for (; inc >= 0 ? i <= limit : i >= limit; i += inc) {
          if (++guard > 1e6 || !inc) break;
          S.push(i);
          S.exec(p);
        }
      });
    });
    d('repeat', () => {
      const p = S.pop();
      const n = S.int();
      loopBody(() => {
        for (let i = 0; i < n; i++) S.exec(p);
      });
    });
    d('loop', () => {
      const p = S.pop();
      loopBody(() => {
        for (let guard = 0; guard < 1e6; guard++) S.exec(p);
      });
    });
    d('exit', () => {
      throw new Exit();
    });
    d('forall', () => {
      const p = S.pop();
      const o = S.pop();
      loopBody(() => {
        if (o instanceof PSArray) for (let i = 0; i < o.len; i++) (S.push(o.get(i)), S.exec(p));
        else if (o instanceof PSString) for (let i = 0; i < o.len; i++) (S.push(o.get(i)), S.exec(p));
        else if (o instanceof PSDict) for (const [k, v] of [...o.map]) (S.push(keyObj(k), v), S.exec(p));
      });
    });
    d('stop', () => {
      throw new Stop();
    });
    d('stopped', () => {
      const p = S.pop();
      const depth = S.depth;
      const gdepth = S.gstack.length;
      try {
        S.exec(p);
        S.push(false);
      } catch (e) {
        if (e instanceof Quit || (e instanceof PSError && e.psName === 'limitcheck')) throw e;
        if (e instanceof Exit) throw e;
        S.depth = depth;
        while (S.gstack.length > gdepth) S.gstack.pop();
        if (e instanceof PSError) {
          const err = S.lookup('$error');
          if (err instanceof PSDict) {
            err.set('errorname', nameOf(e.psName));
            err.set('newerror', true);
          }
        }
        S.push(true);
      }
    });
    d('quit', () => {
      throw new Quit();
    });
    d('countexecstack', () => S.push(S.depth));
    d('execstack', () => S.push(S.pop()));
    // types and conversion
    d('type', () => {
      const v = S.pop();
      const t = typeof v === 'number' ? (Number.isInteger(v) ? 'integertype' : 'realtype') : typeof v === 'boolean' ? 'booleantype' : v instanceof PSName ? 'nametype' : v instanceof PSString ? 'stringtype' : v instanceof PSArray ? (v.exec ? 'arraytype' : 'arraytype') : v instanceof PSDict ? 'dicttype' : v instanceof PSOp ? 'operatortype' : v === MARK ? 'marktype' : v === null ? 'nulltype' : v instanceof PSFile ? 'filetype' : 'savetype';
      S.push(nameOf(t, true));
    });
    d('cvlit', () => {
      const v = S.pop();
      S.push(withExec(v, false));
    });
    d('cvx', () => S.push(withExec(S.pop(), true)));
    d('xcheck', () => {
      const v = S.pop();
      S.push(Boolean(v && v.exec));
    });
    for (const n of ['readonly', 'executeonly', 'noaccess']) d(n, () => {});
    d('rcheck', () => (S.pop(), S.push(true)));
    d('wcheck', () => (S.pop(), S.push(true)));
    d('cvn', () => {
      const v = S.pop();
      S.push(nameOf(v instanceof PSString ? v.text() : String(v), Boolean(v?.exec)));
    });
    d('cvs', () => {
      const str = S.pop();
      const v = S.pop();
      const t = v instanceof PSName ? v.name : v instanceof PSString ? v.text() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v instanceof PSOp ? v.name : '--nostringval--';
      for (let i = 0; i < Math.min(t.length, str.len); i++) str.set(i, t.charCodeAt(i));
      S.push(new PSString(str.bytes, str.off, Math.min(t.length, str.len)));
    });
    d('cvrs', () => {
      const str = S.pop();
      const radix = S.int();
      const v = S.int();
      const t = (v >>> 0).toString(radix).toUpperCase();
      for (let i = 0; i < Math.min(t.length, str.len); i++) str.set(i, t.charCodeAt(i));
      S.push(new PSString(str.bytes, str.off, Math.min(t.length, str.len)));
    });
    // composite objects
    d('string', () => S.push(new PSString(new Uint8Array(Math.max(0, S.int())))));
    d('array', () => S.push(new PSArray(new Array(Math.max(0, S.int())).fill(null))));
    d('dict', () => (S.pop(), S.push(new PSDict())));
    d('length', () => {
      const v = S.pop();
      S.push(v instanceof PSDict ? v.map.size : v instanceof PSName ? v.name.length : v?.len ?? 0);
    });
    d('maxlength', () => (S.pop(), S.push(1000)));
    d('get', () => {
      const k = S.pop();
      const o = S.pop();
      if (o instanceof PSDict) {
        const v = o.get(k);
        if (v === undefined) throw new PSError('undefined', 'get');
        S.push(v);
      } else if (o instanceof PSArray || o instanceof PSString) {
        if (k < 0 || k >= o.len) throw new PSError('rangecheck', 'get');
        S.push(o.get(k));
      } else throw new PSError('typecheck', 'get');
    });
    d('put', () => {
      const v = S.pop();
      const k = S.pop();
      const o = S.pop();
      if (o instanceof PSDict) o.set(k, v);
      else if (o instanceof PSArray || o instanceof PSString) {
        if (k < 0 || k >= o.len) throw new PSError('rangecheck', 'put');
        o.set(k, v);
      }
    });
    d('getinterval', () => {
      const n = S.int();
      const i = S.int();
      const o = S.pop();
      if (i < 0 || n < 0 || i + n > o.len) throw new PSError('rangecheck', 'getinterval');
      S.push(o instanceof PSString ? new PSString(o.bytes, o.off + i, n) : new PSArray(o.items, o.exec, o.off + i, n));
    });
    d('putinterval', () => {
      const src = S.pop();
      const i = S.int();
      const o = S.pop();
      for (let k = 0; k < src.len && i + k < o.len; k++) o.set(i + k, src.get(k));
    });
    d('aload', () => {
      const a = S.pop();
      for (let i = 0; i < a.len; i++) S.push(a.get(i));
      S.push(a);
    });
    d('astore', () => {
      const a = S.pop();
      for (let i = a.len - 1; i >= 0; i--) a.set(i, S.pop());
      S.push(a);
    });
    d('begin', () => {
      const v = S.pop();
      if (!(v instanceof PSDict)) throw new PSError('typecheck', 'begin');
      S.ds.push(v);
    });
    d('end', () => {
      if (S.ds.length > 3) S.ds.pop();
    });
    d('def', () => {
      const v = S.pop();
      const k = S.pop();
      S.ds[S.ds.length - 1].set(k, v);
    });
    d('load', () => {
      const k = S.pop();
      const v = S.lookup(PSDict.key(k));
      if (v === undefined) throw new PSError('undefined', 'load');
      S.push(v);
    });
    d('store', () => {
      const v = S.pop();
      const k = PSDict.key(S.pop());
      for (let i = S.ds.length - 1; i >= 0; i--) {
        if (S.ds[i].map.has(k)) {
          S.ds[i].map.set(k, v);
          return;
        }
      }
      S.ds[S.ds.length - 1].map.set(k, v);
    });
    d('known', () => {
      const k = S.pop();
      const o = S.pop();
      S.push(o instanceof PSDict ? o.has(k) : false);
    });
    d('undef', () => {
      const k = S.pop();
      const o = S.pop();
      if (o instanceof PSDict) o.delete(k);
    });
    d('where', () => {
      const k = PSDict.key(S.pop());
      for (let i = S.ds.length - 1; i >= 0; i--) {
        if (S.ds[i].map.has(k)) {
          S.push(S.ds[i], true);
          return;
        }
      }
      S.push(false);
    });
    d('currentdict', () => S.push(S.ds[S.ds.length - 1]));
    d('countdictstack', () => S.push(S.ds.length));
    d('cleardictstack', () => (S.ds.length = 3));
    d('bind', () => {
      const p = S.pop();
      if (p instanceof PSArray) bindProc(S, p, 0);
      S.push(p);
    });
    d('search', () => {
      const seek = S.pop().text();
      const str = S.pop();
      const t = str.text();
      const i = t.indexOf(seek);
      if (i < 0) S.push(str, false);
      else S.push(new PSString(str.bytes, str.off + i + seek.length, str.len - i - seek.length), new PSString(str.bytes, str.off + i, seek.length), new PSString(str.bytes, str.off, i), true);
    });
    d('anchorsearch', () => {
      const seek = S.pop().text();
      const str = S.pop();
      if (str.text().startsWith(seek)) S.push(new PSString(str.bytes, str.off + seek.length, str.len - seek.length), new PSString(str.bytes, str.off, seek.length), true);
      else S.push(str, false);
    });
    d('token', () => {
      const src = S.pop();
      if (src instanceof PSString) {
        const sc = new Scanner(src.data());
        const t = sc.next();
        if (t === undefined) S.push(false);
        else S.push(new PSString(src.bytes, src.off + sc.pos, src.len - sc.pos), t, true);
      } else S.push(false);
    });
    // dictionaries everyone expects
    for (const [n, dict] of [['systemdict', this.systemdict], ['userdict', this.userdict], ['globaldict', this.globaldict]]) this.systemdict.set(n, dict);
    const statusdict = new PSDict();
    this.systemdict.set('statusdict', statusdict);
    const errordict = new PSDict();
    this.systemdict.set('errordict', errordict);
    const $error = new PSDict();
    $error.set('newerror', false);
    this.systemdict.set('$error', $error);
    this.systemdict.set('FontDirectory', this.fonts);
    this.systemdict.set('GlobalFontDirectory', this.fonts);
    d('languagelevel', () => S.push(3));
    d('version', () => S.push(PSString.from('3010')));
    d('product', () => S.push(PSString.from('Vector Studio')));
    d('revision', () => S.push(1));
    d('serialnumber', () => S.push(0));
    d('realtime', () => S.push(0));
    d('usertime', () => S.push(0));
    d('vmstatus', () => S.push(0, 0, 1e7));
    d('setglobal', () => S.pop());
    d('currentglobal', () => S.push(false));
    d('setshared', () => S.pop());
    d('currentshared', () => S.push(false));
    d('save', () => {
      S.gstack.push(S.gs.clone());
      S.push({ save: S.gstack.length });
    });
    d('restore', () => {
      const s = S.pop();
      if (s && s.save) {
        while (S.gstack.length >= s.save) S.gs = S.gstack.pop();
      }
    });
    d('print', () => S.pop());
    d('=', () => S.pop());
    d('==', () => S.pop());
    d('stack', () => {});
    d('pstack', () => {});
    d('flush', () => {});
    d('echo', () => S.pop());
    d('prompt', () => {});
    d('setpagedevice', () => S.pop());
    d('currentpagedevice', () => S.push(new PSDict()));
    for (const n of ['setflat', 'setsmoothness', 'setstrokeadjust', 'setoverprint', 'setcolorrendering', 'setobjectprintmode', 'setucacheparams', 'setvmthreshold', 'setcachelimit', 'setpacking', 'setuserparams', 'setsystemparams', 'setdevparams', 'setblackgeneration', 'setundercolorremoval', 'settransfer', 'sethalftone', 'setcolortransfer', 'setaccuratescreens']) d(n, () => S.pop());
    d('setscreen', () => (S.pop(), S.pop(), S.pop()));
    d('setcolorscreen', () => {
      for (let i = 0; i < 12; i++) S.pop();
    });
    d('currentflat', () => S.push(1));
    d('currentscreen', () => S.push(60, 45, new PSArray([], true)));
    d('currenttransfer', () => S.push(new PSArray([], true)));
    d('currenthalftone', () => S.push(new PSDict()));
    d('currentoverprint', () => S.push(false));
    d('currentpacking', () => S.push(false));
    d('setpacking', () => S.pop());
    d('currentuserparams', () => S.push(new PSDict()));
    d('currentsystemparams', () => S.push(new PSDict()));
    d('findresource', () => {
      const cat = S.pop();
      const key = S.pop();
      const c = cat instanceof PSName ? cat.name : '';
      if (c === 'Font') {
        S.push(key);
        S.execName('findfont');
        return;
      }
      if (c === 'ProcSet' || c === 'Category') {
        const v = S.lookup(`res:${c}:${PSDict.key(key)}`);
        if (v !== undefined) {
          S.push(v);
          return;
        }
      }
      throw new PSError('undefinedresource', String(PSDict.key(key)));
    });
    d('defineresource', () => {
      const cat = S.pop();
      const inst = S.pop();
      const key = S.pop();
      S.systemdict.set(`res:${cat instanceof PSName ? cat.name : ''}:${PSDict.key(key)}`, inst);
      S.push(inst);
    });
    d('resourcestatus', () => {
      const cat = S.pop();
      const key = S.pop();
      if (S.lookup(`res:${cat instanceof PSName ? cat.name : ''}:${PSDict.key(key)}`) !== undefined) S.push(0, 0, true);
      else S.push(false);
    });
    d('undefineresource', () => (S.pop(), S.pop()));
    d('resourceforall', () => (S.pop(), S.pop(), S.pop(), S.pop()));
    d('showpage', () => {
      S.pages++;
    });
    d('copypage', () => {});
    d('erasepage', () => {});
    // files
    d('currentfile', () => S.push(S.currentfile));
    d('file', () => {
      S.pop();
      S.pop();
      throw new PSError('invalidfileaccess', 'file');
    });
    d('closefile', () => {
      const f = S.pop();
      if (f instanceof PSFile && f !== S.currentfile) f.source.pos = f.source.end;
    });
    d('flushfile', () => {
      const f = S.pop();
      if (f === S.currentfile) S.scanner.pos = S.scanner.end;
      else if (f instanceof PSFile) f.source.pos = f.source.end;
    });
    d('readhexstring', () => {
      const str = S.pop();
      const f = S.pop();
      let n = 0;
      let hi = -1;
      while (n < str.len) {
        const c = f.read();
        if (c < 0) break;
        const v = hexv(c);
        if (v < 0) continue;
        if (hi < 0) hi = v;
        else {
          str.set(n++, (hi << 4) | v);
          hi = -1;
        }
      }
      S.push(new PSString(str.bytes, str.off, n), n === str.len);
    });
    d('readstring', () => {
      const str = S.pop();
      const f = S.pop();
      let n = 0;
      while (n < str.len) {
        const c = f.read();
        if (c < 0) break;
        str.set(n++, c);
      }
      S.push(new PSString(str.bytes, str.off, n), n === str.len);
    });
    d('readline', () => {
      const str = S.pop();
      const f = S.pop();
      let n = 0;
      for (;;) {
        const c = f.read();
        if (c < 0 || c === 10) break;
        if (c === 13) {
          if (f.source.bytes[f.source.pos] === 10) f.read();
          break;
        }
        if (n < str.len) str.set(n++, c);
      }
      S.push(new PSString(str.bytes, str.off, n), true);
    });
    d('read', () => {
      const f = S.pop();
      const c = f.read();
      if (c < 0) S.push(false);
      else S.push(c, true);
    });
    d('bytesavailable', () => {
      const f = S.pop();
      S.push(f.source.end - f.source.pos);
    });
    d('filter', () => S.filter());
    // graphics state
    d('gsave', () => {
      S.gstack.push(S.gs);
      S.gs = S.gs.clone();
    });
    d('grestore', () => {
      if (S.gstack.length) S.gs = S.gstack.pop();
    });
    d('grestoreall', () => {
      if (S.gstack.length) S.gs = S.gstack[0];
      S.gstack.length = 0;
    });
    d('initgraphics', () => {
      S.gs = new GS(S.base);
    });
    d('setlinewidth', () => (S.gs.lw = S.num()));
    d('currentlinewidth', () => S.push(S.gs.lw));
    d('setlinecap', () => (S.gs.cap = S.int()));
    d('currentlinecap', () => S.push(S.gs.cap));
    d('setlinejoin', () => (S.gs.join = S.int()));
    d('currentlinejoin', () => S.push(S.gs.join));
    d('setmiterlimit', () => (S.gs.miter = S.num()));
    d('currentmiterlimit', () => S.push(S.gs.miter));
    d('setdash', () => {
      S.gs.dashOffset = S.num();
      const a = S.pop();
      S.gs.dash = a instanceof PSArray ? a.list().filter((x) => typeof x === 'number') : [];
    });
    d('currentdash', () => S.push(new PSArray(S.gs.dash.slice()), S.gs.dashOffset));
    d('setgray', () => (S.gs.color = { space: 'gray', comps: [S.num()] }));
    d('setrgbcolor', () => {
      const b = S.num();
      const g = S.num();
      S.gs.color = { space: 'rgb', comps: [S.num(), g, b] };
    });
    d('sethsbcolor', () => {
      const b = S.num();
      const s = S.num();
      const h = S.num();
      S.gs.color = { space: 'rgb', comps: hsbToRgb(h, s, b) };
    });
    d('setcmykcolor', () => {
      const k = S.num();
      const y = S.num();
      const m = S.num();
      S.gs.color = { space: 'cmyk', comps: [S.num(), m, y, k] };
    });
    d('currentgray', () => {
      const [r, g, b] = S.rgb();
      S.push(0.3 * r + 0.59 * g + 0.11 * b);
    });
    d('currentrgbcolor', () => S.push(...S.rgb()));
    d('currentcmykcolor', () => {
      const c = S.gs.color;
      if (c.space === 'cmyk') S.push(...c.comps);
      else {
        const [r, g, b] = S.rgb();
        const k = 1 - Math.max(r, g, b);
        S.push(k < 1 ? (1 - r - k) / (1 - k) : 0, k < 1 ? (1 - g - k) / (1 - k) : 0, k < 1 ? (1 - b - k) / (1 - k) : 0, k);
      }
    });
    d('currenthsbcolor', () => S.push(0, 0, S.rgb()[0]));
    d('setcolorspace', () => {
      const cs = S.pop();
      S.gs.color = S.colorSpace(cs);
    });
    d('currentcolorspace', () => S.push(new PSArray([nameOf(S.gs.color.space === 'cmyk' ? 'DeviceCMYK' : S.gs.color.space === 'rgb' ? 'DeviceRGB' : 'DeviceGray')])));
    d('setcolor', () => {
      const c = S.gs.color;
      if (c.space === 'pattern') {
        const p = S.pop();
        S.gs.color = { ...c, pattern: p };
        return;
      }
      const n = c.n || { gray: 1, rgb: 3, cmyk: 4 }[c.space] || 1;
      const comps = [];
      for (let i = 0; i < n; i++) comps.unshift(S.num());
      S.gs.color = { ...c, comps };
    });
    d('currentcolor', () => S.push(...S.gs.color.comps));
    d('setpattern', () => {
      const p = S.pop();
      S.gs.color = { space: 'pattern', comps: [], pattern: p };
    });
    d('makepattern', () => {
      const m = S.pop();
      const p = S.pop();
      const out = new PSDict();
      for (const [k, v] of p.map) out.map.set(k, v);
      out.set('Implementation', new PSArray([m, S.gs.ctm.slice()]));
      S.push(out);
    });
    // matrices
    d('matrix', () => S.push(new PSArray([1, 0, 0, 1, 0, 0])));
    d('identmatrix', () => {
      const m = S.pop();
      [1, 0, 0, 1, 0, 0].forEach((v, i) => m.set(i, v));
      S.push(m);
    });
    d('currentmatrix', () => {
      const m = S.pop();
      const c = multiply(invert(S.base), S.gs.ctm);
      c.forEach((v, i) => m.set(i, v));
      S.push(m);
    });
    d('setmatrix', () => {
      const m = S.matrix(S.pop());
      S.gs.ctm = multiply(S.base, m);
    });
    d('defaultmatrix', () => {
      const m = S.pop();
      [1, 0, 0, 1, 0, 0].forEach((v, i) => m.set(i, v));
      S.push(m);
    });
    d('concat', () => (S.gs.ctm = multiply(S.gs.ctm, S.matrix(S.pop()))));
    const matOp = (name, make) =>
      d(name, () => {
        const top = S.pop();
        if (top instanceof PSArray) {
          const m = make();
          m.forEach((v, i) => top.set(i, v));
          S.push(top);
        } else {
          S.push(top);
          S.gs.ctm = multiply(S.gs.ctm, make());
        }
      });
    matOp('translate', () => {
      const ty = S.num();
      const tx = S.num();
      return [1, 0, 0, 1, tx, ty];
    });
    matOp('scale', () => {
      const sy = S.num();
      const sx = S.num();
      return [sx, 0, 0, sy, 0, 0];
    });
    matOp('rotate', () => {
      const a = (S.num() * Math.PI) / 180;
      return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    });
    d('concatmatrix', () => {
      const m3 = S.pop();
      const m2 = S.matrix(S.pop());
      const m1 = S.matrix(S.pop());
      multiply(m2, m1).forEach((v, i) => m3.set(i, v));
      S.push(m3);
    });
    d('invertmatrix', () => {
      const m2 = S.pop();
      invert(S.matrix(S.pop())).forEach((v, i) => m2.set(i, v));
      S.push(m2);
    });
    const userCtm = () => multiply(invert(S.base), S.gs.ctm);
    const xform = (name, f) =>
      d(name, () => {
        let m = null;
        const top = S.pop();
        if (top instanceof PSArray) m = S.matrix(top);
        else S.push(top);
        const y = S.num();
        const x = S.num();
        const p = f(m || userCtm(), x, y);
        S.push(p.x, p.y);
      });
    xform('transform', (m, x, y) => app(m, x, y));
    xform('itransform', (m, x, y) => app(invert(m), x, y));
    xform('dtransform', (m, x, y) => dapp(m, x, y));
    xform('idtransform', (m, x, y) => dapp(invert(m), x, y));
    // paths
    d('newpath', () => {
      S.gs.path = [];
      S.gs.cur = null;
    });
    d('currentpoint', () => {
      if (!S.gs.cur) throw new PSError('nocurrentpoint');
      const p = app(invert(S.gs.ctm), S.gs.cur.x, S.gs.cur.y);
      S.push(p.x, p.y);
    });
    d('moveto', () => {
      const y = S.num();
      S.moveTo(S.num(), y);
    });
    d('rmoveto', () => {
      const dy = S.num();
      const dx = S.num();
      const c = S.userPoint();
      S.moveTo(c.x + dx, c.y + dy);
    });
    d('lineto', () => {
      const y = S.num();
      S.lineTo(S.num(), y);
    });
    d('rlineto', () => {
      const dy = S.num();
      const dx = S.num();
      const c = S.userPoint();
      S.lineTo(c.x + dx, c.y + dy);
    });
    d('curveto', () => {
      const y3 = S.num();
      const x3 = S.num();
      const y2 = S.num();
      const x2 = S.num();
      const y1 = S.num();
      S.curveTo(S.num(), y1, x2, y2, x3, y3);
    });
    d('rcurveto', () => {
      const y3 = S.num();
      const x3 = S.num();
      const y2 = S.num();
      const x2 = S.num();
      const y1 = S.num();
      const x1 = S.num();
      const c = S.userPoint();
      S.curveTo(c.x + x1, c.y + y1, c.x + x2, c.y + y2, c.x + x3, c.y + y3);
    });
    d('closepath', () => S.closePath());
    d('arc', () => S.arc(false));
    d('arcn', () => S.arc(true));
    d('arct', () => S.arct(false));
    d('arcto', () => S.arct(true));
    d('flattenpath', () => {});
    d('reversepath', () => {});
    d('strokepath', () => {});
    d('clippath', () => {
      S.gs.path = S.gs.clipPath ? S.gs.clipPath.map((s) => ({ anchors: s.anchors.map((a) => ({ ...a })), closed: true })) : S.pageRect();
    });
    d('pathbbox', () => {
      let r = null;
      const inv = invert(S.gs.ctm);
      for (const s of S.gs.path) {
        for (const a of s.anchors) {
          for (const [x, y] of [[a.x, a.y], [a.ix, a.iy], [a.ox, a.oy]]) {
            const p = app(inv, x, y);
            r = r ? [Math.min(r[0], p.x), Math.min(r[1], p.y), Math.max(r[2], p.x), Math.max(r[3], p.y)] : [p.x, p.y, p.x, p.y];
          }
        }
      }
      if (!r) throw new PSError('nocurrentpoint', 'pathbbox');
      S.push(...r);
    });
    d('fill', () => S.paint(true, false, false));
    d('eofill', () => S.paint(true, false, true));
    d('stroke', () => S.paint(false, true, false));
    d('clip', () => S.clip(false));
    d('eoclip', () => S.clip(true));
    d('initclip', () => {
      S.gs.wraps = [];
      S.gs.clipPath = null;
    });
    const rects = () => {
      const top = S.pop();
      if (top instanceof PSArray) {
        const v = top.list();
        const out = [];
        for (let i = 0; i + 3 < v.length; i += 4) out.push(v.slice(i, i + 4));
        return out;
      }
      const h = top;
      const w = S.num();
      const y = S.num();
      const x = S.num();
      return [[x, y, w, h]];
    };
    const rectPath = (list) => {
      const saved = S.gs.path;
      S.gs.path = [];
      for (const [x, y, w, h] of list) {
        S.moveTo(x, y);
        S.lineTo(x + w, y);
        S.lineTo(x + w, y + h);
        S.lineTo(x, y + h);
        S.closePath();
      }
      return saved;
    };
    d('rectfill', () => {
      const saved = rectPath(rects());
      S.paint(true, false, false);
      S.gs.path = saved;
    });
    d('rectstroke', () => {
      // An optional matrix operand (six numbers after the rectangles) is ignored.
      const saved = rectPath(rects());
      S.paint(false, true, false);
      S.gs.path = saved;
    });
    d('rectclip', () => {
      rectPath(rects());
      S.clip(false);
    });
    d('shfill', () => S.shfill(S.pop()));
    // fonts and text
    d('findfont', () => {
      const key = S.pop();
      const name = key instanceof PSName ? key.name : key instanceof PSString ? key.text() : 'Helvetica';
      let f = S.fonts.get(name);
      if (!f) {
        f = new PSDict();
        f.set('FontName', nameOf(name));
        f.set('FontMatrix', new PSArray([0.001, 0, 0, 0.001, 0, 0]));
        f.set('FontType', 1);
        f.set('Encoding', new PSArray([]));
        f.set('FID', 0);
        S.fonts.set(name, f);
      }
      S.push(f);
    });
    d('definefont', () => {
      const f = S.pop();
      const k = S.pop();
      if (f instanceof PSDict) {
        if (!f.has('FontName')) f.set('FontName', k instanceof PSName ? k : nameOf(String(PSDict.key(k))));
        S.fonts.set(k, f);
      }
      S.push(f);
    });
    d('undefinefont', () => S.pop());
    const scaledFont = (f, m) => {
      const out = new PSDict();
      for (const [k, v] of f.map) out.map.set(k, v);
      const fm = f.get('FontMatrix') instanceof PSArray ? S.matrix(f.get('FontMatrix')) : [0.001, 0, 0, 0.001, 0, 0];
      out.set('FontMatrix', new PSArray(multiply(m, fm)));
      return out;
    };
    d('scalefont', () => {
      const s = S.num();
      S.push(scaledFont(S.pop(), [s, 0, 0, s, 0, 0]));
    });
    d('makefont', () => {
      const m = S.matrix(S.pop());
      S.push(scaledFont(S.pop(), m));
    });
    d('setfont', () => (S.gs.font = S.pop()));
    d('currentfont', () => S.push(S.gs.font || S.defaultFont()));
    d('rootfont', () => S.push(S.gs.font || S.defaultFont()));
    d('selectfont', () => {
      const s = S.pop();
      S.execName('findfont');
      const f = S.pop();
      S.gs.font = scaledFont(f, s instanceof PSArray ? S.matrix(s) : [s, 0, 0, s, 0, 0]);
    });
    d('show', () => S.show(S.pop()));
    d('ashow', () => {
      const str = S.pop();
      const ay = S.num();
      const ax = S.num();
      S.show(str, { ax, ay });
    });
    d('widthshow', () => {
      const str = S.pop();
      const ch = S.int();
      const cy = S.num();
      const cx = S.num();
      S.show(str, { cx, cy, ch });
    });
    d('awidthshow', () => {
      const str = S.pop();
      const ay = S.num();
      const ax = S.num();
      const ch = S.int();
      const cy = S.num();
      const cx = S.num();
      S.show(str, { ax, ay, cx, cy, ch });
    });
    d('xshow', () => {
      const w = S.pop();
      S.show(S.pop(), { widths: S.numbers(w), mode: 'x' });
    });
    d('yshow', () => {
      const w = S.pop();
      S.show(S.pop(), { widths: S.numbers(w), mode: 'y' });
    });
    d('xyshow', () => {
      const w = S.pop();
      S.show(S.pop(), { widths: S.numbers(w), mode: 'xy' });
    });
    d('kshow', () => {
      const str = S.pop();
      S.pop();
      S.show(str);
    });
    d('glyphshow', () => {
      const n = S.pop();
      S.show(PSString.from(n instanceof PSName && n.name.length === 1 ? n.name : ' '));
    });
    d('cshow', () => {
      const str = S.pop();
      S.pop();
      S.show(str);
    });
    d('stringwidth', () => {
      const str = S.pop();
      const f = S.gs.font || S.defaultFont();
      const fm = S.matrix(f.get('FontMatrix'));
      let w = 0;
      for (let i = 0; i < str.len; i++) w += approxWidth(str.get(i)) * 1000;
      const p = dapp(fm, w, 0);
      S.push(p.x, p.y);
    });
    d('charpath', () => {
      S.pop();
      const str = S.pop();
      S.warn('Text converted to paths in the file (charpath) could not be imported as outlines; it was kept as type.');
      S.show(str);
    });
    d('setcachedevice', () => {
      for (let i = 0; i < 6; i++) S.pop();
    });
    d('setcachedevice2', () => {
      for (let i = 0; i < 10; i++) S.pop();
    });
    d('setcharwidth', () => (S.pop(), S.pop()));
    // images
    d('image', () => S.image('image'));
    d('imagemask', () => S.image('imagemask'));
    d('colorimage', () => S.image('colorimage'));
    // errors: let handlers be called by name
    d('handleerror', () => {});
    for (const n of ['undefined', 'typecheck', 'rangecheck', 'stackunderflow', 'invalidaccess', 'undefinedresult', 'limitcheck', 'nocurrentpoint', 'unmatchedmark', 'ioerror', 'syntaxerror', 'invalidfont', 'undefinedresource', 'VMerror', 'interrupt', 'timeout', 'dictstackunderflow', 'execstackoverflow', 'invalidexit', 'invalidfileaccess', 'invalidrestore', 'unregistered', 'configurationerror']) {
      errordict.set(n, new PSOp(n, () => {
        throw new Stop();
      }));
    }
    // Common setup files test for these.
    d('setsmoothness', () => S.pop());
    d('currentsmoothness', () => S.push(0.02));
    d('sethalftonephase', () => (S.pop(), S.pop()));
    d('setstrokeadjust', () => S.pop());
    d('currentstrokeadjust', () => S.push(false));
  }

  // ---- helpers ----

  numbers(v) {
    if (v instanceof PSArray) return v.list().filter((x) => typeof x === 'number');
    if (v instanceof PSString) {
      // Encoded number strings are rare; treat as empty.
      return [];
    }
    return [];
  }

  matrix(a) {
    if (!(a instanceof PSArray) || a.len < 6) throw new PSError('typecheck', 'matrix');
    return [0, 1, 2, 3, 4, 5].map((i) => {
      const v = a.get(i);
      return typeof v === 'number' ? v : 0;
    });
  }

  defaultFont() {
    this.push(nameOf('Helvetica'));
    this.execName('findfont');
    const f = this.pop();
    const out = new PSDict();
    for (const [k, v] of f.map) out.map.set(k, v);
    out.set('FontMatrix', new PSArray([0.012, 0, 0, 0.012, 0, 0]));
    return out;
  }

  rgb() {
    return this.colorRGB(this.gs.color);
  }

  colorRGB(c) {
    const comps = c.comps || [];
    if (c.space === 'gray') return [comps[0] ?? 0, comps[0] ?? 0, comps[0] ?? 0];
    if (c.space === 'rgb') return [comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0];
    if (c.space === 'cmyk') {
      const r = cmykEngine.toRgb({ c: (comps[0] ?? 0) * 100, m: (comps[1] ?? 0) * 100, y: (comps[2] ?? 0) * 100, k: (comps[3] ?? 0) * 100 });
      return [r.r / 255, r.g / 255, r.b / 255];
    }
    if (c.pdfSpace) return c.pdfSpace.toRGB(comps.length ? comps : c.pdfSpace.initial);
    return [0, 0, 0];
  }

  colorSpace(cs) {
    const fam = cs instanceof PSName ? cs.name : cs instanceof PSArray && cs.get(0) instanceof PSName ? cs.get(0).name : '';
    if (fam === 'DeviceGray' || fam === 'CIEBasedA') return { space: 'gray', comps: [0] };
    if (fam === 'DeviceRGB' || fam === 'CIEBasedABC') return { space: 'rgb', comps: [0, 0, 0] };
    if (fam === 'DeviceCMYK' || fam === 'CIEBasedDEFG') return { space: 'cmyk', comps: [0, 0, 0, 1] };
    if (fam === 'Pattern') return { space: 'pattern', comps: [] };
    // Separation, DeviceN, Indexed: through the PDF color code (tint transforms are procedures here).
    if (fam === 'Separation' || fam === 'DeviceN' || fam === 'Indexed') {
      const arr = cs.list();
      const conv = arr.map((x, i) => {
        if (x instanceof PSArray && x.exec) return null;
        // Ink names may be strings in PostScript.
        if (i === 1 && fam === 'Separation' && x instanceof PSString) return Name.get(x.text());
        if (i === 1 && fam === 'DeviceN' && x instanceof PSArray) return x.list().map((n) => Name.get(n instanceof PSString ? n.text() : n?.name || ''));
        return toPDF(x);
      });
      const tint = arr.find((x) => x instanceof PSArray && x.exec);
      let space;
      try {
        space = parseColorSpace(null, conv, null);
      } catch {
        space = null;
      }
      if (space && (fam === 'Separation' || fam === 'DeviceN') && tint) {
        // Run the tint procedure in this interpreter.
        const alt = parseColorSpace(null, conv[2], null);
        const run = (comps) => {
          const before = this.os.length;
          try {
            this.push(...comps);
            this.exec(tint);
            const out = this.os.splice(before);
            return out.filter((v) => typeof v === 'number');
          } catch {
            this.os.length = before;
            return alt.initial;
          }
        };
        const n = space.n;
        const toRGB = (c) => alt.toRGB(run(c.slice(0, n)));
        const spot = fam === 'Separation' && space.spot ? { ...space.spot, rgb: toRGB([1]) } : space.spot;
        space = { ...space, toRGB, spot };
      }
      if (space) return { space: 'pdf', pdfSpace: space, comps: space.initial.slice(), n: space.n };
    }
    return { space: 'gray', comps: [0] };
  }

  userPoint() {
    if (!this.gs.cur) throw new PSError('nocurrentpoint');
    return app(invert(this.gs.ctm), this.gs.cur.x, this.gs.cur.y);
  }

  pageRect() {
    const b = this.opts.bbox || { x: 0, y: 0, w: 612, h: 792 };
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => anchorAt(app(this.base, x, y)));
    return [{ anchors: pts, closed: true }];
  }

  moveTo(x, y) {
    const p = app(this.gs.ctm, x, y);
    const last = this.gs.path[this.gs.path.length - 1];
    if (last && last.anchors.length === 1 && !last.closed) this.gs.path.pop();
    this.gs.path.push({ anchors: [anchorAt(p)], closed: false });
    this.gs.cur = p;
  }

  lineTo(x, y) {
    if (!this.gs.cur) throw new PSError('nocurrentpoint', 'lineto');
    let sp = this.gs.path[this.gs.path.length - 1];
    if (!sp || sp.closed) {
      sp = { anchors: [anchorAt(this.gs.cur)], closed: false };
      this.gs.path.push(sp);
    }
    const p = app(this.gs.ctm, x, y);
    sp.anchors.push(anchorAt(p));
    this.gs.cur = p;
  }

  curveTo(x1, y1, x2, y2, x3, y3) {
    if (!this.gs.cur) throw new PSError('nocurrentpoint', 'curveto');
    let sp = this.gs.path[this.gs.path.length - 1];
    if (!sp || sp.closed) {
      sp = { anchors: [anchorAt(this.gs.cur)], closed: false };
      this.gs.path.push(sp);
    }
    const m = this.gs.ctm;
    const c1 = app(m, x1, y1);
    const c2 = app(m, x2, y2);
    const p = app(m, x3, y3);
    const last = sp.anchors[sp.anchors.length - 1];
    last.ox = c1.x;
    last.oy = c1.y;
    sp.anchors.push({ x: p.x, y: p.y, ix: c2.x, iy: c2.y, ox: p.x, oy: p.y });
    this.gs.cur = p;
  }

  closePath() {
    const sp = this.gs.path[this.gs.path.length - 1];
    if (!sp || sp.closed) return;
    const a = sp.anchors;
    if (a.length > 1) {
      const f = a[0];
      const l = a[a.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
        f.ix = l.ix;
        f.iy = l.iy;
        a.pop();
      }
    }
    sp.closed = true;
    this.gs.cur = { x: a[0].x, y: a[0].y };
  }

  arc(neg) {
    let a2 = this.num();
    let a1 = this.num();
    const r = this.num();
    const y = this.num();
    const x = this.num();
    if (neg) {
      while (a2 > a1) a2 -= 360;
    } else while (a2 < a1) a2 += 360;
    const rad = (a) => (a * Math.PI) / 180;
    const sx = x + r * Math.cos(rad(a1));
    const sy = y + r * Math.sin(rad(a1));
    if (this.gs.cur) this.lineTo(sx, sy);
    else this.moveTo(sx, sy);
    const total = a2 - a1;
    const n = Math.max(1, Math.ceil(Math.abs(total) / 90));
    const step = total / n;
    for (let i = 0; i < n; i++) {
      const t0 = rad(a1 + step * i);
      const t1 = rad(a1 + step * (i + 1));
      const k = (4 / 3) * Math.tan((t1 - t0) / 4);
      const c0 = Math.cos(t0);
      const s0 = Math.sin(t0);
      const c1 = Math.cos(t1);
      const s1 = Math.sin(t1);
      this.curveTo(x + r * (c0 - k * s0), y + r * (s0 + k * c0), x + r * (c1 + k * s1), y + r * (s1 - k * c1), x + r * c1, y + r * s1);
    }
  }

  arct(push) {
    const r = this.num();
    const y2 = this.num();
    const x2 = this.num();
    const y1 = this.num();
    const x1 = this.num();
    const p0 = this.userPoint();
    const v1 = { x: p0.x - x1, y: p0.y - y1 };
    const v2 = { x: x2 - x1, y: y2 - y1 };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    const cross = v1.x * v2.y - v1.y * v2.x;
    if (!l1 || !l2 || Math.abs(cross) < 1e-9 || !r) {
      this.lineTo(x1, y1);
      if (push) this.push(x1, y1, x1, y1);
      return;
    }
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2))));
    const dist = r / Math.tan(ang / 2);
    const t1 = { x: x1 + (v1.x / l1) * dist, y: y1 + (v1.y / l1) * dist };
    const t2 = { x: x1 + (v2.x / l2) * dist, y: y1 + (v2.y / l2) * dist };
    this.lineTo(t1.x, t1.y);
    const k = (4 / 3) * Math.tan((Math.PI - ang) / 4);
    this.curveTo(t1.x + (x1 - t1.x) * (k * r / dist), t1.y + (y1 - t1.y) * (k * r / dist), t2.x + (x1 - t2.x) * (k * r / dist), t2.y + (y1 - t2.y) * (k * r / dist), t2.x, t2.y);
    if (push) this.push(t1.x, t1.y, t2.x, t2.y);
  }

  paintOf(color) {
    const c = color;
    if (c.space === 'pattern') {
      const p = c.pattern;
      if (p instanceof PSDict && p.get('PatternType') === 2) {
        const impl = p.get('Implementation');
        const pm = p.get('Matrix') instanceof PSArray ? this.matrix(p.get('Matrix')) : [1, 0, 0, 1, 0, 0];
        const ctm = impl instanceof PSArray ? impl.get(1) : this.base;
        return shadingToPaint(null, toPDF(p.get('Shading')), multiply(ctm, pm), 1, (m) => this.warn(m));
      }
      this.warn('Tiling patterns were simplified to gray.');
      return { type: 'solid', color: '#808080' };
    }
    if (c.pdfSpace?.none) return null;
    const paint = { type: 'solid', color: rgbHex(this.colorRGB(c)) };
    const spot = c.pdfSpace?.spot;
    if (spot) {
      let sw = this.spots.get(spot.name);
      if (!sw) {
        sw = { id: uid('sw'), name: spot.name, paint: { type: 'solid', color: rgbHex(spot.rgb) }, spot: true, global: true };
        this.spots.set(spot.name, sw);
      }
      paint.swatchId = sw.id;
      const t = c.comps[0] ?? 1;
      if (t < 1) paint.tint = Math.round(Math.max(0, t) * 1000) / 1000;
    }
    return paint;
  }

  strokeStyle() {
    const s = scaleOf(this.gs.ctm);
    const gs = this.gs;
    return {
      strokeWidth: Math.max(gs.lw * s, 0.25),
      strokeCap: ['butt', 'round', 'square'][gs.cap] || 'butt',
      strokeJoin: ['miter', 'round', 'bevel'][gs.join] || 'miter',
      miterLimit: gs.miter || 10,
      dash: gs.dash.length && gs.dash.some((x) => x > 0) ? gs.dash.map((x) => x * s) : [],
      dashOffset: gs.dashOffset * s,
    };
  }

  paint(fill, stroke, evenOdd) {
    const subs = this.gs.path.filter((s) => s.anchors.length >= 2);
    const key = subs.length ? JSON.stringify(subs) : '';
    // "gsave fill grestore stroke": stroking the path just filled gives that object a stroke.
    const last = this.lastFill;
    this.lastFill = null;
    if (stroke && !fill && last && last.key === key && last.wraps === this.gs.wraps && this.out.nodes.has(last.id)) {
      const n = this.out.nodes.get(last.id);
      const st = this.paintOf(this.gs.color);
      if (st) this.out.nodes.set(last.id, { ...n, stroke: st, ...this.strokeStyle() });
      this.gs.path = [];
      this.gs.cur = null;
      return;
    }
    if (subs.length) {
      const style = { fill: fill ? this.paintOf(this.gs.color) : null, stroke: stroke ? this.paintOf(this.gs.color) : null, ...this.strokeStyle() };
      if (!stroke) style.strokeWidth = 1;
      if (style.fill || style.stroke) {
        let node;
        if (subs.length === 1) node = createPath(subs[0].anchors, subs[0].closed, style, evenOdd ? { fillRule: 'evenodd' } : {});
        else {
          const kids = subs.map((s) => this.out.add(createPath(s.anchors, s.closed, { fill: null, stroke: null })));
          node = createCompound(kids, style, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
        }
        this.out.add(node);
        this.out.push(node.id, this.gs.wraps);
        if (fill && !stroke) this.lastFill = { id: node.id, key, wraps: this.gs.wraps };
      }
    }
    this.gs.path = [];
    this.gs.cur = null;
  }

  clip(evenOdd) {
    const subpaths = this.gs.path.filter((s) => s.anchors.length >= 2).map((s) => ({ anchors: s.anchors.map((a) => ({ ...a })), closed: true }));
    this.gs.wraps = [...this.gs.wraps, { type: 'clip', subpaths, evenOdd }];
    this.gs.clipPath = subpaths;
  }

  shfill(sh) {
    this.lastFill = null;
    const paint = shadingToPaint(null, toPDF(sh), this.gs.ctm, 1, (m) => this.warn(m));
    if (!paint) return;
    const clip = this.gs.clipPath || this.pageRect();
    let r = null;
    for (const s of clip) for (const a of s.anchors) r = r ? { x0: Math.min(r.x0, a.x), y0: Math.min(r.y0, a.y), x1: Math.max(r.x1, a.x), y1: Math.max(r.y1, a.y) } : { x0: a.x, y0: a.y, x1: a.x, y1: a.y };
    if (!r) return;
    const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(([x, y]) => anchorAt({ x, y }));
    const node = createPath(pts, true, { fill: paint, stroke: null }, { shadingFill: true });
    this.out.add(node);
    this.out.push(node.id, this.gs.wraps);
  }

  // ---- text ----

  show(str, { ax = 0, ay = 0, cx = 0, cy = 0, ch = -1, widths = null, mode = null } = {}) {
    this.lastFill = null;
    if (!(str instanceof PSString)) throw new PSError('typecheck', 'show');
    if (!this.gs.cur) throw new PSError('nocurrentpoint', 'show');
    const font = this.gs.font || this.defaultFont();
    const fm = font.get('FontMatrix') instanceof PSArray ? this.matrix(font.get('FontMatrix')) : [0.012, 0, 0, 0.012, 0, 0];
    const fname = font.get('FontName');
    const baseName = fname instanceof PSName ? fname.name : fname instanceof PSString ? fname.text() : 'Helvetica';
    let text = '';
    const start = this.userPoint();
    let x = start.x;
    let y = start.y;
    for (let i = 0; i < str.len; i++) {
      const code = str.get(i);
      text += String.fromCharCode(code);
      if (widths) {
        if (mode === 'x') x += widths[i] ?? 0;
        else if (mode === 'y') y += widths[i] ?? 0;
        else {
          x += widths[i * 2] ?? 0;
          y += widths[i * 2 + 1] ?? 0;
        }
        continue;
      }
      const w = dapp(fm, approxWidth(code) * 1000, 0);
      x += w.x + ax + (code === ch ? cx : 0);
      y += w.y + ay + (code === ch ? cy : 0);
    }
    const info = parseFontName(baseName);
    const family = this.families.exact(info, baseName) || this.families.substitute(info);
    if (!this.families.exact(info, baseName)) this.substituted = (this.substituted || new Set()).add(`${info.family} (using ${family})`);
    if (text.trim()) {
      // Local text space: the font matrix scaled to 1000 units per em, y down.
      let M = multiply(multiply(this.gs.ctm, [1, 0, 0, 1, start.x, start.y]), multiply(fm, [1000, 0, 0, -1000, 0, 0]));
      const s = scaleOf(M);
      M = [M[0] / s, M[1] / s, M[2] / s, M[3] / s, M[4], M[5]];
      const paint = this.paintOf(this.gs.color);
      const node = createText(text.replace(/[\x00-\x1f]/g, ' '), 0, 0, {
        transform: M,
        char: { ...DEFAULT_CHAR, fontFamily: family, fontWeight: info.weight, fontStyle: info.style, fontSize: Math.round(s * 1000) / 1000, tracking: ax ? Math.round((ax / (scaleOf(fm) * 1000)) * 1000) : 0 },
        fill: paint,
        stroke: null,
      });
      this.out.add(node);
      this.out.push(node.id, this.gs.wraps);
    }
    this.gs.cur = app(this.gs.ctm, x, y);
  }

  // ---- images ----

  /** A data source reader: (n) -> Uint8Array of up to n bytes (null at the end). */
  dataSource(src) {
    if (src instanceof PSString) {
      let used = false;
      return () => {
        if (used) {
          // A string source is read again and again.
          return src.data();
        }
        used = true;
        return src.data();
      };
    }
    if (src instanceof PSFile) {
      return (n) => {
        const out = [];
        for (let i = 0; i < n; i++) {
          const c = src.read();
          if (c < 0) break;
          out.push(c);
        }
        return out.length ? Uint8Array.from(out) : null;
      };
    }
    if (src instanceof PSArray && src.exec) {
      return () => {
        const before = this.os.length;
        this.exec(src);
        const v = this.os.length > before ? this.pop() : null;
        this.os.length = Math.min(this.os.length, before);
        return v instanceof PSString ? v.data().slice() : null;
      };
    }
    return () => null;
  }

  readAll(read, need) {
    const out = new Uint8Array(need);
    let n = 0;
    for (let guard = 0; n < need && guard < 1e6; guard++) {
      const chunk = read(need - n);
      if (!chunk || !chunk.length) break;
      const k = Math.min(chunk.length, need - n);
      out.set(chunk.subarray(0, k), n);
      n += k;
    }
    return out;
  }

  image(kind) {
    this.lastFill = null;
    let width;
    let height;
    let bpc;
    let matrix;
    let sources;
    let ncomp = 1;
    let decode = null;
    let multi = false;
    let polarity = false;
    let colorSpace = null;
    const top = this.pop();
    if (top instanceof PSDict) {
      // Level 2 image dictionary.
      width = top.get('Width');
      height = top.get('Height');
      bpc = kind === 'imagemask' ? 1 : top.get('BitsPerComponent') || 8;
      matrix = this.matrix(top.get('ImageMatrix'));
      const ds = top.get('DataSource');
      multi = top.get('MultipleDataSources') === true;
      sources = multi && ds instanceof PSArray ? ds.list() : [ds];
      const dec = top.get('Decode');
      decode = dec instanceof PSArray ? dec.list() : null;
      if (kind === 'imagemask') polarity = decode ? decode[0] === 1 : false;
      colorSpace = this.gs.color;
      ncomp = colorSpace.space === 'rgb' ? 3 : colorSpace.space === 'cmyk' ? 4 : colorSpace.n || 1;
    } else if (kind === 'colorimage') {
      ncomp = top;
      multi = this.bool();
      sources = [];
      for (let i = 0; i < (multi ? ncomp : 1); i++) sources.unshift(this.pop());
      matrix = this.matrix(this.pop());
      bpc = this.int();
      height = this.int();
      width = this.int();
      colorSpace = { space: ncomp === 4 ? 'cmyk' : ncomp === 3 ? 'rgb' : 'gray', comps: [] };
    } else {
      sources = [top];
      matrix = this.matrix(this.pop());
      if (kind === 'imagemask') {
        polarity = this.bool();
        bpc = 1;
      } else bpc = this.int();
      height = this.int();
      width = this.int();
      colorSpace = { space: 'gray', comps: [] };
    }
    if (!(width > 0) || !(height > 0) || width * height > 5e7) throw new PSError('rangecheck', 'image');
    if (sources.length === 1 && sources[0] instanceof PSFile && sources[0].jpeg && kind !== 'imagemask') {
      // JPEG data: keep it as a JPEG image.
      const src = sources[0].source;
      const bytes = src.bytes.subarray(src.pos, src.end);
      src.pos = src.end;
      const id = uid('img');
      this.images.push({ id, img: { kind: 'jpeg', width, height, bytes: bytes.slice() } });
      const node = createImage(id, width, height, multiply(this.gs.ctm, invert(matrix)));
      this.out.add(node);
      this.out.push(node.id, this.gs.wraps);
      return;
    }
    const rowBytes = Math.ceil((width * (multi ? 1 : ncomp) * bpc) / 8);
    const planes = sources.map((s) => this.readAll(this.dataSource(s), rowBytes * height));
    const data = new Uint8ClampedArray(width * height * 4);
    const max = 2 ** bpc - 1;
    const sample = (plane, i, comp, nc) => {
      const bit = Math.floor(i / width) * rowBytes * 8 + ((i % width) * nc + comp) * bpc;
      if (bpc === 8) return plane[bit >> 3];
      if (bpc === 16) return (plane[bit >> 3] << 8) | plane[(bit >> 3) + 1];
      return (plane[bit >> 3] >> (8 - bpc - (bit & 7))) & max;
    };
    const fill = kind === 'imagemask' ? this.colorRGB(this.gs.color).map((v) => Math.round(v * 255)) : null;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      if (kind === 'imagemask') {
        const v = sample(planes[0], i, 0, 1);
        const paint = polarity ? v === 1 : v === 0;
        data[o] = fill[0];
        data[o + 1] = fill[1];
        data[o + 2] = fill[2];
        data[o + 3] = paint ? 255 : 0;
        continue;
      }
      const comps = [];
      for (let c = 0; c < ncomp; c++) {
        const v = multi ? sample(planes[c] || planes[0], i, 0, 1) : sample(planes[0], i, c, ncomp);
        let x = v / max;
        if (decode && decode.length >= 2 * (c + 1)) x = decode[2 * c] + x * (decode[2 * c + 1] - decode[2 * c]);
        comps.push(x);
      }
      const rgb = this.colorRGB({ ...colorSpace, comps });
      data[o] = Math.round(rgb[0] * 255);
      data[o + 1] = Math.round(rgb[1] * 255);
      data[o + 2] = Math.round(rgb[2] * 255);
      data[o + 3] = 255;
    }
    const id = uid('img');
    this.images.push({ id, img: { kind: 'rgba', width, height, data } });
    const t = multiply(this.gs.ctm, invert(matrix));
    const node = createImage(id, width, height, t);
    this.out.add(node);
    this.out.push(node.id, this.gs.wraps);
  }

  /** The `filter` operator: a file that decodes data from a file, string or procedure source when first read. */
  filter() {
    const name = this.pop();
    const fname = name instanceof PSName ? name.name : '';
    let params = null;
    let src = this.pop();
    if (src instanceof PSDict) {
      params = src;
      src = this.pop();
    }
    if (fname === 'SubFileDecode') {
      // source EODCount EODString /SubFileDecode
      const eodString = src instanceof PSString ? src.text() : '';
      this.pop();
      const from = this.pop();
      this.push(new PSFile(() => {
        const raw = this.rawFrom(from, eodString || null);
        return { bytes: raw, pos: 0, end: raw.length };
      }));
      return;
    }
    void params;
    const file = new PSFile(() => {
      const raw = this.rawFrom(src, fname === 'ASCII85Decode' ? '~>' : fname === 'ASCIIHexDecode' ? '>' : null);
      const out = this.decodeFilter(fname, raw);
      return { bytes: out, pos: 0, end: out.length };
    });
    if (fname === 'DCTDecode') file.jpeg = true;
    this.push(file);
  }

  decodeFilter(fname, raw) {
    switch (fname) {
      case 'ASCII85Decode':
        return decodeA85(raw);
      case 'ASCIIHexDecode': {
        const tmp = [];
        let hi = -1;
        for (const c of raw) {
          const v = hexv(c);
          if (v < 0) continue;
          if (hi < 0) hi = v;
          else {
            tmp.push((hi << 4) | v);
            hi = -1;
          }
        }
        if (hi >= 0) tmp.push(hi << 4);
        return Uint8Array.from(tmp);
      }
      case 'RunLengthDecode': {
        const tmp = [];
        for (let i = 0; i < raw.length; ) {
          const n = raw[i++];
          if (n === 128) break;
          if (n < 128) for (let k = 0; k <= n; k++) tmp.push(raw[i++]);
          else {
            const v = raw[i++];
            for (let k = 0; k < 257 - n; k++) tmp.push(v);
          }
        }
        return Uint8Array.from(tmp);
      }
      case 'FlateDecode':
        return inflate(raw);
      case 'LZWDecode':
        return lzwDecode(raw, 1);
      default:
        // DCTDecode data stays JPEG (images pass it to the browser); NullEncode and others pass through.
        return raw;
    }
  }

  /** All bytes a source can deliver (up to an end-of-data marker for currentfile). */
  rawFrom(src, eod) {
    if (src instanceof PSString) return src.data();
    if (src instanceof PSFile) {
      const s = src.source;
      if (src === this.currentfile && eod) {
        // Read up to the marker.
        const b = s.bytes;
        let i = s.pos;
        const m = [...eod].map((c) => c.charCodeAt(0));
        outer: for (; i < s.end; i++) {
          for (let k = 0; k < m.length; k++) if (b[i + k] !== m[k]) continue outer;
          break;
        }
        const raw = b.subarray(s.pos, i);
        s.pos = Math.min(s.end, i + m.length);
        return raw;
      }
      if (src === this.currentfile) {
        // Without a marker (binary filters on currentfile): the rest of the file.
        const raw = s.bytes.subarray(s.pos, s.end);
        return raw;
      }
      const raw = s.bytes.subarray(s.pos, s.end);
      s.pos = s.end;
      return raw;
    }
    if (src instanceof PSArray && src.exec) {
      const read = this.dataSource(src);
      const parts = [];
      let total = 0;
      for (let guard = 0; guard < 100000; guard++) {
        const c = read(65536);
        if (!c || !c.length) break;
        parts.push(c);
        total += c.length;
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    }
    return new Uint8Array(0);
  }
}

function keyObj(k) {
  if (typeof k === 'string' && k.startsWith('#')) return Number(k.slice(1));
  if (typeof k === 'string' && k.startsWith('?')) return k === '?true';
  return nameOf(k);
}

function withExec(v, exec) {
  if (v instanceof PSName) return nameOf(v.name, exec);
  if (v instanceof PSArray) return new PSArray(v.items, exec, v.off, v.len);
  if (v instanceof PSString) {
    const s = new PSString(v.bytes, v.off, v.len);
    s.exec = exec;
    return s;
  }
  if (v instanceof PSFile) {
    const f = new PSFile(v.source);
    f.exec = exec;
    return f;
  }
  return v;
}

function bindProc(S, p, depth) {
  if (depth > 30) return;
  for (let i = 0; i < p.len; i++) {
    const t = p.get(i);
    if (t instanceof PSName && t.exec) {
      const v = S.lookup(t.name);
      if (v instanceof PSOp) p.set(i, v);
    } else if (t instanceof PSArray && t.exec) bindProc(S, t, depth + 1);
  }
}

function hsbToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}
