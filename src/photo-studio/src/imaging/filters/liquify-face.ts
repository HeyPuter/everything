// Face-aware Liquify: a face guide (landmark points placed by detection or by
// hand) and named sliders that drive smooth, local warps anchored to those
// landmarks.
//
// Every slider becomes one elementary warp (move, scale or rotate a region with
// a raised-cosine elliptical falloff). Each elementary warp is a one-to-one map
// as long as its amount stays inside the bound noted next to it, and the face
// warp is their composition, so no slider setting can fold the image over.
// Warps are inverse maps like the brush field: output point q shows the source
// at map(q). `bakeFaces` composes them with the brush field into the field that
// is rendered (brush strokes act on the face-edited image, frozen areas stay).
import type { IRect, Mask8 } from '../types';
import { LiquifyField } from './liquify';

export type Pt = { x: number; y: number };

/** Landmark names. Left and right are as seen in the picture. */
export const LANDMARKS = [
  'eyeL',
  'eyeR',
  'browL',
  'browR',
  'nose',
  'mouthL',
  'mouthR',
  'lipTop',
  'lipBottom',
  'chin',
  'jawL',
  'jawR',
  'forehead',
] as const;
export type LandmarkId = (typeof LANDMARKS)[number];
export type FaceLandmarks = Record<LandmarkId, Pt>;

export const LANDMARK_LABELS: Record<LandmarkId, string> = {
  eyeL: 'Left eye',
  eyeR: 'Right eye',
  browL: 'Left brow',
  browR: 'Right brow',
  nose: 'Nose tip',
  mouthL: 'Left mouth corner',
  mouthR: 'Right mouth corner',
  lipTop: 'Top of upper lip',
  lipBottom: 'Bottom of lower lip',
  chin: 'Chin',
  jawL: 'Left jaw',
  jawR: 'Right jaw',
  forehead: 'Hairline',
};

/** Eye sliders exist per eye and can be linked. */
export const EYE_SLIDERS = ['eyeSize', 'eyeHeight', 'eyeWidth', 'eyeTilt', 'eyeDistance'] as const;
export type EyeSlider = (typeof EYE_SLIDERS)[number];
export const FACE_SLIDERS = [
  'noseHeight',
  'noseWidth',
  'smile',
  'upperLip',
  'lowerLip',
  'mouthWidth',
  'mouthHeight',
  'forehead',
  'chinHeight',
  'jawline',
  'faceWidth',
] as const;
export type FaceSlider = (typeof FACE_SLIDERS)[number];
export type SliderKey = `${EyeSlider}L` | `${EyeSlider}R` | FaceSlider;

export const SLIDER_LABELS: Record<EyeSlider | FaceSlider, string> = {
  eyeSize: 'Eye Size',
  eyeHeight: 'Eye Height',
  eyeWidth: 'Eye Width',
  eyeTilt: 'Eye Tilt',
  eyeDistance: 'Eye Distance',
  noseHeight: 'Nose Height',
  noseWidth: 'Nose Width',
  smile: 'Smile',
  upperLip: 'Upper Lip',
  lowerLip: 'Lower Lip',
  mouthWidth: 'Mouth Width',
  mouthHeight: 'Mouth Height',
  forehead: 'Forehead',
  chinHeight: 'Chin Height',
  jawline: 'Jawline',
  faceWidth: 'Face Width',
};
export const SLIDER_GROUPS: { title: string; keys: (EyeSlider | FaceSlider)[] }[] = [
  { title: 'Eyes', keys: [...EYE_SLIDERS] },
  { title: 'Nose', keys: ['noseHeight', 'noseWidth'] },
  { title: 'Mouth', keys: ['smile', 'upperLip', 'lowerLip', 'mouthWidth', 'mouthHeight'] },
  { title: 'Face Shape', keys: ['forehead', 'chinHeight', 'jawline', 'faceWidth'] },
];

export type Face = {
  id: number;
  landmarks: FaceLandmarks;
  /** Slider values, -100..100; missing keys are 0. */
  sliders: Partial<Record<SliderKey, number>>;
  /** Eye sliders whose left and right values move together. */
  linked: Record<EyeSlider, boolean>;
  /** How the guide was placed. */
  source: 'manual' | 'detected' | 'ai';
};

export const SLIDER_MIN = -100;
export const SLIDER_MAX = 100;

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt) => Math.hypot(a.x, a.y);

/** The face's frame: origin between the eyes, u toward the right eye, v down
 * the face, D the distance between the eyes. */
export type FaceFrame = { o: Pt; u: Pt; v: Pt; D: number };
export function faceFrame(lm: Pick<FaceLandmarks, 'eyeL' | 'eyeR'>): FaceFrame {
  const d = sub(lm.eyeR, lm.eyeL);
  const D = Math.max(1e-3, len(d));
  const u = { x: d.x / D, y: d.y / D };
  return { o: mid(lm.eyeL, lm.eyeR), u, v: { x: -u.y, y: u.x }, D };
}
/** Point at frame coordinates (a, b), in units of the eye distance. */
export function framePoint(f: FaceFrame, a: number, b: number): Pt {
  return {
    x: f.o.x + (f.u.x * a + f.v.x * b) * f.D,
    y: f.o.y + (f.u.y * a + f.v.y * b) * f.D,
  };
}
/** Frame coordinates of an image point, in units of the eye distance. */
export function toFrame(f: FaceFrame, p: Pt): [number, number] {
  const d = sub(p, f.o);
  return [(d.x * f.u.x + d.y * f.u.y) / f.D, (d.x * f.v.x + d.y * f.v.y) / f.D];
}

// Average proportions of a frontal face, in eye distances from between the eyes.
const TEMPLATE: Record<LandmarkId, [number, number]> = {
  eyeL: [-0.5, 0],
  eyeR: [0.5, 0],
  browL: [-0.52, -0.34],
  browR: [0.52, -0.34],
  nose: [0, 0.66],
  mouthL: [-0.4, 1.05],
  mouthR: [0.4, 1.05],
  lipTop: [0, 0.95],
  lipBottom: [0, 1.17],
  chin: [0, 1.62],
  jawL: [-0.92, 1.05],
  jawR: [0.92, 1.05],
  forehead: [0, -1.05],
};
/** A face guide of average proportions from the two eye centers. */
export function templateFace(eyeL: Pt, eyeR: Pt): FaceLandmarks {
  if (eyeR.x < eyeL.x) [eyeL, eyeR] = [eyeR, eyeL];
  const f = faceFrame({ eyeL, eyeR });
  const out = {} as FaceLandmarks;
  for (const k of LANDMARKS) out[k] = framePoint(f, TEMPLATE[k][0], TEMPLATE[k][1]);
  out.eyeL = { ...eyeL };
  out.eyeR = { ...eyeR };
  return out;
}
/** A full guide from whatever landmarks are known (the eyes at least). Missing
 * points come from the template, stretched down the face to meet the known
 * mouth or chin. */
export function fitFace(
  known: Partial<FaceLandmarks> & Pick<FaceLandmarks, 'eyeL' | 'eyeR'>,
): FaceLandmarks {
  let { eyeL, eyeR } = known;
  if (eyeR.x < eyeL.x) [eyeL, eyeR] = [eyeR, eyeL];
  const f = faceFrame({ eyeL, eyeR });
  // Vertical stretch of the lower face from the mouth or chin, when known.
  let stretch = 1;
  const mouth = known.mouthL && known.mouthR ? mid(known.mouthL, known.mouthR) : undefined;
  if (mouth) stretch = toFrame(f, mouth)[1] / TEMPLATE.mouthL[1];
  else if (known.chin) stretch = toFrame(f, known.chin)[1] / TEMPLATE.chin[1];
  else if (known.nose) stretch = toFrame(f, known.nose)[1] / TEMPLATE.nose[1];
  stretch = Math.max(0.6, Math.min(1.6, stretch || 1));
  const out = {} as FaceLandmarks;
  for (const k of LANDMARKS) {
    const [a, b] = TEMPLATE[k];
    out[k] = known[k] ? { ...known[k]! } : framePoint(f, a, b > 0.2 ? b * stretch : b);
  }
  // Lips follow the known mouth corners.
  if (mouth && !known.lipTop) out.lipTop = add(mouth, mul(f.v, -0.1 * f.D));
  if (mouth && !known.lipBottom) out.lipBottom = add(mouth, mul(f.v, 0.12 * f.D));
  out.eyeL = { ...eyeL };
  out.eyeR = { ...eyeR };
  return out;
}

export function newFace(
  id: number,
  landmarks: FaceLandmarks,
  source: Face['source'] = 'manual',
): Face {
  const linked = {} as Record<EyeSlider, boolean>;
  for (const k of EYE_SLIDERS) linked[k] = true;
  return { id, landmarks, sliders: {}, linked, source };
}
export function cloneFace(f: Face): Face {
  const landmarks = {} as FaceLandmarks;
  for (const k of LANDMARKS) landmarks[k] = { ...f.landmarks[k] };
  return {
    id: f.id,
    landmarks,
    sliders: { ...f.sliders },
    linked: { ...f.linked },
    source: f.source,
  };
}
export function sliderValue(f: Face, key: SliderKey) {
  return f.sliders[key] ?? 0;
}
/** Set a slider (an eye slider also sets the other eye while linked). */
export function setSlider(f: Face, key: SliderKey, value: number) {
  const v = Math.round(Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, value)));
  const set = (k: SliderKey) => {
    if (v) f.sliders[k] = v;
    else delete f.sliders[k];
  };
  set(key);
  const m = /^(eye[A-Za-z]+)([LR])$/.exec(key);
  if (m && f.linked[m[1] as EyeSlider]) set(`${m[1]}${m[2] === 'L' ? 'R' : 'L'}` as SliderKey);
}
export function isNeutral(f: Face) {
  return Object.values(f.sliders).every((v) => !v);
}

// ----- Elementary warps -----

/** A local warp with an elliptical raised-cosine falloff centered at c, with
 * radii rx (along u) and ry (along v). */
export type WarpOp =
  | { kind: 'move'; c: Pt; u: Pt; rx: number; ry: number; t: Pt }
  | { kind: 'scale'; c: Pt; o: Pt; u: Pt; rx: number; ry: number; su: number; sv: number }
  | { kind: 'rotate'; c: Pt; u: Pt; rx: number; ry: number; a: number };

const falloff = (s: number) => (s >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * s));

/** Apply one inverse warp to (x, y) in place (out[0], out[1]). */
function applyOp(op: WarpOp, out: Float64Array) {
  const x = out[0],
    y = out[1];
  const dx = x - op.c.x,
    dy = y - op.c.y;
  const a = (dx * op.u.x + dy * op.u.y) / op.rx,
    b = (-dx * op.u.y + dy * op.u.x) / op.ry;
  const s2 = a * a + b * b;
  if (s2 >= 1) return;
  const w = falloff(Math.sqrt(s2));
  if (op.kind === 'move') {
    // Shows content from -t: the region appears moved by t.
    out[0] = x - op.t.x * w;
    out[1] = y - op.t.y * w;
  } else if (op.kind === 'scale') {
    // Scales about o along u and v; positive amounts enlarge.
    const ox = x - op.o.x,
      oy = y - op.o.y;
    const pu = ox * op.u.x + oy * op.u.y,
      pv = -ox * op.u.y + oy * op.u.x;
    const qu = pu * (1 - op.su * w),
      qv = pv * (1 - op.sv * w);
    out[0] = op.o.x + qu * op.u.x - qv * op.u.y;
    out[1] = op.o.y + qu * op.u.y + qv * op.u.x;
  } else {
    // Rotates the region by a (clockwise on screen for positive a).
    const t = -op.a * w,
      c = Math.cos(t),
      s = Math.sin(t);
    out[0] = op.c.x + dx * c - dy * s;
    out[1] = op.c.y + dx * s + dy * c;
  }
}

/** Image rectangle a warp can change. */
function opBounds(op: WarpOp): IRect {
  const ex = Math.hypot(op.rx * op.u.x, op.ry * op.u.y),
    ey = Math.hypot(op.rx * op.u.y, op.ry * op.u.x);
  const x0 = Math.floor(op.c.x - ex - 1),
    y0 = Math.floor(op.c.y - ey - 1);
  return {
    x: x0,
    y: y0,
    width: Math.ceil(op.c.x + ex + 1) - x0,
    height: Math.ceil(op.c.y + ey + 1) - y0,
  };
}

/** The elementary warps a face's sliders call for (only non-zero ones). Each
 * amount stays within the bound that keeps its warp one-to-one: a move by at
 * most half the smaller radius, a scale by at most 0.35 (0.25 off-center), a
 * rotation by any angle. */
export function faceOps(face: Face): WarpOp[] {
  const lm = face.landmarks;
  const f = faceFrame(lm);
  const { u, v, D } = f;
  const ops: WarpOp[] = [];
  const k = (key: SliderKey) => sliderValue(face, key) / 100;
  const move = (c: Pt, rx: number, ry: number, t: Pt) => {
    if (t.x || t.y) ops.push({ kind: 'move', c, u, rx: rx * D, ry: ry * D, t: mul(t, D) });
  };
  const scale = (c: Pt, o: Pt, rx: number, ry: number, su: number, sv: number) => {
    if (su || sv) ops.push({ kind: 'scale', c, o, u, rx: rx * D, ry: ry * D, su, sv });
  };
  const along = (a: number, b: number) => add(mul(u, a), mul(v, b));
  // Face shape first, then features: the inverse composition applies them in
  // this order to output points.
  const chinHeight = k('chinHeight');
  move(lm.chin, 0.55, 0.38, along(0, 0.15 * chinHeight));
  const forehead = k('forehead');
  move(lm.forehead, 0.95, 0.5, along(0, -0.2 * forehead));
  const jaw = k('jawline');
  move(lm.jawL, 0.42, 0.6, along(-0.12 * jaw, 0));
  move(lm.jawR, 0.42, 0.6, along(0.12 * jaw, 0));
  const fw = k('faceWidth');
  const centre = mid(f.o, lm.chin);
  const faceRx = Math.max(1, (len(sub(lm.jawR, lm.jawL)) / D) * 0.5 + 0.4);
  scale(
    centre,
    centre,
    faceRx,
    Math.max(1.1, len(sub(lm.chin, lm.forehead)) / D / 2 + 0.2),
    0.12 * fw,
    0,
  );
  // Mouth.
  const mouth = mid(lm.mouthL, lm.mouthR);
  const mw = Math.max(0.3, len(sub(lm.mouthR, lm.mouthL)) / D);
  scale(mouth, mouth, mw * 0.5 + 0.3, 0.36, 0.25 * k('mouthWidth'), 0);
  scale(mouth, mouth, mw * 0.5 + 0.2, 0.36, 0, 0.25 * k('mouthHeight'));
  const lipTopC = mid(lm.lipTop, mouth),
    lipBotC = mid(lm.lipBottom, mouth);
  scale(lipTopC, mouth, mw * 0.5 + 0.12, 0.2, 0, 0.25 * k('upperLip'));
  scale(lipBotC, mouth, mw * 0.5 + 0.12, 0.22, 0, 0.25 * k('lowerLip'));
  const smile = k('smile');
  move(lm.mouthL, 0.26, 0.24, along(-0.03 * smile, -0.09 * smile));
  move(lm.mouthR, 0.26, 0.24, along(0.03 * smile, -0.09 * smile));
  // Nose.
  const noseC = add(lm.nose, mul(v, -0.14 * D));
  move(noseC, 0.34, 0.5, along(0, -0.1 * k('noseHeight')));
  scale(add(lm.nose, mul(v, -0.05 * D)), lm.nose, 0.42, 0.4, 0.3 * k('noseWidth'), 0);
  // Eyes: side -1 is the left eye, +1 the right; "outward" points away from
  // the nose, so linked values move the eyes as mirror images.
  for (const [side, eye] of [
    [-1, lm.eyeL],
    [1, lm.eyeR],
  ] as const) {
    const S = side < 0 ? 'L' : 'R';
    const e = (key: EyeSlider) => k(`${key}${S}` as SliderKey);
    move(eye, 0.45, 0.4, along(side * 0.1 * e('eyeDistance'), -0.12 * e('eyeHeight')));
    const size = e('eyeSize');
    scale(eye, eye, 0.42, 0.42, 0.3 * size, 0.3 * size);
    scale(eye, eye, 0.5, 0.36, 0.3 * e('eyeWidth'), 0);
    const tilt = e('eyeTilt');
    // Positive tilt raises the outer corner.
    if (tilt)
      ops.push({ kind: 'rotate', c: eye, u, rx: 0.45 * D, ry: 0.42 * D, a: -side * 0.25 * tilt });
  }
  return ops;
}

/** Inverse map of a list of warps at (x, y): out = source point. */
export function mapOps(ops: WarpOp[], x: number, y: number, out = new Float64Array(2)) {
  out[0] = x;
  out[1] = y;
  for (const op of ops) applyOp(op, out);
  return out;
}
/** Image rectangle the warps can change, or null when there are none. */
export function opsBounds(ops: WarpOp[]): IRect | null {
  let r: IRect | null = null;
  for (const op of ops) r = unionRect(r, opBounds(op));
  return r;
}
export function unionRect(a: IRect | null, b: IRect | null): IRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** All faces' warps with their bounds, for fast skipping. */
export type FaceWarp = { ops: WarpOp[]; bounds: IRect }[];
export function faceWarp(faces: Face[]): FaceWarp {
  const out: FaceWarp = [];
  for (const f of faces) {
    const ops = faceOps(f);
    const bounds = opsBounds(ops);
    if (bounds) out.push({ ops, bounds });
  }
  return out;
}
export function faceWarpBounds(w: FaceWarp): IRect | null {
  let r: IRect | null = null;
  for (const g of w) r = unionRect(r, g.bounds);
  return r;
}

/**
 * Write the rendered field `out` = brush strokes composed with the face warps
 * for the nodes inside `rect` (all nodes when omitted):
 *   d(q) = b(q) + (1 - m(q)) * f(q + b(q))
 * where b is the brush field, f the face displacement and m the freeze mask.
 * With `pinEdges`, border nodes do not move across the image edge.
 */
export function bakeFaces(
  brush: LiquifyField,
  warp: FaceWarp,
  out: LiquifyField,
  rect?: IRect | null,
  freeze?: Mask8,
  pinEdges = false,
) {
  const cs = brush.cellSize,
    C = brush.cols,
    R = brush.rows;
  let i0 = 0,
    i1 = C - 1,
    j0 = 0,
    j1 = R - 1;
  if (rect) {
    i0 = Math.max(0, Math.floor(rect.x / cs) - 1);
    j0 = Math.max(0, Math.floor(rect.y / cs) - 1);
    i1 = Math.min(C - 1, Math.ceil((rect.x + rect.width) / cs) + 1);
    j1 = Math.min(R - 1, Math.ceil((rect.y + rect.height) / cs) + 1);
  }
  const t = new Float64Array(2);
  const W = brush.width,
    H = brush.height;
  for (let j = j0; j <= j1; j++) {
    const py = Math.min(j * cs, H);
    for (let i = i0; i <= i1; i++) {
      const k = j * C + i,
        px = Math.min(i * cs, W);
      let dx = brush.dx[k],
        dy = brush.dy[k];
      const sx = px + dx,
        sy = py + dy;
      for (const g of warp) {
        const b = g.bounds;
        if (sx < b.x || sy < b.y || sx > b.x + b.width || sy > b.y + b.height) continue;
        mapOps(g.ops, sx, sy, t);
        let m = 1;
        if (freeze) {
          const fx = Math.min(freeze.width - 1, Math.max(0, Math.round(px))),
            fy = Math.min(freeze.height - 1, Math.max(0, Math.round(py)));
          m = 1 - freeze.data[fy * freeze.width + fx] / 255;
        }
        dx += (t[0] - sx) * m;
        dy += (t[1] - sy) * m;
        break;
      }
      if (pinEdges) {
        if (i === 0 || i === C - 1 || px <= 0 || px >= W) dx = 0;
        if (j === 0 || j === R - 1 || py <= 0 || py >= H) dy = 0;
      }
      out.dx[k] = dx;
      out.dy[k] = dy;
    }
  }
}

/** Where source point p appears in the output of `field` (solves
 * q + d(q) = p by fixed-point iteration; exact enough for on-screen handles). */
export function forwardPoint(field: LiquifyField, p: Pt): Pt {
  const t = new Float64Array(2);
  let qx = p.x,
    qy = p.y;
  for (let n = 0; n < 8; n++) {
    field.displacementAt(qx, qy, t);
    qx = p.x - t[0];
    qy = p.y - t[1];
  }
  return { x: qx, y: qy };
}

// ----- Persistence -----

export function facesToJSON(faces: Face[]) {
  return faces.map((f) => ({ ...cloneFace(f) }));
}
/** Faces from saved JSON; drops anything malformed. */
export function facesFromJSON(v: unknown): Face[] {
  if (!Array.isArray(v)) return [];
  const out: Face[] = [];
  for (const raw of v) {
    const r = raw as Partial<Face>;
    if (!r || typeof r !== 'object' || !r.landmarks) continue;
    const lm = {} as FaceLandmarks;
    let ok = true;
    for (const k of LANDMARKS) {
      const p = (r.landmarks as Record<string, Pt>)[k];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) ok = false;
      else lm[k] = { x: p.x, y: p.y };
    }
    if (!ok) continue;
    const face = newFace(
      out.length + 1,
      lm,
      r.source === 'ai' || r.source === 'detected' ? r.source : 'manual',
    );
    for (const [key, val] of Object.entries(r.sliders ?? {}))
      if (Number.isFinite(val))
        face.sliders[key as SliderKey] = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, Number(val)));
    for (const key of EYE_SLIDERS)
      if (r.linked && typeof r.linked[key] === 'boolean') face.linked[key] = r.linked[key];
    out.push(face);
  }
  return out;
}
/** Faces mapped to an image scaled by (sx, sy). */
export function scaleFaces(faces: Face[], sx: number, sy: number): Face[] {
  return faces.map((f) => {
    const c = cloneFace(f);
    for (const k of LANDMARKS)
      c.landmarks[k] = { x: c.landmarks[k].x * sx, y: c.landmarks[k].y * sy };
    return c;
  });
}

// ----- Finding faces -----

/** Faces from a vision model's answer: JSON with points in 0..1000 of the
 * image (see `locateFaces`). Tolerates prose or code fences around the JSON,
 * {x, y} points and missing landmarks (filled in from the eyes); faces without
 * both eyes are dropped. */
export function parseFaceAnswer(text: string, width: number, height: number): FaceLandmarks[] {
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { faces?: unknown })?.faces;
  if (!Array.isArray(list)) return [];
  const point = (v: unknown): Pt | undefined => {
    let x: unknown, y: unknown;
    if (Array.isArray(v)) [x, y] = v;
    else if (v && typeof v === 'object') ({ x, y } = v as { x: unknown; y: unknown });
    const nx = Number(x),
      ny = Number(y);
    if (
      !Number.isFinite(nx) ||
      !Number.isFinite(ny) ||
      nx < -50 ||
      ny < -50 ||
      nx > 1050 ||
      ny > 1050
    )
      return;
    return { x: (nx / 1000) * width, y: (ny / 1000) * height };
  };
  const out: FaceLandmarks[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const known: Partial<FaceLandmarks> = {};
    for (const k of LANDMARKS) {
      const p = point((raw as Record<string, unknown>)[k]);
      if (p) known[k] = p;
    }
    if (!known.eyeL || !known.eyeR || len(sub(known.eyeR, known.eyeL)) < 2) continue;
    out.push(fitFace(known as Partial<FaceLandmarks> & Pick<FaceLandmarks, 'eyeL' | 'eyeR'>));
  }
  return out;
}

/** A face guide from a detector's box and its eye/nose/mouth points (any may
 * be missing): eyes from the points when present, else from the box. */
export function faceFromBox(
  box: IRect,
  points: { kind: 'eye' | 'nose' | 'mouth'; x: number; y: number }[],
): FaceLandmarks {
  const eyes = points.filter((p) => p.kind === 'eye').sort((a, b) => a.x - b.x);
  const eyeL =
    eyes.length >= 2 ? eyes[0] : { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
  const eyeR =
    eyes.length >= 2
      ? eyes[eyes.length - 1]
      : { x: box.x + box.width * 0.7, y: box.y + box.height * 0.4 };
  const known: Partial<FaceLandmarks> & Pick<FaceLandmarks, 'eyeL' | 'eyeR'> = {
    eyeL: { x: eyeL.x, y: eyeL.y },
    eyeR: { x: eyeR.x, y: eyeR.y },
  };
  const nose = points.find((p) => p.kind === 'nose');
  if (nose) known.nose = { x: nose.x, y: nose.y };
  return fitFace(known);
}

// ----- Mesh files -----

const MESH_MAGIC = [0x4c, 0x51, 0x4d, 0x31]; // "LQM1"
/** A saved mesh: image size, face guides with their settings, then the brush
 * field (`LiquifyField.serialize`). */
export function encodeMesh(field: LiquifyField, faces: Face[]): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ width: field.width, height: field.height, faces: facesToJSON(faces) }),
  );
  const pad = (4 - ((8 + json.length) % 4)) % 4;
  const body = field.serialize();
  const out = new Uint8Array(8 + json.length + pad + body.length);
  out.set(MESH_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(body, 8 + json.length + pad);
  return out;
}
export function decodeMesh(bytes: Uint8Array): { field: LiquifyField; faces: Face[] } {
  if (bytes.length < 8 || MESH_MAGIC.some((b, i) => bytes[i] !== b))
    throw new Error('This is not a Liquify mesh file.');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + n > bytes.length) throw new Error('The mesh file is damaged.');
  let meta: { faces?: unknown };
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  } catch {
    throw new Error('The mesh file is damaged.');
  }
  const pad = (4 - ((8 + n) % 4)) % 4;
  let field: LiquifyField;
  try {
    field = LiquifyField.deserialize(bytes.subarray(8 + n + pad));
  } catch {
    throw new Error('The mesh file is damaged.');
  }
  return { field, faces: facesFromJSON(meta.faces) };
}
/** The field resampled for an image of width × height (displacements scale
 * with the image). */
export function resampleField(
  src: LiquifyField,
  width: number,
  height: number,
  cellSize = src.cellSize,
): LiquifyField {
  const out = new LiquifyField(width, height, cellSize);
  const sx = src.width / out.width,
    sy = src.height / out.height;
  const t = new Float64Array(2);
  for (let j = 0; j < out.rows; j++)
    for (let i = 0; i < out.cols; i++) {
      src.displacementAt(i * out.cellSize * sx, j * out.cellSize * sy, t);
      const k = j * out.cols + i;
      out.dx[k] = t[0] / sx;
      out.dy[k] = t[1] / sy;
    }
  return out;
}
