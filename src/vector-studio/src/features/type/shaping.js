/**
 * OpenType shaping for type with OpenType features turned on.
 *
 * Plain type draws with the canvas (which applies standard ligatures and
 * kerning on its own). Runs that ask for something more (discretionary
 * ligatures, stylistic sets, fractions, figure styles, a chosen glyph
 * alternate, or standard ligatures turned off) are shaped here: the run's
 * characters map to glyphs of the font file, the font's GSUB lookups for the
 * enabled features are applied in lookup order, and the layout gets one
 * glyph per character (a ligature sits on its first character, the
 * characters it absorbed get -1 and no advance). Those glyphs then draw
 * from their outlines (glyphPath), so what you see is what the font's
 * substitutions produce, in every browser.
 *
 * Fonts are parsed with opentype.js on first use (asynchronously); the run
 * draws unshaped until the parse lands, then every layout re-shapes.
 */
import { textHooks, invalidateTextLayout } from '../../model/text-layout.js';
import { clearGeometryCache } from '../../model/geometry.js';
import { otFontFor, fontEvents, familyInfo, nearestFace } from './fonts.js';
import { needsShaping, featureTags } from './feature-settings.js';

export { needsShaping, featureTags, ssTag, cssFeatureSettings } from './feature-settings.js';

// ---- fonts (sync cache over the async loader) ----

const fonts = new Map(); // face key -> font | null (unavailable) | 'pending'
let pending = 0;
let waiters = [];
let refreshTimer = 0;

function faceKey(st) {
  const info = familyInfo(st.fontFamily);
  const face = info ? nearestFace(info, st.fontWeight, st.fontStyle) : null;
  return info && face ? `${info.family.toLowerCase()}|${face.weight}|${face.style}` : null;
}

function refreshLayouts() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    invalidateTextLayout();
    clearGeometryCache();
    fontEvents.emit('loaded');
  }, 16);
}

/** The parsed font for a style, or null (starting the parse when needed). */
export function shapingFont(st) {
  const key = faceKey(st);
  if (!key) return null;
  const f = fonts.get(key);
  if (f !== undefined) return f === 'pending' ? null : f;
  fonts.set(key, 'pending');
  pending++;
  otFontFor(st)
    .catch(() => null)
    .then((font) => {
      fonts.set(key, font || null);
      if (font) refreshLayouts();
      pending--;
      if (!pending) {
        const w = waiters;
        waiters = [];
        for (const r of w) r();
      }
    });
  return null;
}

/** Resolves when every font requested for shaping has been parsed (tests, export). */
export function shapingIdle() {
  if (!pending) return Promise.resolve();
  return new Promise((r) => waiters.push(r));
}

/** The parsed font for a style once it is available (async). */
export async function loadShapingFont(st) {
  shapingFont(st);
  await shapingIdle();
  return shapingFont(st);
}

// ---- GSUB ----

function coverageIndex(cov, g) {
  if (!cov) return -1;
  if (cov.format === 1) {
    const gl = cov.glyphs;
    let lo = 0;
    let hi = gl.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (gl[mid] === g) return mid;
      if (gl[mid] < g) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  for (const r of cov.ranges || []) if (g >= r.start && g <= r.end) return r.index + g - r.start;
  return -1;
}

function classOf(cd, g) {
  if (!cd) return 0;
  if (cd.format === 1) {
    const k = g - cd.startGlyph;
    return k >= 0 && k < cd.classes.length ? cd.classes[k] : 0;
  }
  for (const r of cd.ranges || []) if (g >= r.start && g <= r.end) return r.classId;
  return 0;
}

const lookupCache = new WeakMap(); // font -> Map(tag -> [lookup indexes])

/** Lookup indexes of a feature tag (latin, then default script). */
export function featureLookups(font, tag) {
  const gsub = font?.tables?.gsub;
  if (!gsub) return [];
  let m = lookupCache.get(font);
  if (!m) {
    m = new Map();
    lookupCache.set(font, m);
  }
  if (m.has(tag)) return m.get(tag);
  const script = gsub.scripts.find((s) => s.tag === 'latn') || gsub.scripts.find((s) => s.tag === 'DFLT') || gsub.scripts[0];
  const allowed = script?.script?.defaultLangSys?.featureIndexes;
  const out = new Set();
  gsub.features.forEach((f, i) => {
    if (f.tag !== tag) return;
    if (allowed && !allowed.includes(i) && gsub.features.some((g, j) => g.tag === tag && allowed.includes(j))) return;
    for (const li of f.feature.lookupListIndexes) out.add(li);
  });
  const list = [...out].sort((a, b) => a - b);
  m.set(tag, list);
  return list;
}

/** Feature tags present in a font's GSUB. */
export function fontFeatures(font) {
  const gsub = font?.tables?.gsub;
  return new Set(gsub ? gsub.features.map((f) => f.tag) : []);
}

function subtablesOf(lookup) {
  return lookup.subtables.map((s) => (lookup.lookupType === 7 ? { type: s.lookupType, st: s.extension } : { type: lookup.lookupType, st: s }));
}

/**
 * Apply one lookup to one position of the glyph run (used directly and by
 * contextual lookups). `items` are { g, ci, n } (glyph, first character,
 * characters covered). Returns true when it substituted.
 */
function applyAt(gsub, lookupIndex, items, pos, opts, depth = 0) {
  const lookup = gsub.lookups[lookupIndex];
  if (!lookup || depth > 8 || pos >= items.length) return false;
  const g = items[pos].g;
  for (const { type, st } of subtablesOf(lookup)) {
    if (type === 1) {
      const k = coverageIndex(st.coverage, g);
      if (k < 0) continue;
      items[pos].g = st.substFormat === 1 ? (g + st.deltaGlyphId + 65536) % 65536 : st.substitute[k];
      return true;
    }
    if (type === 3) {
      const k = coverageIndex(st.coverage, g);
      if (k < 0) continue;
      const alts = st.alternateSets[k] || [];
      if (!alts.length) continue;
      items[pos].g = alts[Math.min(alts.length - 1, Math.max(0, opts.alternate || 0))];
      return true;
    }
    if (type === 4) {
      const k = coverageIndex(st.coverage, g);
      if (k < 0) continue;
      for (const lig of st.ligatureSets[k] || []) {
        const comps = lig.components;
        if (pos + comps.length >= items.length) continue;
        let ok = true;
        for (let c = 0; c < comps.length; c++) {
          if (items[pos + 1 + c]?.g !== comps[c]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const merged = items.splice(pos + 1, comps.length);
        items[pos].g = lig.ligGlyph;
        for (const m of merged) items[pos].n += m.n;
        return true;
      }
      continue;
    }
    if (type === 5 || type === 6) {
      const r = matchContext(type, st, items, pos);
      if (!r) continue;
      for (const rec of r.records) applyAt(gsub, rec.lookupListIndex, items, pos + rec.sequenceIndex, opts, depth + 1);
      return true;
    }
  }
  return false;
}

/** Match a (chaining) contextual subtable at pos: { records } or null. */
function matchContext(type, st, items, pos) {
  const gAt = (i) => (i >= 0 && i < items.length ? items[i].g : -1);
  const seqMatches = (seq, start, dir, test) => {
    for (let k = 0; k < seq.length; k++) if (!test(seq[k], gAt(start + dir * k))) return false;
    return true;
  };
  const chain = type === 6;
  if (st.substFormat === 1) {
    const k = coverageIndex(st.coverage, gAt(pos));
    if (k < 0) return null;
    const rules = (chain ? st.chainRuleSets : st.ruleSets)[k] || [];
    for (const rule of rules) {
      const eq = (a, b) => a === b;
      if (!seqMatches(rule.input, pos + 1, 1, eq)) continue;
      if (chain && !seqMatches(rule.backtrack, pos - 1, -1, eq)) continue;
      if (chain && !seqMatches(rule.lookahead, pos + 1 + rule.input.length, 1, eq)) continue;
      return { records: rule.lookupRecords };
    }
    return null;
  }
  if (st.substFormat === 2) {
    if (coverageIndex(st.coverage, gAt(pos)) < 0) return null;
    const inCd = chain ? st.inputClassDef : st.classDef;
    const sets = chain ? st.chainClassSet : st.classSets;
    const rules = sets[classOf(inCd, gAt(pos))] || [];
    for (const rule of rules) {
      const input = chain ? rule.input : rule.classes;
      const cls = (cd) => (c, g) => g >= 0 && classOf(cd, g) === c;
      if (!seqMatches(input, pos + 1, 1, cls(inCd))) continue;
      if (chain && !seqMatches(rule.backtrack, pos - 1, -1, cls(st.backtrackClassDef))) continue;
      if (chain && !seqMatches(rule.lookahead, pos + 1 + input.length, 1, cls(st.lookaheadClassDef))) continue;
      return { records: rule.lookupRecords };
    }
    return null;
  }
  if (st.substFormat === 3) {
    const cov = (c, g) => g >= 0 && coverageIndex(c, g) >= 0;
    const input = chain ? st.inputCoverage : st.coverages;
    if (!seqMatches(input, pos, 1, cov)) return null;
    if (chain && !seqMatches(st.backtrackCoverage, pos - 1, -1, cov)) return null;
    if (chain && !seqMatches(st.lookaheadCoverage, pos + input.length, 1, cov)) return null;
    return { records: st.lookupRecords };
  }
  return null;
}

/** Apply a lookup across the run wherever `mask(item)` allows. */
function applyLookup(gsub, li, items, mask, opts) {
  for (let pos = 0; pos < items.length; pos++) {
    if (!mask(items[pos])) continue;
    applyAt(gsub, li, items, pos, opts);
  }
}

const isDigit = (c) => c >= '0' && c <= '9';
const isLetter = (c) => c && c.toLowerCase() !== c.toUpperCase();

/** Character ranges of fractions: digits, a slash (/ or U+2044), digits. */
function fractionMask(chars) {
  const on = new Array(chars.length).fill(false);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '/' && chars[i] !== '⁄') continue;
    let a = i;
    while (a > 0 && isDigit(chars[a - 1])) a--;
    let b = i + 1;
    while (b < chars.length && isDigit(chars[b])) b++;
    if (a < i && b > i + 1) for (let k = a; k < b; k++) on[k] = true;
  }
  return on;
}

/** Letters right after digits (1st, 2nd, 3a): where ordinals apply. */
function ordinalMask(chars) {
  const on = new Array(chars.length).fill(false);
  for (let i = 1; i < chars.length; i++) {
    if (isLetter(chars[i]) && (isDigit(chars[i - 1]) || (on[i - 1] && isLetter(chars[i - 1])))) on[i] = true;
  }
  return on;
}

/**
 * Shape a string of characters with a font and a style: returns
 * [{ g, ci, n }] (glyph index, first character index, characters covered).
 * Characters the font lacks keep g = 0 (notdef) and are drawn by the canvas.
 */
export function shapeChars(font, chars, st) {
  const items = chars.map((c, ci) => ({ g: c === '\n' || c === '\t' ? 0 : font.charToGlyphIndex(c) || 0, ci, n: 1, c }));
  const gsub = font.tables?.gsub;
  if (gsub) {
    // Gather lookups with the characters each applies to, in lookup-list order.
    const all = () => true;
    const masks = new Map();
    let frac = null;
    let ordn = null;
    for (const tag of featureTags(st)) {
      let mask = all;
      if (tag === 'frac') {
        frac = frac || fractionMask(chars);
        mask = (it) => frac[it.ci];
      } else if (tag === 'ordn') {
        const contextual = featureLookups(font, 'ordn').every((li) => [5, 6].includes(gsub.lookups[li]?.lookupType));
        if (!contextual) {
          ordn = ordn || ordinalMask(chars);
          mask = (it) => ordn[it.ci];
        }
      }
      for (const li of featureLookups(font, tag)) {
        const prev = masks.get(li);
        masks.set(li, prev && prev !== mask ? (it) => prev(it) || mask(it) : mask);
      }
    }
    // A font without a frac feature still gets numerators and denominators around the slash.
    if (st.fractions && !featureLookups(font, 'frac').length) {
      frac = frac || fractionMask(chars);
      const slash = chars.findIndex((c, i) => (c === '/' || c === '⁄') && frac[i]);
      if (slash >= 0) {
        for (const li of featureLookups(font, 'numr')) if (!masks.has(li)) masks.set(li, (it) => frac[it.ci] && isDigit(it.c) && !afterSlash(chars, it.ci));
        for (const li of featureLookups(font, 'dnom')) if (!masks.has(li)) masks.set(li, (it) => frac[it.ci] && isDigit(it.c) && afterSlash(chars, it.ci));
      }
    }
    const opts = { alternate: 0 };
    for (const li of [...masks.keys()].sort((a, b) => a - b)) applyLookup(gsub, li, items, masks.get(li), opts);
  }
  // A chosen alternate replaces the glyph only where it is an alternate of that character in this font.
  if (st.altGlyph != null) for (const it of items) if (it.n === 1 && isAlternateOf(font, font.charToGlyphIndex(it.c) || 0, st.altGlyph)) it.g = st.altGlyph;
  return items;
}

// ---- alternates (Glyphs panel) ----

/** Features whose one-to-one substitutions are mechanical, not alternates to offer. */
const NOT_ALTERNATES = new Set(['ccmp', 'locl', 'rlig', 'liga', 'clig', 'calt', 'dlig', 'frac', 'init', 'medi', 'fina', 'isol', 'rvrn', 'mark', 'mkmk', 'kern']);
const altCache = new WeakMap(); // font -> { alts: Map(glyph -> [{ glyph, tag }]), base: Map(glyph -> glyph) }

/** One-to-one alternates in a font: glyph -> [{ glyph, tag }], and each alternate's base glyph. */
export function fontAlternates(font) {
  let r = altCache.get(font);
  if (r) return r;
  r = { alts: new Map(), base: new Map() };
  altCache.set(font, r);
  const gsub = font?.tables?.gsub;
  if (!gsub) return r;
  const add = (from, to, tag) => {
    if (from === to || !to) return;
    let list = r.alts.get(from);
    if (!list) r.alts.set(from, (list = []));
    if (!list.some((a) => a.glyph === to)) list.push({ glyph: to, tag });
    if (!r.base.has(to)) r.base.set(to, from);
  };
  const covered = (cov) => {
    if (!cov) return [];
    if (cov.format === 1) return cov.glyphs;
    const out = [];
    for (const rg of cov.ranges || []) for (let g = rg.start; g <= rg.end; g++) out.push(g);
    return out;
  };
  for (const f of gsub.features) {
    if (NOT_ALTERNATES.has(f.tag)) continue;
    for (const li of f.feature.lookupListIndexes) {
      const lookup = gsub.lookups[li];
      if (!lookup) continue;
      for (const { type, st } of subtablesOf(lookup)) {
        if (type === 1) covered(st.coverage).forEach((g, k) => add(g, st.substFormat === 1 ? (g + st.deltaGlyphId + 65536) % 65536 : st.substitute[k], f.tag));
        else if (type === 3) covered(st.coverage).forEach((g, k) => (st.alternateSets[k] || []).forEach((a) => add(g, a, f.tag)));
      }
    }
  }
  return r;
}

/** True when `alt` is `base` itself or one of its alternates (directly or through another alternate). */
export function isAlternateOf(font, base, alt) {
  if (!base || alt == null) return false;
  if (base === alt) return true;
  const { alts } = fontAlternates(font);
  const seen = new Set([base]);
  const queue = [base];
  while (queue.length) {
    const g = queue.shift();
    for (const a of alts.get(g) || []) {
      if (a.glyph === alt) return true;
      if (!seen.has(a.glyph)) {
        seen.add(a.glyph);
        queue.push(a.glyph);
      }
    }
  }
  return false;
}

/** The character a glyph stands for: its own code point, or its base glyph's (for unencoded alternates). */
export function glyphChar(font, glyph) {
  const { base } = fontAlternates(font);
  let g = glyph;
  for (let k = 0; k < 8 && g != null; k++) {
    const gl = font.glyphs.get(g);
    const u = gl?.unicode ?? gl?.unicodes?.[0];
    if (u != null) return String.fromCodePoint(u);
    g = base.get(g);
  }
  return null;
}

function afterSlash(chars, i) {
  for (let k = i - 1; k >= 0 && (isDigit(chars[k]) || chars[k] === '/' || chars[k] === '⁄'); k--) if (chars[k] === '/' || chars[k] === '⁄') return true;
  return false;
}

// ---- layout hook ----

/**
 * textHooks.shape: shape characters [start, end) of a run in place (see
 * text-layout.js measureChars for the arrays). Returns true when it did.
 */
export function shapeRun(st, text, start, end, out) {
  if (!needsShaping(st)) return false;
  const font = shapingFont(st);
  if (!font) return false;
  const chars = out.disp.slice(start, end);
  const items = shapeChars(font, chars, st);
  if (!out.glyph) out.glyph = new Array(out.disp.length).fill(null);
  const upem = font.unitsPerEm || 1000;
  const hs = (st.horizontalScale ?? 100) / 100;
  // Vertical type keeps em advances; its rows carry half-em ascent and descent.
  const vertical = out.vertical ?? (out.asc[start] === out.desc[start] && out.asc[start] === (st.fontSize * hs) / 2);
  const track = ((st.tracking || 0) / 1000) * st.fontSize;
  let prev = null;
  for (const it of items) {
    const i = start + it.ci;
    const c = text[i];
    if (c === '\n' || c === '\t' || !it.g) {
      prev = null;
      continue;
    }
    const glyph = font.glyphs.get(it.g);
    const size = out.size[i];
    const w = ((glyph?.advanceWidth || 0) * size) / upem;
    out.glyph[i] = it.g;
    out.gw[i] = w * hs;
    if (!vertical) {
      out.adv[i] = w * hs + track;
      out.kern[i] = prev != null && i > start ? ((font.getKerningValue(prev, it.g) || 0) * size * hs) / upem : out.kern[i];
    }
    for (let k = 1; k < it.n; k++) {
      out.glyph[i + k] = -1;
      out.adv[i + k] = 0;
      out.gw[i + k] = 0;
      out.kern[i + k] = 0;
    }
    prev = it.g;
  }
  return true;
}

// ---- glyph outlines ----

const ITALIC_SKEW = -0.21;
const pathCache = new Map(); // `${faceKey}|${glyph}|${size}|${skew}` -> Path2D

/** Path2D for a glyph at a size (origin on the baseline, y down), or null. */
export function glyphPath(st, glyph, size) {
  const font = shapingFont(st);
  if (!font) return null;
  const info = familyInfo(st.fontFamily);
  const face = info && nearestFace(info, st.fontWeight, st.fontStyle);
  const skew = st.fontStyle === 'italic' && face && face.style !== 'italic';
  const key = `${faceKey(st)}|${glyph}|${size}|${skew ? 1 : 0}`;
  let p = pathCache.get(key);
  if (p) return p;
  const g = font.glyphs.get(glyph);
  if (!g) return null;
  const cmds = g.getPath(0, 0, size).commands;
  p = new Path2D();
  const X = (x, y) => (skew ? x + ITALIC_SKEW * y : x);
  let lx = 0;
  let ly = 0;
  for (const c of cmds) {
    if (c.type === 'M') p.moveTo(X(c.x, c.y), c.y);
    else if (c.type === 'L') p.lineTo(X(c.x, c.y), c.y);
    else if (c.type === 'C') p.bezierCurveTo(X(c.x1, c.y1), c.y1, X(c.x2, c.y2), c.y2, X(c.x, c.y), c.y);
    else if (c.type === 'Q') {
      const c1x = lx + (2 / 3) * (c.x1 - lx);
      const c1y = ly + (2 / 3) * (c.y1 - ly);
      const c2x = c.x + (2 / 3) * (c.x1 - c.x);
      const c2y = c.y + (2 / 3) * (c.y1 - c.y);
      p.bezierCurveTo(X(c1x, c1y), c1y, X(c2x, c2y), c2y, X(c.x, c.y), c.y);
    } else if (c.type === 'Z') p.closePath();
    if (c.x !== undefined) {
      lx = c.x;
      ly = c.y;
    }
  }
  if (pathCache.size > 4000) pathCache.clear();
  pathCache.set(key, p);
  return p;
}

// ---- optical kerning ----

const BANDS = 12;
const profiles = new Map(); // `${faceKey}|${char}` -> { left, right, adv } at 100px, or null
const opticalPairs = new Map(); // `${faceKey}|${pair}` -> kerning at 100px
const targets = new Map(); // faceKey -> the font's own gap between straight-sided lower case

/**
 * Horizontal ink profile of a character at 100px: for each of BANDS bands
 * between the cap height and the baseline, the leftmost and rightmost ink
 * (null where the band has none) and the advance.
 */
function inkProfile(font, key, c) {
  const pk = `${key}|${c}`;
  if (profiles.has(pk)) return profiles.get(pk);
  let out = null;
  const g = font.charToGlyph(c);
  if (g && g.index) {
    const upem = font.unitsPerEm || 1000;
    const cap = ((font.tables?.os2?.sCapHeight || font.ascender * 0.7) * 100) / upem;
    const left = new Array(BANDS).fill(null);
    const right = new Array(BANDS).fill(null);
    const add = (x, y) => {
      const b = Math.floor(((y + cap) / cap) * BANDS);
      if (b < 0 || b >= BANDS) return;
      if (left[b] == null || x < left[b]) left[b] = x;
      if (right[b] == null || x > right[b]) right[b] = x;
    };
    let lx = 0;
    let ly = 0;
    let mx = 0;
    let my = 0;
    const line = (x, y) => {
      const steps = Math.max(1, Math.ceil(Math.abs(y - ly) / (cap / BANDS / 2)));
      for (let k = 1; k <= steps; k++) add(lx + ((x - lx) * k) / steps, ly + ((y - ly) * k) / steps);
      lx = x;
      ly = y;
    };
    for (const cmd of g.getPath(0, 0, 100).commands) {
      if (cmd.type === 'M') {
        lx = mx = cmd.x;
        ly = my = cmd.y;
        add(lx, ly);
      } else if (cmd.type === 'L') line(cmd.x, cmd.y);
      else if (cmd.type === 'Q' || cmd.type === 'C') {
        const x0 = lx;
        const y0 = ly;
        for (let k = 1; k <= 8; k++) {
          const t = k / 8;
          const u = 1 - t;
          let x;
          let y;
          if (cmd.type === 'Q') {
            x = u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x;
            y = u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y;
          } else {
            x = u ** 3 * x0 + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t ** 3 * cmd.x;
            y = u ** 3 * y0 + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t ** 3 * cmd.y;
          }
          line(x, y);
        }
      } else if (cmd.type === 'Z') line(mx, my);
    }
    out = { left, right, adv: ((g.advanceWidth || 0) * 100) / upem };
  }
  profiles.set(pk, out);
  return out;
}

/** Visual gap between two profiles: half the closest approach, half the average gap (open counters count up to a limit). */
function visualGap(a, b) {
  let min = Infinity;
  let sum = 0;
  let count = 0;
  for (let k = 0; k < BANDS; k++) {
    if (a.right[k] == null || b.left[k] == null) continue;
    const g = a.adv - a.right[k] + b.left[k];
    min = Math.min(min, g);
    sum += Math.min(g, 30);
    count++;
  }
  return count ? 0.5 * min + 0.5 * (sum / count) : null;
}

/**
 * Kerning for a pair judged from the outlines (px at 100px): the pair's
 * visual gap is brought to the gap the font itself puts between straight
 * sided lower case letters. Null while the font loads.
 */
export function opticalKern(st, a, b) {
  const font = shapingFont(st);
  if (!font) return null;
  const key = faceKey(st);
  const pk = `${key}|${a}${b}`;
  if (opticalPairs.has(pk)) return opticalPairs.get(pk);
  let target = targets.get(key);
  if (target === undefined) {
    const n = inkProfile(font, key, 'n');
    const l = inkProfile(font, key, 'l');
    target = (n && l && visualGap(n, l)) ?? 6;
    targets.set(key, target);
  }
  const pa = inkProfile(font, key, a);
  const pb = inkProfile(font, key, b);
  let k = 0;
  if (pa && pb) {
    const g = visualGap(pa, pb);
    if (g != null) k = Math.max(-15, Math.min(8, target - g));
  }
  k = Math.round(k * 10) / 10;
  if (opticalPairs.size > 20000) opticalPairs.clear();
  opticalPairs.set(pk, k);
  return k;
}

/** Install the shaping hooks on the layout engine. */
export function installShaping() {
  textHooks.shape = shapeRun;
  textHooks.glyphPath = glyphPath;
  textHooks.opticalKern = opticalKern;
}
