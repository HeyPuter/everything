// Stereoscopy and multi-view rendering: render views (left / right eyes, or custom views that use
// cameras with a name suffix), per-camera stereo rigs, and combining two eyes into one image
// (anaglyph, interlaced, side-by-side, top-bottom). Pure functions; the render job and the Image
// Editor use them.
import type { CameraData, RenderSettings } from '../../data/types';

export interface SceneRenderView {
  name: string;
  /** suffix of the camera (and file) of this view, e.g. "_L" */
  camera_suffix: string;
  use: boolean;
}

export type StereoDisplayMode = 'ANAGLYPH' | 'INTERLACE' | 'SIDEBYSIDE' | 'TOPBOTTOM';
export type AnaglyphType = 'RED_CYAN' | 'GREEN_MAGENTA' | 'YELLOW_BLUE';
export type InterlaceType = 'ROW_INTERLEAVED' | 'COLUMN_INTERLEAVED' | 'CHECKERBOARD_INTERLEAVED';

/** How two eyes are combined into one image (output files and the Image Editor's stereo view). */
export interface Stereo3dFormat {
  display_mode: StereoDisplayMode;
  anaglyph_type: AnaglyphType;
  interlace_type: InterlaceType;
  use_interlace_swap: boolean;
  use_sidebyside_crosseyed: boolean;
  /** keep the frame size by squeezing each eye to half */
  use_squeezed_frame: boolean;
}

/** Scene render settings of multi-view rendering (merged into RenderSettings). */
export interface MultiviewSettings {
  use_multiview?: boolean;
  views_format?: 'STEREO_3D' | 'MULTIVIEW';
  views?: SceneRenderView[];
  active_view_index?: number;
  /** output: save each view to its own file, or the combined stereo image */
  image_views_format?: 'INDIVIDUAL' | 'STEREO_3D';
  stereo_3d_format?: Stereo3dFormat;
}

export interface CameraStereoData {
  convergence_mode: 'OFFAXIS' | 'PARALLEL' | 'TOE';
  /** distance at which the eyes' views coincide (zero parallax) */
  convergence_distance: number;
  interocular_distance: number;
  /** which eye sits at the camera position */
  pivot: 'LEFT' | 'RIGHT' | 'CENTER';
}

export function defaultCameraStereo(): CameraStereoData {
  return { convergence_mode: 'OFFAXIS', convergence_distance: 1.95, interocular_distance: 0.065, pivot: 'LEFT' };
}

export function defaultStereoFormat(): Stereo3dFormat {
  return { display_mode: 'ANAGLYPH', anaglyph_type: 'RED_CYAN', interlace_type: 'ROW_INTERLEAVED', use_interlace_swap: false, use_sidebyside_crosseyed: false, use_squeezed_frame: false };
}

export function defaultViews(): SceneRenderView[] {
  return [
    { name: 'left', camera_suffix: '_L', use: true },
    { name: 'right', camera_suffix: '_R', use: true },
  ];
}

/** Multi-view settings with every field present. */
export function multiview(r: RenderSettings): Required<MultiviewSettings> {
  const m = r as RenderSettings & MultiviewSettings;
  m.use_multiview ??= false;
  m.views_format ??= 'STEREO_3D';
  if (!m.views?.length) m.views = defaultViews();
  m.active_view_index ??= 0;
  m.image_views_format ??= 'INDIVIDUAL';
  m.stereo_3d_format = { ...defaultStereoFormat(), ...(m.stereo_3d_format ?? {}) };
  return m as Required<MultiviewSettings>;
}

/** Camera stereo rig with every field present. */
export function cameraStereo(ca: CameraData): CameraStereoData {
  const c = ca as CameraData & { stereo?: CameraStereoData };
  c.stereo = { ...defaultCameraStereo(), ...(c.stereo ?? {}) };
  return c.stereo;
}

/** A rendered view: its name, the eye it represents (stereo) and the camera suffix (multi-view). */
export interface RenderViewPlan {
  name: string;
  eye: 'left' | 'right' | null;
  suffix: string;
}

/**
 * Views a final render produces (empty when multi-view is off). Stereo 3D renders the left and
 * right eyes that are enabled; Multi-View renders every enabled view.
 */
export function renderViews(r: RenderSettings): RenderViewPlan[] {
  const m = r as RenderSettings & MultiviewSettings;
  if (!m.use_multiview) return [];
  const mv = multiview(r);
  if (mv.views_format === 'STEREO_3D') {
    const out: RenderViewPlan[] = [];
    const left = mv.views.find((v) => v.name === 'left');
    const right = mv.views.find((v) => v.name === 'right');
    if (left?.use !== false) out.push({ name: 'left', eye: 'left', suffix: left?.camera_suffix ?? '_L' });
    if (right?.use !== false) out.push({ name: 'right', eye: 'right', suffix: right?.camera_suffix ?? '_R' });
    return out;
  }
  return mv.views.filter((v) => v.use).map((v) => ({ name: v.name, eye: v.name === 'left' ? 'left' : v.name === 'right' ? 'right' : null, suffix: v.camera_suffix }));
}

/** Unique name for a new render view. */
export function uniqueViewName(views: SceneRenderView[], base = 'RenderView'): string {
  const names = new Set(views.map((v) => v.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/**
 * Placement of one eye relative to the camera: sideways offset (camera X, scene units), the
 * horizontal frustum shift at distance 1 (off-axis) and the inward rotation (toe-in, radians).
 */
export function eyeTransform(s: CameraStereoData, eye: 'left' | 'right'): { offset: number; shift: number; yaw: number } {
  const d = Math.max(0, s.interocular_distance);
  // eye positions relative to the camera, by pivot
  const left = s.pivot === 'LEFT' ? 0 : s.pivot === 'RIGHT' ? -d : -d / 2;
  const offset = eye === 'left' ? left : left + d;
  if (s.convergence_mode === 'PARALLEL') return { offset, shift: 0, yaw: 0 };
  // the convergence point lies on the axis through the middle between the eyes
  const centre = left + d / 2;
  const rel = offset - centre;
  const conv = Math.max(1e-4, s.convergence_distance);
  if (s.convergence_mode === 'TOE') return { offset, shift: 0, yaw: Math.atan2(rel, conv) };
  return { offset, shift: -rel / conv, yaw: 0 };
}

/** Anaglyph of two RGBA images (channels of one eye, the others from the other eye). */
export function anaglyph(left: Float32Array, right: Float32Array, type: AnaglyphType): Float32Array {
  const out = new Float32Array(left.length);
  // which channels come from the left eye
  const fromLeft = type === 'RED_CYAN' ? [true, false, false] : type === 'GREEN_MAGENTA' ? [false, true, false] : [true, true, false];
  for (let i = 0; i < left.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = fromLeft[c] ? left[i + c] : right[i + c];
    out[i + 3] = Math.max(left[i + 3], right[i + 3]);
  }
  return out;
}

/** Interlaced stereo: alternate rows, columns or a checkerboard of the two eyes. */
export function interlace(left: Float32Array, right: Float32Array, w: number, h: number, type: InterlaceType, swap: boolean): Float32Array {
  const out = new Float32Array(left.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const odd = type === 'ROW_INTERLEAVED' ? y & 1 : type === 'COLUMN_INTERLEAVED' ? x & 1 : (x + y) & 1;
      const src = (odd === 1) !== swap ? right : left;
      const i = (y * w + x) * 4;
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = src[i + 3];
    }
  }
  return out;
}

/** Copy a w×h RGBA image into a larger one at (ox, oy), optionally squeezing it by (sx, sy). */
function place(dst: Float32Array, dw: number, src: Float32Array, w: number, h: number, ox: number, oy: number, sx: number, sy: number) {
  const tw = Math.round(w / sx),
    th = Math.round(h / sy);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      // box filter over the squeezed pixels
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.min(h, Math.floor((y + 1) * sy)); yy++)
        for (let xx = Math.floor(x * sx); xx < Math.min(w, Math.floor((x + 1) * sx)); xx++) {
          const s = (yy * w + xx) * 4;
          r += src[s];
          g += src[s + 1];
          b += src[s + 2];
          a += src[s + 3];
          n++;
        }
      const d = ((oy + y) * dw + ox + x) * 4;
      n = n || 1;
      dst[d] = r / n;
      dst[d + 1] = g / n;
      dst[d + 2] = b / n;
      dst[d + 3] = a / n;
    }
  }
}

/** Combine two eyes (w×h RGBA, top-down rows) as the stereo format says. */
export function combineStereo(left: Float32Array, right: Float32Array, w: number, h: number, f: Stereo3dFormat): { data: Float32Array; width: number; height: number } {
  switch (f.display_mode) {
    case 'ANAGLYPH':
      return { data: anaglyph(left, right, f.anaglyph_type), width: w, height: h };
    case 'INTERLACE':
      return { data: interlace(left, right, w, h, f.interlace_type, f.use_interlace_swap), width: w, height: h };
    case 'SIDEBYSIDE': {
      const sq = f.use_squeezed_frame;
      const W = sq ? w : w * 2;
      const data = new Float32Array(W * h * 4);
      const [a, b] = f.use_sidebyside_crosseyed ? [right, left] : [left, right];
      const half = sq ? Math.round(w / 2) : w;
      place(data, W, a, w, h, 0, 0, sq ? 2 : 1, 1);
      place(data, W, b, w, h, half, 0, sq ? 2 : 1, 1);
      return { data, width: W, height: h };
    }
    default: {
      // top-bottom: the left eye on top
      const sq = f.use_squeezed_frame;
      const H = sq ? h : h * 2;
      const data = new Float32Array(w * H * 4);
      place(data, w, left, w, h, 0, 0, 1, sq ? 2 : 1);
      place(data, w, right, w, h, 0, sq ? Math.round(h / 2) : h, 1, sq ? 2 : 1);
      return { data, width: w, height: H };
    }
  }
}

/** File name of a view: the view's suffix before the extension ("render_0001_L.png"). */
export function viewFileName(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
}

/** The two eyes of a stereo render result combined into one image (null for other results). */
export function stereoResult(r: import('./result').RenderResult, format?: Stereo3dFormat): import('./result').RenderResult | null {
  const f = format ?? r.stereo;
  const views = r.views;
  if (!f || !views || views.length !== 2) return null;
  const L = views.find((v) => v.name === 'left')?.passes.Combined;
  const R = views.find((v) => v.name === 'right')?.passes.Combined;
  if (!L || !R) return null;
  const c = combineStereo(L, R, r.width, r.height, f);
  return { ...r, width: c.width, height: c.height, passes: { Combined: c.data }, viewLayer: undefined, layers: undefined, views: undefined, overlay: undefined };
}
