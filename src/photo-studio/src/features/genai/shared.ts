// Shared parts of the generative layout dialogs (AI Recompose, Remove
// Reflections, Rotate Object): the support check, the notice about what is
// sent, the variation picker, running AI requests with Stop, choosing the
// object to work on and adding the results as layers in one undo step.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { findLayer, insertLayerAt, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { canvasRect, selectionGrid } from '../../model/selection';
import { gridDocBounds, readMask, readRGBA } from '../../model/tiles';
import { toAIError, type AIError } from '../../imaging/ai/puter-ai';
import { CancelledError, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';
import { compositeRGBA } from '../pixels';
import { ensureSignedIn } from '../retouch/ai';
import { buffersOf, channel } from '../retouch/client';
import { mergedImage } from '../retouch/source';
import { drawImage } from '../retouch/workspace';
import { runJob } from '../assist/client';
import type { DetectedObject } from '../../imaging/segment/objects';
import { genaiUnsupported, objectAt } from './math';

/** False (with a message) when the command cannot run on this document. */
export function canRun(e: Editor, what: string): boolean {
  if (!e.hasDocument) return false;
  const why = genaiUnsupported(e.doc, what);
  if (why) {
    e.message(why);
    return false;
  }
  return true;
}

/** What leaves the device, before anything does. */
export const notice = (what: string) =>
  `<div class="ai-notice" role="note"><strong>Before you generate</strong><p>${escapeXML(what)} This requires a Puter account (you may be asked to sign in), and each variation is a separate request that can use credits from your Puter balance. Nothing is sent until you press Generate.</p></div>`;

/** Run `count` requests together; every image that arrived, or the first
 * error when none did. */
export async function settle<T>(count: number, one: () => Promise<T>): Promise<T[]> {
  const n = Math.max(1, Math.min(4, Math.round(count)));
  const settled = await Promise.allSettled(Array.from({ length: n }, one));
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!ok.length) throw toAIError((settled[0] as PromiseRejectedResult).reason);
  return ok;
}

/** The Generate button of a dialog: signs in, runs, turns into Stop while
 * running and reports errors in the status line. Requests already sent
 * cannot be recalled; Stop frees the dialog and ignores late results. */
export class Generator {
  private ctrl?: AbortController;
  constructor(
    private button: HTMLButtonElement,
    private status: HTMLElement,
    private labels: { idle: string; again: string },
    private onBusy: (busy: boolean) => void = () => {},
  ) {}
  get running() {
    return !!this.ctrl;
  }
  say(text: string, kind: '' | 'busy' | 'error' = '') {
    this.status.className = kind ? `ai-status ${kind}` : 'ai-status';
    this.status.textContent = text;
  }
  stop(note = true) {
    if (!this.ctrl) return;
    this.ctrl.abort();
    this.ctrl = undefined;
    this.busy(false, true);
    if (note) this.say('Stopped. Results that arrive later are ignored.');
  }
  private busy(on: boolean, done = false) {
    this.button.textContent = on ? 'Stop' : done ? this.labels.again : this.labels.idle;
    this.onBusy(on);
  }
  /** Start (or, while running, stop). `work` gets a signal; its result is
   * passed to `done` unless stopped. */
  async toggle<T>(
    work: (signal: AbortSignal, say: (t: string) => void) => Promise<T>,
    done: (r: T) => void,
  ) {
    if (this.ctrl) return this.stop();
    const ac = (this.ctrl = new AbortController());
    this.busy(true);
    this.say('Connecting to Puter…', 'busy');
    try {
      await ensureSignedIn();
      if (ac.signal.aborted) return;
      const r = await work(ac.signal, (t) => this.say(t, 'busy'));
      if (ac.signal.aborted) return;
      done(r);
    } catch (error) {
      if (ac.signal.aborted) return;
      const err: AIError = toAIError(error);
      if (err.code === 'cancelled') this.say('Stopped.');
      else this.say(err.message + (err.retryable ? ' You can try again.' : ''), 'error');
    } finally {
      if (this.ctrl === ac) {
        this.ctrl = undefined;
        this.busy(false, true);
      }
    }
  }
}

/** A radio group of thumbnails; arrow keys move the choice. */
export class VariationPicker {
  chosen = -1;
  private count = 0;
  constructor(
    private host: HTMLElement,
    private onChoose: (k: number) => void,
    private empty: string,
  ) {
    host.setAttribute('role', 'radiogroup');
    host.addEventListener('keydown', (ev) => {
      if (!this.count) return;
      const step =
        ev.key === 'ArrowRight' || ev.key === 'ArrowDown'
          ? 1
          : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp'
            ? -1
            : 0;
      if (!step) return;
      ev.preventDefault();
      this.choose((this.chosen + step + this.count) % this.count, true);
    });
    this.clear();
  }
  clear(text = this.empty) {
    this.count = 0;
    this.chosen = -1;
    this.host.innerHTML = `<p class="ga-empty">${escapeXML(text)}</p>`;
  }
  /** Show items, each drawn by `draw` into a canvas of at most `side` px. */
  show(
    items: {
      label: string;
      width: number;
      height: number;
      draw: (g: CanvasRenderingContext2D) => void;
    }[],
    chosen = 0,
    side = 132,
  ) {
    this.host.innerHTML = '';
    this.count = items.length;
    items.forEach((it, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', it.label);
      b.title = it.label;
      b.tabIndex = -1;
      const c = document.createElement('canvas'),
        s = Math.min(1, side / Math.max(it.width, it.height));
      c.width = Math.max(1, Math.round(it.width * s));
      c.height = Math.max(1, Math.round(it.height * s));
      it.draw(c.getContext('2d')!);
      const cap = document.createElement('span');
      cap.textContent = it.label;
      b.append(c, cap);
      b.addEventListener('click', () => this.choose(k));
      this.host.append(b);
    });
    this.choose(Math.min(chosen, items.length - 1));
  }
  choose(k: number, focus = false) {
    this.chosen = k;
    this.host.querySelectorAll<HTMLElement>('[role=radio]').forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === k));
      b.tabIndex = i === k ? 0 : -1;
      if (i === k && focus) b.focus();
    });
    if (k >= 0) this.onChoose(k);
  }
}

/** A small copy of a large picture for previews, made once so redraws
 * (sliders, dragging) never scale the full picture again. Drawn through a
 * canvas: building a resized bitmap from pixel data blocks the page far
 * longer on large images. */
export async function previewBitmap(img: RGBA8, w: number, h: number): Promise<OffscreenCanvas> {
  const out = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvasOf(img), 0, 0, out.width, out.height);
  return out;
}
/** An RGBA buffer as a canvas (drawn with `drawImage` into previews). */
export function canvasOf(img: RGBA8): OffscreenCanvas {
  const c = new OffscreenCanvas(img.width, img.height);
  drawImage(c.getContext('2d')!, img);
  return c;
}

// ---------------------------------------------------------------------------
// The object to work on.

export type ObjectMode = 'selection' | 'layer' | 'subject' | 'click';
export type Source = {
  // The picture the object is cut from and the hole is filled in.
  base: RGBA8;
  // The pixel layer it comes from, when not the visible image.
  layer?: Layer;
  label: string;
};
/** Canvas-sized copy (workers take ownership of what they get). */
const copy = (img: RGBA8): RGBA8 => ({
  width: img.width,
  height: img.height,
  data: new Uint8ClampedArray(img.data),
});

/** The current pixel layer, if it is one with content. */
export function pixelLayer(e: Editor): Layer | undefined {
  const l = e.layer;
  return l && l.kind === 'pixel' && l.pixels?.bounds && !e.settings.quickMask ? l : undefined;
}
/** Whether a layer has see-through parts within the canvas (a cut-out). */
export function hasTransparency(e: Editor, l: Layer | undefined): boolean {
  if (!l?.pixels) return false;
  const b = gridDocBounds(l.pixels);
  if (!b) return false;
  const { width: W, height: H } = e.doc;
  // Content that does not cover the canvas leaves see-through parts.
  if (b.x > 0 || b.y > 0 || b.x + b.width < W || b.y + b.height < H) return true;
  // Otherwise look along rows spread over the canvas (enough to tell a
  // cut-out from a photo without reading every pixel of a large layer).
  const step = Math.max(1, Math.floor(H / 256));
  let opaque = false,
    clear = false;
  for (let y = 0; y < H; y += step) {
    const row = readRGBA(e.assets.tiles, l.pixels, {
      x: 0,
      y: Math.min(H - 1, y),
      width: W,
      height: 1,
    }).data;
    for (let i = 3; i < row.length; i += 4) {
      if (row[i] > 250) opaque = true;
      else clear = true;
      if (opaque && clear) return true;
    }
  }
  return false;
}
/** Which ways of choosing the object apply now, best first. */
export function objectModes(e: Editor): ObjectMode[] {
  const out: ObjectMode[] = [];
  if (e.doc.selection) out.push('selection');
  if (hasTransparency(e, pixelLayer(e))) out.push('layer');
  out.push('subject', 'click');
  return out;
}
export const OBJECT_MODE_LABEL: Record<ObjectMode, string> = {
  selection: 'The selection',
  layer: 'The layer’s content',
  subject: 'The main subject (automatic)',
  click: 'Click an object in the preview',
};

/** The picture to work in: the current pixel layer, or the visible image.
 * For `layer` mode the picture is what lies behind that layer. */
export async function sourceFor(e: Editor, mode: ObjectMode, useLayer: boolean): Promise<Source> {
  const l = pixelLayer(e);
  if (mode === 'layer' && l) {
    const id = l.id;
    const hidden: PhotoDocument = { ...e.doc, layers: hideIn(e.doc.layers, id) };
    return {
      base: await compositeRGBA(e, hidden),
      layer: l,
      label: `What lies behind “${l.name}”`,
    };
  }
  if (useLayer && l)
    return {
      base: readRGBA(e.assets.tiles, l.pixels!, canvasRect(e.doc)),
      layer: l,
      label: `The layer “${l.name}”`,
    };
  return { base: copy(await mergedImage(e)), label: 'The visible image' };
}
function hideIn(layers: Layer[], id: string): Layer[] {
  return layers.map((x) =>
    x.id === id
      ? { ...x, visible: false }
      : x.children.length
        ? { ...x, children: hideIn(x.children, id) }
        : x,
  );
}

/** The object's canvas-sized coverage for a mode (`click` needs a point),
 * or a message saying why there is none. */
export async function objectMask(
  e: Editor,
  mode: ObjectMode,
  src: Source,
  signal: AbortSignal,
  at?: [number, number],
  found?: { list?: DetectedObject[] },
): Promise<Mask8 | string> {
  const { width: W, height: H } = e.doc;
  if (mode === 'selection') {
    const g = selectionGrid(e.doc, e.assets.tiles);
    return g ? readMask(e.assets.tiles, g, canvasRect(e.doc)) : 'Make a selection first.';
  }
  if (mode === 'layer') {
    const l = src.layer;
    if (!l?.pixels) return 'Choose a pixel layer first.';
    const img = readRGBA(e.assets.tiles, l.pixels, canvasRect(e.doc));
    const m: Mask8 = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let i = 0; i < m.data.length; i++) m.data[i] = img.data[i * 4 + 3];
    return m;
  }
  if (mode === 'subject') {
    const img = copy(src.base);
    const m = await channel('heavy').call<Mask8>(
      'subject',
      { img },
      { transfer: buffersOf(img), signal },
    );
    return m.data.some((v) => v > 127)
      ? m
      : 'No distinct subject was found. Select the object or click it instead.';
  }
  if (!at) return 'Click an object in the preview.';
  if (!found?.list) {
    const list = await runJob<DetectedObject[]>({ signal, progress: () => {} }, 'objects', {
      img: copy(src.base),
      opts: {},
    });
    if (found) found.list = list;
    return pickFrom(list, at, W, H);
  }
  return pickFrom(found.list, at, W, H);
}
function pickFrom(
  list: DetectedObject[],
  at: [number, number],
  W: number,
  H: number,
): Mask8 | string {
  const k = objectAt(list, at[0], at[1]);
  if (k < 0)
    return 'No distinct object was found there. Click another spot, or select the object first.';
  const o = list[k];
  const m: Mask8 = { width: W, height: H, data: new Uint8Array(W * H) };
  for (let y = 0; y < o.rect.height; y++)
    m.data.set(
      o.mask.data.subarray(y * o.rect.width, (y + 1) * o.rect.width),
      (y + o.rect.y) * W + o.rect.x,
    );
  return m;
}

/** Context Fill of a hole in `base` (canvas-sized), worked on a region
 * around it; returns the filled picture. */
export async function fillHole(
  base: RGBA8,
  hole: Mask8,
  box: IRect,
  signal: AbortSignal,
  progress?: (f: number) => void,
): Promise<RGBA8> {
  const { width: W, height: H } = base;
  const m = Math.min(1024, Math.max(64, 3 * Math.max(box.width, box.height)));
  const R = { x: Math.max(0, box.x - m), y: Math.max(0, box.y - m), width: 0, height: 0 };
  R.width = Math.min(W, box.x + box.width + m) - R.x;
  R.height = Math.min(H, box.y + box.height + m) - R.y;
  const crop = cropRGBA(base, R),
    h = cropMask(hole, R);
  const filled = await channel('heavy').call<RGBA8>(
    'context-fill',
    {
      img: crop,
      hole: h,
      opts: {
        colorAdaptation: 'default',
        rotationAdaptation: 'none',
        scale: false,
        mirror: false,
        seed: 1,
      },
    },
    { transfer: buffersOf(crop, h), progress, signal },
  );
  const out = copy(base);
  for (let y = 0; y < R.height; y++)
    out.data.set(
      filled.data.subarray(y * R.width * 4, (y + 1) * R.width * 4),
      ((y + R.y) * W + R.x) * 4,
    );
  return out;
}
export function cropRGBA(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    out.set(
      img.data.subarray(
        ((y + r.y) * img.width + r.x) * 4,
        ((y + r.y) * img.width + r.x + r.width) * 4,
      ),
      y * r.width * 4,
    );
  return { width: r.width, height: r.height, data: out };
}
export function cropMask(m: Mask8, r: IRect): Mask8 {
  const out = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++)
    out.set(
      m.data.subarray((y + r.y) * m.width + r.x, (y + r.y) * m.width + r.x + r.width),
      y * r.width,
    );
  return { width: r.width, height: r.height, data: out };
}

// ---------------------------------------------------------------------------
// Results as layers.

/** Insert `layers` (bottom first) above the layer `anchor` (or at the top)
 * as one undo step, optionally hiding a layer, and select the top one. */
export function addLayers(
  e: Editor,
  label: string,
  layers: Layer[],
  anchor: string | undefined,
  hide?: string,
) {
  const at = anchor && findLayer(e.doc.layers, anchor) ? anchor : undefined;
  e.command(label, (d) => {
    const place = (list: Layer[]): boolean => {
      const i = list.findIndex((x) => x.id === at);
      if (i < 0) return list.some((x) => place(x.children));
      layers.forEach((l, k) => insertLayerAt(list, i + 1 + k, l));
      return true;
    };
    if (!at || !place(d.layers)) d.layers.push(...layers);
    if (hide) {
      const h = findLayer(d.layers, hide);
      if (h) h.visible = false;
    }
  });
  e.selectLayers([layers[layers.length - 1].id]);
  e.update();
}
/** Whether a layer may be hidden or replaced (not locked). */
export const replaceable = (e: Editor, l: Layer | undefined) =>
  !!l && !layerLock(e.doc.layers, l.id, 'all');

export function shortName(prefix: string, text: string) {
  const p = text.replace(/\s+/g, ' ').trim();
  return p ? `${prefix}: ${p.length > 32 ? `${p.slice(0, 31)}…` : p}` : prefix;
}
export { CancelledError };
