/**
 * Edit > Edit Colors: color transforms over the selection's paints. Each
 * command maps every color (solid fills and strokes, gradient stops) of the
 * selected objects, recursing into groups, compound paths and type.
 * Paints that change lose their global swatch link (their color no longer
 * matches the swatch).
 */
import { stackPaints, mapStackPaints } from '../../model/appearance.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, rgbToCmyk, cmykToRgb, invert as invertHex, clamp } from '../../lib/color.js';
import { nodeBounds } from '../../model/geometry.js';
import { styledRuns } from '../../model/text-runs.js';

/** Map a paint's colors. fn(hex, info) -> hex. Returns the same object when nothing changed. */
export function mapPaint(paint, fn, info = {}) {
  if (!paint) return paint;
  if (paint.type === 'solid') {
    const c = fn(paint.color, { ...info, paint });
    if (!c || c.toLowerCase() === paint.color.toLowerCase()) return paint;
    const out = { ...paint, color: c };
    delete out.swatchId;
    return out;
  }
  if (paint.type === 'linear' || paint.type === 'radial') {
    let changed = false;
    const stops = paint.stops.map((s, i) => {
      const c = fn(s.color, { ...info, paint, stop: i });
      if (!c || c.toLowerCase() === s.color.toLowerCase()) return s;
      changed = true;
      const out = { ...s, color: c };
      delete out.swatchId;
      return out;
    });
    if (!changed) return paint;
    const out = { ...paint, stops };
    delete out.swatchId;
    return out;
  }
  return paint;
}

/** Paintable leaves under the given ids (groups recurse; compounds paint as a whole). */
export function colorTargets(doc, ids) {
  const out = new Map();
  const visit = (n) => {
    if (!n || out.has(n.id)) return;
    if (n.type === 'group' || n.type === 'layer') {
      // A group's own fills and strokes recolor with its contents.
      if (stackPaints(n).length) out.set(n.id, n);
      for (const c of n.children) visit(doc.get(c));
    } else if (n.type === 'path' || n.type === 'compound' || n.type === 'text') out.set(n.id, n);
  };
  for (const id of ids) {
    const n = doc.get(id);
    if (n?.type === 'path' && doc.get(n.parent)?.type === 'compound') visit(doc.get(n.parent));
    else visit(n);
  }
  return [...out.values()];
}

/**
 * Patches (id -> { fill?, stroke? }) for mapping the colors of nodes.
 * opts.fill / opts.stroke choose which paints change (both by default).
 */
export function colorPatches(nodes, fn, { fill = true, stroke = true } = {}) {
  const patches = new Map();
  for (const n of nodes) {
    const patch = {};
    // Extra fills and strokes of an appearance stack.
    const stack = mapStackPaints(n, (p, key) => ((key === 'fill' ? fill : stroke) ? mapPaint(p, fn, { node: n, key }) : p));
    if (stack) patch.appearance = stack;
    if (fill && n.fill) {
      const p = mapPaint(n.fill, fn, { node: n, key: 'fill' });
      if (p !== n.fill) patch.fill = p;
    }
    if (stroke && n.stroke) {
      const p = mapPaint(n.stroke, fn, { node: n, key: 'stroke' });
      if (p !== n.stroke) patch.stroke = p;
    }
    // Styled characters carry their own fill and stroke.
    if (n.type === 'text' && n.runs) {
      let changed = false;
      const runs = n.runs.map((r) => {
        let out = r;
        for (const [key, on] of [['fill', fill], ['stroke', stroke]]) {
          if (!on || !r[key]) continue;
          const p = mapPaint(r[key], fn, { node: n, key });
          if (p !== r[key]) {
            if (out === r) out = { ...r };
            out[key] = p;
            changed = true;
          }
        }
        return out;
      });
      if (changed) patch.runs = runs;
    }
    if (Object.keys(patch).length) patches.set(n.id, patch);
  }
  return patches;
}

/** Unique colors used by nodes, most used first: [{ color, count }]. */
export function collectColors(nodes, { fill = true, stroke = true } = {}) {
  const counts = new Map();
  const add = (hex) => {
    const k = hex.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const n of nodes) {
    // Type counts the paints its characters actually use.
    const sources = n.type === 'text' && n.runs ? styledRuns(n).filter((r) => r.end > r.start).map((r) => r.style) : n.type === 'group' || n.type === 'layer' ? [] : [n];
    for (const it of n.appearance || []) if (it && !it.base && (it.type === 'fill' || it.type === 'stroke') && it[it.type]) sources.push({ [it.type]: it[it.type] });
    for (const src of sources) {
      for (const [key, on] of [['fill', fill], ['stroke', stroke]]) {
        const p = src[key];
        if (!on || !p) continue;
        if (p.type === 'solid') add(p.color);
        else if (p.stops) for (const s of p.stops) add(s.color);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color, count]) => ({ color, count }));
}

// ---- color functions ----

export const invertColor = (hex) => invertHex(hex);

/** Grayscale by luminance (like converting to Grayscale and back to RGB). */
export function grayscaleColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const v = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgbToHex({ r: v, g: v, b: v });
}

/**
 * Adjust Color Balance: deltas in percent (-100..100) per channel.
 * mode 'rgb': { r, g, b } shift each channel by delta% of 255.
 * mode 'cmyk': { c, m, y, k } shift each ink by delta percentage points.
 * mode 'grayscale': { gray } shifts the black of gray colors; with
 * `convert` every color is made gray first.
 */
export function adjustColor(hex, mode, d) {
  if (mode === 'grayscale') {
    const { r, g, b } = hexToRgb(hex);
    if (!d.convert && (Math.abs(r - g) > 1 || Math.abs(g - b) > 1)) return hex;
    const k = clamp(100 - ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 100 + (d.gray || 0), 0, 100);
    const v = 255 * (1 - k / 100);
    return rgbToHex({ r: v, g: v, b: v });
  }
  if (mode === 'cmyk') {
    const c = rgbToCmyk(hexToRgb(hex));
    return rgbToHex(
      cmykToRgb({
        c: clamp(c.c + (d.c || 0), 0, 100),
        m: clamp(c.m + (d.m || 0), 0, 100),
        y: clamp(c.y + (d.y || 0), 0, 100),
        k: clamp(c.k + (d.k || 0), 0, 100),
      }),
    );
  }
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: clamp(r + ((d.r || 0) / 100) * 255, 0, 255), g: clamp(g + ((d.g || 0) / 100) * 255, 0, 255), b: clamp(b + ((d.b || 0) / 100) * 255, 0, 255) });
}

/**
 * Saturate: -100..100. Positive values push colors away from their gray,
 * negative values pull them toward it (-100 = fully desaturated).
 */
export function saturateColor(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = 1 + clamp(amount, -100, 100) / 100;
  return rgbToHex({ r: clamp(gray + (r - gray) * f, 0, 255), g: clamp(gray + (g - gray) * f, 0, 255), b: clamp(gray + (b - gray) * f, 0, 255) });
}

/** Shift hue/saturation/brightness (used by Recolor's global adjustments). */
export function shiftHsb(hex, { h = 0, s = 0, b = 0 } = {}) {
  const c = rgbToHsb(hexToRgb(hex));
  return rgbToHex(hsbToRgb({ h: (((c.h + h) % 360) + 360) % 360, s: clamp(c.s + s, 0, 100), v: clamp(c.v + b, 0, 100) }));
}

/**
 * Blend fills between the two extreme objects: 'horizontal' (leftmost to
 * rightmost by center), 'vertical' (top to bottom) or 'front' (frontmost to
 * backmost). Needs three or more objects with solid fills. Returns
 * Map id -> new fill color, or null when not applicable.
 */
export function blendFills(doc, nodes, how) {
  const filled = nodes.filter((n) => n.fill && n.fill.type === 'solid');
  if (filled.length < 3) return null;
  let ordered;
  if (how === 'front') {
    ordered = filled.slice(); // nodes arrive back to front
    ordered.reverse();
  } else {
    const key = (n) => {
      const b = nodeBounds(doc, n) || { x: 0, y: 0, w: 0, h: 0 };
      return how === 'horizontal' ? b.x + b.w / 2 : b.y + b.h / 2;
    };
    ordered = filled.map((n) => ({ n, k: key(n) })).sort((a, b) => a.k - b.k).map((x) => x.n);
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const A = hexToRgb(first.fill.color);
  const B = hexToRgb(last.fill.color);
  const out = new Map();
  let positions;
  if (how === 'front') positions = ordered.map((_, i) => i / (ordered.length - 1));
  else {
    const key = (n) => {
      const b = nodeBounds(doc, n) || { x: 0, y: 0, w: 0, h: 0 };
      return how === 'horizontal' ? b.x + b.w / 2 : b.y + b.h / 2;
    };
    const k0 = key(first);
    const k1 = key(last);
    positions = ordered.map((n) => (k1 - k0 ? (key(n) - k0) / (k1 - k0) : 0));
  }
  ordered.forEach((n, i) => {
    if (n === first || n === last) return;
    const t = positions[i];
    out.set(n.id, rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t }));
  });
  return out;
}

/**
 * Recolor mapping: { from: '#hex' -> to: '#hex' } applied with an optional
 * global HSB shift. Colors not in the map get only the shift.
 */
export function recolorFn(map, shift = null) {
  const m = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (hex) => {
    let c = m.get(hex.toLowerCase()) || hex;
    if (shift && (shift.h || shift.s || shift.b)) c = shiftHsb(c, shift);
    return c;
  };
}
