// AI Fill, AI Expand, Generate Image, Edit with Prompt, the AI detail pass of
// Upscale and image descriptions through Puter.js (loaded globally as
// `puter`). This is the only module that sends pixels anywhere, and only when one
// of its functions is called; the UI must call them solely from an explicit user
// command (menu item or button), never automatically or for previews.
//
// What Puter documents (docs.puter.com, AI/txt2img and AI/chat, October 2026):
// - puter.ai.txt2img(prompt, options) generates images and accepts reference
//   images through `input_image` / `input_images` (public URL, data URI or raw
//   base64 with `input_image_mime_type`). OpenAI gpt-image-* models route these
//   to their edit endpoint; Gemini, xAI, BytePlus and Replicate models take
//   them as references. Only Cloudflare's Stable Diffusion 1.5 Inpainting model
//   documents a true pixel mask (`maskImage`, plus `strength`).
// - puter.ai.chat(prompt, imageOrFile, testMode, options) answers about images.
// Each txt2img call returns one image, so variations are separate requests.
// Puter offers no dedicated upscaling endpoint; the AI detail pass of Upscale
// is an image-to-image re-render at a larger output tier and is labeled as
// generative in the UI.
// So: AI Fill and AI Expand work as instruction-guided edits (the mask is sent as
// a second reference image and the result is composited back only inside the
// mask, so pixels outside it never change), or as true mask inpainting with the
// Cloudflare model. Results are capped at the provider's output size (around
// 1 megapixel), so large regions come back softer than the original.
import { cloneRGBA8, type IRect, type Mask8, type RGBA8 } from '../types';
import { heal } from '../retouch/heal';
import { boundingBox, feather } from '../segment/mask-ops';

type PuterImage = { src: string } | HTMLImageElement;
type PuterAI = {
  ai: {
    txt2img(prompt: string, options?: Record<string, unknown>): Promise<PuterImage>;
    chat(prompt: string, media?: string | File | string[], testMode?: boolean, options?: Record<string, unknown>): Promise<unknown>;
  };
};

export type AIErrorCode = 'unavailable' | 'cancelled' | 'moderation' | 'funds' | 'upstream' | 'bad-request' | 'network' | 'decode' | 'unknown';

// Errors carry a short user-facing message and whether retrying may help.
export class AIError extends Error {
  constructor(readonly code: AIErrorCode, message: string, readonly retryable = false, readonly detail?: unknown) {
    super(message);
    this.name = 'AIError';
  }
}

export type AIImageOptions = {
  // Puter model id (for example 'gpt-image-2', 'gemini-3.1-flash-image').
  model?: string;
  provider?: string;
  quality?: string;
  // 'edit' (default): instruction-guided edit with the mask as a reference image.
  // 'inpaint': pixel-mask inpainting (Cloudflare Stable Diffusion 1.5 Inpainting).
  mode?: 'edit' | 'inpaint';
  // 'seamless' matches the generated pixels to the surroundings along the mask
  // edge (Poisson blending); 'normal' composites with a soft edge.
  blend?: 'normal' | 'seamless';
  // Free test endpoint that returns a sample image (no credits).
  testMode?: boolean;
  signal?: AbortSignal;
};

// Model id for mask inpainting. Puter lists "Stable Diffusion 1.5 Inpainting"
// among its Cloudflare models without printing the id; this is Cloudflare's id
// for that model. Override with `model` if Puter's catalog differs
// (puter.drivers.call('puter-image-generation', 'models', {}) lists it).
export const INPAINT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting';
const MAX_SIDE = 1024;

function api(): PuterAI {
  const p = (globalThis as unknown as { puter?: PuterAI }).puter;
  if (!p?.ai?.txt2img) throw new AIError('unavailable', 'AI features need Puter. Check your connection and try again.');
  return p;
}

// Map Puter's `{ message, code }` rejections (and network failures) to AIError.
export function toAIError(e: unknown): AIError {
  if (e instanceof AIError) return e;
  const o = (e && typeof e === 'object' ? e : {}) as { code?: string; errorCode?: string; message?: string; error?: { message?: string; code?: string } };
  const code = String(o.code ?? o.errorCode ?? o.error?.code ?? ''), msg = String(o.message ?? o.error?.message ?? (typeof e === 'string' ? e : ''));
  if (e instanceof DOMException && e.name === 'AbortError') return new AIError('cancelled', 'Cancelled.');
  if (code === 'moderation_flagged') return new AIError('moderation', 'The request was declined by the content filter. Try a different prompt.', false, e);
  if (code === 'insufficient_funds') return new AIError('funds', 'Your Puter balance is too low for this request.', false, e);
  if (code === 'prompt_required') return new AIError('bad-request', 'Enter a prompt first.', false, e);
  if (code === 'bad_request') return new AIError('bad-request', msg || 'The AI service rejected the request.', false, e);
  if (code === 'network_error' || code === 'request_timeout' || e instanceof TypeError) return new AIError('network', 'The AI service could not be reached. Try again.', true, e);
  if (code.startsWith('upstream')) return new AIError('upstream', msg || 'The AI provider failed. Try again.', code === 'upstream_failed', e);
  return new AIError('unknown', msg || 'The AI request failed.', true, e);
}

// ---------------------------------------------------------------------------
// Canvas helpers (DOM).

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function ctx2d(c: OffscreenCanvas | HTMLCanvasElement) {
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) throw new AIError('decode', 'This browser cannot prepare images for AI requests.');
  return g;
}
async function toPngBlob(img: RGBA8): Promise<Blob> {
  const c = canvas(img.width, img.height);
  ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c instanceof HTMLCanvasElement
    ? new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new AIError('decode', 'Could not encode the image.'))), 'image/png'))
    : c.convertToBlob({ type: 'image/png' });
}
async function pngDataUri(img: RGBA8) {
  const bytes = new Uint8Array(await (await toPngBlob(img)).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
// Decode Puter's result into pixels, at the requested size or (without one)
// at the size the provider returned.
async function decodeResult(res: PuterImage, w?: number, h?: number): Promise<RGBA8> {
  const src = 'src' in res ? res.src : String(res);
  let source: CanvasImageSource;
  try {
    // Fetching avoids a tainted canvas for cross-origin URLs; data URIs fetch too.
    source = await createImageBitmap(await (await fetch(src)).blob());
  } catch {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.src = src;
    try {
      await el.decode();
    } catch (e) {
      throw new AIError('decode', 'The generated image could not be loaded.', true, e);
    }
    source = el;
  }
  const el = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement ? source : undefined;
  w ??= Math.max(1, el ? el.naturalWidth : (source as ImageBitmap).width);
  h ??= Math.max(1, el ? el.naturalHeight : (source as ImageBitmap).height);
  const c = canvas(w, h), g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  try {
    const d = g.getImageData(0, 0, w, h);
    return { width: w, height: h, data: new Uint8ClampedArray(d.data.buffer) };
  } catch (e) {
    throw new AIError('decode', 'The generated image could not be read (cross-origin).', false, e);
  }
}

// Encoding and decoding go through this object so tests can run without a DOM.
export const aiCodec = {
  toDataUri: pngDataUri,
  decode: decodeResult,
};
const toDataUri = (img: RGBA8) => aiCodec.toDataUri(img);
const fromResult = (res: PuterImage, w?: number, h?: number) => aiCodec.decode(res, w, h);

function resample(img: RGBA8, w: number, h: number): RGBA8 {
  if (img.width === w && img.height === h) return img;
  const out = new Uint8ClampedArray(w * h * 4), sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Box average over the source footprint (downscaling only).
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4, al = img.data[i + 3];
          r += img.data[i] * al;
          g += img.data[i + 1] * al;
          b += img.data[i + 2] * al;
          a += al;
          n++;
        }
      const o = (y * w + x) * 4;
      if (a) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  return { width: w, height: h, data: out };
}
function cropRGBA(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}
function maskImage(m: Mask8, threshold = 1): RGBA8 {
  const out = new Uint8ClampedArray(m.data.length * 4);
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i] >= threshold ? 255 : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { width: m.width, height: m.height, data: out };
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
}

async function generate(prompt: string, image: RGBA8, mask: Mask8, opts: AIImageOptions, framing: string): Promise<RGBA8> {
  const p = api();
  checkAbort(opts.signal);
  const [w, h] = [image.width, image.height], s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
  const img = resample(image, sw, sh), msk = resample(maskImage(mask), sw, sh);
  const [imgUri, maskUri] = await Promise.all([toDataUri(img), toDataUri(msk)]);
  const options: Record<string, unknown> = { ratio: { w: sw, h: sh }, test_mode: !!opts.testMode };
  if (opts.quality) options.quality = opts.quality;
  if (opts.provider) options.provider = opts.provider;
  let text: string;
  if (opts.mode === 'inpaint') {
    options.model = opts.model ?? INPAINT_MODEL;
    options.input_image = imgUri;
    options.maskImage = maskUri;
    options.width = sw;
    options.height = sh;
    text = prompt;
  } else {
    if (opts.model) options.model = opts.model;
    options.input_images = [imgUri, maskUri];
    text =
      `Edit the first image. The second image is a mask: change only the area that is white in the mask, ${framing}: ${prompt}. ` +
      'Keep everything in the black area exactly as it is. Match the perspective, lighting, color, focus and grain of the photo. ' +
      'Return the full edited image with the same framing and aspect ratio.';
  }
  let res: PuterImage;
  try {
    res = await p.ai.txt2img(text, options);
  } catch (e) {
    throw toAIError(e);
  }
  checkAbort(opts.signal);
  return fromResult(res, w, h);
}

function composite(dst: RGBA8, gen: RGBA8, m: Mask8, at: { x: number; y: number }, blend: 'normal' | 'seamless') {
  if (blend === 'seamless') return heal(dst, gen, m, at, { inPlace: true });
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      const k = m.data[y * m.width + x] / 255;
      if (!k) continue;
      const o = ((y + at.y) * dst.width + x + at.x) * 4, g = (y * m.width + x) * 4;
      const da = dst.data[o + 3] / 255, ga = gen.data[g + 3] / 255, a = da * (1 - k) + ga * k;
      for (let c = 0; c < 3; c++) dst.data[o + c] = a > 0 ? (dst.data[o + c] * da * (1 - k) + gen.data[g + c] * ga * k) / a : 0;
      dst.data[o + 3] = a * 255;
    }
  return dst;
}

// AI Fill: replace the masked area (coverage > 0) following `prompt`. Sends a
// crop around the mask with context, never the whole document.
export async function aiFill(img: RGBA8, mask: Mask8, prompt: string, opts: AIImageOptions = {}): Promise<RGBA8> {
  if (!prompt.trim()) throw new AIError('bad-request', 'Enter a prompt first.');
  const b = boundingBox(mask);
  if (!b) return cloneRGBA8(img);
  const m = Math.max(64, Math.round(Math.max(b.width, b.height) * 0.5));
  const R = { x: Math.max(0, b.x - m), y: Math.max(0, b.y - m), width: 0, height: 0 };
  R.width = Math.min(img.width, b.x + b.width + m) - R.x;
  R.height = Math.min(img.height, b.y + b.height + m) - R.y;
  const crop = cropRGBA(img, R), cm: Mask8 = { width: R.width, height: R.height, data: new Uint8Array(R.width * R.height) };
  for (let y = 0; y < R.height; y++) cm.data.set(mask.data.subarray((y + R.y) * img.width + R.x, (y + R.y) * img.width + R.x + R.width), y * R.width);
  const gen = await generate(prompt, crop, cm, opts, 'painting in');
  // Soft edge on the inside only, so nothing outside the mask changes.
  const soft = feather(cm, 2);
  for (let i = 0; i < soft.data.length; i++) soft.data[i] = Math.min(soft.data[i] * 2, cm.data[i]);
  return composite(cloneRGBA8(img), gen, opts.blend === 'seamless' ? cm : soft, R, opts.blend ?? 'normal');
}

export type ExpandBy = { left: number; top: number; right: number; bottom: number };

// AI Expand: grow the canvas by `by` pixels per side and generate the new area.
// The original pixels are kept exactly; a short band inside the old edge blends.
export async function aiExpand(img: RGBA8, by: ExpandBy, prompt = '', opts: AIImageOptions = {}): Promise<RGBA8> {
  const l = Math.max(0, Math.round(by.left)), t = Math.max(0, Math.round(by.top)), r = Math.max(0, Math.round(by.right)), bt = Math.max(0, Math.round(by.bottom));
  const W = img.width + l + r, H = img.height + t + bt;
  const big: RGBA8 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < img.height; y++) big.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + t) * W + l) * 4);
  if (W === img.width && H === img.height) return big;
  const m: Mask8 = { width: W, height: H, data: new Uint8Array(W * H).fill(255) };
  for (let y = 0; y < img.height; y++) m.data.fill(0, (y + t) * W + l, (y + t) * W + l + img.width);
  // Neutral gray in the empty area reads as "to be filled" for every provider.
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) big.data.set([128, 128, 128, 255], i * 4);
  const what = prompt.trim() || 'a natural continuation of the scene';
  const gen = await generate(what, big, m, opts, 'extending the photo outward');
  // Blend band: soften the mask edge inward over a few pixels of the original.
  const band = Math.max(2, Math.round(Math.min(img.width, img.height) * 0.01));
  const soft = feather(m, band);
  for (let i = 0; i < soft.data.length; i++) soft.data[i] = m.data[i] ? 255 : Math.min(255, soft.data[i] * 2);
  return composite(big, gen, soft, { x: 0, y: 0 }, 'normal');
}

// Short alt text for accessibility (one or two sentences).
export async function describeImage(img: RGBA8, opts: { model?: string; testMode?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const p = api();
  checkAbort(opts.signal);
  const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const small = resample(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
  const file = new File([await toPngBlob(small)], 'image.png', { type: 'image/png' });
  let res: unknown;
  try {
    res = await p.ai.chat(
      'Write concise alt text for this image: one or two plain sentences describing the main subject and setting. No preamble.',
      file,
      !!opts.testMode,
      opts.model ? { model: opts.model } : {},
    );
  } catch (e) {
    throw toAIError(e);
  }
  checkAbort(opts.signal);
  const content = (res as { message?: { content?: unknown } })?.message?.content ?? res;
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? '')).join('')
    : String(content ?? '');
  return text.trim();
}

// ---------------------------------------------------------------------------
// Generate Image, Edit with Prompt and the AI detail pass of Upscale.

export type GenerateOptions = {
  // Requested output size in pixels; providers round it to sizes they support.
  width: number;
  height: number;
  model?: string;
  quality?: string;
  // Number of variations (separate requests), 1..4.
  count?: number;
  testMode?: boolean;
  signal?: AbortSignal;
};
// Longest side requested from providers for new images (they cap output near
// one megapixel for most models).
export const GENERATE_MAX_SIDE = 1536;

/** Fit w x h inside `max` on the longer side, keeping the aspect ratio. */
export function requestSize(w: number, h: number, max = GENERATE_MAX_SIDE) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(64, Math.round(w * s)), h: Math.max(64, Math.round(h * s)) };
}
function baseOptions(o: { model?: string; quality?: string; testMode?: boolean }, w: number, h: number) {
  const options: Record<string, unknown> = { ratio: { w, h }, test_mode: !!o.testMode };
  if (o.model) options.model = o.model;
  if (o.quality) options.quality = o.quality;
  return options;
}
// Run `count` requests together; resolve with every image that arrived, or
// reject with the first error when none did.
async function variations(count: number, signal: AbortSignal | undefined, one: () => Promise<RGBA8>): Promise<RGBA8[]> {
  const n = Math.max(1, Math.min(4, Math.round(count)));
  const settled = await Promise.allSettled(Array.from({ length: n }, one));
  checkAbort(signal);
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!ok.length) throw toAIError((settled[0] as PromiseRejectedResult).reason);
  return ok;
}

/** New images from a text prompt, at the size the provider returns. */
export async function generateImages(prompt: string, opts: GenerateOptions): Promise<RGBA8[]> {
  if (!prompt.trim()) throw new AIError('bad-request', 'Enter a prompt first.');
  const p = api();
  checkAbort(opts.signal);
  const { w, h } = requestSize(opts.width, opts.height);
  const options = baseOptions(opts, w, h);
  return variations(opts.count ?? 1, opts.signal, async () => {
    let res: PuterImage;
    try {
      res = await p.ai.txt2img(prompt.trim(), options);
    } catch (e) {
      throw toAIError(e);
    }
    checkAbort(opts.signal);
    return fromResult(res);
  });
}

export type EditOptions = { model?: string; quality?: string; count?: number; testMode?: boolean; signal?: AbortSignal };
// Longest side of the image sent for editing.
export const EDIT_MAX_SIDE = 1024;

/** Apply a text instruction to an image through an image-to-image model.
 * Results come back at the input's size (resampled from the provider's). */
export async function editImage(img: RGBA8, instruction: string, opts: EditOptions = {}): Promise<RGBA8[]> {
  if (!instruction.trim()) throw new AIError('bad-request', 'Describe the change first.');
  const p = api();
  checkAbort(opts.signal);
  const s = Math.min(1, EDIT_MAX_SIDE / Math.max(img.width, img.height));
  const sw = Math.max(1, Math.round(img.width * s)), sh = Math.max(1, Math.round(img.height * s));
  const uri = await toDataUri(resample(img, sw, sh));
  checkAbort(opts.signal);
  const options = baseOptions(opts, sw, sh);
  options.input_image = uri;
  const text =
    `Edit this photo: ${instruction.trim()}. ` +
    'Change only what the instruction asks for and keep the composition, framing, perspective and everything else as it is. Return the full image with the same aspect ratio.';
  return variations(opts.count ?? 1, opts.signal, async () => {
    let res: PuterImage;
    try {
      res = await p.ai.txt2img(text, options);
    } catch (e) {
      throw toAIError(e);
    }
    checkAbort(opts.signal);
    return fromResult(res, img.width, img.height);
  });
}

export type AIUpscaleOptions = { model?: string; testMode?: boolean; signal?: AbortSignal };
// Image-to-image model with the largest documented output tier.
export const UPSCALE_MODEL = 'gemini-3-pro-image';
export const UPSCALE_INPUT_MAX_SIDE = 2048;

/** Re-render an image at a larger size with a generative model. Returns the
 * provider's image at its native size; callers resample it to the target and
 * should say so when it came back smaller. */
export async function aiUpscale(img: RGBA8, targetW: number, targetH: number, opts: AIUpscaleOptions = {}): Promise<RGBA8> {
  const p = api();
  checkAbort(opts.signal);
  const s = Math.min(1, UPSCALE_INPUT_MAX_SIDE / Math.max(img.width, img.height));
  const sw = Math.max(1, Math.round(img.width * s)), sh = Math.max(1, Math.round(img.height * s));
  const uri = await toDataUri(resample(img, sw, sh));
  checkAbort(opts.signal);
  const options = baseOptions({ model: opts.model ?? UPSCALE_MODEL, quality: Math.max(targetW, targetH) > 2048 ? '4K' : '2K', testMode: opts.testMode }, targetW, targetH);
  options.input_image = uri;
  const text =
    'Reproduce this photo at a higher resolution. Keep it identical: the same composition, framing, colors, lighting, text and every object in the same place. ' +
    'Only restore fine detail and remove blur and compression artifacts. Do not add, remove or restyle anything.';
  let res: PuterImage;
  try {
    res = await p.ai.txt2img(text, options);
  } catch (e) {
    throw toAIError(e);
  }
  checkAbort(opts.signal);
  return fromResult(res);
}

export type TransformOptions = { model?: string; quality?: string; reference?: RGBA8; testMode?: boolean; signal?: AbortSignal };

/** One image-to-image result for a complete instruction (the caller writes
 * the whole prompt), returned at the input's size. An optional reference
 * image (a style or color example) is sent as a second input image. Used by
 * Portrait & Restore (AI colors, AI style, Scene Changer). */
export async function transformImage(img: RGBA8, instruction: string, opts: TransformOptions = {}): Promise<RGBA8> {
  if (!instruction.trim()) throw new AIError('bad-request', 'Describe the change first.');
  const p = api();
  checkAbort(opts.signal);
  const s = Math.min(1, EDIT_MAX_SIDE / Math.max(img.width, img.height));
  const sw = Math.max(1, Math.round(img.width * s)), sh = Math.max(1, Math.round(img.height * s));
  const uri = await toDataUri(resample(img, sw, sh));
  let refUri: string | undefined;
  if (opts.reference) {
    const r = opts.reference, rs = Math.min(1, EDIT_MAX_SIDE / Math.max(r.width, r.height));
    refUri = await toDataUri(resample(r, Math.max(1, Math.round(r.width * rs)), Math.max(1, Math.round(r.height * rs))));
  }
  checkAbort(opts.signal);
  const options = baseOptions(opts, sw, sh);
  if (refUri) options.input_images = [uri, refUri];
  else options.input_image = uri;
  let res: PuterImage;
  try {
    res = await p.ai.txt2img(instruction.trim(), options);
  } catch (e) {
    throw toAIError(e);
  }
  checkAbort(opts.signal);
  return fromResult(res, img.width, img.height);
}
