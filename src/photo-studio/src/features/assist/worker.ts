/// <reference lib="webworker" />
// Assisted-editing jobs (Enhanced Upscale, object detection, fitting generated
// images) run here. Buffers arrive and leave as transferables; cancelling
// terminates the worker, so jobs keep no state.
import type { Mask8, Progress, RGBA8 } from '../../imaging/types';
import { enhancedUpscale, enhancedUpscaleMask, type UpscaleOptions } from '../../imaging/filters/upscale';
import { resize } from '../../imaging/filters/resample';
import { detectObjects, type ObjectOptions } from '../../imaging/segment/objects';
import { fitImage, type FitMode } from './place';
import { detailTransfer, keepAlpha, renderTransformed, type CutObject, type ObjectTransform } from '../genai/math';

const scope = self as unknown as DedicatedWorkerGlobalScope;
type Args = Record<string, unknown>;

const jobs: Record<string, (a: Args, p: Progress) => unknown> = {
  upscale: (a, p) => enhancedUpscale(a.img as RGBA8, a.width as number, a.height as number, a.opts as UpscaleOptions, p),
  'upscale-mask': (a) => enhancedUpscaleMask(a.mask as Mask8, a.width as number, a.height as number),
  // Several images in one call (the layers of a document), with progress across them.
  'upscale-many': (a, p) => {
    const items = a.items as { img: RGBA8; width: number; height: number }[];
    return items.map((it, k) =>
      enhancedUpscale(it.img, it.width, it.height, a.opts as UpscaleOptions, { cancelled: p.cancelled, report: (f) => p.report?.((k + f) / items.length) }),
    );
  },
  resize: (a) => resize(a.img as RGBA8, a.width as number, a.height as number, 'lanczos'),
  fit: (a) => fitImage(a.img as RGBA8, a.width as number, a.height as number, a.mode as FitMode),
  objects: (a, p) => detectObjects(a.img as RGBA8, { ...(a.opts as ObjectOptions), progress: p }),
  // AI Recompose: the object at its new place, at full resolution.
  // Remove Reflections: the chosen result enlarged to the original's size,
  // with its fine detail restored when asked and its transparency kept.
  'reflection-final': (a) => {
    const orig = a.orig as RGBA8,
      sent = a.sent as { width: number; height: number },
      gen = a.gen as RGBA8;
    let out = gen.width === orig.width && gen.height === orig.height ? gen : resize(gen, orig.width, orig.height, 'lanczos');
    if (a.detail) out = detailTransfer(out, orig, resize(resize(orig, sent.width, sent.height, 'lanczos'), orig.width, orig.height, 'lanczos'));
    return a.keep ? keepAlpha(out, orig) : out;
  },
  'transform-object': (a) => renderTransformed(a.obj as CutObject, a.t as ObjectTransform, a.width as number, a.height as number),
};

function transferables(v: unknown, out: Transferable[] = []): Transferable[] {
  if (!v || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) {
    if (!out.includes(v.buffer as ArrayBuffer)) out.push(v.buffer as ArrayBuffer);
    return out;
  }
  for (const x of Object.values(v)) transferables(x, out);
  return out;
}

scope.onmessage = (ev: MessageEvent<{ id: number; op: string; args: Args }>) => {
  const { id, op, args } = ev.data;
  let last = 0;
  const progress: Progress = {
    report: (f) => {
      const now = performance.now();
      if (now - last < 60 && f < 1) return;
      last = now;
      scope.postMessage({ id, progress: f });
    },
  };
  try {
    const job = jobs[op];
    if (!job) throw new Error(`Unknown job: ${op}`);
    const result = job(args, progress);
    scope.postMessage({ id, result }, transferables(result));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
