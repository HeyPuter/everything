// Context Scale: resize a layer with transform handles while seam carving
// keeps detailed areas, skin tones or a saved alpha channel intact. The seam
// order of each axis is found once in workers (first for a reduced preview
// copy, then at full size), so dragging only replays it.
import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { findLayer } from '../../model/document';
import { setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage, readMask } from '../../model/tiles';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import type { Point } from '../../imaging/filters/warp';
import { resize } from '../../imaging/filters/resample';
import { contextScale, protectionMap, seamOrder, seamSize, widthPass, type ContextScaleOrders, type SeamAxis } from '../../imaging/warp/seam-carve';
import { handleUV, type Handle } from '../transform/math';
import { progressHud } from '../filters/hud';
import { previewCopy, WarpSession, warpTarget } from './session';
import { seamOrderJob } from './client';

export { CONTEXT_SCALE_TOOL } from './ids';
import { CONTEXT_SCALE_TOOL } from './ids';
// Seams are searched for up to this share of each side.
const SEAM_SHARE = 0.6;
type Snap = { frame: IRect; amount: number; protect: string; skin: boolean };
type Drag = { kind: 'move' | Handle; start: Point; frame: IRect; moved: boolean };
type Settings = { amount: number; protect: string; skin: boolean };
function settings(e: Editor): Settings {
  const s = ((e.settings.contextScale as Partial<Settings> | undefined) ??= {}) as Partial<Settings>;
  s.amount ??= 100;
  s.protect ??= '';
  s.skin ??= false;
  return s as Settings;
}

/** New frame for a handle drag: corners keep proportions (Shift frees
 * them), sides change one dimension (Shift keeps proportions), Alt scales
 * about the centre. */
export function resizeFrame(r: IRect, handle: Handle, delta: Point, proportional: boolean, centered: boolean): IRect {
  const h = handleUV[handle];
  const sx = h.x === 0 ? -1 : h.x === 1 ? 1 : 0,
    sy = h.y === 0 ? -1 : h.y === 1 ? 1 : 0;
  const k = centered ? 2 : 1;
  let w = r.width + sx * delta.x * k,
    ht = r.height + sy * delta.y * k;
  if (proportional) {
    const aspect = r.width / r.height;
    if (sx && sy) {
      // Follow whichever axis moved further, relative to the frame.
      if (Math.abs(w / r.width - 1) >= Math.abs(ht / r.height - 1)) ht = w / aspect;
      else w = ht * aspect;
    } else if (sx) ht = w / aspect;
    else w = ht * aspect;
  }
  w = Math.max(1, w);
  ht = Math.max(1, ht);
  // The opposite side (or the centre) stays put.
  const ax = centered ? r.x + r.width / 2 : sx < 0 ? r.x + r.width : sx > 0 ? r.x : r.x + r.width / 2;
  const ay = centered ? r.y + r.height / 2 : sy < 0 ? r.y + r.height : sy > 0 ? r.y : r.y + r.height / 2;
  const x = centered || !sx ? ax - w / 2 : sx < 0 ? ax - w : ax,
    y = centered || !sy ? ay - ht / 2 : sy < 0 ? ay - ht : ay;
  return { x, y, width: w, height: ht };
}

class ContextScaleSession extends WarpSession<Snap> {
  private readonly rect: IRect;
  private readonly source: RGBA8;
  private readonly small: { image: RGBA8; factor: number };
  frame: IRect;
  private s: Settings;
  private drag?: Drag;
  private smallOrders?: ContextScaleOrders;
  private fullOrders?: Promise<ContextScaleOrders>;
  private fullReady?: ContextScaleOrders;
  private fullProgress = 0;
  private jobs: (() => void)[] = [];
  private smallProtect?: Uint8Array;
  private fullProtect?: Uint8Array;
  private waiting?: ReturnType<typeof progressHud>;

  constructor(e: Editor, layerId: string, rect: IRect, source: RGBA8) {
    super(e, CONTEXT_SCALE_TOOL, layerId);
    this.rect = rect;
    this.source = source;
    this.small = previewCopy(source, 900);
    this.frame = { ...rect };
    this.s = settings(e);
    if (this.s.protect && !e.doc.channels?.some((c) => c.id === this.s.protect)) this.s.protect = '';
    this.analyze();
  }

  // ----- Seam orders -----
  private protection(img: RGBA8, full: boolean): Uint8Array | undefined {
    const channel = this.s.protect ? this.base.channels?.find((c) => c.id === this.s.protect) : undefined;
    let mask: Mask8 | undefined;
    if (channel) {
      mask = readMask(this.e.assets.tiles, channel.grid, this.rect);
      if (!full) {
        // Nearest samples of the full-size channel for the preview copy.
        const small: Mask8 = { width: img.width, height: img.height, data: new Uint8Array(img.width * img.height) };
        for (let y = 0; y < img.height; y++)
          for (let x = 0; x < img.width; x++) {
            const sx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / img.width)),
              sy = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / img.height));
            small.data[y * img.width + x] = mask.data[sy * mask.width + sx];
          }
        mask = small;
      }
    }
    return protectionMap(img, { skin: this.s.skin, mask });
  }
  /** (Re)start the seam searches for the current protection settings. */
  private analyze() {
    for (const cancel of this.jobs) cancel();
    this.jobs = [];
    this.smallOrders = undefined;
    this.fullReady = undefined;
    this.fullProgress = 0;
    this.exact?.cancel?.();
    this.exact = undefined;
    this.finalRows = undefined;
    const run = (img: RGBA8, full: boolean, progress?: (f: number) => void) => {
      const protect = this.protection(img, full);
      // The preview copy is the full image when it is small enough.
      if (full || this.small.factor >= 1) this.fullProtect = protect;
      if (!full) this.smallProtect = protect;
      const axis = (a: SeamAxis, n: number, p?: (f: number) => void) => {
        const j = seamOrderJob(img, a, Math.floor(n * SEAM_SHARE), protect, p);
        this.jobs.push(j.cancel);
        return j.promise;
      };
      // Both axes run in parallel; progress follows the slower one.
      const f = [0, 0];
      const report = (i: number) => (v: number) => {
        f[i] = v;
        progress?.(Math.min(f[0], f[1]));
      };
      return Promise.all([axis('vertical', img.width, report(0)), axis('horizontal', img.height, report(1))]).then(([vertical, horizontal]) => ({ vertical, horizontal }));
    };
    const ignore = (error: Error) => {
      if (error.message !== 'cancelled' && !this.ended) this.e.message(error.message);
    };
    run(this.small.image, false)
      .then((o) => {
        if (this.ended) return;
        this.smallOrders = o;
        this.refresh(true);
        this.e.options();
      })
      .catch(ignore);
    const full = this.small.factor < 1 ? run(this.source, true, (f) => this.onFullProgress(f)) : run(this.small.image, false);
    this.fullOrders = full;
    full
      .then((o) => {
        if (this.ended || this.fullOrders !== full) return;
        this.fullReady = o;
        this.onFullProgress(1);
      })
      .catch(ignore);
  }
  private onFullProgress(f: number) {
    this.fullProgress = f;
    this.waiting?.set(f);
  }
  protected dispose() {
    for (const cancel of this.jobs) cancel();
    this.jobs = [];
    this.waiting?.close();
  }

  // ----- Session state -----
  protected snapshot(): Snap {
    return { frame: { ...this.frame }, amount: this.s.amount, protect: this.s.protect, skin: this.s.skin };
  }
  protected restore(s: Snap) {
    const reanalyze = s.protect !== this.s.protect || s.skin !== this.s.skin;
    this.frame = { ...s.frame };
    this.s.amount = s.amount;
    this.s.protect = s.protect;
    this.s.skin = s.skin;
    if (reanalyze) this.analyze();
  }
  private get changed() {
    const f = this.frame,
      r = this.rect;
    return Math.round(f.x) !== r.x || Math.round(f.y) !== r.y || Math.round(f.width) !== r.width || Math.round(f.height) !== r.height;
  }
  private setFrame(f: IRect) {
    this.frame = f;
    this.syncFields();
    this.refresh(false);
  }

  // ----- Pointer -----
  pointerDown(p: CanvasPointer) {
    const name = (p.event.target as Element).closest?.('[data-cs-handle]')?.getAttribute('data-cs-handle') as Handle | null;
    const at = { x: p.x, y: p.y };
    const f = this.frame;
    const inside = at.x >= f.x && at.x <= f.x + f.width && at.y >= f.y && at.y <= f.y + f.height;
    if (!name && !inside) return;
    this.push();
    this.drag = { kind: name ?? 'move', start: at, frame: { ...f }, moved: false };
  }
  pointerMove(p: CanvasPointer) {
    const d = this.drag;
    if (!d) return;
    d.moved = true;
    const delta = { x: p.x - d.start.x, y: p.y - d.start.y };
    if (d.kind === 'move') this.setFrame({ ...d.frame, x: d.frame.x + delta.x, y: d.frame.y + delta.y });
    else {
      const corner = handleUV[d.kind].x !== 0.5 && handleUV[d.kind].y !== 0.5;
      this.setFrame(resizeFrame(d.frame, d.kind, delta, corner ? !p.shift : p.shift, p.alt));
    }
  }
  pointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    if (!d.moved) this.discardPush();
    // Whole pixels, as the result will have.
    const f = this.frame;
    this.frame = { x: Math.round(f.x), y: Math.round(f.y), width: Math.max(1, Math.round(f.width)), height: Math.max(1, Math.round(f.height)) };
    this.syncFields();
    this.refresh(true);
  }
  hover(p: CanvasPointer) {
    if ((p.event.target as Element).closest?.('[data-cs-handle]')) return '';
    const f = this.frame;
    return p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height ? 'move' : 'default';
  }
  keyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter') {
      void this.finish();
      return true;
    }
    if (ev.key.startsWith('Arrow') && !ev.metaKey && !ev.ctrlKey) {
      const step = ev.shiftKey ? 10 : 1;
      this.push();
      this.frame = { ...this.frame, x: this.frame.x + (ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0), y: this.frame.y + (ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0) };
      this.syncFields();
      this.refresh(true);
      return true;
    }
    return false;
  }

  // ----- Options bar -----
  options() {
    const s = this.s;
    const f = this.frame;
    const channels = this.base.channels ?? [];
    const pct = (a: number, b: number) => Math.round((a / b) * 1000) / 10;
    let html = `<span class="transform-label">Context Scale</span>`;
    html += `<label title="Width">W <input id="cs-w" type="number" min="1" step="1" value="${Math.round(f.width)}" aria-label="Width">px</label><span class="hint" id="cs-wp">${pct(f.width, this.rect.width)}%</span>`;
    html += `<label title="Height">H <input id="cs-h" type="number" min="1" step="1" value="${Math.round(f.height)}" aria-label="Height">px</label><span class="hint" id="cs-hp">${pct(f.height, this.rect.height)}%</span>`;
    html += `<span class="divider"></span><label title="How much of the change protects content; the rest is ordinary scaling">Amount <input id="cs-amount-range" type="range" min="0" max="100" step="1" value="${s.amount}" aria-label="Amount"><input id="cs-amount" type="number" min="0" max="100" step="1" value="${s.amount}" aria-label="Amount percent">%</label>`;
    html += `<span class="divider"></span><label title="Keep the pixels of a saved selection intact">Protect <select id="cs-protect" aria-label="Protect alpha channel"><option value="">None</option>${channels.map((c) => `<option value="${escapeXML(c.id)}" ${c.id === s.protect ? 'selected' : ''}>${escapeXML(c.name)}</option>`).join('')}</select></label>`;
    html += `<button class="icon-button toggle" data-cs="skin" aria-pressed="${s.skin}" title="Protect skin tones" aria-label="Protect skin tones">${svg('protect-skin', 16)}</button>`;
    if (!this.smallOrders) html += `<span class="hint" role="status">Analyzing…</span>`;
    html += `<span class="divider"></span><button data-cs="cancel" class="icon-button" title="Cancel Context Scale (Escape)" aria-label="Cancel Context Scale">${svg('ban', 16)}</button><button data-cs="commit" class="icon-button transform-apply" title="Commit Context Scale (Enter)" aria-label="Commit Context Scale">${svg('check', 16)}</button>`;
    return html;
  }
  bindOptions(el: HTMLElement) {
    el.querySelectorAll<HTMLButtonElement>('[data-cs]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.cs;
        if (a === 'commit') void this.finish();
        else if (a === 'cancel') this.cancel();
        else if (a === 'skin') {
          this.push();
          this.s.skin = !this.s.skin;
          this.analyze();
          this.e.options();
        }
      }),
    );
    const size = (key: 'width' | 'height') => (v: string, t: HTMLInputElement) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 8192) return void (t.value = String(Math.round(this.frame[key])));
      this.push();
      this.frame = { ...this.frame, [key]: n };
      this.syncFields();
      this.refresh(true);
    };
    this.on(el, 'cs-w', size('width'));
    this.on(el, 'cs-h', size('height'));
    const amount = (v: string, commit: boolean) => {
      // A cleared or invalid entry keeps the value in use (and shows it again).
      const typed = Math.max(0, Math.min(100, Math.round(v.trim() === '' ? NaN : Number(v))));
      const n = Number.isFinite(typed) ? typed : this.s.amount;
      for (const id of ['cs-amount', 'cs-amount-range']) {
        const f = el.querySelector<HTMLInputElement>(`#${id}`);
        if (f && f.value !== String(n)) f.value = String(n);
      }
      if (n !== typed) return;
      if (commit) this.push();
      this.s.amount = n;
      this.refresh(commit);
    };
    this.on(el, 'cs-amount-range', (v) => amount(v, false), 'input');
    this.on(el, 'cs-amount-range', (v) => amount(v, true));
    this.on(el, 'cs-amount', (v) => amount(v, true));
    this.on(el, 'cs-protect', (v) => {
      this.push();
      this.s.protect = v;
      this.analyze();
      this.e.options();
    });
  }
  private syncFields() {
    const set = (id: string, v: string) => {
      const f = this.e.root.querySelector<HTMLInputElement>(`#${id}`);
      if (!f) return;
      if (f.tagName === 'INPUT') {
        if (document.activeElement !== f) f.value = v;
      } else f.textContent = v;
    };
    set('cs-w', String(Math.round(this.frame.width)));
    set('cs-h', String(Math.round(this.frame.height)));
    set('cs-wp', `${Math.round((this.frame.width / this.rect.width) * 1000) / 10}%`);
    set('cs-hp', `${Math.round((this.frame.height / this.rect.height) * 1000) / 10}%`);
  }

  // ----- Overlay -----
  overlay() {
    const z = this.e.zoom,
      sw = 1 / z,
      f = this.frame;
    let html = `<rect class="ts-frame" x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" stroke-width="${sw}"/>`;
    for (const [h, uv] of Object.entries(handleUV)) {
      const cx = f.x + uv.x * f.width,
        cy = f.y + uv.y * f.height;
      html += `<g class="transform-handle handle-${h}" data-cs-handle="${h}"><circle class="handle-hit" cx="${cx}" cy="${cy}" r="${9 / z}"/><rect x="${cx - 3.5 / z}" y="${cy - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${sw}"/></g>`;
    }
    return html;
  }

  // ----- Rendering -----
  /** Height order searched on the preview copy after its column pass, for
   * the column count in `key` (see contextScale). */
  private exact?: { key: string; order?: Uint16Array; cancel?: () => void };
  private get sizes() {
    const f = this.frame,
      k = this.small.factor;
    return { w: Math.max(1, Math.round(f.width * k)), h: Math.max(1, Math.round(f.height * k)) };
  }
  protected renderPreview(settled: boolean) {
    if (!this.changed) return undefined;
    const { w, h } = this.sizes;
    const orders = this.smallOrders;
    if (!orders) return { image: resize(this.small.image, w, h, 'bilinear'), rect: { ...this.frame } };
    const amount = this.s.amount / 100;
    const { cw, ch } = seamSize(this.small.image.width, this.small.image.height, w, h, amount);
    let heightOrder: Uint16Array | undefined;
    if (cw !== this.small.image.width && ch !== this.small.image.height) {
      const key = `${cw}`;
      if (this.exact?.key === key) heightOrder = this.exact.order;
      else if (settled) this.searchRows(key, cw, orders);
    }
    return { image: contextScale(this.small.image, orders, w, h, amount, heightOrder), rect: { ...this.frame } };
  }
  /** Search the rows of the preview copy after its column pass, then redraw. */
  private searchRows(key: string, cw: number, orders: ContextScaleOrders) {
    this.exact?.cancel?.();
    const pass = widthPass(this.small.image, orders, cw, this.smallProtect);
    const job = seamOrderJob(pass.image, 'horizontal', Math.floor(this.small.image.height * SEAM_SHARE), pass.protect);
    const entry: NonNullable<typeof this.exact> = { key, cancel: job.cancel };
    this.exact = entry;
    job.promise
      .then((order) => {
        if (this.exact !== entry || this.ended) return;
        entry.order = order;
        this.refresh(false);
      })
      .catch(() => {});
  }

  // ----- Commit -----
  // Height order for the full-size column pass, found before committing.
  private finalRows?: { cw: number; order: Uint16Array };
  /** Commit once the full-size seam searches are done, with progress. */
  async finish() {
    if (this.ended || this.waiting) return;
    if (!this.changed) return this.apply();
    const hud = (this.waiting = progressHud(this.e, 'Analyzing image…', () => this.cancel()));
    try {
      hud.set(this.fullProgress);
      const orders = await this.fullOrders!;
      const f = this.frame;
      const { cw, ch } = seamSize(this.source.width, this.source.height, Math.round(f.width), Math.round(f.height), this.s.amount / 100);
      if (cw !== this.source.width && ch !== this.source.height) {
        const pass = widthPass(this.source, orders, cw, this.fullProtect);
        const job = seamOrderJob(pass.image, 'horizontal', Math.floor(this.source.height * SEAM_SHARE), pass.protect, (v) => hud.set(v));
        this.jobs.push(job.cancel);
        this.finalRows = { cw, order: await job.promise };
      }
    } catch {
      /* Cancelled, or reported by analyze. */
    } finally {
      hud.close();
      this.waiting = undefined;
    }
    this.apply();
  }
  apply(restoreTool = true) {
    if (this.ended) return;
    if (this.e.doc !== this.base || !this.changed) return this.cancel(restoreTool);
    const f = this.frame;
    const w = Math.max(1, Math.round(f.width)),
      h = Math.max(1, Math.round(f.height));
    const amount = this.s.amount / 100;
    // Committed by another edit before the searches finished: search now.
    const protect = this.fullProtect ?? this.protection(this.source, true);
    const orders = this.fullReady ?? {
      vertical: seamOrder(this.source, 'vertical', Math.floor(this.source.width * SEAM_SHARE), protect),
      horizontal: seamOrder(this.source, 'horizontal', Math.floor(this.source.height * SEAM_SHARE), protect),
    };
    const { cw, ch } = seamSize(this.source.width, this.source.height, w, h, amount);
    let rows: Uint16Array | undefined;
    if (cw !== this.source.width && ch !== this.source.height) {
      if (this.finalRows?.cw === cw) rows = this.finalRows.order;
      else {
        const pass = widthPass(this.source, orders, cw, protect);
        rows = seamOrder(pass.image, 'horizontal', Math.floor(this.source.height * SEAM_SHARE), pass.protect);
      }
    }
    const image = contextScale(this.source, orders, w, h, amount, rows);
    const id = this.layerId;
    this.end(restoreTool);
    const grid = gridFromImage(this.e.assets.tiles, image, Math.round(f.x), Math.round(f.y));
    this.e.command('Context Scale', (d) => {
      const l = findLayer(d.layers, id);
      if (l) setLayerPixels(l, grid, d);
    });
  }
}

/** Start Context Scale on the selected layer. */
export async function startContextScale(e: Editor) {
  const target = await warpTarget(e, 'Context Scale', false);
  if (!target || target.kind !== 'pixel') return;
  if (target.rect.width < 3 || target.rect.height < 3) {
    e.message('The layer is too small to scale by content.');
    return;
  }
  const s = new ContextScaleSession(e, target.layer.id, target.rect, target.source);
  s.begin();
}
