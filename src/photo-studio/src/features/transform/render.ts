// Rendering of a source image through a transform frame (homography of its
// rectangle) or a mesh, shared by sessions, Transform Again and canvas ops.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument } from '../../model/document';
import { layerRGBA } from '../pixels';
import type { IRect, RGBA8 } from '../../imaging/types';
import { applyMat3, transformImage, type Mat3 } from '../../imaging/filters/warp';
import { meshWarp, type MeshGrid } from '../../imaging/filters/mesh';
import type { Interp } from '../../imaging/filters/sampling';
import { compose, flip, mapMesh, rectToQuad, rotate90, scaleM, translate, type Quad } from './math';

export type RenderOptions = {
  // Output pixels per document pixel (previews render reduced).
  scale?: number;
  method?: Interp;
  // Use exact pixel rearrangements for integer moves, quarter turns and flips.
  exact?: boolean;
  // Results are limited to one canvas size around this document's canvas.
  doc?: Pick<PhotoDocument, 'width' | 'height'>;
};
/** Render `src`, which covers the document rectangle `rect`, onto `quad` (or
 * through `mesh`, in document coordinates). The result rect is in scaled
 * document coordinates; undefined when nothing remains. */
export function renderFrame(src: RGBA8, rect: IRect, quad: Quad, mesh: MeshGrid | undefined, opts: RenderOptions = {}): { image: RGBA8; rect: IRect } | undefined {
  const scale = opts.scale ?? 1,
    method = opts.method ?? 'bicubic';
  const S = scaleM(scale, scale);
  const limit = opts.doc ? scaledLimit(opts.doc, scale) : undefined;
  if (mesh) {
    const r = meshWarp(src, mapMesh(S, mesh), method, limit ? { clip: limit } : {});
    return r.rect.width && r.rect.height ? r : undefined;
  }
  // Source pixels → document rectangle → frame → output scale.
  const H = compose(S, rectToQuad(rect, quad), translate(rect.x, rect.y), scaleM(rect.width / src.width, rect.height / src.height));
  if (opts.exact) {
    const fast = exactPlacement(src, H);
    if (fast) return fast;
  }
  let out = frameBounds(H, src.width, src.height);
  if (limit) out = intersect(out, limit);
  if (out.width <= 0 || out.height <= 0) return undefined;
  return { image: transformImage(src, H, out, method), rect: out };
}
/** Whole-pixel bounds of the transformed source. Corners within rounding
 * noise of a pixel edge stay on it: a solved homography maps an exact 2x
 * scale to 19.9999999, which would add a row of faint filter spill. */
export function frameBounds(m: Mat3, width: number, height: number): IRect {
  const pts = [applyMat3(m, 0, 0), applyMat3(m, width, 0), applyMat3(m, width, height), applyMat3(m, 0, height)];
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x = Math.floor(Math.min(...xs) + 1e-6),
    y = Math.floor(Math.min(...ys) + 1e-6);
  return { x, y, width: Math.ceil(Math.max(...xs) - 1e-6) - x, height: Math.ceil(Math.max(...ys) - 1e-6) - y };
}
export function intersect(a: IRect, b: IRect): IRect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
/** Off-canvas pixels survive a transform, but perspective toward the horizon
 * must not allocate without bound: keep one canvas size around the canvas. */
export function scaledLimit(doc: Pick<PhotoDocument, 'width' | 'height'>, s: number): IRect {
  const W = doc.width,
    H = doc.height;
  return { x: Math.floor(-W * s), y: Math.floor(-H * s), width: Math.ceil(3 * W * s), height: Math.ceil(3 * H * s) };
}
// Quarter-turn linear parts (y down, clockwise): [a, b, d, e] and turn count.
const TURNS: [number, number, number, number, number][] = [
  [1, 0, 0, 1, 0],
  [0, -1, 1, 0, 1],
  [-1, 0, 0, -1, 2],
  [0, 1, -1, 0, 3],
];
/** Integer translations, quarter turns and mirror images at unit scale are
 * pixel rearrangements; returns undefined for anything that needs resampling. */
export function exactPlacement(src: RGBA8, H: Mat3): { image: RGBA8; rect: IRect } | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (!near(H[6], 0) || !near(H[7], 0) || !near(H[8], 1)) return;
  const [a, b, , d, e] = H;
  for (const [ra, rb, rd, re, k] of TURNS)
    for (const mirrored of [false, true]) {
      // Mirroring first negates the first column of the turn.
      if (!near(a, mirrored ? -ra : ra) || !near(b, rb) || !near(d, mirrored ? -rd : rd) || !near(e, re)) continue;
      const p = applyMat3(H, 0, 0),
        q = applyMat3(H, src.width, src.height);
      const x = Math.min(p.x, q.x),
        y = Math.min(p.y, q.y);
      if (!near(x, Math.round(x)) || !near(y, Math.round(y))) return;
      const image = rotate90(mirrored ? flip(src, true) : src, k);
      return { image, rect: { x: Math.round(x), y: Math.round(y), width: image.width, height: image.height } };
    }
}

/** An embedded image layer rendered at its own resolution (filters applied,
 * masks and effects left out), for resampling it into a pixel layer. */
export async function imageLayerSource(e: Editor, l: Layer): Promise<RGBA8> {
  const sw = Math.max(1, Math.round(l.sourceWidth)),
    sh = Math.max(1, Math.round(l.sourceHeight));
  const plain: Layer = { ...l, transform: { x: 0, y: 0, width: sw, height: sh, rotation: 0 }, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: false, maskDisabled: false, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined };
  return layerRGBA(e, plain, { ...e.doc, width: sw, height: sh, layers: [plain] });
}
