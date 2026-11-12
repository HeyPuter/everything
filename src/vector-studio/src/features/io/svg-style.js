/**
 * SVG attribute helpers: transform lists, lengths, style attributes and
 * <style> stylesheets (class, id, type, attribute and descendant selectors,
 * resolved with the browser's own selector engine on the parsed tree and
 * ordered by specificity).
 */
import { multiply, identity, translate, scale, rotate } from '../../lib/matrix.js';

const DEG = Math.PI / 180;

/**
 * Parse an SVG transform attribute or a CSS transform property into one
 * matrix: matrix, translate, scale, rotate, skewX, skewY, plus the CSS
 * forms translateX/Y, scaleX/Y, skew, rotateZ and the 3D functions reduced
 * to 2D (translate3d, scale3d, matrix3d, translateZ/scaleZ ignored), with
 * CSS units (px, pt, mm, ...; deg, rad, grad, turn). Invalid input gives
 * identity.
 */
export function parseTransform(str) {
  let m = identity();
  if (!str) return m;
  const re = /(matrix3d|matrix|translate3d|translatex|translatey|translatez|translate|scale3d|scalex|scaley|scalez|scale|rotatez|rotate3d|rotate|skewx|skewy|skew)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(String(str)))) {
    const name = match[1].toLowerCase();
    const nums = (match[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn|px|pt|pc|in|mm|cm|q|%)?/gi) || []).map((s) => {
      const v = parseFloat(s);
      const u = (/[a-z%]+$/i.exec(s)?.[0] || '').toLowerCase();
      if (u === 'rad') return v / DEG;
      if (u === 'grad') return v * 0.9;
      if (u === 'turn') return v * 360;
      if (u in UNIT) return v * UNIT[u];
      // Percentages refer to the CSS reference box, which SVG content does not have: ignore them.
      if (u === '%') return 0;
      return v;
    });
    if (nums.some((v) => !Number.isFinite(v))) return identity();
    let t = null;
    const skew = (ax, ay) => [1, Math.tan(ay * DEG), Math.tan(ax * DEG), 1, 0, 0];
    switch (name) {
      case 'matrix':
        if (nums.length >= 6) t = nums.slice(0, 6);
        break;
      case 'matrix3d':
        if (nums.length >= 16) t = [nums[0], nums[1], nums[4], nums[5], nums[12], nums[13]];
        break;
      case 'translate':
      case 'translate3d':
        if (nums.length >= 1) t = translate(nums[0], nums[1] ?? 0);
        break;
      case 'translatex':
        if (nums.length >= 1) t = translate(nums[0], 0);
        break;
      case 'translatey':
        if (nums.length >= 1) t = translate(0, nums[0]);
        break;
      case 'scale':
        if (nums.length >= 1) t = scale(nums[0], nums[1] ?? nums[0]);
        break;
      case 'scale3d':
        if (nums.length >= 2) t = scale(nums[0], nums[1]);
        break;
      case 'scalex':
        if (nums.length >= 1) t = scale(nums[0], 1);
        break;
      case 'scaley':
        if (nums.length >= 1) t = scale(1, nums[0]);
        break;
      case 'rotate':
      case 'rotatez':
        if (nums.length >= 1) t = nums.length >= 3 ? rotate(nums[0], nums[1], nums[2]) : rotate(nums[0]);
        break;
      case 'rotate3d':
        // Only a turn about the z axis stays in the plane.
        if (nums.length >= 4 && !nums[0] && !nums[1] && nums[2]) t = rotate(nums[2] > 0 ? nums[3] : -nums[3]);
        break;
      case 'skew':
        if (nums.length >= 1) t = skew(nums[0], nums[1] ?? 0);
        break;
      case 'skewx':
        if (nums.length >= 1) t = skew(nums[0], 0);
        break;
      case 'skewy':
        if (nums.length >= 1) t = skew(0, nums[0]);
        break;
      default:
        break;
    }
    if (t) m = multiply(m, t);
  }
  return m;
}

/**
 * Length units in user units. A user unit (px) maps to one point (SVG
 * read at 72 ppi); absolute units follow.
 */
export const UNIT = { px: 1, pt: 1, pc: 12, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, q: 72 / 101.6 };

/** Parse a length. `ref` resolves percentages, `fontSize` em/ex. Returns `fallback` when invalid. */
export function parseLength(v, { ref = 100, fontSize = 16, fallback = 0 } = {}) {
  if (v == null) return fallback;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|mm|cm|q|em|ex|rem|%)?\s*$/i.exec(String(v));
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'px').toLowerCase();
  if (u === '%') return (n / 100) * ref;
  if (u === 'em' || u === 'rem') return n * fontSize;
  if (u === 'ex') return n * fontSize * 0.5;
  return n * (UNIT[u] ?? 1);
}

/** Numbers in a list attribute (points, viewBox, dasharray). */
export function parseNumberList(s) {
  return (String(s || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) || []).map(Number).filter(Number.isFinite);
}

/** Parse a `style` attribute (or a declaration block) into { prop: { value, important } }. */
export function parseDeclarations(text) {
  const out = {};
  for (const decl of splitOutside(String(text || ''), ';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    let important = false;
    if (/!\s*important\s*$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important\s*$/i, '').trim();
    }
    out[prop] = { value, important };
  }
  return out;
}

/** Split on a separator that is not inside parentheses or quotes (url(data:...;base64,...)). */
function splitOutside(s, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === sep && !depth) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Specificity [ids, classes/attributes/pseudo-classes, types] as one comparable number. */
export function specificity(sel) {
  const s = sel.replace(/"[^"]*"|'[^']*'/g, '');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?/g, ' ').match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length;
  return ids * 10000 + classes * 100 + types;
}

/**
 * Whether a media query list matches the medium a drawing is opened for:
 * a light screen at 1x with a mouse, whose viewport is the SVG's own size
 * (`width`/`height`, when known), like the file seen as an image in a
 * browser. Unknown media features don't match, as in browsers.
 */
export function mediaMatches(list, { width = null, height = null } = {}) {
  const px = (v) => {
    const n = parseLength(v, { fallback: NaN });
    return Number.isFinite(n) ? n : NaN;
  };
  const range = (name, value, actual) => {
    if (actual == null) return null;
    const v = px(value);
    if (Number.isNaN(v)) return false;
    if (name.startsWith('min-')) return actual >= v;
    if (name.startsWith('max-')) return actual <= v;
    return Math.abs(actual - v) < 1e-9;
  };
  const feature = (f) => {
    // Range syntax: (width >= 600px), (400px < width).
    const r = /^\(\s*([a-z-]+|[\d.]+[a-z%]*)\s*(<=|>=|<|>|=)\s*([a-z-]+|[\d.]+[a-z%]*)\s*\)$/i.exec(f.trim());
    if (r && /^(width|height)$/i.test(r[1]) !== /^(width|height)$/i.test(r[3])) {
      const flip = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=' };
      const [name, op, value] = /^(width|height)$/i.test(r[1]) ? [r[1], r[2], r[3]] : [r[3], flip[r[2]], r[1]];
      const actual = name.toLowerCase() === 'width' ? width : height;
      if (actual == null) return true;
      const v = px(value);
      if (Number.isNaN(v)) return false;
      return { '<': actual < v, '>': actual > v, '<=': actual <= v, '>=': actual >= v, '=': Math.abs(actual - v) < 1e-9 }[op];
    }
    const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]*?))?\s*\)$/i.exec(f.trim());
    if (!m) return false;
    const name = m[1].toLowerCase();
    const value = (m[2] ?? '').trim().toLowerCase();
    const dim = /^(min-|max-)?(width|height)$/.exec(name);
    if (dim) {
      const r = value ? range(name, value, dim[2] === 'width' ? width : height) : (dim[2] === 'width' ? width : height) !== 0;
      // An unknown viewport size keeps the rule (the drawing has no viewport to test against).
      return r ?? true;
    }
    if (/^(min-|max-)?aspect-ratio$/.test(name)) {
      if (!(width > 0 && height > 0)) return true;
      const [a, b = '1'] = value.split('/');
      const want = Number(a) / Number(b);
      if (!Number.isFinite(want)) return false;
      const actual = width / height;
      return name.startsWith('min-') ? actual >= want - 1e-9 : name.startsWith('max-') ? actual <= want + 1e-9 : Math.abs(actual - want) < 1e-9;
    }
    if (name === 'orientation') return !(width > 0 && height > 0) || value === (height >= width ? 'portrait' : 'landscape');
    const fixed = {
      'prefers-color-scheme': ['light'],
      'prefers-reduced-motion': ['no-preference'],
      'prefers-reduced-transparency': ['no-preference'],
      'prefers-contrast': ['no-preference'],
      'forced-colors': ['none'],
      'inverted-colors': ['none'],
      hover: ['hover', ''],
      'any-hover': ['hover', ''],
      pointer: ['fine', ''],
      'any-pointer': ['fine', ''],
      color: [''],
      'color-gamut': ['srgb'],
      scripting: ['none'],
      'display-mode': ['browser'],
    };
    if (fixed[name]) return fixed[name].includes(value);
    if (/^(min-|max-)?(resolution|device-pixel-ratio|-webkit-(min-|max-)?device-pixel-ratio)$/.test(name)) {
      const v = parseFloat(value);
      const ratio = /dpi$/.test(value) ? v / 96 : /dpcm$/.test(value) ? (v * 2.54) / 96 : v;
      if (!Number.isFinite(ratio)) return false;
      return /min-/.test(name) ? 1 >= ratio : /max-/.test(name) ? 1 <= ratio : ratio === 1;
    }
    return false;
  };
  const query = (q) => {
    let s = q.trim().toLowerCase();
    if (!s) return false;
    let negate = false;
    if (s.startsWith('not ')) {
      negate = true;
      s = s.slice(4).trim();
    } else if (s.startsWith('only ')) s = s.slice(5).trim();
    const parts = splitOutside(s.replace(/\)\s*and\s*\(/g, ') and ('), ' ')
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => p !== 'and');
    if (parts.includes('or')) return parts.filter((p) => p !== 'or').some(feature) !== negate;
    let ok = true;
    for (const p of parts) {
      if (p.startsWith('(')) ok = ok && feature(p);
      else ok = ok && (p === 'all' || p === 'screen');
    }
    return negate ? !ok : ok;
  };
  return splitOutside(String(list || ''), ',').some(query) || !String(list || '').trim();
}

/**
 * Parse stylesheet text into rules [{ selector, spec, order, decls }].
 * At-rules: @media blocks are kept when they match the medium the drawing
 * opens for (see mediaMatches), @supports contents are kept, @font-face,
 * @import, @keyframes and the like are skipped.
 */
export function parseStylesheet(text, media = {}) {
  const css = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
  const rules = [];
  let order = 0;
  const parseBlock = (src) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      i = j;
      if (prelude.startsWith('@')) {
        // Statement at-rules (@import x;) before the block prelude.
        const stmt = prelude.lastIndexOf(';');
        const pre = stmt >= 0 ? prelude.slice(stmt + 1).trim() : prelude;
        const at = /^@media\b([\s\S]*)$/i.exec(pre);
        if (at) {
          if (mediaMatches(at[1], media)) parseBlock(body);
        } else if (/^@(supports|layer|container)\b/i.test(pre)) parseBlock(body);
        else if (!pre.startsWith('@')) addRule(pre, body);
        continue;
      }
      const stmt = prelude.lastIndexOf(';');
      addRule(stmt >= 0 ? prelude.slice(stmt + 1).trim() : prelude, body);
    }
  };
  const addRule = (prelude, body) => {
    const decls = parseDeclarations(body);
    if (!Object.keys(decls).length) return;
    for (const raw of splitOutside(prelude, ',')) {
      const selector = raw.trim();
      if (!selector) continue;
      rules.push({ selector, spec: specificity(selector), order: order++, decls });
    }
  };
  parseBlock(css);
  return rules;
}

/**
 * Match rules against a parsed SVG document. Returns Map<Element, decls[]>
 * with the declaration blocks in cascade order (lowest priority first).
 * Selectors the engine rejects (or pseudo-elements) are ignored.
 */
export function matchStylesheet(root, rules) {
  const map = new Map();
  for (const rule of rules) {
    if (/::|:(hover|active|focus|visited|link|target)/i.test(rule.selector)) continue;
    let els;
    try {
      els = root.querySelectorAll(rule.selector);
    } catch {
      continue;
    }
    for (const el of els) {
      let list = map.get(el);
      if (!list) map.set(el, (list = []));
      list.push(rule);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.spec - b.spec || a.order - b.order);
  return map;
}
