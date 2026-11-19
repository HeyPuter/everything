/// <reference lib="webworker" />
// Filter worker: keeps dialog sources, runs filters and stacks by ID, and
// returns either a pane image or finished tiles. Cancellation terminates the
// worker (filters run synchronously), so it holds no state worth keeping.
import { LiquifyField } from '../../imaging/filters/liquify';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import type { FromWorker, ToWorker, View } from './protocol';
import { cropMask, cropRGBA, fadeMix, halveMask, halveRGBA, keepAlpha, maskToRGBA } from './stack';
import { mixByMask, rgbaToMask, runStack } from './stack';
import { readPayload, tileize, type GridPayload } from './tilepack';

type Source = {
  rect: IRect;
  base: GridPayload;
  levels: RGBA8[];
  sel?: Mask8[];
  mask?: Mask8;
};
const sources = new Map<string, Source>();
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

function level(s: Source, k: number): RGBA8 {
  while (s.levels.length <= k) s.levels.push(halveRGBA(s.levels[s.levels.length - 1]));
  return s.levels[k];
}
function selLevel(s: Source, k: number): Mask8 | undefined {
  if (!s.sel) return undefined;
  while (s.sel.length <= k) s.sel.push(halveMask(s.sel[s.sel.length - 1]));
  return s.sel[k];
}
function viewOf(s: Source, v: View | undefined) {
  if (!v) return { img: s.levels[0], sel: s.sel?.[0], mask: s.mask };
  const img = level(s, v.level),
    sel = selLevel(s, v.level);
  const whole = v.x === 0 && v.y === 0 && v.width === img.width && v.height === img.height;
  let mask = s.mask;
  for (let k = 0; mask && k < v.level; k++) mask = halveMask(mask);
  return whole
    ? { img, sel, mask }
    : {
        img: cropRGBA(img, v.x, v.y, v.width, v.height),
        sel: sel && cropMask(sel, v.x, v.y, v.width, v.height),
        mask: mask && cropMask(mask, v.x, v.y, v.width, v.height),
      };
}
function finish(job: number, s: Source, out: RGBA8, output: 'image' | 'tiles') {
  if (output === 'image') {
    post({ type: 'done', job, image: out }, [out.data.buffer]);
    return;
  }
  const img = s.base.channels === 1 ? rgbaToMask(out) : out;
  const tiles = tileize(s.base, s.rect, img);
  post({ type: 'done', job, tiles }, tiles.tiles.flatMap((t) => (t.data ? [t.data.buffer] : [])));
}
let lastReport = 0;
const progressFor = (job: number) => ({
  report: (f: number) => {
    const now = performance.now();
    if (now - lastReport < 60 && f < 1) return;
    lastReport = now;
    post({ type: 'progress', job, value: f });
  },
});

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'load') {
    const raw = readPayload(m.image, m.rect);
    const img = m.image.channels === 1 ? maskToRGBA(raw as Mask8) : (raw as RGBA8);
    sources.set(m.key, {
      rect: m.rect,
      base: m.image,
      levels: [img],
      sel: m.selection ? [readPayload(m.selection, m.rect) as Mask8] : undefined,
      mask: m.mask ? (readPayload(m.mask, m.rect) as Mask8) : undefined,
    });
    return;
  }
  if (m.type === 'drop') {
    sources.delete(m.key);
    return;
  }
  try {
    if (m.type === 'run') {
      const s = sources.get(m.key);
      if (!s) throw new Error('The filter source is not loaded.');
      const v = viewOf(s, m.view);
      const scale = (m.ctx.scale ?? 1) * (m.view ? 2 ** -m.view.level : 1);
      const out = await runStack(v.img, m.filters, { ...m.ctx, scale }, { selection: m.useSelection ? v.sel : undefined, mask: m.useMask ? v.mask : undefined }, progressFor(m.job));
      finish(m.job, s, m.keepAlpha ? keepAlpha(v.img, out) : out, m.output);
    } else if (m.type === 'thumbs') {
      const s = sources.get(m.key);
      if (!s) throw new Error('The filter source is not loaded.');
      const v = viewOf(s, m.view);
      const images: RGBA8[] = [];
      for (const filters of m.filters) {
        try {
          images.push(await runStack(v.img, filters, { ...m.ctx, scale: 2 ** -m.view.level }));
        } catch {
          images.push(v.img);
        }
      }
      post({ type: 'done', job: m.job, images }, images.map((i) => i.data.buffer).filter((b, i, a) => a.indexOf(b) === i && b !== v.img.data.buffer && b !== s.levels[0].data.buffer));
    } else if (m.type === 'liquify') {
      const s = sources.get(m.key);
      if (!s) throw new Error('The filter source is not loaded.');
      const field = LiquifyField.deserialize(m.field);
      const src = s.levels[0];
      let out = field.render(src);
      if (m.useSelection && s.sel) out = mixByMask(src, out, s.sel[0]);
      if (m.keepAlpha) out = keepAlpha(src, out);
      finish(m.job, s, out, 'tiles');
    } else if (m.type === 'fade') {
      const a = sources.get(m.beforeKey),
        b = sources.get(m.afterKey);
      if (!a || !b) throw new Error('The fade source is not loaded.');
      const va = viewOf(a, m.view),
        vb = viewOf(b, m.view);
      finish(m.job, b, fadeMix(va.img, vb.img, m.mode, m.opacity), m.output);
    }
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'CancelledError';
    post({ type: 'error', job: m.job, message: error instanceof Error ? error.message : String(error), cancelled });
  }
};
