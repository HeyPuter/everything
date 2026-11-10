/**
 * Turns entities into display-list primitives (see display.js) with fully
 * resolved styles: ByLayer and ByBlock colors, linetypes and lineweights,
 * layer visibility and transparency, block references (nested), text,
 * dimensions and hatches.
 */
import { COLOR_BYBLOCK, COLOR_BYLAYER, LW_BYBLOCK, LW_BYLAYER, LW_DEFAULT, LINEWEIGHTS, DEFAULT_LINEWEIGHT } from './schema.js';
import { PALETTE, hexToRgb } from './colors.js';
import { tessellate } from './geom/index.js';
import { layoutText, layoutMText } from './text/layout.js';
import { buildDimension, buildLeader, dimStyleOf } from './dims.js';
import { loopsToRings, solidPolygons, patternSegments } from './hatch/fill.js';
import { hatchPattern } from './hatch/patterns.js';

const EMPTY = [];
const MAX_DEPTH = 16;
const LW_INDEX = new Map(LINEWEIGHTS.map((w, i) => [w, i]));

/**
 * Build a render context.
 *   drawing   Drawing
 *   fg        RGB for color index 7
 *   tol       chord tolerance in world units
 *   view      [minX, minY, maxX, maxY] visible area (clips construction lines)
 *   pointSize world size of point markers
 *   hidden    optional Set of ids to skip (e.g. objects being edited)
 *   patterns  include scaled linetype patterns in styles (exporters); the GPU
 *             renderer only needs basePattern and ltscale
 *   bounds    measuring extents: construction lines inside blocks are skipped
 *   clip      { box: () => [minX, minY, maxX, maxY], state: { used } } for
 *             view-dependent curve tessellation (see geom/tessellate.js)
 */
export function makeContext(drawing, opts) {
  return {
    drawing,
    fg: opts.fg ?? [255, 255, 255],
    tol: opts.tol ?? 0.01,
    view: opts.view ?? [-1e6, -1e6, 1e6, 1e6],
    pointSize: opts.pointSize ?? 1,
    hidden: opts.hidden ?? null,
    ltscale: drawing.header.ltscale || 1,
    plot: !!opts.plot,
    hatchLimit: opts.hatchLimit ?? 200000,
    warnings: opts.warnings ?? null,
    patterns: opts.patterns !== false,
    bounds: !!opts.bounds,
    clip: opts.clip ?? null,
    blockStack: null,
  };
}

function resolveColor(c, layer, parent) {
  if (c === COLOR_BYLAYER || c == null) c = layer?.color ?? 7;
  else if (c === COLOR_BYBLOCK) c = parent ? parent.color : 7;
  return c;
}

function colorToRgb(c, fg) {
  if (typeof c === 'string') return hexToRgb(c);
  if (c === 7 || c === COLOR_BYLAYER || c === COLOR_BYBLOCK) return fg;
  return PALETTE[c] ?? fg;
}

/** Effective style values for an entity (before conversion to a sink style). */
function effective(ent, ctx, parent) {
  const d = ctx.drawing;
  let layerName = ent.layer ?? '0';
  if (parent && layerName === '0') layerName = parent.layer;
  const layer = d.layers.get(layerName) ?? d.layers.get('0');
  const color = resolveColor(ent.color, layer, parent);
  let lt = ent.linetype ?? 'ByLayer';
  if (lt === 'ByLayer') lt = layer?.linetype ?? 'Continuous';
  else if (lt === 'ByBlock') lt = parent ? parent.linetype : 'Continuous';
  let lw = ent.lineweight ?? LW_BYLAYER;
  if (lw === LW_BYLAYER) lw = layer?.lineweight ?? LW_DEFAULT;
  else if (lw === LW_BYBLOCK) lw = parent ? parent.lineweight : LW_DEFAULT;
  const transparency = layer?.transparency ?? 0;
  return { layerName, layer, color, linetype: lt, lineweight: lw, transparency, ltscale: (ent.ltscale ?? 1) * (parent?.ltscale ?? 1) };
}

function toSinkStyle(eff, ctx, id) {
  const lt = ctx.drawing.linetypes.get(eff.linetype);
  const base = lt?.pattern ?? EMPTY;
  const lts = ctx.ltscale * eff.ltscale;
  let lw = eff.lineweight;
  if (lw < 0) lw = DEFAULT_LINEWEIGHT;
  const rgb = colorToRgb(eff.color, ctx.fg);
  return {
    rgb,
    aci7: eff.color === 7,
    lw,
    lwIndex: LW_INDEX.get(lw) ?? LW_INDEX.get(DEFAULT_LINEWEIGHT),
    pattern: base.length && ctx.patterns ? base.map((v) => v * lts) : EMPTY,
    basePattern: base,
    ltscale: lts,
    id,
    alpha: 1 - eff.transparency / 100,
  };
}

/** Same style with a different color value (for dimension parts). */
function withColor(style, c, ctx, eff) {
  if (c === COLOR_BYBLOCK || c == null) return style;
  const col = c === COLOR_BYLAYER ? eff.layer?.color ?? 7 : c;
  return { ...style, rgb: colorToRgb(col, ctx.fg), aci7: col === 7 };
}

/** Wraps a sink and applies an affine matrix [a, b, c, d, e, f] to all points. */
class TransformSink {
  constructor(sink, m) {
    this.sink = sink;
    this.m = m;
  }
  _t(pts) {
    const [a, b, c, d, e, f] = this.m;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i],
        y = pts[i + 1];
      out[i] = a * x + c * y + e;
      out[i + 1] = b * x + d * y + f;
    }
    return out;
  }
  line(pts, closed, style) {
    this.sink.line(this._t(pts), closed, style);
  }
  fill(rings, style) {
    // A mirroring matrix flips ring orientation; the fill rule does not care.
    this.sink.fill(rings.map((r) => this._t(r)), style);
  }
  segs(s, style) {
    const t = this._t(s);
    if (this.sink.segs) this.sink.segs(t, style);
    else for (let i = 0; i < t.length; i += 4) this.sink.line([t[i], t[i + 1], t[i + 2], t[i + 3]], false, style);
  }
}

function insertMatrix(ins, block) {
  const c = Math.cos(ins.rot || 0),
    s = Math.sin(ins.rot || 0);
  const sx = ins.sx ?? 1,
    sy = ins.sy ?? 1;
  const bx = block.bx || 0,
    by = block.by || 0;
  // T(x, y) * R(rot) * S(sx, sy) * T(-bx, -by)
  const a = c * sx,
    b = s * sx,
    cc = -s * sy,
    d = c * sy;
  return [a, b, cc, d, ins.x - (a * bx + cc * by), ins.y - (b * bx + d * by)];
}

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export { insertMatrix, mul as mulMatrix };

/**
 * Emit one entity into `sink`. `parent` carries the resolved style of an
 * enclosing block reference (for ByBlock) and is null at the top level.
 */
export function emitEntity(ent, sink, ctx, parent = null, topId = ent.id, depth = 0) {
  const eff = effective(ent, ctx, parent);
  const layer = eff.layer;
  if (!ctx.ignoreVisibility && layer && (!layer.on || layer.frozen)) return;
  if (ctx.plot && layer && layer.plot === false) return;
  const style = toSinkStyle(eff, ctx, topId);
  switch (ent.type) {
    case 'line':
      sink.line([ent.x1, ent.y1, ent.x2, ent.y2], false, style);
      return;
    case 'xline':
    case 'ray':
      emitInfinite(ent, sink, ctx, style);
      return;
    case 'circle':
    case 'arc':
    case 'ellipse':
    case 'spline':
      for (const p of tessellate(ent, ctx.tol, ctx.clip)) sink.line(p.pts, p.closed, style);
      return;
    case 'polyline':
      emitPolyline(ent, sink, ctx, style);
      return;
    case 'point':
      emitPoint(ent, sink, ctx, style);
      return;
    case 'text':
      emitStrokes(layoutText(ent, ctx.drawing.textStyles.get(ent.style)).strokes, sink, { ...style, basePattern: EMPTY, pattern: EMPTY });
      return;
    case 'mtext':
      emitStrokes(layoutMText(ent, ctx.drawing.textStyles.get(ent.style)).strokes, sink, { ...style, basePattern: EMPTY, pattern: EMPTY });
      return;
    case 'dimension':
    case 'leader':
      emitDimension(ent, sink, ctx, style, eff);
      return;
    case 'hatch':
      emitHatch(ent, sink, ctx, style);
      return;
    case 'insert':
      emitInsert(ent, sink, ctx, eff, topId, depth);
      return;
  }
}

function emitStrokes(strokes, sink, style) {
  for (const s of strokes) if (s.length >= 4) sink.line(s, false, style);
}

/**
 * Construction lines are drawn as a segment just covering the view, centred
 * on the point of the line nearest the view centre, so its ends stay close
 * to the view and keep full precision.
 */
function emitInfinite(ent, sink, ctx, style) {
  if (ctx.bounds && ctx.blockStack) return;
  const [x0, y0, x1, y1] = ctx.view;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const tc = (cx - ent.x) * ent.dx + (cy - ent.y) * ent.dy;
  let t0 = tc - diag,
    t1 = tc + diag;
  if (ent.type === 'ray') {
    if (t1 < 0) return;
    t0 = Math.max(0, t0);
  }
  // Dashes start at the segment start: start on a whole pattern from the
  // base point so they stay put while the view moves.
  let period = 0;
  for (const v of style.basePattern ?? EMPTY) period += Math.abs(v);
  period *= style.ltscale ?? 1;
  if (period > 0 && Number.isFinite(t0 / period)) t0 = Math.floor(t0 / period) * period;
  sink.line([ent.x + ent.dx * t0, ent.y + ent.dy * t0, ent.x + ent.dx * t1, ent.y + ent.dy * t1], false, style);
}

function emitPolyline(ent, sink, ctx, style) {
  const parts = tessellate(ent, ctx.tol, ctx.clip);
  if (!(ent.width > 0)) {
    for (const p of parts) sink.line(p.pts, p.closed, style);
    return;
  }
  const solid = { ...style, basePattern: EMPTY, pattern: EMPTY };
  for (const p of parts) emitBand(p.pts, p.closed, ent.width / 2, sink, solid);
}

/** Longest mitre, in half widths, before a corner of a wide polyline is cut off instead. */
const MITER_LIMIT = 4;
const MITER_MIN = 2 / (MITER_LIMIT * MITER_LIMIT);

/** The points without repeats of the previous point (the same array when there are none). */
function distinctPoints(pts, closed) {
  let n = pts.length >> 1;
  let same = closed && n > 2 && pts[0] === pts[2 * n - 2] && pts[1] === pts[2 * n - 1];
  for (let i = 2; !same && i < 2 * n; i += 2) same = pts[i] === pts[i - 2] && pts[i + 1] === pts[i - 1];
  if (!same) return pts;
  const P = [];
  for (let i = 0; i < 2 * n; i += 2) {
    const k = P.length;
    if (k && P[k - 2] === pts[i] && P[k - 1] === pts[i + 1]) continue;
    P.push(pts[i], pts[i + 1]);
  }
  n = P.length >> 1;
  if (closed && n > 2 && P[0] === P[2 * n - 2] && P[1] === P[2 * n - 1]) P.length -= 2;
  return P;
}

/**
 * Band of half width hw along a flat polyline: one quad per segment. Segments
 * share their corner points at a joint (a mitre), so the band has no notch on
 * the outside of a corner and no overlap on the inside. Very sharp corners are
 * cut off (a bevel), and where the corner lines of a short segment cross
 * before the full width (a tight arc) that edge shrinks to the crossing.
 */
function emitBand(pts, closed, hw, sink, style) {
  const P = distinctPoints(pts, closed);
  const n = P.length >> 1;
  if (n < 2) return;
  const loop = closed && n > 2;
  const segs = loop ? n : n - 1;
  // Unit direction and length of the current segment, starting with the first.
  // (sqrt of the squares, not Math.hypot: several times faster, and lengths here need no overflow care)
  let dx = P[2] - P[0],
    dy = P[3] - P[1];
  let cl = Math.sqrt(dx * dx + dy * dy);
  let cx = dx / cl,
    cy = dy / cl;
  const fx = cx,
    fy = cy;
  // Mitre offset to the left at the start of the current segment (sm: there is one).
  let sm = false,
    sx = 0,
    sy = 0;
  if (loop) {
    dx = P[0] - P[2 * n - 2];
    dy = P[1] - P[2 * n - 1];
    const l = Math.sqrt(dx * dx + dy * dy);
    const px = dx / l,
      py = dy / l;
    const k = 1 + px * cx + py * cy;
    if (k > MITER_MIN) {
      sm = true;
      sx = (-(py + cy) / k) * hw;
      sy = ((px + cx) / k) * hw;
    }
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = P[i * 2],
      ay = P[i * 2 + 1],
      bx = P[j * 2],
      by = P[j * 2 + 1];
    const nx = -cy * hw,
      ny = cx * hw;
    // The next segment and the joint with it.
    let em = false,
      ex = nx,
      ey = ny,
      tx = 0,
      ty = 0,
      tl = 0;
    if (i + 1 < segs || loop) {
      if (i + 1 < segs) {
        const m = ((j + 1) % n) * 2;
        dx = P[m] - bx;
        dy = P[m + 1] - by;
        tl = Math.sqrt(dx * dx + dy * dy);
        tx = dx / tl;
        ty = dy / tl;
      } else {
        tx = fx;
        ty = fy;
      }
      const k = 1 + cx * tx + cy * ty;
      if (k > MITER_MIN) {
        em = true;
        ex = (-(cy + ty) / k) * hw;
        ey = ((cx + tx) / k) * hw;
      } else {
        // Too sharp: cut the corner off with a triangle on its outer side.
        const turn = cx * ty - cy * tx;
        if (turn !== 0) {
          const sg = turn > 0 ? -hw : hw;
          sink.fill([[bx, by, bx - cy * sg, by + cx * sg, bx - ty * sg, by + tx * sg]], style);
        }
      }
    }
    if (!sm) {
      sx = nx;
      sy = ny;
    }
    // Corners: left of the start and end, then right of the end and start.
    const q = [ax + sx, ay + sy, bx + ex, by + ey, bx - ex, by - ey, ax - sx, ay - sy];
    // shrink: how far the mitres move the left ends together (the right ends apart).
    const shrink = (sx - ex) * cx + (sy - ey) * cy;
    if (shrink >= cl || -shrink >= cl) {
      const den = sx * ey - sy * ex;
      const t = den ? (cl * (cx * ey - cy * ex)) / den : 0;
      const side = shrink >= cl ? 0 : 4;
      if (side ? t < 0 && t >= -1 : t > 0 && t <= 1) {
        q[side] = q[side + 2] = ax + sx * t;
        q[side + 1] = q[side + 3] = ay + sy * t;
      } else {
        // No crossing to use: square ends on that side.
        const e = side ? [bx - nx, by - ny, ax - nx, ay - ny] : [ax + nx, ay + ny, bx + nx, by + ny];
        for (let k = 0; k < 4; k++) q[side + k] = e[k];
      }
    }
    sink.fill([q], style);
    sm = em;
    sx = ex;
    sy = ey;
    cx = tx;
    cy = ty;
    cl = tl;
  }
}

function emitPoint(ent, sink, ctx, style) {
  const mode = ctx.drawing.header.pdmode || 0;
  let size = ctx.drawing.header.pdsize || 0;
  if (size <= 0) size = ctx.pointSize;
  const h = size / 2,
    x = ent.x,
    y = ent.y;
  const s = { ...style, basePattern: EMPTY, pattern: EMPTY };
  const base = mode & 31;
  if (base === 0) sink.line([x, y, x, y], false, s);
  else if (base === 2) {
    sink.line([x - h, y, x + h, y], false, s);
    sink.line([x, y - h, x, y + h], false, s);
  } else if (base === 3) {
    sink.line([x - h, y - h, x + h, y + h], false, s);
    sink.line([x - h, y + h, x + h, y - h], false, s);
  } else if (base === 4) sink.line([x, y, x, y + h], false, s);
  if (mode & 32) {
    const pts = [];
    for (let i = 0; i < 32; i++) pts.push(x + Math.cos((i / 32) * Math.PI * 2) * h, y + Math.sin((i / 32) * Math.PI * 2) * h);
    sink.line(pts, true, s);
  }
  if (mode & 64) sink.line([x - h, y - h, x + h, y - h, x + h, y + h, x - h, y + h], true, s);
}

function emitDimension(ent, sink, ctx, style, eff) {
  const d = ctx.drawing;
  const ds = dimStyleOf(d, ent.style);
  const g = ent.type === 'leader' ? buildLeader(ent, ds, d.header) : buildDimension(ent, ds, d.header);
  if (!g) return;
  const lineStyle = withColor({ ...style, basePattern: EMPTY, pattern: EMPTY }, ds.lineColor, ctx, eff);
  const textStyle = withColor({ ...style, basePattern: EMPTY, pattern: EMPTY }, ds.textColor, ctx, eff);
  for (const l of g.lines) sink.line(l.pts, l.closed, lineStyle);
  for (const f of g.fills) sink.fill(f, lineStyle);
  if (g.text && g.text.value) {
    const t = layoutText({ type: 'text', widthFactor: 1, oblique: 0, ...g.text }, d.textStyles.get(ds.textStyle));
    emitStrokes(t.strokes, sink, textStyle);
  }
}

function emitHatch(ent, sink, ctx, style) {
  const rings = loopsToRings(ent.loops || [], ctx.tol);
  if (!rings.length) return;
  const solid = { ...style, basePattern: EMPTY, pattern: EMPTY };
  if (!ent.pattern || ent.pattern === 'SOLID') {
    for (const poly of solidPolygons(rings)) sink.fill(poly, solid);
    return;
  }
  const pat = hatchPattern(ent);
  if (!pat) {
    for (const poly of solidPolygons(rings)) sink.fill(poly, solid);
    return;
  }
  const tint = () => {
    for (const poly of solidPolygons(rings)) sink.fill(poly, { ...solid, alpha: (solid.alpha ?? 1) * 0.35 });
  };
  // On screen, a pattern finer than about a pixel reads as a tint: draw it as one.
  if (!ctx.plot) {
    let spacing = Infinity;
    for (const f of pat.families) spacing = Math.min(spacing, Math.abs(f.dy) * (ent.scale || 1));
    if (spacing < ctx.tol * 6) return tint();
  }
  const res = patternSegments(rings, pat, ent.scale || 1, ent.angle || 0, { maxSegments: ctx.hatchLimit });
  // Too many lines to generate: a partial pattern would leave part of the area
  // (or all of it) empty, so cover the whole area with the tint instead.
  if (res.truncated) {
    ctx.warnings?.add('hatch-dense');
    return tint();
  }
  const segs = res.segs;
  if (sink.segs) sink.segs(segs, solid);
  else for (let i = 0; i < segs.length; i += 4) sink.line([segs[i], segs[i + 1], segs[i + 2], segs[i + 3]], false, solid);
  const dots = res.dots;
  for (let i = 0; i < dots.length; i += 2) sink.line([dots[i], dots[i + 1], dots[i], dots[i + 1]], false, solid);
}

function emitInsert(ent, sink, ctx, eff, topId, depth) {
  if (depth >= MAX_DEPTH) return;
  // A block that (directly or not) contains itself is drawn once, not forever.
  if (ctx.blockStack && ctx.blockStack.has(ent.name)) return;
  const block = ctx.drawing.blocks.get(ent.name);
  if (!block) return;
  const m = insertMatrix(ent, block);
  // The largest stretch decides how finely curves must be split.
  const scale = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) || 1;
  const blockStack = new Set(ctx.blockStack || []);
  blockStack.add(ent.name);
  const child = { ...ctx, tol: ctx.tol / scale, pointSize: ctx.pointSize / scale, view: invView(ctx.view, m), blockStack };
  if (ctx.clip) child.clip = clipInBlock(ctx.clip, m);
  const tsink = new TransformSink(sink, m);
  const parent = {
    layer: eff.layerName,
    color: eff.color,
    linetype: eff.linetype,
    lineweight: eff.lineweight,
    ltscale: eff.ltscale,
  };
  for (const e of block.entities) emitEntity(e, tsink, child, parent, topId, depth + 1);
}

/** The clip box of view-dependent tessellation in block coordinates, worked out only if a curve asks. */
function clipInBlock(clip, m) {
  let box = null;
  return { state: clip.state, box: () => (box ??= invView(clip.box(), m)) };
}

/** Approximate the view rectangle in block coordinates (for construction lines). */
function invView(view, m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return view;
  const ia = m[3] / det,
    ib = -m[1] / det,
    ic = -m[2] / det,
    id = m[0] / det;
  const xs = [],
    ys = [];
  for (const [x, y] of [
    [view[0], view[1]],
    [view[2], view[1]],
    [view[2], view[3]],
    [view[0], view[3]],
  ]) {
    const px = x - m[4],
      py = y - m[5];
    xs.push(ia * px + ic * py);
    ys.push(ib * px + id * py);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A sink that only accumulates bounds. */
export class BoundsSink {
  constructor() {
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
  }
  _add(p) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i],
        y = p[i + 1];
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
    }
  }
  line(pts) {
    this._add(pts);
  }
  fill(rings) {
    for (const r of rings) this._add(r);
  }
  segs(s) {
    this._add(s);
  }
  get bounds() {
    return this.minX === Infinity ? null : [this.minX, this.minY, this.maxX, this.maxY];
  }
}
