// The "Render Result": float passes of the last render, display conversion and encoding.
import { toDisplayRGBA8, displayPixel, type ViewSettings } from './colormanage';
import { compositeOverlay, type StampField } from './stamp';

export type PassName = 'Combined' | 'Depth' | 'Normal' | 'Mist' | 'Position' | 'UV' | 'IndexOB' | 'IndexMA' | 'DiffCol' | 'Emit' | 'AO';
export type ChannelMode = 'COLOR_ALPHA' | 'COLOR' | 'ALPHA' | 'Z';

export interface RenderInfo {
  frame: number;
  /** render time in seconds */
  time: number;
  engine: string;
  samples?: number;
  maxSamples?: number;
  camera: string;
  scene: string;
  /** progress text while rendering */
  status?: string;
}

export interface RenderResult {
  width: number;
  height: number;
  /** top-down rows. Combined/Normal: RGBA (Combined premultiplied scene-linear), Depth/Mist: 1 channel */
  passes: Partial<Record<PassName, Float32Array>>;
  filmTransparent: boolean;
  info: RenderInfo;
  version: number;
  rendering: boolean;
  /** display transform override (viewport solid renders are shown like the viewport) */
  view?: ViewSettings;
  /** raw render passes when `passes.Combined` holds a post-processed (composited) image */
  viewLayer?: Partial<Record<PassName, Float32Array>>;
  /** metadata of the render (Output ▸ Metadata), written into saved files */
  metadata?: StampField[];
  /** burnt-in metadata: RGBA8 overlay drawn over the display-converted Combined pass */
  overlay?: Uint8ClampedArray;
}

/** Post-processing of each finished frame of a render job (e.g. compositing), in order. */
export const renderPostHooks: ((r: RenderResult, ctx: { final: boolean }) => void | Promise<void>)[] = [];

/** Images that exist only in memory (e.g. the compositor's "Viewer Node"), browsable in the Image Editor. */
export interface VirtualImage {
  id: string;
  label: string;
  icon: string;
  get(): RenderResult | null;
}
export const virtualImages = new Map<string, VirtualImage>();
const virtualListeners = new Set<(id: string) => void>();
export function onVirtualImageChange(fn: (id: string) => void) {
  virtualListeners.add(fn);
  return () => virtualListeners.delete(fn);
}
export function touchVirtualImage(id: string) {
  for (const fn of virtualListeners) fn(id);
}

export const PASS_CHANNELS: Record<PassName, number> = { Combined: 4, Depth: 1, Normal: 4, Mist: 1, Position: 4, UV: 4, IndexOB: 1, IndexMA: 1, DiffCol: 4, Emit: 4, AO: 1 };

/** Display order of passes (pass menus, Render Layers outputs). */
export const PASS_ORDER: PassName[] = ['Combined', 'Depth', 'Mist', 'Normal', 'Position', 'UV', 'IndexOB', 'IndexMA', 'DiffCol', 'Emit', 'AO'];

/** Readable pass names. */
export const PASS_LABELS: Record<PassName, string> = { Combined: 'Combined', Depth: 'Depth', Normal: 'Normal', Mist: 'Mist', Position: 'Position', UV: 'UV', IndexOB: 'Object Index', IndexMA: 'Material Index', DiffCol: 'Diffuse Color', Emit: 'Emission', AO: 'Ambient Occlusion' };

/** Render slots: renders go into the active slot so earlier ones can be compared. */
export const RENDER_SLOTS = 8;
const slots: (RenderResult | null)[] = new Array(RENDER_SLOTS).fill(null);
let activeSlot = 0;
const listeners = new Set<(pixels: boolean) => void>();

export const renderResult = {
  get(): RenderResult | null {
    return slots[activeSlot];
  },
  set(r: RenderResult | null) {
    slots[activeSlot] = r;
    this.touch();
  },
  /** Index of the slot that is shown and rendered into. */
  get slot() {
    return activeSlot;
  },
  setSlot(i: number) {
    activeSlot = Math.max(0, Math.min(RENDER_SLOTS - 1, i));
    this.touch();
  },
  hasRender(i: number) {
    return !!slots[i];
  },
  /** Next (or previous) slot holding a render; the active slot when there is none. */
  cycle(reverse = false) {
    for (let k = 1; k <= RENDER_SLOTS; k++) {
      const i = (activeSlot + (reverse ? -k : k) + RENDER_SLOTS * 2) % RENDER_SLOTS;
      if (slots[i]) return i;
    }
    return activeSlot;
  },
  clearSlot() {
    slots[activeSlot] = null;
    this.touch();
  },
  /** Pixels changed (bumps the version so displays re-convert). */
  touch() {
    const current = slots[activeSlot];
    if (current) current.version++;
    for (const l of listeners) l(true);
  },
  /** Only the info/status text changed. */
  touchInfo() {
    for (const l of listeners) l(false);
  },
  subscribe(fn: (pixels: boolean) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Range of finite (foreground) depth values. */
export function depthRange(z: Float32Array): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (v >= 1e9 || !(v > 0)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return [0, 1];
  return [lo, Math.max(hi, lo + 1e-6)];
}

/**
 * Convert one pass of a result to 8-bit RGBA for display or saving.
 * Combined is colour-managed; data passes are shown as raw values (depth normalised).
 */
export function passToRGBA8(r: RenderResult, pass: PassName, channel: ChannelMode, view: ViewSettings, opts: { keepAlpha?: boolean; dither?: number } = {}): Uint8ClampedArray {
  const n = r.width * r.height;
  const out = new Uint8ClampedArray(n * 4);
  const src = r.passes[pass];
  if (!src) return out;
  const zSrc = channel === 'Z' ? r.passes.Depth : null;
  if (zSrc) {
    const [lo, hi] = depthRange(zSrc);
    for (let i = 0; i < n; i++) {
      const v = zSrc[i] >= 1e9 ? 1 : (zSrc[i] - lo) / (hi - lo);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v * 255;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (pass === 'Combined') {
    if (channel === 'ALPHA') {
      for (let i = 0; i < n; i++) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Math.min(1, Math.max(0, src[i * 4 + 3])) * 255;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    const keep = channel === 'COLOR_ALPHA' && (opts.keepAlpha ?? true);
    toDisplayRGBA8(src, r.width, r.height, view, { keepAlpha: keep, dither: opts.dither }, out);
    if (r.overlay && r.overlay.length === out.length) compositeOverlay(out, r.overlay);
    return out;
  }
  if (pass === 'Depth') {
    const [lo, hi] = depthRange(src);
    for (let i = 0; i < n; i++) {
      const v = src[i] >= 1e9 ? 1 : (src[i] - lo) / (hi - lo);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v * 255;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (pass === 'DiffCol' || pass === 'Emit') {
    // light passes are shown through the view transform, opaque
    toDisplayRGBA8(src, r.width, r.height, view, { keepAlpha: false }, out);
    return out;
  }
  if (pass === 'IndexOB' || pass === 'IndexMA') {
    for (let i = 0; i < n; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i] * 255;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (pass === 'Mist') {
    for (let i = 0; i < n; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i] * 255;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  // Normal / Position / UV: raw values (negative components clip, like viewing the pass directly)
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * 4] * 255;
    out[i * 4 + 1] = src[i * 4 + 1] * 255;
    out[i * 4 + 2] = src[i * 4 + 2] * 255;
    out[i * 4 + 3] = channel === 'ALPHA' ? 255 : 255;
  }
  return out;
}

/** Pixel values under the cursor for the sample readout. */
export function samplePixel(r: RenderResult, pass: PassName, x: number, y: number, view: ViewSettings): { raw: number[]; display?: number[]; depth?: number } | null {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
  const i = y * r.width + x;
  const src = r.passes[pass];
  if (!src) return null;
  const ch = PASS_CHANNELS[pass];
  const raw = Array.from(src.subarray(i * ch, i * ch + ch));
  const out: { raw: number[]; display?: number[]; depth?: number } = { raw };
  if (pass === 'Combined') {
    const d = [0, 0, 0, 0];
    displayPixel(raw[0], raw[1], raw[2], raw[3], view, d);
    out.display = d;
  }
  if (r.passes.Depth) out.depth = r.passes.Depth[i];
  return out;
}

/** Convert RGBA8 to grayscale (BW colour mode), keeping alpha. */
export function toBW(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = l;
  }
  return px;
}

export type FileFormat = 'PNG' | 'JPEG' | 'WEBP';
export const MIME: Record<FileFormat, string> = { PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp' };
export const EXT: Record<FileFormat, string> = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp' };

/** Encode RGBA8 pixels into an image file. */
export async function encodeRGBA8(px: Uint8ClampedArray, w: number, h: number, format: FileFormat, opts: { alpha: boolean; quality?: number }): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const data = new ImageData(new Uint8ClampedArray(px), w, h);
  if (!opts.alpha || format === 'JPEG') for (let i = 3; i < data.data.length; i += 4) data.data[i] = 255;
  ctx.putImageData(data, 0, 0);
  return canvasBytes(c, format, opts.quality);
}

export async function canvasBytes(c: HTMLCanvasElement, format: FileFormat, quality = 0.9): Promise<Uint8Array> {
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, MIME[format], quality));
  if (!blob) throw new Error(`Could not encode ${format}`);
  return new Uint8Array(await blob.arrayBuffer());
}

export function download(data: Blob | Uint8Array, name: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
