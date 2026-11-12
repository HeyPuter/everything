/**
 * Glyph outlines for text: Create Outlines (Shift+Cmd+O) and the
 * textToPathData() service that SVG/PDF export uses through
 * `app.textOutlines`.
 *
 * Glyphs are placed with the same layout the canvas draws from
 * (glyphPlacements), and their shapes come from the very font bytes that
 * were loaded for display, parsed with opentype.js, so outlines land where
 * the type was on screen.
 */
import { UserError } from '../../lib/errors.js';
import { otFontIfReady } from './fonts.js';
import { layoutText, glyphPlacements, riseOf, decorationRects, cssFont, drawsAsSegments } from '../../model/text-layout.js';
import { createPath, createCompound, createGroup, DEFAULT_STYLE } from '../../model/nodes.js';
import { multiply } from '../../lib/matrix.js';
import { nodeBounds, gradientEnds } from '../../model/geometry.js';
import { isGradient } from '../../model/gradients.js';
import { otFontFor, familyInfo, nearestFace } from './fonts.js';
import { isThreaded, removeThreading } from './thread-model.js';

const ITALIC_SKEW = [1, 0, -0.21, 1, 0, 0];

function applyM(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** opentype.js path commands -> contours of anchors (cubic, absolute), transformed by m. */
export function commandsToContours(commands, m) {
  const contours = [];
  let cur = null;
  let last = null;
  const finish = (closed) => {
    if (!cur || cur.length === 0) return;
    if (closed && cur.length > 1) {
      // A closing point that repeats the start merges into it.
      const a = cur[0];
      const z = cur[cur.length - 1];
      if (Math.abs(a.x - z.x) < 1e-6 && Math.abs(a.y - z.y) < 1e-6) {
        cur.pop();
        a.ix = z.ix;
        a.iy = z.iy;
      }
    }
    if (cur.length > 1) contours.push({ anchors: cur, closed });
    cur = null;
  };
  const point = (x, y) => {
    const p = applyM(m, x, y);
    return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
  };
  for (const c of commands) {
    if (c.type === 'M') {
      finish(false);
      cur = [point(c.x, c.y)];
      last = { x: c.x, y: c.y };
    } else if (c.type === 'L') {
      if (!cur) cur = [point(last?.x ?? 0, last?.y ?? 0)];
      cur.push(point(c.x, c.y));
      last = { x: c.x, y: c.y };
    } else if (c.type === 'C' || c.type === 'Q') {
      if (!cur) cur = [point(last?.x ?? 0, last?.y ?? 0)];
      let c1x;
      let c1y;
      let c2x;
      let c2y;
      if (c.type === 'C') {
        c1x = c.x1;
        c1y = c.y1;
        c2x = c.x2;
        c2y = c.y2;
      } else {
        // Quadratic to cubic.
        c1x = last.x + (2 / 3) * (c.x1 - last.x);
        c1y = last.y + (2 / 3) * (c.y1 - last.y);
        c2x = c.x + (2 / 3) * (c.x1 - c.x);
        c2y = c.y + (2 / 3) * (c.y1 - c.y);
      }
      const prev = cur[cur.length - 1];
      const h1 = applyM(m, c1x, c1y);
      prev.ox = h1.x;
      prev.oy = h1.y;
      const p = point(c.x, c.y);
      const h2 = applyM(m, c2x, c2y);
      p.ix = h2.x;
      p.iy = h2.y;
      cur.push(p);
      last = { x: c.x, y: c.y };
    } else if (c.type === 'Z') {
      finish(true);
    }
  }
  finish(false);
  return contours;
}

function rectContour(m, x0, y0, x1, y1) {
  const pts = [applyM(m, x0, y0), applyM(m, x1, y0), applyM(m, x1, y1), applyM(m, x0, y1)];
  return { anchors: pts.map((p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y })), closed: true };
}

/** Distinct font styles a text node uses (for preloading outline fonts). */
function stylesOf(lay) {
  const seen = new Map();
  for (const st of lay.chars.sty) if (st) seen.set(`${st.fontFamily}|${st.fontWeight}|${st.fontStyle}`, st);
  return [...seen.values()];
}

/**
 * Outlines of a text node in document space: one entry per glyph (and per
 * underline or strikethrough bar) as
 *   { index, fill, stroke, strokeWidth, contours: [{ anchors, closed }] }
 * Fails with an Error naming the font when its outlines are unavailable.
 */
export async function textToPathData(node) {
  const lay = layoutText(node);
  const fonts = new Map();
  for (const st of stylesOf(lay)) {
    const key = `${st.fontFamily}|${st.fontWeight}|${st.fontStyle}`;
    const font = await otFontFor(st);
    if (!font) throw new UserError(`The font "${st.fontFamily}" has no outlines available. Choose a bundled or local font.`);
    fonts.set(key, font);
  }
  return glyphOutlines(node, lay, fonts);
}

/**
 * textToPathData() without waiting: the outlines when every font the text
 * uses is already loaded, undefined while one is still loading (call
 * textToPathData() or otFontFor() to load them), null when a font has no
 * outlines.
 */
export function textToPathDataSync(node) {
  const lay = layoutText(node);
  const fonts = new Map();
  for (const st of stylesOf(lay)) {
    const font = otFontIfReady(st);
    if (font === undefined) return undefined;
    if (!font) return null;
    fonts.set(`${st.fontFamily}|${st.fontWeight}|${st.fontStyle}`, font);
  }
  return glyphOutlines(node, lay, fonts);
}

/** Characters (no default-ignorable ones such as joiners and variation selectors) a font has no glyph for. */
function missingIn(font, str) {
  const out = [];
  for (const c of str) if (!/\p{Default_Ignorable_Code_Point}|\p{M}|\s/u.test(c) && !font.charToGlyphIndex(c)) out.push(c);
  return out;
}

/**
 * Outline of a string (one character, a cluster, or a list number such as
 * "1."). The outline library's own string shaping throws on some
 * contextual lookups it does not support (Inter's, for a digit or letter
 * before a period); then each character's glyph is placed by its advance.
 */
function stringPath(font, str, size) {
  if ([...str].length === 1) return font.charToGlyph(str).getPath(0, 0, size);
  try {
    return font.getPath(str, 0, 0, size, { kerning: false, features: {}, hinting: false });
  } catch {
    const commands = [];
    let x = 0;
    for (const c of str) {
      const gl = font.charToGlyph(c);
      commands.push(...gl.getPath(x, 0, size).commands);
      x += ((gl.advanceWidth || 0) * size) / (font.unitsPerEm || 1000);
    }
    return { commands };
  }
}

/**
 * Glyph outlines of a laid-out text. The list's `missing` property holds the
 * characters the fonts have no glyphs for: the canvas shows those in a
 * fallback font, but their outlines would be the font's empty-glyph box.
 */
function glyphOutlines(node, lay, fonts) {
  const base = node.transform || [1, 0, 0, 1, 0, 0];
  const out = [];
  const missing = new Map(); // character -> font family
  const stand = []; // [{ g, entry }] for characters the font lacks
  for (const g of glyphPlacements(lay)) {
    const st = g.style;
    const font = fonts.get(`${st.fontFamily}|${st.fontWeight}|${st.fontStyle}`);
    // A character the font lacks: how the canvas draws it (a system font stands in), for exports to place instead.
    let fallback = null;
    if (g.glyph == null && g.ch) {
      const miss = missingIn(font, g.ch);
      if (miss.length) {
        missing.set([...g.ch].length > 1 ? g.ch : miss[0], st.fontFamily);
        fallback = { ch: g.ch, font: cssFont(st, g.size), size: g.size, seg: g.m, m: multiply(base, g.m) };
      }
    }
    let gm = multiply(base, g.m);
    if (st.fontStyle === 'italic') {
      const info = familyInfo(st.fontFamily);
      const face = info && nearestFace(info, st.fontWeight, st.fontStyle);
      if (face && face.style !== 'italic') gm = multiply(gm, ITALIC_SKEW);
    }
    // Shaped glyphs (OpenType substitutions) come from their glyph index; others from the character.
    if (g.glyph == null && /^\s+$/.test(g.ch)) continue; // spaces have no ink (and a font without them would draw boxes)
    const glyph = g.glyph != null && g.glyph >= 0 ? font.glyphs.get(g.glyph) : null;
    const path = glyph ? glyph.getPath(0, 0, g.size) : stringPath(font, g.ch, g.size);
    const contours = commandsToContours(path.commands, gm);
    if (contours.length || fallback) out.push({ index: g.i, fill: st.fill ?? null, stroke: st.stroke ?? null, strokeWidth: st.strokeWidth ?? 0, contours, ...(fallback ? { fallback } : {}) });
    if (fallback && !g.extra) stand.push({ g, entry: out[out.length - 1] });
  }
  if (stand.length > 1 && drawsAsSegments(lay)) joinFallbackRuns(lay, stand);
  // Underline and strikethrough bars, drawn per line segment of a style like the canvas does.
  if (lay.kind !== 'path' && !lay.vertical) {
    for (const line of lay.lines) {
      let i = line.start;
      while (i < line.contentEnd) {
        const st = lay.chars.sty[i];
        let j = i + 1;
        while (j < line.contentEnd && lay.chars.sty[j] === st) j++;
        if (st.underline || st.strike) {
          const x0 = line.xs[i - line.start];
          const x1 = j >= line.contentEnd ? line.xs[line.contentEnd - line.start] - ((st.tracking || 0) / 1000) * st.fontSize : line.xs[j - line.start];
          const b = line.y - riseOf(st, lay.chars.tm);
          const size = lay.chars.size[i];
          // One item per bar color: the text's fill, or a bar's own color.
          const byPaint = new Map();
          for (const r of decorationRects(st, size, x0, x1, b)) {
            const k = r.paint ? JSON.stringify(r.paint) : '';
            if (!byPaint.has(k)) byPaint.set(k, { paint: r.paint, contours: [] });
            byPaint.get(k).contours.push(rectContour(base, r.x, r.y, r.x + r.w, r.y + r.h));
          }
          for (const g of byPaint.values()) out.push({ index: i, fill: g.paint ?? st.fill ?? null, stroke: null, strokeWidth: 0, contours: g.contours });
        }
        i = j;
      }
    }
  }
  out.missing = [...missing].map(([ch, family]) => ({ ch, family }));
  return out;
}

/**
 * Stand-in characters next to each other (same line and style, only spaces
 * between) become one run drawn with one fillText, as the canvas draws
 * them: right-to-left scripts keep their order and Arabic its joining.
 */
function joinFallbackRuns(lay, stand) {
  const { chars, text } = lay;
  let li = 0;
  let run = null;
  for (const f of stand) {
    const g = f.g;
    while (li < lay.lines.length - 1 && g.i >= lay.lines[li].contentEnd) li++;
    const line = lay.lines[li];
    const prev = run?.last.g;
    let join = Boolean(run) && run.line === line && g.style === run.first.g.style && g.size === run.first.g.size;
    for (let k = prev ? prev.i + 1 : 0; join && k <= g.i; k++) {
      if (chars.manual?.[k] && k > run.first.g.i) join = false;
      else if (k < g.i && chars.disp[k] && (text[k] !== ' ' || line.justified)) join = false;
    }
    if (join) {
      run.last = f;
      f.entry.fallback = { merged: true };
      const st = run.first.g.style;
      const first = run.first.entry.fallback;
      first.ch = chars.disp.slice(run.first.g.i, g.i + 1).join('');
      const track = ((st.tracking || 0) / 1000) * st.fontSize;
      if (track) first.letterSpacing = track / ((st.horizontalScale ?? 100) / 100);
    } else run = { first: f, last: f, line };
  }
}

/** Node subtree (group of glyph paths/compounds) for a text node's outlines. */
export async function outlineNodes(node) {
  const glyphs = await textToPathData(node);
  const descendants = [];
  const children = [];
  const group = createGroup([], { name: '', opacity: node.opacity ?? 1, blendMode: node.blendMode || 'normal', effects: node.effects || [] });
  // A gradient spans the whole text object, so each glyph keeps that span instead of fitting its own bounds.
  const bounds = nodeBounds(null, node);
  const span = (p) => (isGradient(p) && p.x1 === undefined && bounds ? gradientEnds(p, bounds) : p);
  for (const g of glyphs) {
    if (!g.contours.length) continue;
    const style = {
      ...DEFAULT_STYLE,
      fill: span(g.fill),
      stroke: span(g.stroke),
      strokeWidth: g.strokeWidth,
      strokeJoin: node.strokeJoin || 'miter',
      strokeCap: node.strokeCap || 'butt',
      miterLimit: node.miterLimit ?? 10,
      dash: node.dash || [],
      opacity: 1,
      blendMode: 'normal',
      effects: [],
    };
    if (g.contours.length === 1) {
      const p = createPath(g.contours[0].anchors, g.contours[0].closed, style, { parent: group.id });
      descendants.push(p);
      children.push(p.id);
    } else {
      const comp = createCompound([], style, { parent: group.id, fillRule: 'nonzero' });
      for (const c of g.contours) {
        const p = createPath(c.anchors, c.closed, { ...style, fill: null, stroke: null }, { parent: comp.id });
        descendants.push(p);
        comp.children.push(p.id);
      }
      descendants.push(comp);
      children.push(comp.id);
    }
  }
  group.children = children;
  return { group, descendants, missing: glyphs.missing || [] };
}

/** Text nodes under the selection (selected text, and text inside selected groups). */
export function selectedTextNodes(editor) {
  const { doc } = editor;
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (n.type === 'text') out.push(n);
    else if (n.type === 'group' || n.type === 'layer') for (const c of n.children) visit(doc.get(c));
  };
  for (const id of editor.topSelection()) visit(doc.get(id));
  return out;
}

/** Type > Create Outlines: replace each selected text object with a group of glyph shapes. */
export async function createOutlines(app) {
  const editor = app.editor;
  if (!editor) return;
  if (editor.textEdit) app.tool?.endEditing?.({ select: true });
  const nodes = selectedTextNodes(editor);
  if (!nodes.length) return;
  let built = [];
  for (const n of nodes) built.push({ n, ...(await outlineNodes(n)) });
  // Type with characters its font lacks stays live: outlined, they would turn into empty-glyph boxes.
  const kept = built.filter((b) => b.missing.length);
  if (kept.length) {
    const chars = [...new Set(kept.flatMap((b) => b.missing.map((m) => m.ch)))];
    const list = chars.slice(0, 8).join(' ') + (chars.length > 8 ? ' …' : '');
    const fonts = [...new Set(kept.flatMap((b) => b.missing.map((m) => `“${m.family}”`)))].join(', ');
    const what = kept.length === built.length ? (kept.length === 1 ? 'The type was' : 'The type objects were') : `${kept.length} of ${built.length} type objects were`;
    app.notify(`${what} not outlined: ${fonts} ${fonts.includes(',') ? 'have' : 'has'} no glyphs for ${list}. Choose a font that includes these characters.`, { error: true, timeout: 8000 });
    built = built.filter((b) => !b.missing.length);
    if (!built.length) return;
  }
  const { doc } = editor;
  const ids = [];
  doc.transact('Create Outlines', () => {
    // Outlined frames leave their threads; the other frames keep the text they show.
    const threaded = built.map((b) => b.n.id).filter((id) => isThreaded(doc.get(id)));
    if (threaded.length) removeThreading(doc, threaded);
    for (const { n, group, descendants } of built) {
      const cur = doc.get(n.id);
      if (!cur) continue;
      const parent = doc.get(cur.parent);
      const index = parent.children.indexOf(cur.id);
      doc.insert(group, parent.id, index + 1, descendants);
      doc.remove(cur.id);
      ids.push(group.id);
    }
    editor.select([...ids, ...kept.map((b) => b.n.id)]);
  });
}
