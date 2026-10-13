/**
 * Pure geometry behind the face tools (engine/face-render.js): steadying
 * landmarks from frame to frame, the warp handles of face shape, the region
 * masks of the skin fixes, and the spot test of blemish clearing (mirrored
 * by LAYER_FS, see clearSpots there).
 *
 * Faces are Float32Arrays of x, y pairs in source pixels (y down), indexed
 * like the face landmarker's mesh. "A" is the eye, brow and side on the left
 * of the picture for a face looking at the camera, "B" the one on the right.
 */

/** Landmark indices of the face mesh used here. */
export const LM = Object.freeze({
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  lipsOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146],
  lipsInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  eyeA: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
  eyeB: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  lowerLidA: [33, 7, 163, 144, 145, 153, 154, 155, 133],
  lowerLidB: [263, 249, 390, 373, 374, 380, 381, 382, 362],
  browA: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  browB: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  jawA: [93, 132, 172, 150],
  jawB: [323, 361, 397, 379],
  irisA: 468,
  irisB: 473,
  sideA: 234,
  sideB: 454,
  top: 10,
  chin: 152,
  mouthA: 61,
  mouthB: 291,
  lowerLip: 17,
  noseTip: 1,
  noseBase: 2,
  alaA: 98,
  alaB: 327,
  wingA: 129,
  wingB: 358,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const P = (pts, i) => [pts[i * 2], pts[i * 2 + 1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Width (cheek to cheek, px) of a face. */
export const faceWidth = (pts) => dist(P(pts, LM.sideA), P(pts, LM.sideB)) || 1;

/** Middle of a face (between the cheeks, forehead and chin). */
export function faceCenter(pts) {
  const ids = [LM.sideA, LM.sideB, LM.top, LM.chin];
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return [x / ids.length, y / ids.length];
}

/**
 * Axes of a face: ux across it (toward side B), uy down it (toward the
 * chin), plus its width, height and center, all in source pixels.
 */
export function faceFrame(pts) {
  const a = P(pts, LM.sideA);
  const b = P(pts, LM.sideB);
  const width = dist(a, b) || 1;
  const ux = [(b[0] - a[0]) / width, (b[1] - a[1]) / width];
  return { ux, uy: [-ux[1], ux[0]], width, height: dist(P(pts, LM.top), P(pts, LM.chin)) || width, center: faceCenter(pts) };
}

/* Steadying ------------------------------------------------------------------ */

/**
 * For each item of next, the index of the item of prev it continues, or -1.
 * Nearest centers first, and only within reach(item of next).
 */
export function matchNearest(prev, next, center, reach) {
  const out = new Array(next.length).fill(-1);
  const pairs = [];
  const prevCenters = prev.map(center);
  next.forEach((n, i) => {
    const cn = center(n);
    const r = reach(n);
    prevCenters.forEach((cp, j) => {
      const d = dist(cn, cp);
      if (d < r) pairs.push([d, i, j]);
    });
  });
  pairs.sort((x, y) => x[0] - y[0]);
  const used = new Set();
  for (const [, i, j] of pairs) {
    if (out[i] >= 0 || used.has(j)) continue;
    out[i] = j;
    used.add(j);
  }
  return out;
}

/**
 * For each detected face, the index of the previous face it continues, or
 * -1. Nearest centers first, and only within half a face width.
 */
export const matchFaces = (prev, next) => matchNearest(prev, next, faceCenter, (f) => faceWidth(f) * 0.5);

/**
 * Points of the new frame, steadied against the last one. Every point
 * moves part of the way to where the model now puts it; the step grows with
 * how fast the points as a whole move (in sizes per second, size being the
 * width of the face or body), so a turning head is followed at once while
 * the model's frame-to-frame jitter on a still subject is averaged away. A
 * jump (no previous points, a different point count, or no time between)
 * takes the new points as they are.
 */
export function smoothPoints(prev, next, dt, size, { minHz = 1.2, gain = 9, still = 0.1 } = {}) {
  if (!prev || prev.length !== next.length || !(dt > 0) || dt > 0.25) return Float32Array.from(next);
  const n = next.length / 2;
  let moved = 0;
  for (let i = 0; i < next.length; i += 2) moved += Math.hypot(next[i] - prev[i], next[i + 1] - prev[i + 1]);
  // The model's own jitter reads as a little motion; below `still` the subject counts as still.
  const speed = Math.max(0, moved / n / (size || 1) / dt - still);
  const hz = minHz + gain * speed;
  const tau = 1 / (2 * Math.PI * hz);
  const k = 1 / (1 + tau / dt);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = prev[i] + (next[i] - prev[i]) * k;
  return out;
}

/** Face landmarks of the new frame, steadied against the last one (see smoothPoints). */
export const smoothLandmarks = (prev, next, dt, opts) => smoothPoints(prev, next, dt, faceWidth(next), opts);

/** How long (seconds) a face the model briefly lost is kept in place. */
export const FACE_HOLD = 0.3;

/**
 * Faces to draw this frame from the faces of the last one (tracks: { pts,
 * seen }) and what the model found now. Matched faces are steadied, new
 * faces start fresh, and a face missing for less than FACE_HOLD stays where
 * it was so a single missed detection does not make the warp pop.
 */
export function trackFaces(tracks, detected, sec, dt) {
  const prev = tracks || [];
  const match = matchFaces(prev.map((t) => t.pts), detected);
  const out = detected.map((pts, i) => ({ pts: match[i] >= 0 ? smoothLandmarks(prev[match[i]].pts, pts, dt) : Float32Array.from(pts), seen: sec }));
  prev.forEach((t, j) => {
    if (!match.includes(j) && Math.abs(sec - t.seen) < FACE_HOLD) out.push(t);
  });
  return out;
}

/* Face shape ----------------------------------------------------------------- */

/**
 * A warp handle: inside the ellipse given by m (rows mapping an offset from
 * the center c to the unit circle) the picture moves by d and is scaled by
 * 1 + s around c, both fading to nothing at the edge.
 */
const circle = (c, r, d, s = 0) => ({ c, m: [1 / r, 0, 0, 1 / r], d, s });
const ellipse = (c, ax, ra, ay, rb, d, s = 0) => ({ c, m: [ax[0] / ra, ax[1] / ra, ay[0] / rb, ay[1] / rb], d, s });

/** Falloff of a handle at squared normalized distance r2 (smooth to the edge). */
export const handleWeight = (r2) => (r2 >= 1 ? 0 : (1 - r2) * (1 - r2));

/**
 * Warp handles for one face. amounts: slim, eyes, nose, smile, chin, each
 * -1..1 (0 leaves that part alone).
 */
export function faceHandles(pts, amounts) {
  const { ux, uy, width: fw } = faceFrame(pts);
  const out = [];
  const along = (v, k) => [v[0] * k, v[1] * k];
  const { slim = 0, eyes = 0, nose = 0, smile = 0, chin = 0 } = amounts;
  if (slim) {
    // Cheeks and jaw move toward the middle, most at the jaw corner.
    const weights = [0.45, 0.8, 1, 0.75];
    const r = fw * 0.3;
    const k = slim * fw * 0.06;
    LM.jawA.forEach((i, n) => out.push(circle(P(pts, i), r, along(ux, k * weights[n]))));
    LM.jawB.forEach((i, n) => out.push(circle(P(pts, i), r, along(ux, -k * weights[n]))));
  }
  if (eyes) {
    for (const [iris, a, b] of [[LM.irisA, 33, 133], [LM.irisB, 263, 362]]) {
      const ew = dist(P(pts, a), P(pts, b)) || fw * 0.2;
      out.push(ellipse(P(pts, iris), ux, ew * 0.95, uy, ew * 0.75, [0, 0], eyes * 0.27));
    }
  }
  if (nose) {
    const a = P(pts, LM.alaA);
    const b = P(pts, LM.alaB);
    const nw = dist(a, b) || fw * 0.25;
    const r = nw * 0.5;
    const k = nose * nw * 0.14;
    out.push(circle(a, r, along(ux, k)), circle(b, r, along(ux, -k)));
    out.push(circle(P(pts, LM.wingA), r * 0.9, along(ux, k * 0.6)), circle(P(pts, LM.wingB), r * 0.9, along(ux, -k * 0.6)));
  }
  if (smile) {
    const a = P(pts, LM.mouthA);
    const b = P(pts, LM.mouthB);
    const mw = dist(a, b) || fw * 0.35;
    const r = mw * 0.34;
    const up = smile * mw * 0.1;
    const outw = smile * mw * 0.02;
    out.push(circle(a, r, [-uy[0] * up - ux[0] * outw, -uy[1] * up - ux[1] * outw]));
    out.push(circle(b, r, [-uy[0] * up + ux[0] * outw, -uy[1] * up + ux[1] * outw]));
  }
  if (chin) {
    const c = P(pts, LM.chin);
    const reach = dist(c, P(pts, LM.lowerLip)) || fw * 0.2;
    out.push(ellipse(c, ux, fw * 0.36, uy, reach * 1.3, along(uy, chin * reach * 0.38)));
  }
  return out;
}

/**
 * The warp of a frame: handles of the chosen faces ('all' or 'largest') in
 * face groups, each with a bounding circle (cx, cy, reach) and its handle
 * range, so the shader can skip faces far from a pixel.
 */
export function warpPlan(faces, amounts, which = 'all') {
  let list = faces || [];
  if (which === 'largest' && list.length > 1) list = [list.reduce((a, b) => (faceWidth(b) > faceWidth(a) ? b : a))];
  const handles = [];
  const groups = [];
  for (const pts of list) {
    const hs = faceHandles(pts, amounts);
    if (!hs.length) continue;
    const center = faceCenter(pts);
    let reach = 0;
    for (const h of hs) {
      // The largest radius of the ellipse is 1 / the smallest singular value of m; bound it by the row norms.
      const ra = 1 / Math.min(Math.hypot(h.m[0], h.m[1]), Math.hypot(h.m[2], h.m[3]));
      reach = Math.max(reach, dist(center, h.c) + ra);
    }
    groups.push({ cx: center[0], cy: center[1], reach, first: handles.length, end: handles.length + hs.length });
    handles.push(...hs);
  }
  return { handles, groups };
}

/** Offset of the warp at (x, y): the picture there is sampled from (x - dx, y - dy). */
export function warpOffset(handles, x, y) {
  let dx = 0;
  let dy = 0;
  for (const h of handles) {
    const rx = x - h.c[0];
    const ry = y - h.c[1];
    const qx = h.m[0] * rx + h.m[1] * ry;
    const qy = h.m[2] * rx + h.m[3] * ry;
    const w = handleWeight(qx * qx + qy * qy);
    if (!w) continue;
    dx += (h.d[0] + rx * h.s) * w;
    dy += (h.d[1] + ry * h.s) * w;
  }
  return [dx, dy];
}

/** Handles as texture rows (RGBA float, one column per handle): center + move, shape matrix, scale. */
export function packHandles(handles) {
  const n = handles.length;
  const out = new Float32Array(Math.max(1, n) * 3 * 4);
  handles.forEach((h, i) => {
    out.set([h.c[0], h.c[1], h.d[0], h.d[1]], i * 4);
    out.set(h.m, (n + i) * 4);
    out[(2 * n + i) * 4] = h.s;
  });
  return out;
}

/* Region masks --------------------------------------------------------------- */

/**
 * Antialiased polygon coverage (even-odd, four sub-rows per pixel, exact
 * along each row) written into buf (w x h, 0..1): mode 'add' keeps the
 * larger value, 'cut' removes the polygon. poly: flat x, y pairs in buffer
 * pixels.
 */
export function fillPolygon(buf, w, h, poly, mode = 'add') {
  const n = poly.length / 2;
  if (n < 3) return buf;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < poly.length; i += 2) {
    y0 = Math.min(y0, poly[i]);
    y1 = Math.max(y1, poly[i]);
  }
  const ja = clamp(Math.floor(y0), 0, h);
  const jb = clamp(Math.ceil(y1), 0, h);
  const row = new Float32Array(w);
  const xs = [];
  for (let j = ja; j < jb; j++) {
    let lo = w;
    let hi = -1;
    for (let s = 0; s < 4; s++) {
      const sy = j + (s + 0.5) / 4;
      xs.length = 0;
      for (let i = 0; i < n; i++) {
        const ay = poly[i * 2 + 1];
        const k = i + 1 === n ? 0 : i + 1;
        const by = poly[k * 2 + 1];
        if ((ay <= sy) !== (by <= sy)) {
          const ax = poly[i * 2];
          xs.push(ax + ((sy - ay) / (by - ay)) * (poly[k * 2] - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = clamp(xs[k], 0, w);
        const xb = clamp(xs[k + 1], 0, w);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.min(w - 1, Math.floor(xb));
        lo = Math.min(lo, ia);
        hi = Math.max(hi, ib);
        for (let i = ia; i <= ib; i++) row[i] += (Math.min(xb, i + 1) - Math.max(xa, i)) * 0.25;
      }
    }
    if (hi < lo) continue;
    const o = j * w;
    for (let i = lo; i <= hi; i++) {
      const v = Math.min(1, row[i]);
      row[i] = 0;
      if (mode === 'cut') buf[o + i] *= 1 - v;
      else if (v > buf[o + i]) buf[o + i] = v;
    }
  }
  return buf;
}

/**
 * Two passes of a separable box blur of radius r (about a Gaussian), in
 * place. box = [x0, y0, x1, y1] limits it to where something was drawn
 * (it grows by the blur's reach).
 */
export function blurMask(buf, w, h, r, box = null) {
  r = Math.round(r);
  if (r < 1) return buf;
  const reach = 2 * r + 1;
  const x0 = box ? clamp(Math.floor(box[0]) - reach, 0, w) : 0;
  const y0 = box ? clamp(Math.floor(box[1]) - reach, 0, h) : 0;
  const x1 = box ? clamp(Math.ceil(box[2]) + reach, 0, w) : w;
  const y1 = box ? clamp(Math.ceil(box[3]) + reach, 0, h) : h;
  if (x1 <= x0 || y1 <= y0) return buf;
  const line = new Float32Array(Math.max(w, h) + 2 * r);
  const norm = 1 / (2 * r + 1);
  // One line (len samples, stride apart from base) through a running sum, edges held.
  const pass = (base, len, stride) => {
    for (let i = 0; i < len; i++) line[i + r] = buf[base + i * stride];
    const first = line[r];
    const last = line[r + len - 1];
    for (let i = 0; i < r; i++) {
      line[i] = first;
      line[r + len + i] = last;
    }
    let acc = 0;
    for (let i = 0; i <= 2 * r; i++) acc += line[i];
    for (let i = 0; i < len; i++) {
      buf[base + i * stride] = acc * norm;
      if (i + 1 < len) acc += line[i + 2 * r + 1] - line[i];
    }
  };
  for (let t = 0; t < 2; t++) {
    for (let y = y0; y < y1; y++) pass(y * w + x0, x1 - x0, 1);
    for (let x = x0; x < x1; x++) pass(y0 * w + x, y1 - y0, w);
  }
  return buf;
}

/** Bounds [x0, y0, x1, y1] of flat x, y polygons. */
export function bounds(polys) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      b[0] = Math.min(b[0], p[i]);
      b[1] = Math.min(b[1], p[i + 1]);
      b[2] = Math.max(b[2], p[i]);
      b[3] = Math.max(b[3], p[i + 1]);
    }
  }
  return b;
}

/** Points of a polygon scaled by k around their mean. */
export function scaled(pts, ids, k) {
  let cx = 0;
  let cy = 0;
  for (const i of ids) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  cx /= ids.length;
  cy /= ids.length;
  return ids.flatMap((i) => [cx + (pts[i * 2] - cx) * k, cy + (pts[i * 2 + 1] - cy) * k]);
}

/** Crescent under one eye: the lower lid, and the same line pushed down the face (less at the corners). */
function underEye(pts, lid, uy, eyeW) {
  const top = [];
  const bottom = [];
  lid.forEach((i, n) => {
    const t = Math.sin((Math.PI * n) / (lid.length - 1));
    const [x, y] = P(pts, i);
    const a = eyeW * (0.06 + 0.04 * t);
    const b = eyeW * (0.12 + 0.5 * t);
    top.push([x + uy[0] * a, y + uy[1] * a]);
    bottom.push([x + uy[0] * b, y + uy[1] * b]);
  });
  return [...top, ...bottom.reverse()].flat();
}

/** Ellipse polygon (16 points) with semi-axes ra along ax and rb along ay. */
export function ellipsePoly(c, ax, ra, ay, rb) {
  const out = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const u = Math.cos(a) * ra;
    const v = Math.sin(a) * rb;
    out.push(c[0] + ax[0] * u + ay[0] * v, c[1] + ax[1] * u + ay[1] * v);
  }
  return out;
}

/** Polygons (source pixels) of the regions the skin fixes work in, per face. */
export function faceRegions(pts) {
  const { ux, uy, width: fw } = faceFrame(pts);
  const ewA = dist(P(pts, 33), P(pts, 133)) || fw * 0.2;
  const ewB = dist(P(pts, 263), P(pts, 362)) || fw * 0.2;
  const nose = mid(P(pts, LM.alaA), P(pts, LM.alaB));
  const nw = dist(P(pts, LM.alaA), P(pts, LM.alaB)) || fw * 0.25;
  const base = P(pts, LM.noseBase);
  const nc = [(nose[0] + base[0]) / 2, (nose[1] + base[1]) / 2];
  return {
    skin: [scaled(pts, LM.oval, 0.93)],
    features: [
      scaled(pts, LM.eyeA, 1.7),
      scaled(pts, LM.eyeB, 1.7),
      scaled(pts, LM.browA, 1.35),
      scaled(pts, LM.browB, 1.35),
      scaled(pts, LM.lipsOuter, 1.2),
      ellipsePoly(nc, ux, nw * 0.68, uy, nw * 0.42),
    ],
    underEye: [underEye(pts, LM.lowerLidA, uy, ewA), underEye(pts, LM.lowerLidB, uy, ewB)],
    lips: LM.lipsOuter.flatMap((i) => P(pts, i)),
    mouth: LM.lipsInner.flatMap((i) => P(pts, i)),
    width: fw,
  };
}

/**
 * Where region masks for the faces of a frame sit: rect = [x, y, w, h] of
 * the source around the face ovals (padded), drawn at width x height with
 * to(poly) mapping source polygons into it and k its scale. null without
 * faces or when they are off the picture.
 */
export function maskFrame(faces, srcW, srcH, maxSide = 384) {
  if (!faces?.length) return null;
  const b = bounds(faces.map((pts) => LM.oval.flatMap((i) => P(pts, i))));
  const pad = (b[2] - b[0]) * 0.08 + 4;
  const x0 = clamp(Math.floor(b[0] - pad), 0, srcW);
  const y0 = clamp(Math.floor(b[1] - pad), 0, srcH);
  const x1 = clamp(Math.ceil(b[2] + pad), 0, srcW);
  const y1 = clamp(Math.ceil(b[3] + pad), 0, srcH);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const k = Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0));
  const width = Math.max(2, Math.ceil((x1 - x0) * k));
  const height = Math.max(2, Math.ceil((y1 - y0) * k));
  const to = (poly) => poly.map((v, i) => (i % 2 ? (v - y0) * k : (v - x0) * k));
  return { rect: [x0, y0, x1 - x0, y1 - y0], width, height, k, to };
}

/** Four 0..1 channels (w x h) as RGBA bytes. */
export function packChannels(ch, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = ch[c] ? Math.round(clamp(ch[c][i], 0, 1) * 255) : 0;
  }
  return data;
}

/**
 * Region masks of the skin fixes for the faces of a frame, as RGBA bytes
 * (rows top first) over rect = [x, y, w, h] of the source: R skin where
 * spots are cleared (the face without eyes, brows, lips and nostrils), G
 * under the eyes, B the lips, A inside the mouth. null without faces.
 */
export function faceMasks(faces, srcW, srcH, { maxSide = 384 } = {}) {
  const frame = maskFrame(faces, srcW, srcH, maxSide);
  if (!frame) return null;
  const { width: w, height: h, k, to } = frame;
  const ch = [0, 1, 2, 3].map(() => new Float32Array(w * h));
  const drawn = [[], [], [], []];
  let fw = 0;
  for (const r of faces.map(faceRegions)) {
    const skin = r.skin.map(to);
    const under = r.underEye.map(to);
    const lips = to(r.lips);
    const mouth = to(r.mouth);
    for (const p of skin) fillPolygon(ch[0], w, h, p);
    for (const p of r.features) fillPolygon(ch[0], w, h, to(p), 'cut');
    for (const p of under) fillPolygon(ch[1], w, h, p);
    fillPolygon(ch[2], w, h, lips);
    fillPolygon(ch[2], w, h, mouth, 'cut');
    fillPolygon(ch[3], w, h, mouth);
    drawn[0].push(...skin);
    drawn[1].push(...under);
    drawn[2].push(lips);
    drawn[3].push(mouth);
    fw = Math.max(fw, r.width * k);
  }
  [0.02, 0.035, 0.006, 0.004].forEach((f, c) => blurMask(ch[c], w, h, fw * f, bounds(drawn[c])));
  return { rect: frame.rect, width: w, height: h, data: packChannels(ch, w, h) };
}

/* Hair ----------------------------------------------------------------------- */

/**
 * Square (x, y, side in source pixels) around the heads of the faces, where
 * the hair model looks: from above the head to the shoulders. It moves and
 * grows in coarse steps so a steady head keeps the same square, letting the
 * matte be steadied between frames. null without faces.
 */
export function hairRegion(faces) {
  if (!faces?.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pts of faces) {
    const { center, width, height } = faceFrame(pts);
    const half = Math.max(width * 1.4, height * 1.25);
    const cy = center[1] - height * 0.15;
    x0 = Math.min(x0, center[0] - half);
    x1 = Math.max(x1, center[0] + half);
    y0 = Math.min(y0, cy - half);
    y1 = Math.max(y1, cy + half * 1.1);
  }
  const side = 2 ** (Math.round(Math.log2(Math.max(8, x1 - x0, y1 - y0)) * 8) / 8);
  const step = side / 32;
  const cx = Math.round((x0 + x1) / 2 / step) * step;
  const cy = Math.round((y0 + y1) / 2 / step) * step;
  return [cx - side / 2, cy - side / 2, side, side];
}

/* Blemishes ------------------------------------------------------------------ */

/** Samples on the ring of the spot test (LAYER_FS uses the same). */
export const SPOT_RING = 10;

/**
 * How much of a spot (0..1) the pixel at (x, y) of a one-channel image is:
 * it must be darker than every sample on a ring of radius r around it, so
 * small dark spots stand out while edges, shadows and thin lines (which
 * reach the ring) do not. lo..hi is the contrast that fades the test in.
 */
export function spotStrength(v, w, h, x, y, r, { lo = 0.012, hi = 0.045, phase = 0 } = {}) {
  const c = v[y * w + x];
  let mn = Infinity;
  for (let k = 0; k < SPOT_RING; k++) {
    const a = (k * Math.PI * 2) / SPOT_RING + phase;
    const sx = clamp(Math.round(x + Math.cos(a) * r), 0, w - 1);
    const sy = clamp(Math.round(y + Math.sin(a) * r), 0, h - 1);
    mn = Math.min(mn, v[sy * w + sx]);
  }
  return smoothstep(lo, hi, mn - c);
}

/** Search radius (source pixels) of the spot test for faces of width fw. */
export const spotRadius = (fw) => clamp(fw * 0.012, 1.5, 10);
