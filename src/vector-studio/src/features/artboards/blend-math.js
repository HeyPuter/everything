/**
 * Blend geometry: intermediate objects between two key objects.
 *
 * A blend is a group node with `blend: { spacing, steps, distance,
 * orientation }` whose children are the key objects (back to front). The
 * steps between each pair of consecutive keys are generated on the fly:
 * paths get matching anchor counts (the path with fewer anchors is split at
 * its longest segments, closed paths are rotated to the best start point)
 * and their anchors, handles, colors, stroke weights and opacity are
 * interpolated. Compound paths and groups with the same structure blend
 * child by child; other objects blend their position and size.
 *
 * A blend may carry a spine: a child path flagged `blendSpine` (unpainted)
 * that the steps follow instead of the straight line between the keys.
 * Key k belongs at k/(K-1) of the spine's length; each step sits at its
 * share of the length between its keys, keeping the keys' own offsets
 * from the spine, and with orientation 'path' turns with the spine.
 *
 * Easing spaces the steps unevenly (bunched toward the start, the end or
 * both) and can apply to the colors as well; colors blend in RGB or around
 * the hue wheel (the short or the long way).
 *
 * Generated steps are cached per blend group and key-object identity, so
 * redraws cost nothing until a key object changes.
 */
import { registerLive } from '../../model/live.js';
import { segmentCount, segmentPoints, cubicLength, split } from '../../model/bezier.js';
import { nodeBounds, transformPatches } from '../../model/geometry.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb } from '../../lib/color.js';
import { multiply, scale, translate, rotate } from '../../lib/matrix.js';
import { pathSampler } from '../../model/path-sampler.js';
import { isGradient, sampleStops } from '../../model/gradients.js';
import { remapIdRefs } from '../../model/document.js';

export const DEFAULT_BLEND = Object.freeze({ spacing: 'smooth', steps: 5, distance: 20, orientation: 'page', easing: 'linear', easeAmount: 0.5, easeColor: true, colorMode: 'rgb' });

/** Step spacing curves and color interpolation modes of blend options. */
export const BLEND_EASINGS = [
  { value: 'linear', label: 'Even' },
  { value: 'in', label: 'Ease In (bunched at the start)' },
  { value: 'out', label: 'Ease Out (bunched at the end)' },
  { value: 'inOut', label: 'Ease In and Out' },
];
export const BLEND_COLOR_MODES = [
  { value: 'rgb', label: 'Straight (RGB)' },
  { value: 'hue', label: 'Around the Hue Wheel' },
  { value: 'hueLong', label: 'Around the Hue Wheel (long way)' },
];

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Where a step at even position t (0-1) goes with an easing curve.
 * `amount` (0-1) sets how strong the curve is (0 is even spacing).
 */
export function easeT(t, easing = 'linear', amount = 0.5) {
  const p = 1 + 3 * Math.max(0, Math.min(1, amount));
  if (easing === 'in') return t ** p;
  if (easing === 'out') return 1 - (1 - t) ** p;
  if (easing === 'inOut') return t < 0.5 ? 0.5 * (2 * t) ** p : 1 - 0.5 * (2 - 2 * t) ** p;
  return t;
}

/** Split the longest segments of an anchor list until it has `count` anchors. */
export function subdivideTo(anchors, closed, count) {
  let out = anchors;
  const segs = segmentCount(anchors, closed);
  if (out.length < count && segs > 0)
    out = splitLongest(anchors, closed, segs, count - anchors.length);
  // Degenerate single-point paths: repeat the point.
  while (out.length < count) out = [...out, { ...out[out.length - 1] }];
  return out;
}

const isLineSeg = (c) =>
  Math.abs(c[2] - c[0]) < 1e-9 &&
  Math.abs(c[3] - c[1]) < 1e-9 &&
  Math.abs(c[4] - c[6]) < 1e-9 &&
  Math.abs(c[5] - c[7]) < 1e-9;

/**
 * Split segments in half `extra` times, always the longest one (the first on ties), as
 * repeated insertAnchor(longest, 0.5) would, but with a heap so dense paths stay fast.
 * Each piece is { c, len, seg, lo, hi }: its cubic, length, segment and place in it.
 */
function splitLongest(anchors, closed, segs, extra) {
  const before = (a, b) =>
    a.len > b.len || (a.len === b.len && (a.seg < b.seg || (a.seg === b.seg && a.lo < b.lo)));
  const heap = [];
  const push = (p) => {
    let i = heap.push(p) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!before(heap[i], heap[up])) break;
      [heap[i], heap[up]] = [heap[up], heap[i]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && before(heap[l], heap[m])) m = l;
        if (r < heap.length && before(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const piece = (c, seg, lo, hi) => ({ c, len: cubicLength(c, 0.5), seg, lo, hi });
  for (let i = 0; i < segs; i++) push(piece(segmentPoints(anchors, i), i, 0, 1));
  for (let k = 0; k < extra; k++) {
    const p = pop();
    const [l, r] = split(p.c, 0.5);
    if (isLineSeg(p.c)) {
      // A straight segment's new anchor has no handles.
      l[4] = l[6];
      l[5] = l[7];
      r[2] = r[0];
      r[3] = r[1];
    }
    const mid = (p.lo + p.hi) / 2;
    push(piece(l, p.seg, p.lo, mid));
    push(piece(r, p.seg, mid, p.hi));
  }
  const done = heap.sort((a, b) => a.seg - b.seg || a.lo - b.lo);
  const out = [];
  const at = [];
  let j = 0;
  for (let i = 0; i < anchors.length; i++) {
    at.push(out.length);
    const a = { ...anchors[i] };
    out.push(a);
    if (i >= segs) continue;
    const first = j;
    while (j < done.length && done[j].seg === i) j++;
    a.ox = done[first].c[2];
    a.oy = done[first].c[3];
    for (let q = first + 1; q < j; q++) {
      const c = done[q].c;
      const p = done[q - 1].c;
      out.push({ x: c[0], y: c[1], ix: p[4], iy: p[5], ox: c[2], oy: c[3] });
    }
  }
  // Each segment's last piece sets the in handle of the anchor it ends at.
  j = 0;
  for (let i = 0; i < segs; i++) {
    while (j + 1 < done.length && done[j + 1].seg === i) j++;
    const end = out[at[(i + 1) % anchors.length]];
    end.ix = done[j].c[4];
    end.iy = done[j].c[5];
    j++;
  }
  return out;
}

function centroid(anchors) {
  let x = 0;
  let y = 0;
  for (const a of anchors) {
    x += a.x;
    y += a.y;
  }
  return { x: x / anchors.length, y: y / anchors.length };
}

/** Rotate a closed anchor list so it starts at index k. */
function rotateList(anchors, k) {
  return k ? [...anchors.slice(k), ...anchors.slice(0, k)] : anchors;
}

/**
 * Two anchor lists with the same length, ready to interpolate. For two
 * closed paths, B is rotated to the start point that best matches A
 * (relative to their centers) so the blend does not twist.
 */
export function matchAnchors(a, closedA, b, closedB) {
  const n = Math.max(a.length, b.length);
  let A = subdivideTo(a, closedA, n);
  let B = subdivideTo(b, closedB, n);
  if (closedA && closedB && n > 1) B = rotateList(B, bestRotation(A, B));
  return [A, B];
}

/**
 * The start index k for B that best matches A (least squared distance between
 * A[i] and B[i + k] relative to their centers; the first k on ties). Dense
 * paths score every k at once by FFT and check the near-best ones exactly.
 */
function bestRotation(A, B) {
  const n = A.length;
  const ca = centroid(A);
  const cb = centroid(B);
  const cost = (k) => {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const p = A[i];
      const q = B[(i + k) % n];
      d += (p.x - ca.x - (q.x - cb.x)) ** 2 + (p.y - ca.y - (q.y - cb.y)) ** 2;
    }
    return d;
  };
  let ks = null;
  if (n > 512) {
    // d(k) = sum |u|^2 + sum |v|^2 - 2 Re sum conj(u_i) v_(i+k): one circular correlation.
    let N = 1;
    while (N < 2 * n) N *= 2;
    const ur = new Float64Array(N);
    const ui = new Float64Array(N);
    const vr = new Float64Array(N);
    const vi = new Float64Array(N);
    let su = 0;
    for (let i = 0; i < n; i++) {
      ur[i] = A[i].x - ca.x;
      ui[i] = A[i].y - ca.y;
      const x = B[i].x - cb.x;
      const y = B[i].y - cb.y;
      vr[i] = vr[i + n] = x;
      vi[i] = vi[i + n] = y;
      su += ur[i] ** 2 + ui[i] ** 2 + x * x + y * y;
    }
    fft(ur, ui, false);
    fft(vr, vi, false);
    for (let i = 0; i < N; i++) {
      // conj(U) * V
      const r = ur[i] * vr[i] + ui[i] * vi[i];
      const m = ur[i] * vi[i] - ui[i] * vr[i];
      ur[i] = r;
      ui[i] = m;
    }
    fft(ur, ui, true);
    const approx = new Float64Array(n);
    let lo = Infinity;
    for (let k = 0; k < n; k++) lo = Math.min(lo, (approx[k] = su - (2 * ur[k]) / N));
    const slack = 1e-9 * su + 1e-9;
    ks = [];
    for (let k = 0; k < n && ks.length < 64; k++) if (approx[k] <= lo + slack) ks.push(k);
  }
  let best = 0;
  let bestD = Infinity;
  for (let j = 0, m = ks ? ks.length : n; j < m; j++) {
    const k = ks ? ks[j] : j;
    const d = cost(k);
    if (d < bestD - 1e-9) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** In-place radix-2 FFT of (re, im); `inverse` leaves the result unscaled. */
function fft(re, im, inverse) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Matched anchor lists per pair of anchor arrays (nodes are immutable): every step between two
// keys interpolates the same pair, so the matching (O(n^2) for closed paths) runs once per pair.
const matchCache = new WeakMap();

function matchedPair(a, b) {
  let byB = matchCache.get(a.anchors);
  if (!byB) matchCache.set(a.anchors, (byB = new WeakMap()));
  const key = `${a.closed ? 1 : 0}${b.closed ? 1 : 0}`;
  let hit = byB.get(b.anchors);
  if (!hit) byB.set(b.anchors, (hit = {}));
  if (!hit[key]) hit[key] = matchAnchors(a.anchors, a.closed, b.anchors, b.closed);
  return hit[key];
}

export function lerpAnchors(A, B, t) {
  return A.map((p, i) => {
    const q = B[i];
    return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), ix: lerp(p.ix, q.ix, t), iy: lerp(p.iy, q.iy, t), ox: lerp(p.ox, q.ox, t), oy: lerp(p.oy, q.oy, t) };
  });
}

export function lerpColor(a, b, t, mode = 'rgb') {
  const p = hexToRgb(a);
  const q = hexToRgb(b);
  if (mode === 'hue' || mode === 'hueLong') {
    const x = rgbToHsb(p);
    const y = rgbToHsb(q);
    // A gray end takes the other end's hue, so it does not swing through the wheel.
    const ha = x.s < 1e-6 ? y.h : x.h;
    const hb = y.s < 1e-6 ? x.h : y.h;
    let d = (((hb - ha) % 360) + 540) % 360 - 180;
    if (mode === 'hueLong' && Math.abs(d) > 1e-9) d = d > 0 ? d - 360 : d + 360;
    const c = hsbToRgb({ h: ha + d * t, s: lerp(x.s, y.s, t), v: lerp(x.v, y.v, t) });
    return rgbToHex({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
  }
  return rgbToHex({ r: Math.round(lerp(p.r, q.r, t)), g: Math.round(lerp(p.g, q.g, t)), b: Math.round(lerp(p.b, q.b, t)) });
}

/** A gradient's stops sampled at the given offsets (so two gradients can blend stop by stop). */
function stopsAt(stops, offsets) {
  return offsets.map((offset) => ({ offset, ...sampleStops(stops, offset) }));
}

/** A gradient shaped like `like` in one solid color (none: like's colors, transparent), for blending with it. */
function flatGradient(paint, like) {
  if (!paint) return { ...like, stops: like.stops.map((s) => ({ offset: s.offset, color: s.color, opacity: 0 })) };
  return { ...like, stops: like.stops.map((s) => ({ offset: s.offset, color: paint.color, opacity: paint.opacity ?? 1 })) };
}

/**
 * Interpolate two paints. None blends as the other color fading out; a solid color
 * or none blends into a gradient as a gradient of that color; gradients with
 * different stops blend at the stops of both; other mismatched kinds switch halfway.
 */
export function lerpPaint(a, b, t, mode = 'rgb') {
  if (!a && !b) return null;
  if (a?.type === 'solid' && b?.type === 'solid') {
    const out = { type: 'solid', color: lerpColor(a.color, b.color, t, mode) };
    const oa = a.opacity ?? 1;
    const ob = b.opacity ?? 1;
    if (oa !== 1 || ob !== 1) out.opacity = lerp(oa, ob, t);
    return out;
  }
  if (!a && b?.type === 'solid') return { ...b, opacity: lerp(0, b.opacity ?? 1, t) };
  if (a?.type === 'solid' && !b) return { ...a, opacity: lerp(a.opacity ?? 1, 0, t) };
  if (isGradient(b) && (!a || a.type === 'solid') && b.stops?.length) return lerpPaint(flatGradient(a, b), b, t, mode);
  if (isGradient(a) && (!b || b.type === 'solid') && a.stops?.length) return lerpPaint(a, flatGradient(b, a), t, mode);
  if (a && b && a.type === b.type && isGradient(a) && a.stops?.length && b.stops?.length && a.stops.length !== b.stops.length) {
    const offsets = [...new Set([...a.stops, ...b.stops].map((s) => s.offset))].sort((x, y) => x - y);
    return lerpPaint({ ...a, stops: stopsAt(a.stops, offsets) }, { ...b, stops: stopsAt(b.stops, offsets) }, t, mode);
  }
  if (a && b && a.type === b.type && (a.type === 'linear' || a.type === 'radial') && a.stops.length === b.stops.length) {
    const sa = [...a.stops].sort((x, y) => x.offset - y.offset);
    const sb = [...b.stops].sort((x, y) => x.offset - y.offset);
    const out = {
      ...a,
      angle: lerp(a.angle || 0, b.angle || 0, t),
      stops: sa.map((s, i) => ({ offset: lerp(s.offset, sb[i].offset, t), color: lerpColor(s.color, sb[i].color, t, mode), opacity: lerp(s.opacity ?? 1, sb[i].opacity ?? 1, t) })),
    };
    for (const k of ['x1', 'y1', 'x2', 'y2']) if (a[k] !== undefined && b[k] !== undefined) out[k] = lerp(a[k], b[k], t);
    return out;
  }
  return t < 0.5 ? a : b;
}

const STYLE_SWITCH = ['strokeCap', 'strokeJoin', 'strokeAlign', 'dash', 'blendMode', 'effects', 'arrowStart', 'arrowEnd'];

/** Interpolated style; `colorT` and `colorMode` let paints follow their own easing and color mode. */
export function lerpStyle(a, b, t, { colorT = t, colorMode = 'rgb' } = {}) {
  const out = {
    fill: lerpPaint(a.fill ?? null, b.fill ?? null, colorT, colorMode),
    stroke: lerpPaint(a.stroke ?? null, b.stroke ?? null, colorT, colorMode),
    strokeWidth: lerp(a.strokeWidth ?? 0, b.strokeWidth ?? 0, t),
    opacity: lerp(a.opacity ?? 1, b.opacity ?? 1, colorT),
    miterLimit: lerp(a.miterLimit ?? 10, b.miterLimit ?? 10, t),
  };
  for (const k of STYLE_SWITCH) {
    const v = t < 0.5 ? a[k] : b[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Fill/stroke colors of the first paintable leaf (for Smooth Color step counts). */
function leafPaints(doc, node) {
  let n = node;
  while (n && (n.type === 'group' || n.type === 'layer') && n.children.length) n = doc.get(n.children[0]);
  return n ? [n.fill, n.stroke] : [null, null];
}

function colorDistance(pa, pb) {
  if (pa?.type !== 'solid' || pb?.type !== 'solid') return pa === pb || (!pa && !pb) ? 0 : -1;
  const a = hexToRgb(pa.color);
  const b = hexToRgb(pb.color);
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/**
 * Number of intermediate steps between two key objects for blend options.
 * `along` overrides the distance between the keys (the spine length between them).
 */
export function blendStepCount(doc, opts, a, b, along = null) {
  const o = { ...DEFAULT_BLEND, ...opts };
  if (o.spacing === 'steps') return Math.max(1, Math.min(1000, Math.round(o.steps)));
  const ba = nodeBounds(doc, a);
  const bb = nodeBounds(doc, b);
  if (!ba || !bb) return 1;
  const dist = along ?? Math.hypot(bb.x + bb.w / 2 - (ba.x + ba.w / 2), bb.y + bb.h / 2 - (ba.y + ba.h / 2));
  if (o.spacing === 'distance') return Math.max(1, Math.min(1000, Math.round(dist / Math.max(0.01, o.distance)) - 1));
  // Smooth color: one step per color level that changes; identical colors (or gradients)
  // fall back to the longest distance between the bounding box edges.
  const [fa, sa] = leafPaints(doc, a);
  const [fb, sb] = leafPaints(doc, b);
  const d = Math.max(colorDistance(fa, fb), colorDistance(sa, sb));
  if (d > 0) return Math.max(1, Math.min(256, Math.round(d)));
  const edge = Math.max(Math.abs(bb.x - ba.x), Math.abs(bb.x + bb.w - ba.x - ba.w), Math.abs(bb.y - ba.y), Math.abs(bb.y + bb.h - ba.y - ba.h));
  return Math.max(1, Math.min(256, Math.round(edge / 2)));
}

let vid = 0;

/** A virtual copy of `node` with a matrix applied (fallback for objects that cannot morph). */
function transformedCopy(doc, node, m, extra, style) {
  const patches = transformPatches(doc, node, m, {});
  const ids = new Map();
  const copy = (n) => {
    const nid = `blend~${++vid}`;
    ids.set(n.id, nid);
    let out = { ...n, ...(patches.get(n.id) || {}), id: nid };
    if (n.children) {
      out.children = n.children.map((c) => {
        const cn = doc.get(c);
        if (!cn) return null;
        const cc = copy(cn);
        extra.set(cc.id, cc);
        return cc.id;
      }).filter(Boolean);
      // Nested live objects that name their children (interlace zones) name the copies.
      out = remapIdRefs(out, ids);
    }
    return out;
  };
  const out = copy(node);
  if (style && (out.type === 'path' || out.type === 'compound' || out.type === 'text')) Object.assign(out, style);
  return out;
}

/**
 * An interpolated (virtual) node between key objects a and b at t in (0, 1).
 * Child nodes of virtual groups/compounds go into `extra` (id -> node).
 */
export function interpolateNode(doc, a, b, t, extra, copts = {}) {
  if (a.type === 'path' && b.type === 'path' && a.anchors.length && b.anchors.length) {
    const [A, B] = matchedPair(a, b);
    return { ...a, ...lerpStyle(a, b, t, copts), id: `blend~${++vid}`, anchors: lerpAnchors(A, B, t), closed: t < 0.5 ? a.closed : b.closed, shape: undefined };
  }
  if ((a.type === 'compound' || a.type === 'group') && a.type === b.type && a.children.length === b.children.length && a.children.length) {
    const kids = a.children.map((c, i) => {
      const ca = doc.get(c);
      const cb = doc.get(b.children[i]);
      if (!ca || !cb) return null;
      const k = interpolateNode(doc, ca, cb, t, extra, copts);
      extra.set(k.id, k);
      return k.id;
    }).filter(Boolean);
    const out = { ...a, id: `blend~${++vid}`, children: kids };
    if (a.type === 'compound') Object.assign(out, lerpStyle(a, b, t, copts));
    else out.opacity = lerp(a.opacity ?? 1, b.opacity ?? 1, copts.colorT ?? t);
    return out;
  }
  // Different structures: move and scale the nearer key object's box toward the other.
  const ba = nodeBounds(doc, a);
  const bb = nodeBounds(doc, b);
  const src = t < 0.5 ? a : b;
  const from = t < 0.5 ? ba : bb;
  if (!ba || !bb || !from) return transformedCopy(doc, src, [1, 0, 0, 1, 0, 0], extra);
  const w = lerp(ba.w, bb.w, t);
  const hgt = lerp(ba.h, bb.h, t);
  const cx = lerp(ba.x + ba.w / 2, bb.x + bb.w / 2, t);
  const cy = lerp(ba.y + ba.h / 2, bb.y + bb.h / 2, t);
  const sx = from.w > 1e-9 ? w / from.w : 1;
  const sy = from.h > 1e-9 ? hgt / from.h : 1;
  const m = multiply(translate(cx - (from.x + from.w / 2), cy - (from.y + from.h / 2)), scale(sx, sy, from.x + from.w / 2, from.y + from.h / 2));
  const style = (a.type === 'path' || a.type === 'compound' || a.type === 'text') && (b.type === 'path' || b.type === 'compound' || b.type === 'text') ? lerpStyle(a, b, t, copts) : null;
  return transformedCopy(doc, src, m, extra, style);
}

/** All node objects in a subtree (identity snapshot for cache checks). */
function subtreeNodes(doc, id, out = []) {
  const n = doc.get(id);
  if (!n) return out;
  out.push(n);
  if (n.children) for (const c of n.children) subtreeNodes(doc, c, out);
  return out;
}

const cache = new WeakMap();

/** The spine path of a blend group, or null (straight between the keys). */
export function blendSpine(doc, group) {
  for (const c of group.children) {
    const n = doc.get(c);
    if (n?.blendSpine && n.type === 'path' && n.anchors.length >= 2) return n;
  }
  return null;
}

/** The key objects of a blend (visible children other than the spine), back to front. */
export function blendKeys(doc, group) {
  return group.children.map((c) => doc.get(c)).filter((n) => n && !n.hidden && !n.blendSpine);
}

const boxCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Smallest signed difference b - a between two angles in radians. */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move a virtual step (and its virtual descendants in `extra`) by matrix m, in place. */
function moveVirtual(doc, extra, node, m) {
  const view = virtualDoc(doc, extra);
  const patches = transformPatches(view, node, m, {});
  for (const [id, patch] of patches) if (id !== node.id && extra.has(id)) extra.set(id, { ...extra.get(id), ...patch });
  return { ...node, ...(patches.get(node.id) || {}) };
}

/**
 * Generated steps of a blend group: [{ after: keyIndex, nodes: [virtual nodes] }]
 * plus the `extra` map of virtual descendants. Cached until a key changes.
 */
export function blendSteps(doc, group) {
  const snapshot = group.children.flatMap((c) => subtreeNodes(doc, c));
  const hit = cache.get(group);
  if (hit && hit.snapshot.length === snapshot.length && hit.snapshot.every((n, i) => n === snapshot[i])) return hit.result;
  const extra = new Map();
  const runs = [];
  const keys = blendKeys(doc, group);
  const spine = blendSpine(doc, group);
  const sampler = spine ? pathSampler(spine.anchors, spine.closed) : null;
  const along = (k) => (keys.length > 1 ? (k / (keys.length - 1)) * sampler.length : 0);
  const opts = { ...DEFAULT_BLEND, ...group.blend };
  const orient = opts.orientation === 'path';
  for (let k = 0; k < keys.length - 1; k++) {
    const a = keys[k];
    const b = keys[k + 1];
    let count;
    let place = null;
    if (sampler && sampler.length > 0) {
      const sa = along(k);
      const sb = along(k + 1);
      count = blendStepCount(doc, group.blend, a, b, Math.abs(sb - sa));
      const ba = nodeBounds(doc, a);
      const bb = nodeBounds(doc, b);
      if (ba && bb) {
        const ca = boxCenter(ba);
        const cb = boxCenter(bb);
        const pa = sampler.at(sa);
        const pb = sampler.at(sb);
        // Each step keeps the keys' offsets from the spine, blended.
        place = (t) => {
          const p = sampler.at(sa + (sb - sa) * t);
          const off = { x: lerp(ca.x - pa.x, cb.x - pb.x, t), y: lerp(ca.y - pa.y, cb.y - pb.y, t) };
          const lin = { x: lerp(ca.x, cb.x, t), y: lerp(ca.y, cb.y, t) };
          let m = translate(p.x + off.x - lin.x, p.y + off.y - lin.y);
          if (orient) {
            const turn = angleDelta(pa.angle + angleDelta(pa.angle, pb.angle) * t, p.angle);
            m = multiply(rotate((turn * 180) / Math.PI, p.x + off.x, p.y + off.y), m);
          }
          return m;
        };
      }
    } else count = blendStepCount(doc, group.blend, a, b);
    const nodes = [];
    for (let i = 1; i <= count; i++) {
      const even = i / (count + 1);
      const t = easeT(even, opts.easing, opts.easeAmount);
      let n = interpolateNode(doc, a, b, t, extra, { colorT: opts.easeColor === false ? even : t, colorMode: opts.colorMode });
      if (place) n = moveVirtual(doc, extra, n, place(t));
      nodes.push(n);
    }
    runs.push({ after: a.id, nodes });
  }
  const result = { runs, extra };
  cache.set(group, { snapshot, result });
  return result;
}

/** A doc-like view that resolves virtual step nodes as well as real ones (for drawing). */
export function virtualDoc(doc, extra) {
  return { get: (id) => extra.get(id) || doc.get(id), assets: doc.assets, root: doc.root, has: (id) => extra.has(id) || doc.has(id) };
}

/**
 * Real nodes for expanding a blend: a list of subtrees { root, nodes } in
 * paint order (keys and steps interleaved), for VDocument.importSubtree.
 */
export function expandedSubtrees(doc, group) {
  const { runs, extra } = blendSteps(doc, group);
  const vdoc = virtualDoc(doc, extra);
  const collect = (n) => {
    const out = [n];
    for (const c of n.children || []) {
      const cn = vdoc.get(c);
      if (cn) out.push(...collect(cn));
    }
    return out;
  };
  const subs = [];
  for (const c of group.children) {
    const key = doc.get(c);
    if (!key || key.blendSpine) continue;
    subs.push({ key: true, id: key.id });
    const run = runs.find((r) => r.after === key.id);
    if (run) for (const n of run.nodes) subs.push({ key: false, sub: { root: n.id, nodes: collect(n) } });
  }
  return subs;
}

/**
 * A blend as live artwork: each key object followed by the steps toward
 * the next key, so drawing, hit testing, bounds and export all see the steps.
 */
registerLive('blend', {
  label: '<Blend>',
  test: (n) => n.type === 'group' && Boolean(n.blend),
  generate(doc, group) {
    const { runs, extra } = blendSteps(doc, group);
    const items = [];
    for (const c of group.children) {
      // The spine draws (unpainted) so it outlines and clicks like the rest of the blend.
      items.push(c);
      const run = runs.find((r) => r.after === c);
      if (run) items.push(...run.nodes);
    }
    return { items, extra };
  },
});

