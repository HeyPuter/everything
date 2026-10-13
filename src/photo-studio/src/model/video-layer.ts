// Video layers. A video layer is a pixel layer whose `pixels` show one frame
// of its own frame sequence: frames of a footage file (decoded on demand and
// cached outside the document), blank frames, or frames altered by painting
// and filters. Altered frames are stored as tile grids in the document.
//
// Frame indices here are layer frames (at the layer's interpreted frame
// rate), not timeline frames; the timeline maps time to a layer frame.
//
// Placement: frames live in "layer space", whose origin sits at (x, y) in the
// document. Footage frames reach layer space through `matrix` and each altered
// frame through its own `alteredMatrix` entry (absent = identity, as for a
// layer that was only moved). Canvas edits and layer transforms carry every
// frame by composing these matrices (`transformVideo`); the frame shown is
// resampled through them when a time is placed, so all frames stay aligned
// and nothing is resampled more than once per placement.
import type { TileGrid } from './tiles';
import { applyMat3, homography, mat3Multiply, type Mat3 } from '../imaging/filters/warp';
import { validAudioSource, type AudioSource } from './audio-timeline';

export type VideoAlpha = 'straight' | 'premultiplied' | 'ignore';
export const videoAlphaModes: [VideoAlpha, string][] = [
  ['straight', 'Straight (unmatted)'],
  ['premultiplied', 'Premultiplied'],
  ['ignore', 'Ignore (opaque)'],
];
/** A footage file kept in the document's assets. */
export type VideoFootage = {
  asset: string;
  name: string;
  // Media type of the original file (the asset is stored as an opaque source).
  type: string;
  width: number;
  height: number;
  // Frames and frame rate as read from the file (or estimated).
  frames: number;
  fps: number;
};
export type VideoLayerData = {
  footage?: VideoFootage;
  // Where frame (0, 0) sits in the document at the current time.
  x: number;
  y: number;
  // Frame size in pixels.
  width: number;
  height: number;
  // Interpreted frame rate and alpha.
  fps: number;
  alpha: VideoAlpha;
  // Times the sequence plays inside its clip; 0 repeats until the clip ends.
  loops: number;
  // Frames in the sequence after inserts and deletes.
  frames: number;
  // Runs of [first footage frame, count]; -1 is a run of blank frames.
  // Absent: footage frames 0, 1, 2, … (or blank frames without footage).
  map?: [number, number][];
  // Painted or filtered frames by layer frame index; grids are relative to
  // (x, y).
  altered?: Record<string, TileGrid>;
  // Footage frame pixels → layer space (absent: identity).
  matrix?: Mat3;
  // Altered frame grid coordinates → layer space, per frame (absent: identity).
  alteredMatrix?: Record<string, Mat3>;
  // The footage's sound (same asset), played by the layer's linked audio clip.
  audio?: AudioSource;
  // The footage's sound is silent.
  muted?: true;
};

export const maxVideoFrames = 100_000;
export const blankFrame = -1;

/** A blank video layer sequence covering `frames` frames. */
export function blankVideo(width: number, height: number, frames: number, fps: number, x = 0, y = 0): VideoLayerData {
  return { x, y, width, height, fps, alpha: 'straight', loops: 1, frames: Math.max(1, Math.min(maxVideoFrames, Math.round(frames))) };
}
export function footageVideo(footage: VideoFootage, x = 0, y = 0): VideoLayerData {
  return { footage, x, y, width: footage.width, height: footage.height, fps: footage.fps, alpha: 'straight', loops: 1, frames: Math.max(1, footage.frames) };
}

/** The runs of a sequence, materialized. */
export function videoRuns(v: VideoLayerData): [number, number][] {
  if (v.map) return v.map.map(([a, n]) => [a, n]);
  if (!v.footage) return [[blankFrame, v.frames]];
  const real = Math.min(v.frames, v.footage.frames);
  const runs: [number, number][] = real > 0 ? [[0, real]] : [];
  if (v.frames > real) runs.push([blankFrame, v.frames - real]);
  return runs;
}
/** Merge neighbors that continue each other; drops empty runs. */
export function normalizeRuns(runs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, n] of runs) {
    if (n <= 0) continue;
    const last = out.at(-1);
    if (last && ((a === blankFrame && last[0] === blankFrame) || (a !== blankFrame && last[0] !== blankFrame && last[0] + last[1] === a))) last[1] += n;
    else out.push([a, n]);
  }
  return out;
}
/** Footage frame shown by layer frame `k`, or -1 for a blank frame. */
export function footageFrame(v: VideoLayerData, k: number): number {
  if (k < 0 || k >= v.frames) return blankFrame;
  if (!v.map) return v.footage && k < v.footage.frames ? k : blankFrame;
  let at = 0;
  for (const [a, n] of v.map) {
    if (k < at + n) return a === blankFrame ? blankFrame : a + (k - at);
    at += n;
  }
  return blankFrame;
}

// Keep the identity map implicit, so ordinary footage layers stay small.
function setRuns(v: VideoLayerData, runs: [number, number][]) {
  const norm = normalizeRuns(runs);
  v.frames = norm.reduce((s, [, n]) => s + n, 0);
  const implicit = videoRuns({ ...v, map: undefined });
  if (JSON.stringify(implicit) === JSON.stringify(norm)) delete v.map;
  else v.map = norm;
}
function splice(runs: [number, number][], k: number, remove: number, insert: [number, number][]) {
  // Split the run containing k so the edit starts on a run boundary.
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, n] of runs) {
    if (k > at && k < at + n) {
      const head = k - at;
      out.push([a, head], [a === blankFrame ? a : a + head, n - head]);
    } else out.push([a, n]);
    at += n;
  }
  // Find the run index at k and remove `remove` frames from there.
  let i = 0;
  at = 0;
  while (i < out.length && at < k) at += out[i++][1];
  let left = remove;
  while (left > 0 && i < out.length) {
    const [a, n] = out[i];
    if (n <= left) {
      out.splice(i, 1);
      left -= n;
    } else {
      out[i] = [a === blankFrame ? a : a + left, n - left];
      left = 0;
    }
  }
  out.splice(i, 0, ...insert);
  return out;
}
// Shift altered frames at or after `k` by `by` (dropping the removed ones).
function shiftAltered(v: VideoLayerData, k: number, by: number, removed = 0) {
  const shift = <T>(rec: Record<string, T> | undefined) => {
    if (!rec) return undefined;
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(rec)) {
      const i = Number(key);
      if (i < k) out[i] = value;
      else if (i >= k + removed) out[i + by] = value;
    }
    return Object.keys(out).length ? out : undefined;
  };
  v.altered = shift(v.altered);
  if (!v.altered) delete v.altered;
  v.alteredMatrix = shift(v.alteredMatrix);
  if (!v.alteredMatrix) delete v.alteredMatrix;
}

/** Insert a blank frame before layer frame `k`. */
export function insertBlankFrame(v: VideoLayerData, k: number) {
  if (v.frames >= maxVideoFrames) return false;
  k = Math.max(0, Math.min(v.frames, Math.round(k)));
  setRuns(v, splice(videoRuns(v), k, 0, [[blankFrame, 1]]));
  shiftAltered(v, k, 1);
  return true;
}
/** Insert a copy of frame `k` after it (an altered frame stays altered). */
export function duplicateFrame(v: VideoLayerData, k: number) {
  if (v.frames >= maxVideoFrames || k < 0 || k >= v.frames) return false;
  const src = footageFrame(v, k);
  const grid = v.altered?.[k];
  const m = v.alteredMatrix?.[k];
  setRuns(v, splice(videoRuns(v), k + 1, 0, [[src, 1]]));
  shiftAltered(v, k + 1, 1);
  if (grid) v.altered = { ...v.altered, [k + 1]: grid };
  if (m) v.alteredMatrix = { ...v.alteredMatrix, [k + 1]: m };
  return true;
}
/** Delete frame `k`; a sequence keeps at least one frame. */
export function deleteFrame(v: VideoLayerData, k: number) {
  if (v.frames <= 1 || k < 0 || k >= v.frames) return false;
  setRuns(v, splice(videoRuns(v), k, 1, []));
  shiftAltered(v, k, -1, 1);
  return true;
}

// ----- Placement -----

export const identity3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const translation = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
/** True for the identity (within rounding). */
export function isIdentity(m: Mat3 | undefined, eps = 1e-9) {
  return !m || m.every((v, i) => Math.abs(v / m[8] - identity3[i]) <= eps);
}
const clean = (m: Mat3): Mat3 | undefined => (isIdentity(m) ? undefined : m.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)) as Mat3);
/** Document matrix of a frame grid (grid coordinates → document). */
export function placementOf(v: VideoLayerData, altered: boolean, k = -1): Mat3 {
  const m = altered ? v.alteredMatrix?.[k] : v.matrix;
  return m ? mat3Multiply(translation(v.x, v.y), m) : translation(v.x, v.y);
}
/** Carry every frame of a video layer through a document transform `g`
 * (projective). The new origin is the mapped origin rounded to whole pixels;
 * what remains goes into the frame matrices. */
export function transformVideo(v: VideoLayerData, g: Mat3): VideoLayerData {
  const p = applyMat3(g, v.x, v.y);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return v;
  const x = Math.round(p.x),
    y = Math.round(p.y);
  const c = mat3Multiply(mat3Multiply(translation(-x, -y), g), translation(v.x, v.y));
  const out: VideoLayerData = { ...v, x, y };
  const matrix = clean(v.matrix ? mat3Multiply(c, v.matrix) : c);
  if (matrix) out.matrix = matrix;
  else delete out.matrix;
  const altered: Record<string, Mat3> = {};
  for (const k of Object.keys(v.altered ?? {})) {
    const a = v.alteredMatrix?.[k];
    const m = clean(a ? mat3Multiply(c, a) : c);
    if (m) altered[k] = m;
  }
  if (Object.keys(altered).length) out.alteredMatrix = altered;
  else delete out.alteredMatrix;
  return out;
}
/** The projective matrix of a point map, fitted on four points of a
 * `width` x `height` area (exact for affine and projective maps). */
export function matrixOfMap(f: (x: number, y: number) => [number, number], width: number, height: number): Mat3 {
  const w = Math.max(1, width),
    h = Math.max(1, height);
  const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const dst = src.map((p) => {
    const [x, y] = f(p.x, p.y);
    return { x, y };
  });
  return homography(src, dst);
}

/** Layer frame shown `seconds` into the clip's content, honoring loops; the
 * last frame holds after the last loop. */
export function frameAtSeconds(v: VideoLayerData, seconds: number) {
  const n = Math.max(1, v.frames);
  let k = Math.floor(seconds * v.fps + 1e-6);
  if (k < 0) k = 0;
  if (v.loops > 0 && k >= n * v.loops) return n - 1;
  return k % n;
}
/** Length of the sequence (all loops) in seconds; Infinity when it repeats forever. */
export const videoSeconds = (v: VideoLayerData) => (v.loops > 0 ? (v.frames * v.loops) / v.fps : Infinity);

/** Apply an alpha interpretation to decoded RGBA in place. */
export function interpretAlpha(data: Uint8ClampedArray, mode: VideoAlpha) {
  if (mode === 'straight') return data;
  for (let i = 0; i < data.length; i += 4) {
    if (mode === 'ignore') data[i + 3] = 255;
    else {
      const a = data[i + 3];
      if (a === 0 || a === 255) continue;
      // Colors were stored multiplied by alpha: divide it back out.
      const k = 255 / a;
      // The clamped array rounds and clamps.
      data[i] *= k;
      data[i + 1] *= k;
      data[i + 2] *= k;
    }
  }
  return data;
}

// ----- Validation (projects) -----

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
export function validateVideoLayer(v: VideoLayerData, packed: (g: unknown) => boolean) {
  const bad = () => new Error('Invalid video layer.');
  if (!v || typeof v !== 'object' || ![v.x, v.y].every(finite) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.height < 1 || v.width > 8192 || v.height > 8192) throw bad();
  if (!finite(v.fps) || v.fps <= 0 || v.fps > 240 || !videoAlphaModes.some(([m]) => m === v.alpha) || !Number.isInteger(v.loops) || v.loops < 0 || v.loops > 10000) throw bad();
  if (!Number.isInteger(v.frames) || v.frames < 1 || v.frames > maxVideoFrames) throw bad();
  const f = v.footage;
  if (f !== undefined && (!f || typeof f.asset !== 'string' || !f.asset || typeof f.name !== 'string' || typeof f.type !== 'string' || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 || !Number.isInteger(f.frames) || f.frames < 0 || f.frames > maxVideoFrames || !finite(f.fps) || f.fps <= 0 || f.fps > 240))
    throw bad();
  if (v.map !== undefined) {
    if (!Array.isArray(v.map) || v.map.length > maxVideoFrames) throw bad();
    let total = 0;
    for (const r of v.map) {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[1] < 1 || r[0] < blankFrame) throw bad();
      total += r[1];
    }
    if (total !== v.frames) throw bad();
  }
  if (v.altered !== undefined) {
    if (!v.altered || typeof v.altered !== 'object' || Array.isArray(v.altered)) throw bad();
    for (const [k, g] of Object.entries(v.altered)) if (!/^\d+$/.test(k) || Number(k) >= v.frames || !packed(g)) throw bad();
  }
  if (v.audio !== undefined && !(validAudioSource(v.audio) && v.footage && v.audio.asset === v.footage.asset)) throw bad();
  if (v.muted !== undefined && v.muted !== true) throw bad();
  const mat = (m: unknown) => Array.isArray(m) && m.length === 9 && m.every(finite) && m[8] !== 0;
  if (v.matrix !== undefined && !mat(v.matrix)) throw bad();
  if (v.alteredMatrix !== undefined) {
    if (!v.alteredMatrix || typeof v.alteredMatrix !== 'object' || Array.isArray(v.alteredMatrix)) throw bad();
    for (const [k, m] of Object.entries(v.alteredMatrix)) if (!v.altered?.[k] || !mat(m)) throw bad();
  }
}
