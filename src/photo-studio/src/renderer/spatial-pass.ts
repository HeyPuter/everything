import type { Backend, Texture } from './backend';
import { spatialGeometry } from '../imaging/adjust/spatial';
import { MAX_LIGHTS, prepareLights, relightGeometry, type RelightParams } from '../imaging/relight/model';

// Spatial adjustment layers on the GPU: the pass sequence of
// src/imaging/adjust/spatial.ts run with the filter shaders. Reduced planes
// live in float scratch textures kept between frames (same document size,
// same textures).
export type SpatialFilter =
  // Clarity and dehaze as fractions in -1..1.
  | { type: 'clarity-dehaze'; clarity: number; dehaze: number }
  // Strength (code fraction), grain cell size in pixels, roughness and color 0..1.
  | { type: 'grain'; strength: number; cell: number; roughness: number; color: number }
  // Relight settings (normalized); see src/imaging/relight.
  | { type: 'relight'; params: RelightParams };

export class SpatialPasses {
  private scratch = new Map<string, Texture>();
  private size = '';
  private relightSize = '';
  constructor(private backend: Backend) {}
  private texture(width: number, height: number, slot: string) {
    const key = `${width}x${height}:${slot}`;
    let t = this.scratch.get(key);
    if (!t) this.scratch.set(key, (t = this.backend.floatTexture(width, height)));
    return t;
  }
  /** Filters `source` (document sized) into `target` (same size). */
  run(source: Texture, filter: SpatialFilter, target: Texture, opts: { docMax: number; clampTop: boolean }) {
    const u = new Float32Array(16);
    const clamp = opts.clampTop ? 1 : 0;
    if (filter.type === 'relight') return this.relight(source, filter.params, target, clamp);
    if (filter.type === 'grain') {
      u.set([5, 0, 0, 0, filter.strength, filter.cell, filter.roughness, filter.color, clamp, 0, 0, 0]);
      this.backend.filterPass([source], u, target);
      return;
    }
    const g = spatialGeometry(source.width, source.height, opts.docMax);
    // Planes of another document size are no longer needed.
    const size = `${g.width}x${g.height}`;
    if (size !== this.size) this.dispose();
    this.size = size;
    const tex = (w: number, h: number, slot: string) => this.texture(w, h, slot);
    const clarity = filter.clarity !== 0,
      dehaze = filter.dehaze !== 0;
    let a = tex(g.width, g.height, 'a'),
      b = tex(g.width, g.height, 'b');
    const pass = (values: number[], from: Texture[], to: Texture) => {
      u.fill(0);
      u.set(values);
      this.backend.filterPass(from, u, to);
    };
    const swap = () => ([a, b] = [b, a]);
    pass([1, g.factor], [source], a);
    if (clarity || dehaze)
      for (const dir of [[1, 0], [0, 1]]) {
        pass([2, dir[0], dir[1], 0, g.sigmaC, clarity ? g.radiusC : 0, dehaze ? 1 : 0, g.radiusD], [a], b);
        swap();
      }
    if (dehaze)
      for (const dir of [[1, 0], [0, 1]]) {
        pass([2, dir[0], dir[1], 0, 0, 0, 2, g.radiusS, g.sigmaD], [a], b);
        swap();
      }
    // Atmospheric light: reduce the smoothed dark channel to one texel.
    let light = a;
    for (let level = 0; dehaze && (light.width > 1 || light.height > 1); level++) {
      const next = tex(Math.ceil(light.width / 16), Math.ceil(light.height / 16), `max${level}`);
      pass([3, 16], [light], next);
      light = next;
    }
    pass([4, g.factor, 0, 0, filter.clarity, filter.dehaze, clarity ? 1 : 0, dehaze ? 1 : 0, clamp], [source, a, light], target);
  }
  /** Relight: surface estimate on reduced planes (modes 1, 2, 6, 7, 8),
   * soft shadows (10), then shading at full size (9). The planes are
   * recomputed every frame: they cost a fraction of the full-size passes and
   * follow any edit below the layer without bookkeeping. */
  private relight(source: Texture, p: RelightParams, target: Texture, clamp: number) {
    const W = source.width,
      H = source.height;
    const g = relightGeometry(W, H, p, Math.max(W, H));
    const size = `${g.width}x${g.height}`;
    if (size !== this.relightSize) {
      for (const [key, t] of this.scratch)
        if (key.includes(':r')) {
          this.backend.destroy(t);
          this.scratch.delete(key);
        }
      this.relightSize = size;
    }
    const tex = (slot: string) => this.texture(g.width, g.height, `r${slot}`);
    const u = new Float32Array(96);
    const pass = (values: number[], from: Texture[], to: Texture) => {
      u.fill(0);
      u.set(values);
      this.backend.filterPass(from, u, to);
    };
    const f = g.factor;
    const reduced = tex('0'),
      tmp = tex('t');
    pass([1, f], [source], reduced);
    const blurred = [0, 1, 2].map((s) => {
      const out = tex(`b${s}`);
      pass([2, 1, 0, 0, g.sigmas[s], g.radii[s], 0, 0], [reduced], tmp);
      pass([2, 0, 1, 0, g.sigmas[s], g.radii[s], 0, 0], [tmp], out);
      return out;
    });
    const height = tex('h');
    pass([6, 0, 0, 0, ...g.weights, 0], blurred, height);
    pass([7, 1, 0, 0, g.sigmaS, g.radiusS, g.sigmaR, 0], [height], tmp);
    pass([7, 0, 1, 0, g.sigmaS, g.radiusS, g.sigmaR, 0], [tmp], height);
    const normals = tex('n');
    pass([8, 0, 0, 0, g.relief / f, g.relief], [height], normals);
    const lights = prepareLights(p, W, H).slice(0, MAX_LIGHTS);
    const shadows = p.shadows > 0 && lights.length > 0;
    const header = (mode: number) => {
      u.fill(0);
      u.set([mode, f, lights.length, clamp, p.ambient / 100, p.shadows / 100, g.shadowSteps, g.shadowStep, 0, 0, 0, 0, shadows ? 1 : 0, 0, 0, 0]);
      lights.forEach((l, k) => u.set([l.x, l.y, l.z, l.reach, l.r, l.g, l.b, l.wrap], 16 + 8 * k));
    };
    let shade = normals;
    if (shadows) {
      shade = tex('s');
      header(10);
      this.backend.filterPass([normals], u, shade);
    }
    header(9);
    this.backend.filterPass([source, normals, shade], u, target);
  }
  dispose() {
    this.relightSize = '';
    for (const t of this.scratch.values()) this.backend.destroy(t);
    this.scratch.clear();
  }
}
