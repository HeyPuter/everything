// Sequencer evaluation: renders the channel stack at a frame on the GPU compositor.
// Each strip produces a full-frame premultiplied image (source → crop/transform → colour →
// modifiers) that is blended over the channels below with its blend mode and opacity.
import type { SeqChannel, SequenceEditor, Strip } from './types';
import { Compositor, placementMatrix, isPixelExact, type Source, type Target } from './gpu';
import { renderStack, contentFrame, effectFac, effectInputs, findStrip, speedInputFrame, TRANSITIONS, activeAt, allStrips } from './strips';
import { getMovie, loadImage } from './media';
import { valueAt } from './fades';
import { hasRetiming, speedAt } from './retime';
import { drawTextStrip } from './text';
import type { RGBA8Image } from './scene';

export interface RenderOptions {
  /** output (render) resolution */
  W: number;
  H: number;
  /** scale of the composited image relative to the output resolution (preview size) */
  k: number;
  /** realtime playback: movies play live instead of seeking exact frames */
  live: boolean;
  fps: number;
  /** first frame of the scene (scene strip content frame 0) */
  sceneStart: number;
  /** renders the 3D scene for scene strips */
  sceneImage: (frame: number, cameraId: string | null, w: number, h: number) => Promise<RGBA8Image | null>;
  /** cancelled renders stop early (stale preview requests) */
  cancelled?: () => boolean;
}

export class Cancelled extends Error {}

let shared: Compositor | null = null;
/** The shared compositor (one WebGL2 context for previews and final renders). */
export function compositor(): Compositor {
  if (shared?.lost) shared = null;
  return (shared ??= new Compositor());
}

let textCanvas: HTMLCanvasElement | null = null;

export class SequencerRender {
  constructor(
    public comp: Compositor,
    public o: RenderOptions,
  ) {}

  private all: Strip[] = [];
  /** async loads that were not ready (preview shows a partial frame and re-renders later) */
  pending: Promise<unknown>[] = [];

  get Wk() {
    return Math.max(1, Math.round(this.o.W * this.o.k));
  }
  get Hk() {
    return Math.max(1, Math.round(this.o.H * this.o.k));
  }

  /** Render the editor's top level at `frame`; the caller releases the returned target. */
  async render(ed: SequenceEditor, frame: number): Promise<Target> {
    this.comp.resize(this.Wk, this.Hk);
    this.all = allStrips(ed.strips);
    return this.renderList(ed.strips, ed.channels, frame);
  }

  private check() {
    if (this.o.cancelled?.()) throw new Cancelled();
  }

  /** lists being rendered (innermost last): multicam selectors look up their source channel here */
  private lists: Strip[][] = [];

  async renderList(list: Strip[], channels: SeqChannel[] | undefined, frame: number): Promise<Target> {
    this.lists.push(list);
    try {
      return await this.renderListInner(list, channels, frame);
    } finally {
      this.lists.pop();
    }
  }

  private async renderListInner(list: Strip[], channels: SeqChannel[] | undefined, frame: number): Promise<Target> {
    const c = this.comp;
    let acc = c.acquire();
    c.clear(acc);
    for (const s of renderStack(list, channels, frame)) {
      this.check();
      let layer: Target | null;
      try {
        if (s.type === 'ADJUSTMENT') layer = this.finish(s, c.asSource(acc, this.o.W, this.o.H), true);
        else layer = await this.renderStrip(s, frame);
      } catch (e) {
        if (e instanceof Cancelled) {
          c.release(acc);
          throw e;
        }
        console.warn('sequencer: strip failed', s.name, e);
        layer = null;
      }
      if (!layer) continue;
      const out = c.acquire();
      c.blend(out, acc, layer, s.blend_type, valueAt(s, 'blend_alpha', frame));
      c.release(acc);
      c.release(layer);
      acc = out;
    }
    return acc;
  }

  /** A strip's full-frame image at `frame` (null if it produces nothing). */
  async renderStrip(s: Strip, frame: number): Promise<Target | null> {
    const c = this.comp;
    const o = this.o;
    switch (s.type) {
      case 'COLOR': {
        const t = c.acquire();
        const [r, g, b] = s.color ?? [0.5, 0.5, 0.5];
        c.fill(t, [r, g, b, 1]);
        return this.finish(s, c.asSource(t, o.W, o.H), true, t);
      }
      case 'TEXT': {
        textCanvas ??= document.createElement('canvas');
        const tc = textCanvas;
        if (tc.width !== this.Wk || tc.height !== this.Hk) {
          tc.width = this.Wk;
          tc.height = this.Hk;
        }
        const g = tc.getContext('2d')!;
        g.clearRect(0, 0, tc.width, tc.height);
        drawTextStrip(g, s, tc.width, tc.height, o.k);
        const src = c.upload(tc, o.W, o.H);
        const out = this.finish(s, src);
        c.dropSource(src);
        return out;
      }
      case 'IMAGE': {
        const el = s.elements?.length ? s.elements[Math.max(0, Math.min(s.elements.length - 1, contentFrame(s, frame)))] : null;
        const bytes = el?.bytes ?? s.media?.bytes;
        const mime = el?.mime ?? s.media?.mime ?? 'image/png';
        if (!bytes) return null;
        const bmp = await loadImage(bytes, mime);
        this.check();
        const src = c.cached(bmp, bmp, s.orig_width || bmp.width, s.orig_height || bmp.height);
        return this.finish(s, src);
      }
      case 'MOVIE': {
        if (!s.media) return null;
        const m = getMovie(s.media.bytes, s.media.mime);
        const t = (contentFrame(s, frame) + 0.5) / Math.max(1, o.fps);
        const info = await m.info.catch(() => null);
        if (!info) return null;
        const w = s.orig_width || info.width,
          h = s.orig_height || info.height;
        if (o.live) {
          const v = m.live(t, hasRetiming(s) ? Math.max(0.0625, Math.min(16, speedAt(s, frame - s.frame_start))) : 1);
          if (!v) return null;
          const src = c.upload(v, w, h);
          const out = this.finish(s, src);
          c.dropSource(src);
          return out;
        }
        const width = o.k < 1 ? Math.ceil(w * o.k) : 0;
        const bmp = await m.frame(t, width);
        this.check();
        if (!bmp) return null;
        const src = c.upload(bmp, w, h);
        const out = this.finish(s, src);
        c.dropSource(src);
        return out;
      }
      case 'SCENE': {
        const sf = o.sceneStart + contentFrame(s, frame);
        const img = await o.sceneImage(sf, s.scene_camera ?? null, this.Wk, this.Hk);
        this.check();
        if (!img) return null;
        const src = c.upload({ data: img.data, width: img.width, height: img.height, bottomUp: img.bottomUp }, o.W, o.H);
        const out = this.finish(s, src);
        c.dropSource(src);
        return out;
      }
      case 'META': {
        const t = await this.renderList(s.strips ?? [], s.channels, frame);
        return this.finish(s, c.asSource(t, o.W, o.H), true, t);
      }
      case 'MULTICAM': {
        // shows the strip of the source channel (below the selector) at this frame
        const list = this.lists[this.lists.length - 1] ?? [];
        const ch = s.multicam_source ?? 0;
        if (ch <= 0 || ch >= s.channel) return null;
        const src = list.find((x) => x.channel === ch && !x.mute && x.type !== 'SOUND' && activeAt(x, frame));
        const t = src ? await this.renderStrip(src, frame) : null;
        if (!t) return null;
        return this.finish(s, c.asSource(t, o.W, o.H), true, t);
      }
      case 'SOUND':
      case 'ADJUSTMENT':
        return null;
    }
    return this.renderEffect(s, frame);
  }

  private async input(name: string | null | undefined, frame: number): Promise<Target> {
    const s = name ? findStrip(this.all, name) : null;
    const t = s && !s.mute ? await this.renderStrip(s, frame) : null;
    if (t) return t;
    const e = this.comp.acquire();
    this.comp.clear(e);
    return e;
  }

  private async renderEffect(s: Strip, frame: number): Promise<Target | null> {
    const c = this.comp;
    const o = this.o;
    const out = c.acquire();
    if (s.type === 'SPEED') {
      const inp = findStrip(this.all, s.input_1);
      if (!inp) return (c.release(out), null);
      const t = await this.input(s.input_1, speedInputFrame(s, inp, frame));
      c.release(out);
      return this.finish(s, c.asSource(t, o.W, o.H), true, t);
    }
    if (s.type === 'TRANSFORM') {
      const a = await this.input(s.input_1, frame);
      const uniform = !!s.use_uniform_scale;
      const px = s.translation_unit === 'PERCENT';
      const M = placementMatrix(o.W, o.H, o.W, o.H, {
        offset_x: (s.translate_start_x ?? 0) * (px ? o.W / 100 : 1),
        offset_y: (s.translate_start_y ?? 0) * (px ? o.H / 100 : 1),
        scale_x: s.scale_start_x ?? 1,
        scale_y: uniform ? (s.scale_start_x ?? 1) : (s.scale_start_y ?? 1),
        rotation: ((s.rotation_start ?? 0) * Math.PI) / 180,
        origin: [0.5, 0.5],
      }, o.k);
      c.place(out, c.asSource(a, o.W, o.H), M, [0, 0, o.W, o.H], false, false, false);
      c.release(a);
      return this.finish(s, c.asSource(out, o.W, o.H), true, out);
    }
    if (s.type === 'GLOW') {
      const a = await this.input(s.input_1, frame);
      c.glow(out, a, s.threshold ?? 0.25, s.clamp ?? 1, s.boost_factor ?? 0.5, Math.max(0.01, (s.blur_radius ?? 3) * o.k), !!s.use_only_boost);
      c.release(a);
      return this.finish(s, c.asSource(out, o.W, o.H), true, out);
    }
    if (s.type === 'GAUSSIAN_BLUR') {
      const a = await this.input(s.input_1, frame);
      const sx = (s.size_x ?? 0) * o.k * 0.5,
        sy = (s.size_y ?? 0) * o.k * 0.5;
      if (sx <= 0 && sy <= 0) c.copy(out, a);
      else c.blur(out, a, Math.max(0.01, sx), Math.max(0.01, sy));
      c.release(a);
      return this.finish(s, c.asSource(out, o.W, o.H), true, out);
    }
    // two-input effects
    const a = await this.input(s.input_1, frame);
    const b = await this.input(s.input_2, frame);
    let fac: number;
    if (TRANSITIONS.includes(s.type)) fac = effectFac(s, frame);
    else if (s.type === 'COLORMIX') fac = s.factor ?? 1;
    else fac = s.use_default_fade ? 1 : s.effect_fader;
    c.effect(out, a, b, s.type, fac, {
      mix: s.blend_effect,
      wipe: s.type === 'WIPE' ? { type: ['SINGLE', 'DOUBLE', 'IRIS', 'CLOCK'].indexOf(s.transition_type ?? 'SINGLE'), dir: s.direction === 'IN' ? 1 : 0, angle: s.angle ?? 0, blur: s.blur_width ?? 0 } : undefined,
    });
    c.release(a);
    c.release(b);
    return this.finish(s, c.asSource(out, o.W, o.H), true, out);
  }

  /**
   * Place a source into the frame with the strip's crop/transform/flip, then apply colour
   * adjustments and modifiers. `owned` is a target to release once consumed.
   */
  finish(s: Strip, src: Source, fullFrame = false, owned?: Target): Target {
    const c = this.comp;
    const o = this.o;
    const t = s.transform;
    const cr = s.crop;
    const identity = fullFrame && t.offset_x === 0 && t.offset_y === 0 && t.scale_x === 1 && t.scale_y === 1 && t.rotation === 0 && !cr.min_x && !cr.max_x && !cr.min_y && !cr.max_y && !s.use_flip_x && !s.use_flip_y;
    let img: Target;
    if (identity && owned) img = owned;
    else {
      img = c.acquire();
      const M = placementMatrix(o.W, o.H, src.w, src.h, t, o.k);
      const nearest = t.filter === 'NEAREST' || (t.filter === 'AUTO' && isPixelExact(M));
      c.place(img, src, M, [cr.min_x, cr.min_y, src.w - cr.max_x, src.h - cr.max_y], s.use_flip_x, s.use_flip_y, nearest);
      if (owned) c.release(owned);
    }
    if (s.color_saturation !== 1 || s.color_multiply !== 1) {
      const n = c.acquire();
      c.stripColor(n, img, s.color_saturation, s.color_multiply, s.multiply_alpha);
      c.release(img);
      img = n;
    }
    for (const m of s.modifiers ?? []) {
      if (m.mute) continue;
      const n = c.acquire();
      if (m.type === 'COLOR_BALANCE' && m.color_balance) c.colorBalance(n, img, m.color_balance, m.color_multiply ?? 1);
      else if (m.type === 'BRIGHT_CONTRAST') c.brightContrast(n, img, m.bright ?? 0, m.contrast ?? 0);
      else {
        c.release(n);
        continue;
      }
      c.release(img);
      img = n;
    }
    return img;
  }
}

/** Visible strips in a list at a frame including inputs of active effects (for prefetching). */
export function activeVisualStrips(ed: SequenceEditor, frame: number): Strip[] {
  const all = allStrips(ed.strips);
  const out = new Set<Strip>();
  for (const s of all) if (activeAt(s, frame) && s.type !== 'SOUND') {
    out.add(s);
    for (const i of effectInputs(all, s)) out.add(i);
  }
  return [...out];
}

let lock: Promise<unknown> = Promise.resolve();
/** Serialise sequencer renders: the compositor's target pool is resized per render. */
export function withCompositor<T>(fn: (c: Compositor) => Promise<T>): Promise<T> {
  const run = lock.then(() => fn(compositor()));
  lock = run.catch(() => undefined);
  return run;
}
