/**
 * SVG import: parses SVG markup with DOMParser and converts it into
 * document nodes. Transforms are baked into path anchors (the model stores
 * absolute geometry); text and images keep a matrix.
 *
 * Supported: path (all commands, arcs as cubics), rect (rounded), circle,
 * ellipse, line, polyline, polygon, g, a, switch, nested svg with viewBox
 * and preserveAspectRatio, use/symbol/defs, presentation attributes, style
 * attributes and <style> rules, inherited paint and stroke properties,
 * currentColor, linear and radial gradients (units, transforms, href
 * inheritance), clipPath (to clip groups), simple masks (as clips), blur and
 * drop shadow filters (as effects), mix-blend-mode, text/tspan and images.
 * Anything else is skipped and reported in `warnings`; malformed input never
 * throws past the top-level "not an SVG" error.
 */
import { UserError } from '../../lib/errors.js';
import { VDocument } from '../../model/document.js';
import { createPath, createCompound, createGroup, createText, createImage, createLayer, DEFAULT_CHAR, DEFAULT_PARA, LAYER_COLORS } from '../../model/nodes.js';
import { transformAnchors, pathBounds } from '../../model/bezier.js';
import { rectangle, ellipse as ellipseAnchors } from '../../model/shapes.js';
import { nodeBounds, unionRect, transformRect } from '../../model/geometry.js';
import { multiply, invert, apply, decompose, identity, translate, rotate, scale as scaleM } from '../../lib/matrix.js';
import { parseCssColor, hexToRgb, rgbToHex } from '../../lib/color.js';
import { uid } from '../../lib/ids.js';
import { measure } from '../../model/text-layout.js';
import { parsePathData } from './svg-path.js';
import { parseTransform, parseLength, parseNumberList, parseDeclarations, parseStylesheet, matchStylesheet } from './svg-style.js';
import { dataUrlToBytes, sniffMime, imageSize, svgImageSize } from './image-info.js';
import { mergeAppearanceGroup } from './svg-appearance.js';

/** Children that are not artwork (they never make nodes). */
const NON_ART = new Set(['title', 'desc', 'metadata', 'defs', 'style', 'script']);

const INHERITED = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'text-anchor', 'visibility', 'clip-rule', 'text-decoration', 'marker-start',
  'marker-mid', 'marker-end', 'vector-effect', 'white-space',
];
const NON_INHERITED = ['baseline-shift', 'opacity', 'display', 'clip-path', 'mask', 'filter', 'mix-blend-mode', 'stop-color', 'stop-opacity', 'overflow', 'transform', 'transform-origin'];
const PRESENTATION = [...INHERITED, ...NON_INHERITED.filter((p) => p !== 'transform')];
const PRESENTATION_SET = new Set(PRESENTATION);

const BASE_STYLE = {
  fill: 'black',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-opacity': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  color: 'black',
  'font-family': 'sans-serif',
  'font-size': 16,
  'font-weight': 'normal',
  'font-style': 'normal',
  'letter-spacing': 'normal',
  'text-anchor': 'start',
  visibility: 'visible',
  'clip-rule': 'nonzero',
  'text-decoration': 'none',
};

const SKIP = new Set([
  'defs', 'title', 'desc', 'metadata', 'style', 'script', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern',
  'marker', 'symbol', 'filter', 'font', 'font-face', 'cursor', 'view', 'stop', 'namedview', 'animate', 'animateTransform',
  'animateMotion', 'set', 'mpath', 'hatch', 'meshgradient', 'solidcolor',
]);
const ANIMATION = new Set(['animate', 'animateTransform', 'animateMotion', 'set']);

const BLEND = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'colorDodge',
  'color-burn': 'colorBurn', 'hard-light': 'hardLight', 'soft-light': 'softLight', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

const MAX_ELEMENTS = 250000;
const INK = 'http://www.inkscape.org/namespaces/inkscape';
const XLINK = 'http://www.w3.org/1999/xlink';

const TEXT_KEYS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-decoration'];

function textKey(st) {
  return TEXT_KEYS.map((k) => st[k]).join('|');
}

/** SVG baseline-shift in user units (super and sub approximate the browser's offsets). */
function baselineShiftOf(v, fontSize) {
  const t = String(v ?? '').trim();
  if (!t || t === 'baseline' || t === '0') return 0;
  const size = typeof fontSize === 'number' ? fontSize : 16;
  if (t === 'super') return size * 0.55;
  if (t === 'sub') return -size * 0.55;
  return parseLength(t, { ref: size, fontSize: size, fallback: 0 });
}

function overridesOfRun(run) {
  const o = {};
  for (const k in run) if (k !== 'len') o[k] = run[k];
  return o;
}

function hrefOf(el) {
  return el.getAttribute('href') || el.getAttributeNS?.(XLINK, 'href') || el.getAttribute('xlink:href') || '';
}

function urlId(v) {
  const m = /url\(\s*['"]?\s*#([^'")\s]+)\s*['"]?\s*\)/.exec(v || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function opacityValue(v, fallback = 1) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim();
  const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

let colorCtx = null;
/** Any CSS color via the canvas parser (browser only), as a last resort. */
function cssColorFallback(v) {
  try {
    if (!colorCtx) {
      if (typeof OffscreenCanvas !== 'undefined') colorCtx = new OffscreenCanvas(1, 1).getContext('2d');
      else if (typeof document !== 'undefined') colorCtx = document.createElement('canvas').getContext('2d');
    }
    if (!colorCtx) return null;
    colorCtx.fillStyle = '#010203';
    colorCtx.fillStyle = v;
    const out = colorCtx.fillStyle;
    if (out === '#010203' && !/^#010203$/i.test(v)) return null;
    return parseCssColor(out);
  } catch {
    return null;
  }
}

/**
 * A closed path's anchors starting at index k. SVG circles and ellipses
 * start at the rightmost point (our ellipses start at the leftmost), and
 * dashes are laid out from the start point, so this keeps dash phase.
 */
function startAt(anchors, k) {
  return k ? [...anchors.slice(k), ...anchors.slice(0, k)] : anchors;
}

export function parseColor(v) {
  return parseCssColor(v) || cssColorFallback(v);
}

/** The matrix that maps a viewBox into a viewport (x, y, w, h) per preserveAspectRatio. */
export function viewBoxTransform(vb, x, y, w, h, par = '') {
  const [minX, minY, vw, vh] = vb;
  const parts = String(par || 'xMidYMid meet').trim().split(/\s+/);
  let align = parts[0] === 'defer' ? parts[1] : parts[0];
  const mode = (parts[0] === 'defer' ? parts[2] : parts[1]) || 'meet';
  if (!align) align = 'xMidYMid';
  let sx = w / vw;
  let sy = h / vh;
  if (align === 'none') return [sx, 0, 0, sy, x - minX * sx, y - minY * sy];
  const s = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = sy = s;
  let tx = x - minX * s;
  let ty = y - minY * s;
  if (/xMid/.test(align)) tx += (w - vw * s) / 2;
  else if (/xMax/.test(align)) tx += w - vw * s;
  if (/YMid/.test(align)) ty += (h - vh * s) / 2;
  else if (/YMax/.test(align)) ty += h - vh * s;
  return [s, 0, 0, s, tx, ty];
}

function scaleOf(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

function parseXml(text) {
  const src = String(text || '').replace(/^﻿/, '');
  let lenient = false;
  let svg = null;
  if (typeof DOMParser === 'undefined') throw new Error('SVG import needs a DOM parser.');
  try {
    const xml = new DOMParser().parseFromString(src, 'image/svg+xml');
    const root = xml.documentElement;
    if (root && root.localName === 'svg' && !xml.getElementsByTagName('parsererror').length) svg = root;
  } catch {
    svg = null;
  }
  if (!svg) {
    // Fall back to the forgiving HTML parser (unescaped ampersands, unclosed tags, missing namespace).
    const html = new DOMParser().parseFromString(src, 'text/html');
    svg = html.querySelector('svg');
    lenient = true;
  }
  if (!svg) throw new UserError('This file is not a valid SVG image.');
  return { svg, lenient };
}

class Importer {
  constructor(text) {
    const { svg, lenient } = parseXml(text);
    this.svg = svg;
    this.doc = svg.ownerDocument;
    this.warnings = new Set();
    if (lenient) this.warnings.add('The SVG had markup errors and was read leniently.');
    this.nodes = new Map();
    this.assets = new Map();
    this.assetByHref = new Map();
    this.count = 0;
    this.ids = new Map();
    this.pathCache = new Map();
    for (const el of this.doc.querySelectorAll('[id]')) if (!this.ids.has(el.id)) this.ids.set(el.id, el);
    let css = '';
    for (const st of this.doc.querySelectorAll('style')) css += '\n' + st.textContent;
    this.css = css.trim() ? matchStylesheet(this.doc, parseStylesheet(css)) : new Map();
    this.shim = { get: (id) => this.nodes.get(id) };
    this.styleCache = new Map();
  }

  warn(msg) {
    this.warnings.add(msg);
  }

  add(node) {
    this.nodes.set(node.id, node);
    return node.id;
  }

  // ---- style cascade ----

  computeStyle(el, parent) {
    const s = {};
    for (const k of INHERITED) s[k] = parent[k];
    const set = (k, v) => {
      if (v == null) return;
      v = String(v).trim();
      if (!v) return;
      if (v === 'inherit') s[k] = parent[k];
      else if (v === 'initial' || v === 'unset') s[k] = INHERITED.includes(k) && v === 'unset' ? parent[k] : BASE_STYLE[k];
      else s[k] = v;
    };
    // Walk the element's own attributes (usually a handful) rather than probing every property.
    for (const a of el.attributes) if (PRESENTATION_SET.has(a.name)) set(a.name, a.value);
    const rules = this.css.get(el);
    const important = [];
    if (rules) {
      for (const r of rules) {
        for (const [k, d] of Object.entries(r.decls)) {
          if (d.important) important.push([k, d.value]);
          else this.setProp(set, k, d.value);
        }
      }
    }
    const inline = el.getAttribute('style');
    let inlineDecls = null;
    if (inline) {
      inlineDecls = parseDeclarations(inline);
      for (const [k, d] of Object.entries(inlineDecls)) if (!d.important) this.setProp(set, k, d.value);
    }
    for (const [k, v] of important) this.setProp(set, k, v);
    if (inlineDecls) for (const [k, d] of Object.entries(inlineDecls)) if (d.important) this.setProp(set, k, d.value);
    // Resolve font-size to user units now (em and % are relative to the parent).
    const pf = typeof parent['font-size'] === 'number' ? parent['font-size'] : 16;
    if (typeof s['font-size'] !== 'number') {
      const named = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, larger: pf * 1.2, smaller: pf / 1.2 };
      const v = String(s['font-size']).trim();
      s['font-size'] = named[v] ?? parseLength(v, { ref: pf, fontSize: pf, fallback: pf });
    }
    return s;
  }

  setProp(set, k, v) {
    if (k === 'font') {
      // font: [style] [weight] size[/line-height] family
      const m = /^\s*((?:italic|oblique|normal|bold|bolder|lighter|\d{3}|small-caps)\s+)*([\d.]+[a-z%]*)(?:\/\S+)?\s+(.+)$/i.exec(v);
      if (m) {
        if (/italic|oblique/i.test(v.slice(0, v.indexOf(m[2])))) set('font-style', 'italic');
        const w = /\b(bold|bolder|lighter|\d{3})\b/i.exec(v.slice(0, v.indexOf(m[2])));
        if (w) set('font-weight', w[1]);
        set('font-size', m[2]);
        set('font-family', m[3]);
      }
      return;
    }
    if (k === 'marker') {
      for (const m of ['marker-start', 'marker-mid', 'marker-end']) set(m, v);
      return;
    }
    if (INHERITED.includes(k) || NON_INHERITED.includes(k)) set(k, v);
  }

  /**
   * An element's own transform: a CSS transform (style attribute or
   * stylesheet) overrides the transform attribute, like in browsers, and
   * transform-origin moves the origin of either. Null for none.
   */
  elementTransform(el, st, ctx) {
    const css = st.transform != null ? String(st.transform).trim() : null;
    const tf = css != null ? (css === 'none' ? null : css) : el.getAttribute('transform');
    if (!tf) return null;
    let T = parseTransform(tf);
    const origin = st['transform-origin'];
    if (origin) {
      // Reference box: the viewport (transform-box: view-box, the SVG default).
      const parts = String(origin).trim().split(/\s+/);
      const kw = { left: ['x', 0], right: ['x', 1], top: ['y', 0], bottom: ['y', 1], center: [null, 0.5] };
      let ox = null;
      let oy = null;
      const pending = [];
      for (const p of parts.slice(0, 2)) {
        const k = kw[p.toLowerCase()];
        if (k?.[0] === 'x') ox = k[1] * (ctx.vw || 0);
        else if (k?.[0] === 'y') oy = k[1] * (ctx.vh || 0);
        else pending.push(k ? { center: true } : p);
      }
      for (const p of pending) {
        const axis = ox == null ? 'x' : 'y';
        const ref = axis === 'x' ? ctx.vw || 0 : ctx.vh || 0;
        const v = p.center ? ref / 2 : parseLength(p, { ref, fallback: 0 });
        if (axis === 'x') ox = v;
        else oy = v;
      }
      ox ??= (ctx.vw || 0) / 2;
      oy ??= (ctx.vh || 0) / 2;
      if (ox || oy) T = multiply(multiply([1, 0, 0, 1, ox, oy], T), [1, 0, 0, 1, -ox, -oy]);
    }
    return T;
  }

  // ---- traversal ----

  // Traversal is written as generators that yield after every element, so
  // the same code runs synchronously (drain) or in time slices (runAsync).

  convertChildren(el, ctx) {
    return drain(this.convertChildrenGen(el, ctx));
  }

  *convertChildrenGen(el, ctx) {
    const out = [];
    for (const child of el.children) {
      try {
        out.push(...(yield* this.convertGen(child, ctx)));
      } catch (err) {
        this.warn('Some elements could not be read and were skipped.');
        if (typeof console !== 'undefined') console.warn('SVG import:', err);
      }
      yield;
    }
    return out;
  }

  convert(el, ctx) {
    return drain(this.convertGen(el, ctx));
  }

  *convertGen(el, ctx) {
    if (++this.count > MAX_ELEMENTS) {
      this.warn('The file is very large; only part of it was imported.');
      return [];
    }
    const ns = el.namespaceURI;
    if (ns && ns !== 'http://www.w3.org/2000/svg') return [];
    const tag = el.localName;
    if (SKIP.has(tag)) {
      if (ANIMATION.has(tag)) this.warn('Animations were ignored.');
      return [];
    }
    if (tag === 'foreignObject') {
      this.warn('Embedded HTML (foreignObject) is not supported and was skipped.');
      return [];
    }
    const st = this.computeStyle(el, ctx.style);
    if (st.display === 'none') return [];
    const T = this.elementTransform(el, st, ctx);
    const M = T ? multiply(ctx.ctm, T) : ctx.ctm;
    let ids = [];
    let isGroup = false;
    switch (tag) {
      case 'svg':
        ids = yield* this.viewportGen(el, st, M, ctx, this.viewportBox(el, ctx));
        break;
      case 'g':
      case 'a':
        ids = yield* this.convertChildrenGen(el, { ...ctx, ctm: M, style: st });
        // One object's fills and strokes (an appearance stack written by the SVG export).
        if (ids.length > 1 && el.hasAttribute('data-appearance')) {
          const merged = mergeAppearanceGroup(this.nodes, [...el.children].filter((c) => !NON_ART.has(c.localName)), ids);
          if (merged) {
            ids = [merged];
            break;
          }
        }
        if (ids.length) {
          const g = createGroup(ids, { name: this.nameOf(el) });
          ids = [this.add(g)];
          isGroup = true;
        }
        break;
      case 'switch': {
        for (const child of el.children) {
          // Like browsers, no extensions are supported (the editor-private branches of exporters).
          if (child.hasAttribute('requiredExtensions')) continue;
          const r = this.convert(child, { ...ctx, ctm: M, style: st });
          if (r.length) {
            ids = r;
            break;
          }
        }
        break;
      }
      case 'use':
        ids = this.use(el, st, M, ctx);
        break;
      case 'path':
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon':
        if (st.visibility === 'hidden' || st.visibility === 'collapse') return [];
        ids = this.shape(el, tag, st, M, ctx);
        break;
      case 'text':
        if (st.visibility === 'hidden') return [];
        ids = this.text(el, st, M, ctx);
        break;
      case 'image':
        if (st.visibility === 'hidden') return [];
        ids = this.image(el, st, M, ctx);
        break;
      default:
        // Unknown elements (and non-SVG markup) render nothing, but a group-like
        // wrapper from an editor extension may still hold artwork.
        if (el.children.length) ids = yield* this.convertChildrenGen(el, { ...ctx, ctm: M, style: st });
        break;
    }
    if (!ids.length) return [];
    return this.decorate(el, st, M, ctx, ids, isGroup);
  }

  /** Opacity, blend mode, filters, clip paths and masks on an element's result. */
  decorate(el, st, M, ctx, ids, isGroup) {
    const opacity = opacityValue(st.opacity, 1);
    const blend = BLEND[String(st['mix-blend-mode'] || '').trim()] || null;
    const effects = st.filter && st.filter !== 'none' ? this.filterEffects(st.filter, scaleOf(M)) : null;
    const clipRef = st['clip-path'] && st['clip-path'] !== 'none' ? st['clip-path'] : null;
    const maskRef = st.mask && st.mask !== 'none' ? st.mask : null;
    if ((opacity < 1 || blend || effects?.length) && ids.length > 1) {
      ids = [this.add(createGroup(ids))];
      isGroup = true;
    }
    if (ids.length === 1) {
      const n = this.nodes.get(ids[0]);
      const patch = {};
      if (opacity < 1) patch.opacity = (n.opacity ?? 1) * opacity;
      if (blend) patch.blendMode = blend;
      if (effects?.length) patch.effects = [...(n.effects || []), ...effects];
      if (!n.name && !isGroup) {
        const name = this.nameOf(el);
        if (name) patch.name = name;
      }
      if (Object.keys(patch).length) this.nodes.set(n.id, { ...n, ...patch });
    }
    if (clipRef) ids = this.applyClip(clipRef, M, ids, ctx);
    if (maskRef && ids.length) ids = this.applyMask(maskRef, M, ids, ctx);
    return ids;
  }

  nameOf(el) {
    const label = el.getAttributeNS?.(INK, 'label') || el.getAttribute('inkscape:label') || el.getAttribute('data-name');
    if (label) return label;
    // Editor-generated ids ("path123", "g4_2") make poor layer names.
    const id = el.id || '';
    return /^(path|rect|circle|ellipse|line|polyline|polygon|g|text|tspan|use|image|svg|layer|group|shape|object|clippath|mask|a)[-_]?\d+([-_]\d+)*$/i.test(id) ? '' : id;
  }

  // ---- viewports ----

  viewportBox(el, ctx) {
    const w = el.getAttribute('width');
    const h = el.getAttribute('height');
    return {
      x: parseLength(el.getAttribute('x'), { ref: ctx.vw }),
      y: parseLength(el.getAttribute('y'), { ref: ctx.vh }),
      w: w == null || w === 'auto' ? ctx.vw : parseLength(w, { ref: ctx.vw, fallback: ctx.vw }),
      h: h == null || h === 'auto' ? ctx.vh : parseLength(h, { ref: ctx.vh, fallback: ctx.vh }),
    };
  }

  /** Content of an <svg> or <symbol> laid into a viewport box (x, y, w, h). */
  viewport(el, st, M, ctx, box, styleParent = st) {
    return drain(this.viewportGen(el, st, M, ctx, box, styleParent));
  }

  *viewportGen(el, st, M, ctx, box, styleParent = st) {
    if (!(box.w > 0) || !(box.h > 0)) return [];
    const vb = parseNumberList(el.getAttribute('viewBox'));
    const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    const inner = hasVb ? multiply(M, viewBoxTransform(vb, box.x, box.y, box.w, box.h, el.getAttribute('preserveAspectRatio'))) : multiply(M, translate(box.x, box.y));
    const ids = yield* this.convertChildrenGen(el, { ...ctx, ctm: inner, style: styleParent, vw: hasVb ? vb[2] : box.w, vh: hasVb ? vb[3] : box.h });
    if (!ids.length) return [];
    const overflow = String(st.overflow || 'hidden').trim();
    if (overflow === 'visible' || overflow === 'auto') return ids;
    // Clip only when the content actually leaves the viewport.
    const clipRect = transformRect({ x: box.x, y: box.y, w: box.w, h: box.h }, M);
    let b = null;
    for (const id of ids) b = unionRect(b, nodeBounds(this.shim, this.nodes.get(id)));
    const pad = 1e-3;
    if (!b || (b.x >= clipRect.x - pad && b.y >= clipRect.y - pad && b.x + b.w <= clipRect.x + clipRect.w + pad && b.y + b.h <= clipRect.y + clipRect.h + pad)) return ids;
    const anchors = transformAnchors(rectangle(box.x, box.y, box.w, box.h), M);
    const mask = this.add(createPath(anchors, true, { fill: null, stroke: null }));
    return [this.add(createGroup([...ids, mask], { clip: true }))];
  }

  use(el, st, M, ctx) {
    const id = (hrefOf(el).match(/#(.+)$/) || [])[1];
    const target = id ? this.ids.get(decodeURIComponent(id)) : null;
    if (!target) {
      if (hrefOf(el)) this.warn('Some <use> references point outside the file and were skipped.');
      return [];
    }
    const stack = ctx.useStack || new Set();
    if (stack.has(target) || stack.size > 24) {
      this.warn('A recursive <use> reference was skipped.');
      return [];
    }
    const nextCtx = { ...ctx, useStack: new Set([...stack, target]) };
    const x = parseLength(el.getAttribute('x'), { ref: ctx.vw });
    const y = parseLength(el.getAttribute('y'), { ref: ctx.vh });
    const M2 = multiply(M, translate(x, y));
    if (target.localName === 'symbol' || target.localName === 'svg') {
      const tst = this.computeStyle(target, st);
      if (tst.display === 'none') return [];
      const w = el.getAttribute('width') ?? target.getAttribute('width');
      const h = el.getAttribute('height') ?? target.getAttribute('height');
      const box = {
        x: target.localName === 'svg' ? 0 : parseLength(target.getAttribute('x'), { ref: ctx.vw }),
        y: target.localName === 'svg' ? 0 : parseLength(target.getAttribute('y'), { ref: ctx.vh }),
        w: w == null || w === 'auto' ? ctx.vw : parseLength(w, { ref: ctx.vw, fallback: ctx.vw }),
        h: h == null || h === 'auto' ? ctx.vh : parseLength(h, { ref: ctx.vh, fallback: ctx.vh }),
      };
      let tf = target.getAttribute('transform');
      const MT = tf ? multiply(M2, parseTransform(tf)) : M2;
      let ids = this.viewport(target, tst, MT, nextCtx, box, tst);
      if (!ids.length) return [];
      if (target.localName === 'symbol') {
        // Mark each use of a <symbol> so the symbols feature can turn the uses into instances.
        const title = [...target.children].find((c) => c.localName === 'title')?.textContent?.trim();
        const importedSymbol = { key: `${id}|${box.w}|${box.h}`, name: title || id, m: MT };
        ids = [this.add(createGroup(ids, { importedSymbol }))];
      }
      return this.decorate(target, tst, MT, nextCtx, ids, false);
    }
    return this.convert(target, { ...nextCtx, ctm: M2, style: st });
  }

  // ---- shapes ----

  /** Local geometry of a basic shape: { subpaths, shape (live params in local space) }. */
  geometry(el, tag, ctx) {
    const L = (name, ref) => parseLength(el.getAttribute(name), { ref });
    switch (tag) {
      case 'path': {
        // Charts and icon sets reuse one path many times (<use>): parse each distinct path once.
        const d = el.getAttribute('d') || '';
        let subpaths = this.pathCache.get(d);
        if (!subpaths) {
          subpaths = parsePathData(d);
          this.pathCache.set(d, subpaths);
        }
        return { subpaths };
      }
      case 'rect': {
        const x = L('x', ctx.vw);
        const y = L('y', ctx.vh);
        const w = L('width', ctx.vw);
        const h = L('height', ctx.vh);
        if (!(w > 0) || !(h > 0)) return { subpaths: [] };
        const rxa = el.getAttribute('rx');
        const rya = el.getAttribute('ry');
        let rx = rxa != null && rxa !== 'auto' ? L('rx', ctx.vw) : null;
        let ry = rya != null && rya !== 'auto' ? L('ry', ctx.vh) : null;
        if (rx == null && ry != null) rx = ry;
        if (ry == null && rx != null) ry = rx;
        rx = Math.max(0, Math.min(rx || 0, w / 2));
        ry = Math.max(0, Math.min(ry || 0, h / 2));
        if (rx && ry && Math.abs(rx - ry) > 1e-9) {
          const d = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
          return { subpaths: parsePathData(d) };
        }
        const r = rx && ry ? rx : 0;
        // SVG starts a rounded rect at the end of the top-left corner, which sets the dash phase.
        return { subpaths: [{ anchors: startAt(rectangle(x, y, w, h, r), r ? 1 : 0), closed: true }], shape: { kind: 'rect', x, y, w, h, r } };
      }
      case 'circle': {
        const r = parseLength(el.getAttribute('r'), { ref: Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2 });
        if (!(r > 0)) return { subpaths: [] };
        const cx = L('cx', ctx.vw);
        const cy = L('cy', ctx.vh);
        return { subpaths: [{ anchors: startAt(ellipseAnchors(cx - r, cy - r, 2 * r, 2 * r), 2), closed: true }], shape: { kind: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r } };
      }
      case 'ellipse': {
        const rxa = el.getAttribute('rx');
        const rya = el.getAttribute('ry');
        let rx = rxa != null && rxa !== 'auto' ? L('rx', ctx.vw) : null;
        let ry = rya != null && rya !== 'auto' ? L('ry', ctx.vh) : null;
        if (rx == null) rx = ry;
        if (ry == null) ry = rx;
        if (!(rx > 0) || !(ry > 0)) return { subpaths: [] };
        const cx = L('cx', ctx.vw);
        const cy = L('cy', ctx.vh);
        return { subpaths: [{ anchors: startAt(ellipseAnchors(cx - rx, cy - ry, 2 * rx, 2 * ry), 2), closed: true }], shape: { kind: 'ellipse', x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry } };
      }
      case 'line': {
        const x1 = L('x1', ctx.vw);
        const y1 = L('y1', ctx.vh);
        const x2 = L('x2', ctx.vw);
        const y2 = L('y2', ctx.vh);
        const a = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
        return { subpaths: [{ anchors: [a(x1, y1), a(x2, y2)], closed: false }], shape: { kind: 'line', x1, y1, x2, y2 } };
      }
      case 'polyline':
      case 'polygon': {
        const nums = parseNumberList(el.getAttribute('points'));
        const anchors = [];
        for (let i = 0; i + 1 < nums.length; i += 2) anchors.push({ x: nums[i], y: nums[i + 1], ix: nums[i], iy: nums[i + 1], ox: nums[i], oy: nums[i + 1] });
        if (anchors.length < 2) return { subpaths: [] };
        return { subpaths: [{ anchors, closed: tag === 'polygon' }] };
      }
      default:
        return { subpaths: [] };
    }
  }

  /** Live-shape params in document space when the matrix keeps the shape intact. */
  liveShape(shape, M) {
    if (!shape) return undefined;
    if (shape.kind === 'line') {
      const a = apply(M, shape.x1, shape.y1);
      const b = apply(M, shape.x2, shape.y2);
      return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    const d = decompose(M);
    const uniform = Math.abs(Math.abs(d.sx) - Math.abs(d.sy)) < 1e-6 && Math.abs(d.skew) < 1e-6 && d.sx > 0 && d.sy > 0;
    const axis = Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9 && M[0] > 0 && M[3] > 0;
    if (!uniform && !axis) return undefined;
    const c = apply(M, shape.x + shape.w / 2, shape.y + shape.h / 2);
    const sx = axis ? M[0] : d.sx;
    const sy = axis ? M[3] : d.sy;
    const angle = axis ? 0 : ((d.rotation % 360) + 360) % 360;
    if (shape.kind === 'rect') {
      const r = (shape.r || 0) * Math.min(sx, sy);
      if (shape.r && Math.abs(sx - sy) > 1e-6) return undefined;
      return { kind: 'rect', cx: c.x, cy: c.y, w: shape.w * sx, h: shape.h * sy, radii: [r, r, r, r], angle };
    }
    return { kind: 'ellipse', cx: c.x, cy: c.y, w: shape.w * sx, h: shape.h * sy, angle };
  }

  shape(el, tag, st, M, ctx) {
    const { subpaths, shape } = this.geometry(el, tag, ctx);
    if (!subpaths.length) return [];
    let bbox = null;
    for (const sp of subpaths) bbox = unionRect(bbox, pathBounds(sp.anchors, sp.closed));
    const docPaths = subpaths.map((sp) => ({ anchors: transformAnchors(sp.anchors, M), closed: sp.closed }));
    // A pattern fill becomes its tiles clipped to the shape, under the shape's stroke.
    const patternIds = tag === 'line' ? null : this.patternFill(st, bbox, M, ctx, docPaths);
    const style = this.paintStyle(patternIds ? { ...st, fill: 'none' } : st, bbox, M, ctx, tag === 'line');
    let ids;
    if (docPaths.length === 1) {
      const live = this.liveShape(shape, M);
      ids = [this.add(createPath(docPaths[0].anchors, docPaths[0].closed, style, live ? { shape: live } : {}))];
    } else {
      const kids = docPaths.map((sp) => this.add(createPath(sp.anchors, sp.closed, { fill: null, stroke: null })));
      const fillRule = String(st['fill-rule']).trim() === 'evenodd' ? 'evenodd' : 'nonzero';
      const compound = createCompound(kids, style, { fillRule });
      for (const k of kids) this.nodes.set(k, { ...this.nodes.get(k), parent: compound.id });
      ids = [this.add(compound)];
    }
    if (patternIds) ids = style.stroke ? [...patternIds, ...ids] : patternIds;
    // Markers are expanded into artwork drawn on top of the path, grouped with it.
    const markers = this.markers(subpaths, st, M, ctx);
    if (markers.length || ids.length > 1) return [this.add(createGroup([...ids, ...markers]))];
    return ids;
  }

  /**
   * Expand a pattern fill into tiles of its artwork clipped to the shape.
   * Returns the clip group ids, or null when the fill is not a usable pattern
   * (the caller then falls back to a flat color).
   */
  patternFill(st, bbox, M, ctx, docPaths) {
    const v = String(st.fill || '').trim();
    if (!v.startsWith('url(')) return null;
    const ref = this.ids.get(urlId(v));
    if (!ref || ref.localName !== 'pattern' || !bbox) return null;
    const chain = [];
    for (let p = ref; p && chain.length < 8 && !chain.includes(p) && p.localName === 'pattern'; ) {
      chain.push(p);
      const id = (hrefOf(p).match(/#(.+)$/) || [])[1];
      p = id ? this.ids.get(decodeURIComponent(id)) : null;
    }
    const attr = (n) => {
      for (const c of chain) if (c.hasAttribute(n)) return c.getAttribute(n);
      return null;
    };
    const content = chain.find((c) => c.children.length);
    if (!content) return null;
    const obb = (attr('patternUnits') || 'objectBoundingBox') !== 'userSpaceOnUse';
    const len = (n, ref, size) => {
      const a = attr(n);
      if (a == null) return 0;
      if (obb) {
        const t = String(a).trim();
        return (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)) * size || 0;
      }
      return parseLength(a, { ref });
    };
    const tx = (obb ? bbox.x : 0) + len('x', ctx.vw, bbox.w);
    const ty = (obb ? bbox.y : 0) + len('y', ctx.vh, bbox.h);
    const tw = len('width', ctx.vw, bbox.w);
    const th = len('height', ctx.vh, bbox.h);
    if (!(tw > 0) || !(th > 0)) return null;
    const PT = parseTransform(attr('patternTransform'));
    const inv = invert(PT);
    if (!inv) return null;
    // Tiles covering the shape's box, in pattern space.
    const pts = [[bbox.x, bbox.y], [bbox.x + bbox.w, bbox.y], [bbox.x, bbox.y + bbox.h], [bbox.x + bbox.w, bbox.y + bbox.h]].map(([x, y]) => apply(inv, x, y));
    const i0 = Math.floor((Math.min(...pts.map((p) => p.x)) - tx) / tw);
    const i1 = Math.ceil((Math.max(...pts.map((p) => p.x)) - tx) / tw);
    const j0 = Math.floor((Math.min(...pts.map((p) => p.y)) - ty) / th);
    const j1 = Math.ceil((Math.max(...pts.map((p) => p.y)) - ty) / th);
    if ((i1 - i0) * (j1 - j0) > 2500) return null;
    const vb = parseNumberList(attr('viewBox'));
    const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    const inner = hasVb
      ? viewBoxTransform(vb, 0, 0, tw, th, attr('preserveAspectRatio'))
      : (attr('patternContentUnits') || 'userSpaceOnUse') === 'objectBoundingBox'
        ? [bbox.w, 0, 0, bbox.h, 0, 0]
        : identity();
    const pst = this.markerStyle(content);
    const stack = ctx.useStack || new Set();
    if (stack.has(content)) return null;
    const tiles = [];
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const T = multiply(multiply(M, PT), multiply(translate(tx + i * tw, ty + j * th), inner));
        tiles.push(...this.convertChildren(content, { ...ctx, ctm: T, style: pst, vw: hasVb ? vb[2] : tw, vh: hasVb ? vb[3] : th, useStack: new Set([...stack, content]) }));
      }
    }
    if (!tiles.length) return null;
    const opacity = opacityValue(st['fill-opacity'], 1);
    const group = this.add(createGroup(tiles, opacity < 1 ? { opacity } : {}));
    const rule = String(st['fill-rule']).trim() === 'evenodd' ? 'evenodd' : 'nonzero';
    return this.clipGroup([group], this.maskNode(docPaths.map((sp) => ({ anchors: sp.anchors, closed: true })), rule));
  }

  /** Expanded marker-start/mid/end artwork for a shape's local subpaths. */
  markers(subpaths, st, M, ctx) {
    const ref = (k) => {
      const v = st[k];
      if (!v || v === 'none') return null;
      const id = urlId(v);
      const el = id ? this.ids.get(id) : null;
      return el && el.localName === 'marker' ? el : null;
    };
    const kinds = { start: ref('marker-start'), mid: ref('marker-mid'), end: ref('marker-end') };
    if (!kinds.start && !kinds.mid && !kinds.end) return [];
    // Vertices with incoming and outgoing directions, in the shape's local space.
    const verts = [];
    for (const sp of subpaths) {
      const a = sp.anchors;
      const n = a.length;
      if (!n) continue;
      const pts = sp.closed ? [...a, a[0]] : a;
      pts.forEach((p, i) => {
        const prev = i > 0 ? pts[i - 1] : sp.closed ? a[n - 1] : null;
        const next = i < pts.length - 1 ? pts[i + 1] : null;
        let din = null;
        if (prev) din = Math.hypot(p.x - p.ix, p.y - p.iy) > 1e-9 ? [p.x - p.ix, p.y - p.iy] : Math.hypot(p.x - prev.ox, p.y - prev.oy) > 1e-9 ? [p.x - prev.ox, p.y - prev.oy] : [p.x - prev.x, p.y - prev.y];
        let dout = null;
        if (next) dout = Math.hypot(p.ox - p.x, p.oy - p.y) > 1e-9 ? [p.ox - p.x, p.oy - p.y] : Math.hypot(next.ix - p.x, next.iy - p.y) > 1e-9 ? [next.ix - p.x, next.iy - p.y] : [next.x - p.x, next.y - p.y];
        verts.push({ x: p.x, y: p.y, din, dout });
      });
    }
    if (!verts.length) return [];
    const angleOf = (v) => {
      const ain = v.din ? Math.atan2(v.din[1], v.din[0]) : null;
      const aout = v.dout ? Math.atan2(v.dout[1], v.dout[0]) : null;
      if (ain == null) return aout ?? 0;
      if (aout == null) return ain;
      // Bisect the turn between the incoming and outgoing directions.
      let d = aout - ain;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return ain + d / 2;
    };
    const lw = parseLength(st['stroke-width'], { ref: Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2, fontSize: st['font-size'], fallback: 1 });
    const out = [];
    const place = (marker, v, which) => {
      const mst = this.markerStyle(marker);
      if (mst.display === 'none') return;
      const orient = String(marker.getAttribute('orient') || '0').trim();
      let deg;
      if (orient === 'auto' || orient === 'auto-start-reverse') {
        deg = (angleOf(v) * 180) / Math.PI;
        if (orient === 'auto-start-reverse' && which === 'start') deg += 180;
      } else deg = parseFloat(orient) || 0;
      const units = String(marker.getAttribute('markerUnits') || 'strokeWidth').trim();
      const k = units === 'userSpaceOnUse' ? 1 : lw;
      const mw = parseLength(marker.getAttribute('markerWidth') ?? '3', { ref: ctx.vw, fallback: 3 });
      const mh = parseLength(marker.getAttribute('markerHeight') ?? '3', { ref: ctx.vh, fallback: 3 });
      if (!(mw > 0) || !(mh > 0)) return;
      const vb = parseNumberList(marker.getAttribute('viewBox'));
      const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
      const V = hasVb ? viewBoxTransform(vb, 0, 0, mw, mh, marker.getAttribute('preserveAspectRatio')) : identity();
      const r = apply(V, parseLength(marker.getAttribute('refX'), { ref: hasVb ? vb[2] : mw, fallback: 0 }), parseLength(marker.getAttribute('refY'), { ref: hasVb ? vb[3] : mh, fallback: 0 }));
      const T = multiply(multiply(multiply(M, translate(v.x, v.y)), multiply(rotate(deg), scaleM(k, k))), multiply(translate(-r.x, -r.y), V));
      const ids = this.convertChildren(marker, { ...ctx, ctm: T, style: mst, vw: hasVb ? vb[2] : mw, vh: hasVb ? vb[3] : mh, useStack: new Set([...(ctx.useStack || []), marker]) });
      if (ids.length) out.push(...(ids.length > 1 ? [this.add(createGroup(ids))] : ids));
    };
    if (ctx.useStack?.has(kinds.start) || ctx.useStack?.has(kinds.mid) || ctx.useStack?.has(kinds.end)) return [];
    if (kinds.start) place(kinds.start, verts[0], 'start');
    if (kinds.mid) for (let i = 1; i < verts.length - 1; i++) place(kinds.mid, verts[i], 'mid');
    if (kinds.end && verts.length) place(kinds.end, verts[verts.length - 1], 'end');
    return out;
  }

  /** A marker's style inherits from its own ancestors, not from the path that uses it. */
  markerStyle(marker) {
    const chain = [];
    for (let e = marker; e && e.nodeType === 1; e = e.parentElement) chain.unshift(e);
    let st = { ...BASE_STYLE };
    for (const e of chain) st = this.computeStyle(e, st);
    return st;
  }

  /** Model style fields (fill, stroke and stroke options) from a computed style. */
  paintStyle(st, bbox, M, ctx, noFill = false) {
    const s = scaleOf(M);
    const fill = noFill ? null : this.paint(st.fill, st['fill-opacity'], st, bbox, M);
    let stroke = this.paint(st.stroke, st['stroke-opacity'], st, bbox, M);
    const nonScaling = String(st['vector-effect'] || '').trim() === 'non-scaling-stroke';
    const diag = Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2;
    let strokeWidth = parseLength(st['stroke-width'], { ref: diag, fontSize: st['font-size'], fallback: 1 }) * (nonScaling ? 1 : s);
    if (!(strokeWidth > 0)) {
      stroke = null;
      strokeWidth = 0;
    }
    let dash = [];
    const da = String(st['stroke-dasharray'] || 'none').trim();
    if (da !== 'none') {
      const parts = da.split(/[\s,]+/).filter(Boolean).map((p) => parseLength(p, { ref: diag, fontSize: st['font-size'], fallback: NaN }));
      if (parts.length && parts.every((v) => Number.isFinite(v) && v >= 0) && parts.some((v) => v > 0)) {
        dash = (parts.length % 2 ? [...parts, ...parts] : parts).map((v) => v * (nonScaling ? 1 : s));
      }
    }
    const cap = String(st['stroke-linecap']).trim();
    const join = String(st['stroke-linejoin']).trim();
    return {
      fill,
      stroke,
      strokeWidth: strokeWidth || 1,
      strokeCap: ['butt', 'round', 'square'].includes(cap) ? cap : 'butt',
      strokeJoin: join === 'round' ? 'round' : join === 'bevel' ? 'bevel' : 'miter',
      miterLimit: Math.max(1, num(st['stroke-miterlimit'], 4)),
      dash,
      dashOffset: dash.length ? parseLength(st['stroke-dashoffset'], { ref: diag, fallback: 0 }) * (nonScaling ? 1 : s) : 0,
    };
  }

  /** A paint from a fill/stroke value. */
  paint(value, opacityStr, st, bbox, M) {
    const v = String(value ?? 'none').trim();
    if (!v || v === 'none') return null;
    const opacity = opacityValue(opacityStr, 1);
    if (v.startsWith('url(')) {
      const id = urlId(v);
      const ref = id ? this.ids.get(id) : null;
      const fallback = v.slice(v.indexOf(')') + 1).trim();
      if (ref && (ref.localName === 'linearGradient' || ref.localName === 'radialGradient')) {
        const g = this.gradient(ref, bbox, M, opacity, st);
        if (g !== undefined) return g;
      }
      if (ref && ref.localName === 'pattern') this.warn('Pattern fills were replaced with a flat color.');
      if (fallback) return this.paint(fallback, opacityStr, st, bbox, M);
      if (ref && ref.localName === 'pattern') {
        const color = this.patternColor(ref) || '#808080';
        return { type: 'solid', color, ...(opacity < 1 ? { opacity } : {}) };
      }
      return null;
    }
    const raw = v === 'currentColor' || v === 'currentcolor' ? st.color : v;
    const c = parseColor(raw);
    if (!c) {
      if (/^(transparent|none)$/i.test(String(raw).trim())) return null;
      return { type: 'solid', color: '#000000', ...(opacity < 1 ? { opacity } : {}) };
    }
    const a = c.alpha * opacity;
    if (a <= 0) return null;
    return a < 1 ? { type: 'solid', color: c.hex, opacity: Math.round(a * 1000) / 1000 } : { type: 'solid', color: c.hex };
  }

  /**
   * A flat stand-in color for a pattern: the solid fill of its first filled
   * shape (usually the tile background, like chart hatching over a bar color).
   */
  patternColor(el) {
    for (let p = el, depth = 0; p && depth < 8; depth++) {
      const base = this.computeStyle(p, BASE_STYLE);
      for (const shape of p.querySelectorAll('rect, path, circle, ellipse, polygon')) {
        let st = base;
        const chain = [];
        for (let a = shape; a && a !== p; a = a.parentElement) chain.unshift(a);
        for (const a of chain) st = this.computeStyle(a, st);
        const c = parseColor(String(st.fill || '').trim());
        if (c && c.alpha > 0) return c.hex;
      }
      const id = (hrefOf(p).match(/#(.+)$/) || [])[1];
      p = id ? this.ids.get(decodeURIComponent(id)) : null;
    }
    return null;
  }

  /** Gradient element to a document paint. Returns undefined when it cannot be used. */
  gradient(el, bbox, M, opacity, st) {
    const chain = [];
    let g = el;
    while (g && chain.length < 12 && !chain.includes(g) && (g.localName === 'linearGradient' || g.localName === 'radialGradient')) {
      chain.push(g);
      const id = (hrefOf(g).match(/#(.+)$/) || [])[1];
      g = id ? this.ids.get(decodeURIComponent(id)) : null;
    }
    const attr = (name) => {
      for (const c of chain) if (c.hasAttribute(name)) return c.getAttribute(name);
      return null;
    };
    const stopHost = chain.find((c) => [...c.children].some((ch) => ch.localName === 'stop'));
    const stops = [];
    if (stopHost) {
      const gst = this.computeStyle(stopHost, st);
      let last = 0;
      for (const s of stopHost.children) {
        if (s.localName !== 'stop') continue;
        const sst = this.computeStyle(s, gst);
        const offRaw = s.getAttribute('offset') ?? '0';
        let off = String(offRaw).trim().endsWith('%') ? parseFloat(offRaw) / 100 : parseFloat(offRaw);
        if (!Number.isFinite(off)) off = 0;
        off = Math.max(last, Math.min(1, Math.max(0, off)));
        last = off;
        const colorRaw = sst['stop-color'] ?? 'black';
        const c = parseColor(colorRaw === 'currentColor' ? sst.color : colorRaw) || { hex: '#000000', alpha: 1 };
        const so = opacityValue(sst['stop-opacity'], 1) * c.alpha * opacity;
        stops.push({ offset: Math.round(off * 10000) / 10000, color: c.hex, opacity: Math.round(so * 1000) / 1000 });
      }
    }
    if (!stops.length) return null;
    if (stops.length === 1) return { type: 'solid', color: stops[0].color, ...(stops[0].opacity < 1 ? { opacity: stops[0].opacity } : {}) };
    const units = attr('gradientUnits') || 'objectBoundingBox';
    const obb = units !== 'userSpaceOnUse';
    if (obb && (!bbox || bbox.w <= 0 || bbox.h <= 0)) {
      const s = stops[stops.length - 1];
      return { type: 'solid', color: s.color, ...(s.opacity < 1 ? { opacity: s.opacity } : {}) };
    }
    const spread = String(attr('spreadMethod') || 'pad').trim();
    const base = obb ? multiply(M, [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y]) : M;
    const T = multiply(base, parseTransform(attr('gradientTransform')));
    const vw = this.vw || 100;
    const vh = this.vh || 100;
    const val = (name, def, ref) => {
      const v = attr(name);
      if (v == null || v === '') return def;
      if (obb) {
        const s = String(v).trim();
        const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
        return Number.isFinite(n) ? n : def;
      }
      return parseLength(v, { ref, fallback: def });
    };
    const type = el.localName === 'radialGradient' ? 'radial' : 'linear';
    let x1;
    let y1;
    let x2;
    let y2;
    if (type === 'linear') {
      const lx1 = val('x1', 0, vw);
      const ly1 = val('y1', 0, vh);
      const lx2 = val('x2', obb ? 1 : vw, vw);
      const ly2 = val('y2', 0, vh);
      const p1 = apply(T, lx1, ly1);
      const dx = lx2 - lx1;
      const dy = ly2 - ly1;
      const det = T[0] * T[3] - T[1] * T[2];
      if (!det || (!dx && !dy)) {
        const s = stops[stops.length - 1];
        return { type: 'solid', color: s.color, ...(s.opacity < 1 ? { opacity: s.opacity } : {}) };
      }
      // Exact equivalent under any affine map: the gradient normal maps by the inverse transpose.
      const nx = (T[3] * dx - T[1] * dy) / det;
      const ny = (-T[2] * dx + T[0] * dy) / det;
      const k = (dx * dx + dy * dy) / (nx * nx + ny * ny);
      x1 = p1.x;
      y1 = p1.y;
      x2 = p1.x + nx * k;
      y2 = p1.y + ny * k;
    } else {
      const diag = Math.hypot(vw, vh) / Math.SQRT2;
      const cx = val('cx', obb ? 0.5 : vw / 2, vw);
      const cy = val('cy', obb ? 0.5 : vh / 2, vh);
      const r = val('r', obb ? 0.5 : diag / 2, diag);
      const c = apply(T, cx, cy);
      // The gradient circle maps to an ellipse: its axes come from the
      // singular value decomposition of the linear part of T.
      const [a, b, cc, d] = T;
      const e00 = a * a + cc * cc;
      const e01 = a * b + cc * d;
      const e11 = b * b + d * d;
      const tr = e00 + e11;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (e00 * e11 - e01 * e01)));
      const s1 = Math.sqrt(Math.max(0, tr / 2 + disc));
      const s2 = Math.sqrt(Math.max(0, tr / 2 - disc));
      if (!(r * s1 > 0)) {
        const s = stops[stops.length - 1];
        return { type: 'solid', color: s.color, ...(s.opacity < 1 ? { opacity: s.opacity } : {}) };
      }
      let ux = e01;
      let uy = s1 * s1 - e00;
      if (Math.hypot(ux, uy) < 1e-12) {
        ux = s1 * s1 - e11;
        uy = e01;
      }
      if (Math.hypot(ux, uy) < 1e-12) {
        ux = 1;
        uy = 0;
      }
      const ul = Math.hypot(ux, uy);
      const R = r * s1;
      x1 = c.x;
      y1 = c.y;
      x2 = c.x + (ux / ul) * R;
      y2 = c.y + (uy / ul) * R;
      const aspect = s2 / s1;
      // Focal point (fx, fy, fr): kept as an offset in the gradient's own
      // unit circle (major axis, then minor axis), so it follows the object.
      const focal = {};
      const fx = val('fx', cx, vw);
      const fy = val('fy', cy, vh);
      const fr = val('fr', 0, diag);
      if (Math.abs(fx - cx) > 1e-9 || Math.abs(fy - cy) > 1e-9) {
        const F = apply(T, fx, fy);
        const Ax = x2 - x1;
        const Ay = y2 - y1;
        const Px = -Ay * aspect;
        const Py = Ax * aspect;
        const det = Ax * Py - Ay * Px;
        if (Math.abs(det) > 1e-12) {
          let u = ((F.x - c.x) * Py - (F.y - c.y) * Px) / det;
          let v = (Ax * (F.y - c.y) - Ay * (F.x - c.x)) / det;
          // SVG 1.1 moves a focal point outside the circle onto its edge.
          const len = Math.hypot(u, v);
          if (len > 0.99) (u = (u / len) * 0.99), (v = (v / len) * 0.99);
          focal.focal = [Math.round(u * 1e5) / 1e5, Math.round(v * 1e5) / 1e5];
        }
      }
      if (fr > 0 && r > 0) focal.focalRadius = Math.round(Math.min(1, fr / r) * 1e5) / 1e5;
      if (Math.abs(aspect - 1) > 1e-4) {
        const angle = (-Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        return this.spreadGradient({ type, stops, angle: Math.round(angle * 1000) / 1000, x1, y1, x2, y2, aspect: Math.round(aspect * 1e5) / 1e5, ...focal }, spread, bbox, M);
      }
      const angle = (-Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      return this.spreadGradient({ type, stops, angle: Math.round(angle * 1000) / 1000, x1, y1, x2, y2, ...focal }, spread, bbox, M);
    }
    const angle = (-Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    return this.spreadGradient({ type, stops, angle: Math.round(angle * 1000) / 1000, x1, y1, x2, y2 }, spread, bbox, M);
  }

  /**
   * spreadMethod repeat/reflect: repeat the stops along a longer gradient
   * vector that covers the whole object (bbox in local space, M to the
   * document), so it renders like the browser does.
   */
  spreadGradient(g, spread, bbox, M) {
    if ((spread !== 'repeat' && spread !== 'reflect') || !bbox) return g;
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) return g;
    const corners = [
      [bbox.x, bbox.y],
      [bbox.x + bbox.w, bbox.y],
      [bbox.x, bbox.y + bbox.h],
      [bbox.x + bbox.w, bbox.y + bbox.h],
    ].map(([x, y]) => apply(M, x, y));
    let t0 = 0;
    let t1 = 1;
    if (g.type === 'linear') {
      const ts = corners.map((p) => ((p.x - g.x1) * dx + (p.y - g.y1) * dy) / L2);
      t0 = Math.floor(Math.min(...ts) + 1e-9);
      t1 = Math.ceil(Math.max(...ts) - 1e-9);
    } else {
      const aspect = g.aspect || 1;
      const ts = corners.map((p) => Math.hypot(((p.x - g.x1) * dx + (p.y - g.y1) * dy) / L2, ((p.y - g.y1) * dx - (p.x - g.x1) * dy) / (L2 * aspect)));
      t1 = Math.ceil(Math.max(...ts) - 1e-9);
    }
    if (t0 >= 0 && t1 <= 1) return g;
    if (t1 - t0 > 64) {
      this.warn('Repeating gradients were imported as padded gradients.');
      return g;
    }
    const stops = [];
    for (let k = t0; k < t1; k++) {
      const rev = spread === 'reflect' && k % 2 !== 0;
      for (const st of rev ? [...g.stops].reverse() : g.stops) {
        const o = rev ? 1 - st.offset : st.offset;
        stops.push({ ...st, offset: Math.round(((k - t0 + o) / (t1 - t0)) * 1e5) / 1e5 });
      }
    }
    const out = { ...g, stops, x1: g.x1 + dx * t0, y1: g.y1 + dy * t0, x2: g.x1 + dx * t1, y2: g.y1 + dy * t1 };
    // A larger radius keeps the focal point where it was.
    if (g.focal) out.focal = g.focal.map((v) => v / t1);
    if (g.focalRadius) out.focalRadius = g.focalRadius / t1;
    return out;
  }

  // ---- clipping, masks, filters ----

  /** Collect clip geometry (doc-space subpaths) from the children of a clipPath/mask. */
  clipGeometry(container, T, parentStyle, opts = {}, depth = 0) {
    const out = [];
    let rule = 'nonzero';
    for (const child of container.children) {
      if (depth > 16) break;
      const tag = child.localName;
      const st = this.computeStyle(child, parentStyle);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const tf = child.getAttribute('transform');
      const M = tf ? multiply(T, parseTransform(tf)) : T;
      if (opts.filter && !opts.filter(child, st)) continue;
      if (['path', 'rect', 'circle', 'ellipse', 'polyline', 'polygon'].includes(tag)) {
        const { subpaths } = this.geometry(child, tag, { vw: this.vw, vh: this.vh });
        for (const sp of subpaths) out.push({ anchors: transformAnchors(sp.anchors, M), closed: true });
        if (String(st['clip-rule']).trim() === 'evenodd') rule = 'evenodd';
      } else if (tag === 'use') {
        const id = (hrefOf(child).match(/#(.+)$/) || [])[1];
        const target = id ? this.ids.get(decodeURIComponent(id)) : null;
        if (target && target !== container) {
          const x = parseLength(child.getAttribute('x'));
          const y = parseLength(child.getAttribute('y'));
          const wrap = { children: [target] };
          const r = this.clipGeometry(wrap, multiply(M, translate(x, y)), st, opts, depth + 1);
          out.push(...r.subpaths);
          if (r.rule === 'evenodd') rule = 'evenodd';
        }
      } else if (tag === 'g') {
        const r = this.clipGeometry(child, M, st, opts, depth + 1);
        out.push(...r.subpaths);
      } else if (tag === 'text') {
        const ids = this.text(child, st, M, { vw: this.vw, vh: this.vh });
        for (const id of ids) {
          const b = nodeBounds(this.shim, this.nodes.get(id));
          if (b) out.push({ anchors: rectangle(b.x, b.y, b.w, b.h), closed: true });
        }
        if (ids.length) this.warn('Text used as a clipping path was approximated by its bounding box.');
      }
    }
    return { subpaths: out, rule };
  }

  contentBounds(ids) {
    let b = null;
    for (const id of ids) b = unionRect(b, nodeBounds(this.shim, this.nodes.get(id)));
    return b;
  }

  /** Mask node (path or compound) from doc-space subpaths. */
  maskNode(subpaths, rule) {
    if (subpaths.length === 1) return this.add(createPath(subpaths[0].anchors, true, { fill: null, stroke: null }));
    const kids = subpaths.map((sp) => this.add(createPath(sp.anchors, true, { fill: null, stroke: null })));
    const c = createCompound(kids, { fill: null, stroke: null }, { fillRule: rule });
    for (const k of kids) this.nodes.set(k, { ...this.nodes.get(k), parent: c.id });
    return this.add(c);
  }

  /** Units transform for clipPathUnits/maskContentUnits = objectBoundingBox. */
  obbTransform(M, ids) {
    const b = this.contentBounds(ids);
    if (!b) return null;
    const local = transformRect(b, invert(M));
    return [local.w, 0, 0, local.h, local.x, local.y];
  }

  applyClip(ref, M, ids, ctx) {
    const id = urlId(ref);
    const cp = id ? this.ids.get(id) : null;
    if (!cp || cp.localName !== 'clipPath') return ids;
    let T = M;
    const tf = cp.getAttribute('transform');
    if (tf) T = multiply(T, parseTransform(tf));
    if (cp.getAttribute('clipPathUnits') === 'objectBoundingBox') {
      const u = this.obbTransform(M, ids);
      if (!u) return ids;
      T = multiply(T, u);
    }
    const base = this.computeStyle(cp, ctx.style);
    const { subpaths, rule } = this.clipGeometry(cp, T, base);
    if (!subpaths.length) return []; // an empty clip path hides everything
    if (base['clip-path'] && base['clip-path'] !== 'none') this.warn('Nested clipping paths were simplified.');
    const mask = this.maskNode(subpaths, rule);
    return this.clipGroup(ids, mask);
  }

  /** Wrap ids in a clip group, reusing a lone plain group instead of nesting another one. */
  clipGroup(ids, mask) {
    if (ids.length === 1) {
      const g = this.nodes.get(ids[0]);
      if (g.type === 'group' && !g.clip && (g.opacity ?? 1) === 1 && !g.effects?.length && (!g.blendMode || g.blendMode === 'normal')) {
        this.nodes.set(g.id, { ...g, clip: true, children: [...g.children, mask] });
        return [g.id];
      }
    }
    return [this.add(createGroup([...ids, mask], { clip: true }))];
  }

  applyMask(ref, M, ids, ctx) {
    const id = urlId(ref);
    const mk = id ? this.ids.get(id) : null;
    if (!mk || mk.localName !== 'mask') return ids;
    // Masks made of opaque white shapes map to a clip, and so does one white
    // shape with black cut-outs on top (a hole); anything with gradients or
    // gray levels is left out (content stays visible).
    let simple = true;
    const order = [];
    const base = this.computeStyle(mk, ctx.style);
    const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polyline', 'polygon']);
    const classify = (st) => {
      const fill = String(st.fill || 'black').trim();
      if (fill === 'none') return 'none';
      if (fill.startsWith('url(')) return 'other';
      const c = parseColor(fill === 'currentColor' ? st.color : fill);
      if (!c) return 'other';
      const { r, g, b } = hexToRgb(c.hex);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const alpha = c.alpha * opacityValue(st['fill-opacity']) * opacityValue(st.opacity);
      if (alpha >= 0.99 && lum >= 0.9) return 'white';
      if (lum <= 0.1 || alpha <= 0.01) return 'black';
      return 'other';
    };
    const check = (el, st) => {
      if (!SHAPES.has(el.localName)) return true;
      const k = classify(st);
      if (k === 'other') simple = false;
      order.push(k);
      return true;
    };
    let T = M;
    if (mk.getAttribute('maskContentUnits') === 'objectBoundingBox') {
      const u = this.obbTransform(M, ids);
      if (!u) return ids;
      T = multiply(T, u);
    }
    this.clipGeometry(mk, T, base, { filter: check });
    const only = (kind) => (el, st) => !SHAPES.has(el.localName) || classify(st) === kind;
    const whites = simple ? this.clipGeometry(mk, T, base, { filter: only('white') }).subpaths : [];
    const blacks = simple ? this.clipGeometry(mk, T, base, { filter: only('black') }).subpaths : [];
    let subpaths = whites;
    let rule = 'nonzero';
    if (simple && blacks.length) {
      // Black on top of a single white shape cuts holes; any other arrangement is not a plain clip.
      const firstBlack = order.indexOf('black');
      const whiteAfter = order.lastIndexOf('white') > firstBlack;
      const outer = whites.length === 1 ? pathBounds(whites[0].anchors, true) : null;
      const boxes = blacks.map((sp) => pathBounds(sp.anchors, true));
      const inside = outer && boxes.every((b) => b.x >= outer.x && b.y >= outer.y && b.x + b.w <= outer.x + outer.w && b.y + b.h <= outer.y + outer.h);
      const apart = boxes.every((a, i) => boxes.every((b, j) => j <= i || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
      if (whiteAfter || !inside || !apart) simple = false;
      else {
        subpaths = [...whites, ...blacks];
        rule = 'evenodd';
      }
    }
    if (!simple || !whites.length) {
      this.warn('Masks with transparency were ignored.');
      return ids;
    }
    this.warn('Masks were converted to clipping paths.');
    const mask = this.maskNode(subpaths, rule);
    return this.clipGroup(ids, mask);
  }

  filterEffects(ref, s) {
    const id = urlId(ref);
    const f = id ? this.ids.get(id) : null;
    if (!f || f.localName !== 'filter') {
      if (!/^url\(/.test(String(ref).trim())) this.warn('CSS filter functions were ignored.');
      return null;
    }
    const prims = [...f.children];
    const names = prims.map((p) => p.localName);
    const std = (p) => {
      const v = parseNumberList(p?.getAttribute('stdDeviation'));
      return v.length ? (v[0] + (v[1] ?? v[0])) / 2 : 0;
    };
    const ds = prims.find((p) => p.localName === 'feDropShadow');
    if (ds) {
      const fst = this.computeStyle(ds, BASE_STYLE);
      const c = parseColor(ds.getAttribute('flood-color') || fst['flood-color'] || 'black') || { hex: '#000000', alpha: 1 };
      return [{ type: 'dropShadow', x: num(ds.getAttribute('dx'), 2) * s, y: num(ds.getAttribute('dy'), 2) * s, blur: std(ds) * 2 * s, color: c.hex, opacity: opacityValue(ds.getAttribute('flood-opacity'), 1) * c.alpha }];
    }
    const blur = prims.find((p) => p.localName === 'feGaussianBlur');
    if (names.length === 1 && blur) return [{ type: 'blur', radius: std(blur) * s }];
    const off = prims.find((p) => p.localName === 'feOffset');
    // Drop shadows: blur + offset merged (or, as design tools write them, blended) under the source.
    if (blur && off && (names.includes('feMerge') || names.includes('feBlend'))) {
      // A transparent flood is only a background placeholder ("BackgroundImageFix").
      const flood = prims.find((p) => p.localName === 'feFlood' && opacityValue(p.getAttribute('flood-opacity'), 1) > 0);
      // The tint is the color matrix applied after the blur, not the one that extracts the alpha.
      const cm = prims.filter((p) => p.localName === 'feColorMatrix' && p.getAttribute('in') !== 'SourceAlpha').pop();
      let color = '#000000';
      let opacity = 1;
      if (flood) {
        const c = parseColor(flood.getAttribute('flood-color') || 'black');
        if (c) color = c.hex;
        opacity = opacityValue(flood.getAttribute('flood-opacity'), 1);
      } else if (cm) {
        const v = parseNumberList(cm.getAttribute('values'));
        if (v.length === 20) {
          color = rgbToHex({ r: v[4] * 255, g: v[9] * 255, b: v[14] * 255 });
          opacity = Math.max(0, Math.min(1, v[18] || v[19] || 0.5));
        }
      }
      return [{ type: 'dropShadow', x: num(off.getAttribute('dx'), 0) * s, y: num(off.getAttribute('dy'), 0) * s, blur: std(blur) * 2 * s, color, opacity }];
    }
    // Inner glow as written by the SVG exporter: (inverted alpha,) blur, flood, clip to the shape, blend.
    const fb = prims.find((p) => p.localName === 'feBlend');
    const flood = prims.find((p) => p.localName === 'feFlood');
    if (blur && fb && flood && !off && names.filter((n) => n === 'feComposite').length >= 2) {
      const ct = prims.find((p) => p.localName === 'feComponentTransfer');
      const c = parseColor(flood.getAttribute('flood-color') || 'white') || { hex: '#ffffff', alpha: 1 };
      const m = String(fb.getAttribute('mode') || 'normal').trim();
      return [{ type: 'innerGlow', mode: m === 'normal' ? 'normal' : BLEND[m] || 'screen', opacity: opacityValue(flood.getAttribute('flood-opacity'), 1) * c.alpha, blur: std(blur) * s, color: c.hex, source: ct ? 'edge' : 'center' }];
    }
    this.warn('Some filter effects are not supported and were left out.');
    return null;
  }

  // ---- text ----

  charOf(st) {
    const fam = String(st['font-family'] || 'sans-serif').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'sans-serif';
    const w = String(st['font-weight'] || 'normal').trim();
    const weight = w === 'bold' || w === 'bolder' ? 700 : w === 'lighter' ? 300 : Number.isFinite(parseFloat(w)) ? parseFloat(w) : 400;
    const size = st['font-size'] || 16;
    const ls = String(st['letter-spacing'] || 'normal').trim();
    const track = ls === 'normal' ? 0 : (parseLength(ls, { fontSize: size, fallback: 0 }) / size) * 1000;
    const deco = String(st['text-decoration'] || '');
    return {
      ...DEFAULT_CHAR,
      fontFamily: fam,
      fontWeight: weight,
      fontStyle: /italic|oblique/.test(st['font-style'] || '') ? 'italic' : 'normal',
      fontSize: Math.round(size * 1000) / 1000,
      tracking: Math.round(track * 100) / 100,
      underline: /underline/.test(deco),
      strike: /line-through/.test(deco),
    };
  }

  text(el, st, M, ctx) {
    const chunks = [];
    let chunk = null;
    let cx = 0;
    let cy = 0;
    const preserve = el.getAttribute('xml:space') === 'preserve' || /pre/.test(st['white-space'] || '');
    const first = (attr, ref) => {
      const v = el && attr != null ? String(attr).trim().split(/[\s,]+/)[0] : null;
      return v ? parseLength(v, { ref, fallback: NaN }) : NaN;
    };
    const walk = (node, style, isRoot, parentRise = 0) => {
      const nst = isRoot ? style : this.computeStyle(node, style);
      if (nst.display === 'none') return;
      // baseline-shift is not inherited but nested shifts add up (positive = up, like riseOf).
      const rise = isRoot ? 0 : parentRise + baselineShiftOf(nst['baseline-shift'], nst['font-size']);
      if (node.localName === 'textPath') this.warn('Text on a path was imported as straight text.');
      const x = first(node.getAttribute('x'), ctx.vw);
      const y = first(node.getAttribute('y'), ctx.vh);
      const dx = first(node.getAttribute('dx'), ctx.vw);
      const dy = first(node.getAttribute('dy'), ctx.vh);
      const penX = cx;
      let positioned = false;
      if (Number.isFinite(x)) (cx = x), (positioned = true);
      if (Number.isFinite(y)) (cy = y), (positioned = true);
      if (Number.isFinite(dx) && dx) (cx += dx), (positioned = true);
      if (Number.isFinite(dy) && dy) (cy += dy), (positioned = true);
      const anchor = String(nst['text-anchor'] || 'start').trim();
      // A positioned span that starts where the line's pen already is (as
      // design tools write every style run: x on each tspan) and stays near
      // its baseline continues the line; the vertical offset becomes a
      // baseline shift.
      const em = Math.max(nst['font-size'] || 16, chunk?.runs[0]?.char.fontSize || 0);
      const continues = positioned && chunk && chunk.runs.length && anchor === 'start' && chunk.anchor === 'start' && Math.abs(cx - penX) <= em * 0.3 && Math.abs(cy - chunk.y) <= em * 0.75;
      if ((positioned && !continues) || !chunk) {
        // An explicit y plus a dy on a line's first span is a shifted first run.
        const base = Number.isFinite(y) && Number.isFinite(dy) && dy && Math.abs(dy) <= em * 0.75 ? y : cy;
        chunk = { x: cx, y: base, anchor, runs: [] };
        chunks.push(chunk);
      }
      // Per-character positions (x="10 30 50"): each positioned character starts a new piece.
      const list = (name, ref) => String(node.getAttribute(name) || '').trim().split(/[\s,]+/).filter(Boolean).map((v) => parseLength(v, { ref, fallback: NaN }));
      const xs = list('x', ctx.vw);
      const ys = list('y', ctx.vh);
      const dxs = list('dx', ctx.vw);
      const dys = list('dy', ctx.vh);
      const perChar = xs.length > 1 || ys.length > 1 || dxs.length > 1 || dys.length > 1;
      let k = 0;
      const addText = (t) => {
        const prev = chunk.runs[chunk.runs.length - 1];
        if (!preserve && prev && prev.text.endsWith(' ') && t.startsWith(' ')) t = t.slice(1);
        if (!t) return;
        const shift = rise + (chunk.y - cy);
        const key = `${textKey(nst)}|${shift}`;
        if (prev && prev.key === key) {
          prev.text += t;
          cx = prev.x + measure(prev.text, prev.char);
        } else {
          const char = { ...this.charOf(nst), baselineShift: Math.round(shift * 1000) / 1000 };
          const run = { text: t, st: nst, key, char, x: cx, y: cy };
          chunk.runs.push(run);
          cx += measure(t, char);
        }
      };
      for (const child of node.childNodes) {
        if (child.nodeType === 3 || child.nodeType === 4) {
          let t = child.nodeValue || '';
          if (!preserve) t = t.replace(/[\r\n]+/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');
          if (!t) continue;
          if (!perChar) {
            addText(t);
            continue;
          }
          // Leading white space is not addressable, so it does not use up a position.
          if (!preserve && k === 0) t = t.replace(/^ +/, '');
          let start = 0;
          for (let i = 0; i < t.length; i++) {
            const n = k + i;
            const has = (a) => n < a.length && Number.isFinite(a[n]);
            if (n === 0 || !(has(xs) || has(ys) || (has(dxs) && dxs[n]) || (has(dys) && dys[n]))) continue;
            if (i > start) addText(t.slice(start, i));
            if (has(xs)) cx = xs[n];
            if (has(ys)) cy = ys[n];
            if (has(dxs)) cx += dxs[n];
            if (has(dys)) cy += dys[n];
            chunk = { x: cx, y: cy, anchor, runs: [] };
            chunks.push(chunk);
            start = i;
          }
          addText(t.slice(start));
          k += t.length;
        } else if (child.nodeType === 1 && ['tspan', 'a', 'textPath', 'tref'].includes(child.localName)) {
          walk(child, nst, false, rise);
          // Continue the parent's chunk after a nested positioned span.
        }
      }
    };
    walk(el, st, true);
    // Trim the outer whitespace of each chunk.
    if (!preserve) {
      for (const c of chunks) {
        if (c.runs.length) {
          c.runs[0].text = c.runs[0].text.replace(/^ +/, '');
          const last = c.runs[c.runs.length - 1];
          last.text = last.text.replace(/ +$/, '');
        }
        c.runs = c.runs.filter((r) => r.text);
      }
    }
    const live = chunks.filter((c) => c.runs.length);
    if (!live.length) return [];
    // One line per chunk; its styled spans become runs of a single text object.
    const items = live.map((c) => {
      const width = c.runs.reduce((a, r) => a + measure(r.text, r.char), 0);
      return { runs: c.runs, key: c.runs[0].key, x: c.x, y: c.y, align: c.anchor === 'middle' ? 'center' : c.anchor === 'end' ? 'right' : 'left', width };
    });
    // Merge evenly stacked lines of one <text> that start at the same x into
    // one multi-line text (their styles become runs).
    const groups = [];
    for (const it of items) {
      const g = groups[groups.length - 1];
      const prev = g?.[g.length - 1];
      const dy = prev ? it.y - prev.y : 0;
      if (prev && Math.abs(prev.x - it.x) < 1e-6 && prev.align === it.align && dy > 0 && (g.length < 2 || Math.abs(dy - (g[1].y - g[0].y)) < 1e-6)) g.push(it);
      else groups.push([it]);
    }
    const ids = [];
    const sw = (style) => (style.stroke ? style.strokeWidth / scaleOf(M) : 1);
    for (const g of groups) {
      const it = g[0];
      const first = it.runs[0];
      const lead = g.length > 1 ? g[1].y - g[0].y : null;
      const char = { ...first.char, leading: lead ? Math.round(lead * 1000) / 1000 : null };
      const width = Math.max(...g.map((r) => r.width));
      const bx = it.align === 'center' ? it.x - width / 2 : it.align === 'right' ? it.x - width : it.x;
      const bbox = { x: bx, y: it.y - char.fontSize * 0.8, w: width || 1, h: (g[g.length - 1].y - it.y) + char.fontSize };
      const style = this.paintStyle(first.st, bbox, M, ctx);
      const base = { ...char, fill: style.fill, stroke: style.stroke, strokeWidth: sw(style) };
      const runs = [];
      let text = '';
      g.forEach((line, li) => {
        line.runs.forEach((r, ri) => {
          const rs = r === first ? style : this.paintStyle(r.st, bbox, M, ctx);
          const full = { ...r.char, leading: char.leading, fill: rs.fill, stroke: rs.stroke, strokeWidth: sw(rs) };
          const o = {};
          for (const k of Object.keys(full)) if (JSON.stringify(full[k]) !== JSON.stringify(base[k])) o[k] = full[k];
          const t = r.text + (ri === line.runs.length - 1 && li < g.length - 1 ? '\n' : '');
          text += t;
          const last = runs[runs.length - 1];
          if (last && JSON.stringify(overridesOfRun(last)) === JSON.stringify(o)) last.len += t.length;
          else runs.push({ len: t.length, ...o });
        });
      });
      const node = createText(text, it.x, it.y, {
        transform: M.slice(),
        char,
        para: { ...DEFAULT_PARA, align: it.align },
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: sw(style),
        strokeJoin: style.strokeJoin,
        strokeCap: style.strokeCap,
        miterLimit: style.miterLimit,
        ...(runs.some((r) => Object.keys(r).length > 1) ? { runs } : {}),
      });
      ids.push(this.add(node));
    }
    if (ids.length === 1) return ids;
    return [this.add(createGroup(ids))];
  }

  // ---- images ----

  image(el, st, M, ctx) {
    const href = hrefOf(el).trim();
    if (!href) return [];
    let assetId = this.assetByHref.get(href);
    let size = null;
    if (href.startsWith('data:')) {
      const info = dataUrlToBytes(href);
      if (!info) {
        this.warn('An embedded image could not be decoded.');
        return [];
      }
      let mime = sniffMime(info.bytes) || info.mime;
      if (mime === 'image/svg+xml' || /svg/.test(info.mime)) {
        mime = 'image/svg+xml';
        size = svgImageSize(new TextDecoder().decode(info.bytes));
      } else size = imageSize(info.bytes);
      if (!assetId) {
        assetId = uid('img');
        this.assets.set(assetId, { mime, data: href });
        this.assetByHref.set(href, assetId);
      }
    } else if (/^(https?:)?\/\//i.test(href) || href.startsWith('blob:')) {
      if (!assetId) {
        assetId = uid('img');
        const ext = (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.exec(href) || [])[1]?.toLowerCase();
        const mime = ext ? (ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`) : 'image/png';
        this.assets.set(assetId, { mime, data: href, external: true });
        this.assetByHref.set(href, assetId);
      }
      this.warn('Linked images were kept as links; they may not appear if the server blocks access.');
    } else {
      this.warn(`The linked image "${href.slice(0, 60)}" is not available and was skipped.`);
      return [];
    }
    const x = parseLength(el.getAttribute('x'), { ref: ctx.vw });
    const y = parseLength(el.getAttribute('y'), { ref: ctx.vh });
    const wa = el.getAttribute('width');
    const ha = el.getAttribute('height');
    let w = wa != null && wa !== 'auto' ? parseLength(wa, { ref: ctx.vw, fallback: NaN }) : NaN;
    let h = ha != null && ha !== 'auto' ? parseLength(ha, { ref: ctx.vh, fallback: NaN }) : NaN;
    const nat = size && size.width > 0 && size.height > 0 ? size : null;
    if (!Number.isFinite(w) && !Number.isFinite(h)) {
      w = nat ? nat.width : 100;
      h = nat ? nat.height : 100;
    } else if (!Number.isFinite(w)) w = nat ? (h * nat.width) / nat.height : h;
    else if (!Number.isFinite(h)) h = nat ? (w * nat.height) / nat.width : w;
    if (!(w > 0) || !(h > 0)) return [];
    const natW = nat ? nat.width : w;
    const natH = nat ? nat.height : h;
    const par = el.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
    const T = multiply(M, viewBoxTransform([0, 0, natW, natH], x, y, w, h, par));
    const node = createImage(assetId, natW, natH, T, { name: this.nameOf(el) });
    const id = this.add(node);
    if (/slice/.test(par) && !/^\s*none/.test(par)) {
      const mask = this.add(createPath(transformAnchors(rectangle(x, y, w, h), M), true, { fill: null, stroke: null }));
      return [this.add(createGroup([id, mask], { clip: true }))];
    }
    return [id];
  }

  // ---- top level ----

  run() {
    return drain(this.runGen());
  }

  /**
   * The import in time slices: yields to the event loop every ~12 ms so the
   * page stays responsive, reporting progress (0..1) by element count.
   */
  async runAsync({ onProgress, slice = 12 } = {}) {
    const total = Math.max(1, this.svg.getElementsByTagName('*').length);
    const gen = this.runGen();
    let t0 = now();
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (now() - t0 > slice) {
        onProgress?.(Math.min(1, this.count / total));
        await nextTask();
        t0 = now();
      }
    }
  }

  *runGen() {
    const svg = this.svg;
    const vb = parseNumberList(svg.getAttribute('viewBox'));
    const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    const lenAttr = (name) => {
      const v = svg.getAttribute(name);
      if (v == null || /%|auto/.test(v)) return null;
      const n = parseLength(v, { fallback: NaN });
      return n > 0 ? n : null;
    };
    let W = lenAttr('width');
    let H = lenAttr('height');
    if (hasVb) {
      if (W == null && H == null) {
        W = vb[2];
        H = vb[3];
      } else if (W == null) W = (H * vb[2]) / vb[3];
      else if (H == null) H = (W * vb[3]) / vb[2];
    }
    const sized = W != null && H != null;
    this.vw = hasVb ? vb[2] : W || 100;
    this.vh = hasVb ? vb[3] : H || 100;
    let ctm = hasVb && sized ? viewBoxTransform(vb, 0, 0, W, H, svg.getAttribute('preserveAspectRatio')) : identity();
    const rootTf = svg.getAttribute('transform');
    if (rootTf) ctm = multiply(parseTransform(rootTf), ctm);
    const rootStyle = this.computeStyle(svg, BASE_STYLE);
    const ctx = { ctm, style: rootStyle, vw: this.vw, vh: this.vh, useStack: new Set() };
    // Editor layers (top-level groups marked as layers) become document layers.
    const kids = [...svg.children];
    const isLayer = (el) => el.localName === 'g' && (el.getAttributeNS?.(INK, 'groupmode') === 'layer' || el.getAttribute('inkscape:groupmode') === 'layer');
    const layered = kids.some(isLayer);
    const layers = [];
    let loose = null;
    for (const el of kids) {
      if (layered && isLayer(el)) {
        const st = this.computeStyle(el, rootStyle);
        const T = this.elementTransform(el, st, ctx);
        const M = T ? multiply(ctm, T) : ctm;
        let ids = [];
        try {
          ids = yield* this.convertChildrenGen(el, { ...ctx, ctm: M, style: st });
          if (ids.length && (st['clip-path'] || st.mask || opacityValue(st.opacity) < 1)) ids = this.decorate(el, { ...st, display: 'inline' }, M, ctx, [this.add(createGroup(ids))], true);
        } catch {
          this.warn('Some elements could not be read and were skipped.');
        }
        layers.push({ name: this.nameOf(el) || `Layer ${layers.length + 1}`, ids, hidden: st.display === 'none' });
        loose = null;
      } else {
        let ids = [];
        try {
          ids = yield* this.convertGen(el, ctx);
        } catch {
          this.warn('Some elements could not be read and were skipped.');
        }
        if (!ids.length) continue;
        if (!loose) {
          loose = { name: layers.length ? `Layer ${layers.length + 1}` : 'Layer 1', ids: [] };
          layers.push(loose);
        }
        loose.ids.push(...ids);
      }
    }
    // Root-level decorations (opacity, clip-path on the svg element).
    if (!layered && layers.length && (rootStyle['clip-path'] || opacityValue(rootStyle.opacity) < 1 || rootStyle.filter)) {
      const g = this.add(createGroup(layers[0].ids));
      layers[0].ids = this.decorate(svg, { ...rootStyle, display: 'inline' }, ctm, ctx, [g], true);
    }
    if (!layers.length) layers.push({ name: 'Layer 1', ids: [] });
    let artboard;
    if (sized) artboard = { x: 0, y: 0, w: W, h: H };
    else {
      const b = this.contentBounds(layers.flatMap((l) => l.ids));
      if (b && b.w > 0 && b.h > 0) {
        const right = b.x + b.w;
        const bottom = b.y + b.h;
        artboard = b.x >= 0 && b.y >= 0 ? { x: 0, y: 0, w: Math.ceil(right), h: Math.ceil(bottom) } : { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.ceil(b.w), h: Math.ceil(b.h) };
      } else artboard = { x: 0, y: 0, w: W || 612, h: H || 792 };
    }
    return { artboard, layers, nodes: this.nodes, assets: this.assets, warnings: [...this.warnings] };
  }
}

/** Parse SVG text into { artboard, layers: [{ name, ids }], nodes: Map, assets: Map, warnings }. */
export function convertSVG(text) {
  return new Importer(text).run();
}

/** convertSVG in time slices (see Importer.runAsync); opts.onProgress(0..1). */
export async function convertSVGAsync(text, opts = {}) {
  const imp = new Importer(text);
  return imp.runAsync(opts);
}

function drain(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Resolve on the next task (a MessageChannel message avoids setTimeout's clamping). */
function nextTask() {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

function setParents(nodes, id, parent) {
  const n = nodes.get(id);
  if (!n) return;
  nodes.set(id, { ...n, parent });
  for (const c of n.children || []) setParents(nodes, c, id);
}

/** A new document from SVG text. The result carries `importWarnings`. */
export function svgToDocument(text, { name = 'Untitled' } = {}) {
  return documentFrom(convertSVG(text), name);
}

/** svgToDocument in time slices, for large files; opts.onProgress(0..1). */
export async function svgToDocumentAsync(text, { name = 'Untitled', onProgress } = {}) {
  return documentFrom(await convertSVGAsync(text, { onProgress }), name);
}

function documentFrom(r, name) {
  const doc = VDocument.create({ name, width: r.artboard.w, height: r.artboard.h, units: 'px' });
  const root = doc.root;
  for (const id of root.children) doc.nodes.delete(id);
  const layerIds = [];
  r.layers.forEach((l, i) => {
    const layer = createLayer(l.name, LAYER_COLORS[i % LAYER_COLORS.length]);
    if (l.hidden) layer.hidden = true;
    layer.children = l.ids;
    doc.nodes.set(layer.id, { ...layer, parent: 'root' });
    layerIds.push(layer.id);
  });
  for (const [id, n] of r.nodes) doc.nodes.set(id, n);
  for (const lid of layerIds) for (const c of doc.nodes.get(lid).children) setParents(doc.nodes, c, lid);
  const boards = [{ ...root.artboards[0], ...r.artboard, name: 'Artboard 1' }];
  doc.nodes.set('root', { ...root, children: layerIds, artboards: boards });
  for (const [id, a] of r.assets) doc.assets.set(id, a);
  doc.repairParents();
  doc.importWarnings = r.warnings;
  return doc;
}

/**
 * SVG artwork as a subtree for placing or pasting into an existing document:
 * { nodes: [root, ...descendants], root, assets: { id: asset }, bounds, warnings }.
 * `nodes` is in the exportSubtree() format accepted by doc.importSubtree().
 */
export function svgToNodes(text) {
  return nodesFrom(convertSVG(text));
}

/** svgToNodes in time slices, for large files; opts.onProgress(0..1). */
export async function svgToNodesAsync(text, { onProgress } = {}) {
  return nodesFrom(await convertSVGAsync(text, { onProgress }));
}

function nodesFrom(r) {
  const top = r.layers.flatMap((l) => l.ids);
  if (!top.length) return { nodes: [], root: null, assets: {}, bounds: null, warnings: r.warnings };
  const nodes = r.nodes;
  let rootId;
  if (top.length === 1 && nodes.get(top[0]).type === 'group' && !nodes.get(top[0]).clip) rootId = top[0];
  else {
    const g = createGroup(top);
    nodes.set(g.id, g);
    rootId = g.id;
  }
  setParents(nodes, rootId, undefined);
  const list = [];
  const visit = (id) => {
    const n = nodes.get(id);
    if (!n) return;
    list.push(n);
    for (const c of n.children || []) visit(c);
  };
  visit(rootId);
  let bounds = null;
  const shim = { get: (id) => nodes.get(id) };
  bounds = nodeBounds(shim, nodes.get(rootId));
  const assets = {};
  for (const [id, a] of r.assets) assets[id] = a;
  return { nodes: list, root: rootId, subtree: { root: rootId, nodes: list }, assets, bounds, artboard: r.artboard, warnings: r.warnings };
}
