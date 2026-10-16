// Plane tracks: a planar quad that follows a group of point tracks. Between consecutive frames
// the motion of the tracks they share is fitted with a homography, which carries the plane's
// corners from its keyframes (placed by the user) to every other frame.
import { homographyDLT, homographyError, homographyRansac, type UV } from './solve/geometry';
import { enabledMarkerAt, markerExact, type MovieClipData, type MovieTrackingPlaneMarker, type MovieTrackingPlaneTrack, type MovieTrackingTrack, type TrackingObjectData } from './types';
import type { Vec2 } from '../data/types';

export type Quad = [Vec2, Vec2, Vec2, Vec2];

export function newPlaneTrack(name: string, tracks: string[]): MovieTrackingPlaneTrack {
  return { name, tracks: [...tracks], markers: [], select: true, image: null, image_opacity: 1, use_auto_keying: false };
}

export function uniquePlaneName(o: TrackingObjectData, base: string) {
  const names = new Set((o.plane_tracks ?? []).map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Apply a row-major 3×3 homography to a point. */
export function applyH(H: ArrayLike<number>, p: ArrayLike<number>): Vec2 {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

/** Plane marker in effect at a frame: the exact one, else the nearest earlier (or first). */
export function planeMarkerAt(pt: MovieTrackingPlaneTrack, frame: number): MovieTrackingPlaneMarker | null {
  let best: MovieTrackingPlaneMarker | null = null;
  for (const m of pt.markers) {
    if (m.frame <= frame && (!best || m.frame > best.frame)) best = m;
  }
  return best ?? pt.markers[0] ?? null;
}

export function planeMarkerExact(pt: MovieTrackingPlaneTrack, frame: number) {
  return pt.markers.find((m) => m.frame === frame) ?? null;
}

export function insertPlaneMarker(pt: MovieTrackingPlaneTrack, m: MovieTrackingPlaneMarker) {
  const i = pt.markers.findIndex((x) => x.frame === m.frame);
  if (i >= 0) pt.markers[i] = m;
  else {
    pt.markers.push(m);
    pt.markers.sort((a, b) => a.frame - b.frame);
  }
}

/** Homography (pixel space) taking the tracks' positions on frame a to frame b, or null. */
export function trackHomography(clip: MovieClipData, tracks: MovieTrackingTrack[], a: number, b: number): number[] | null {
  const [W, H] = clip.size;
  const pa: UV[] = [],
    pb: UV[] = [];
  for (const t of tracks) {
    const ma = markerExact(t, a),
      mb = markerExact(t, b);
    if (!ma || !mb || ma.mute || mb.mute) continue;
    pa.push([(ma.co[0] + t.offset[0]) * W, (ma.co[1] + t.offset[1]) * H]);
    pb.push([(mb.co[0] + t.offset[0]) * W, (mb.co[1] + t.offset[1]) * H]);
  }
  if (pa.length < 4) return null;
  let Hm = pa.length > 6 ? (homographyRansac(pa, pb, 3, { iterations: 120, seed: a * 131 + b })?.H ?? null) : homographyDLT(pa, pb);
  if (!Hm) return null;
  // a least squares refit on the consistent tracks
  if (pa.length > 6) {
    const keep = pa.map((p, i) => homographyError(Hm!, p, pb[i]) < 3);
    const ref = homographyDLT(
      pa.filter((_, i) => keep[i]),
      pb.filter((_, i) => keep[i]),
    );
    if (ref) Hm = ref;
  }
  return Array.from(Hm);
}

function toPx(clip: MovieClipData, q: Quad): Vec2[] {
  return q.map((p) => [p[0] * clip.size[0], p[1] * clip.size[1]]);
}
function fromPx(clip: MovieClipData, q: Vec2[]): Quad {
  return q.map((p) => [p[0] / clip.size[0], p[1] / clip.size[1]]) as Quad;
}

/**
 * Recompute the computed (non-keyed) plane markers from the point tracks: each keyframe carries
 * its corners forwards and backwards frame by frame, halfway to the neighbouring keyframes or
 * until fewer than four tracks are shared between neighbouring frames.
 */
export function updatePlaneTrack(clip: MovieClipData, o: TrackingObjectData, pt: MovieTrackingPlaneTrack) {
  const tracks = pt.tracks.map((n) => o.tracks.find((t) => t.name === n)).filter((t): t is MovieTrackingTrack => !!t);
  const keys = pt.markers.filter((m) => m.is_keyed).sort((a, b) => a.frame - b.frame);
  if (!keys.length || !clip.size[0]) return;
  const last = Math.max(clip.frame_duration, ...tracks.flatMap((t) => t.markers.map((m) => m.frame)));
  const out = new Map<number, MovieTrackingPlaneMarker>();
  for (const k of keys) out.set(k.frame, k);
  const walk = (k: MovieTrackingPlaneMarker, dir: 1 | -1, stop: number) => {
    let corners = toPx(clip, k.corners);
    for (let f = k.frame + dir; dir > 0 ? f < stop : f > stop; f += dir) {
      if (f < 1 || f > last) break;
      const Hm = trackHomography(clip, tracks, f - dir, f);
      if (!Hm) break;
      corners = corners.map((p) => applyH(Hm, p));
      if (corners.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) break;
      if (!out.has(f) || !out.get(f)!.is_keyed) out.set(f, { frame: f, corners: fromPx(clip, corners), mute: false, is_keyed: false });
    }
  };
  // between two keyframes each one covers the half nearest to it
  keys.forEach((k, i) => {
    const next = keys[i + 1],
      prev = keys[i - 1];
    walk(k, 1, next ? Math.floor((k.frame + next.frame) / 2) + 1 : Infinity);
    walk(k, -1, prev ? Math.floor((prev.frame + k.frame) / 2) : -Infinity);
  });
  pt.markers = [...out.values()].sort((a, b) => a.frame - b.frame);
}

export function updatePlaneTracksOf(clip: MovieClipData, o: TrackingObjectData, only?: Set<string>) {
  for (const pt of o.plane_tracks ?? []) if (!only || pt.tracks.some((n) => only.has(n))) updatePlaneTrack(clip, o, pt);
}

/** Initial quad of a plane track: the bounding box of the tracks' markers at a frame. */
export function initialQuad(tracks: MovieTrackingTrack[], frame: number): Quad | null {
  const pts = tracks.map((t) => enabledMarkerAt(t, frame)).filter((m): m is NonNullable<typeof m> => !!m);
  if (pts.length < 4) return null;
  const xs = pts.map((m) => m.co[0]),
    ys = pts.map((m) => m.co[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Homography from the unit square (LL, LR, UR, UL) to a quad. */
export function squareToQuad(p: ArrayLike<number>[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p as number[][];
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2,
    dy2 = y3 - y2,
    dy3 = y0 - y1 + y2 - y3;
  let g = 0,
    hh = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    hh = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

/**
 * Rectified copy of the plane area of an RGBA frame (top-left origin rows) as RGBA pixels of
 * the given size; the plane's lower-left corner maps to the image's bottom-left.
 */
export function rectify(src: { width: number; height: number; data: Uint8ClampedArray }, quadPx: Vec2[], w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const Hm = squareToQuad(quadPx);
  const out = new Uint8ClampedArray(w * h * 4);
  const sw = src.width,
    sh = src.height,
    d = src.data;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [x, yUp] = applyH(Hm, [(i + 0.5) / w, 1 - (j + 0.5) / h]);
      // bottom-left pixel space → canvas rows
      const sx = x - 0.5,
        sy = sh - yUp - 0.5;
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy);
      const fx = sx - x0,
        fy = sy - y0;
      const k = (j * w + i) * 4;
      for (let c = 0; c < 4; c++) {
        const s = (xx: number, yy: number) => (xx >= 0 && yy >= 0 && xx < sw && yy < sh ? d[(yy * sw + xx) * 4 + c] : 0);
        const v = (s(x0, y0) * (1 - fx) + s(x0 + 1, y0) * fx) * (1 - fy) + (s(x0, y0 + 1) * (1 - fx) + s(x0 + 1, y0 + 1) * fx) * fy;
        out[k + c] = v;
      }
    }
  return out;
}
