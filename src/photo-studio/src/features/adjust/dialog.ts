// Destructive Image > Adjustments dialogs. The same editors as adjustment
// layers run in a floating dialog with a Preview checkbox; OK applies the
// exact CPU result (in a worker) to the target through applyToLayer as one
// history step, Cancel restores the canvas.
//
// Live preview of adjustment kinds on a plain layer uses the GPU: a
// temporary adjustment layer clipped to the target (and masked by the
// selection) makes the compositor adjust only the target. Masks, Quick Mask,
// layers already inside a clipping group and non-LUT operations preview the
// exact CPU result instead.
import type { Editor } from '../../editor';
import { ADJUSTMENT_LABELS, defaultParams, histograms, isSpatialKind, type Adjustment, type AdjustmentKind, type AdjustmentParamsMap } from '../../imaging/adjust';
import type { IRect, OperationContext, ParamSpec, ParamValues, RGBA8 } from '../../imaging/types';
import { allLayers, findLayer, layer, type Layer, type PhotoDocument } from '../../model/document';
import { readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import { canvasRect, selectionGrid } from '../../model/selection';
import { escapeXML } from '../../model/assets';
import { applyToLayer, hexRgb, layerRGBA, pixelTarget, previewTarget, roundIRect, toRGBA8, type PixelTarget } from '../pixels';
import { DEFAULT_MATCH, labStats, matchColorLut, type LabStats, type MatchOptions } from './match-color';
import type { AdjustHost } from './host';
import { adjustmentSpec, specAdjustment } from './compile';
import { recordStep } from '../filters/record';
import { kindEditors } from './editors';
import { cancelPick, picking, pickPoint, sampleAt, type SourceImage } from './source';
import { adjustInWorker, operationInWorker } from './worker-client';
import { h, slider, checkbox, select } from './ui';
import { svg } from '../../app/icons';
import { noteDialogCancelled } from '../action-settings';

const PREVIEW_ID = 'adjust-dialog-preview';

// ----- Target pixels -----

type TargetPixels = { area: IRect; image: RGBA8; cover?: Uint8Array };
/** The pixels an operation will see, exactly as applyToLayer reads them. */
export function readTarget(e: Editor, t: PixelTarget): TargetPixels | null {
  const doc = e.doc,
    tiles = e.assets.tiles;
  const sel = selectionGrid(doc, tiles);
  if (t.kind !== 'pixels') {
    const area = canvasRect(doc);
    const m = readMask(tiles, t.grid, area);
    const data = new Uint8ClampedArray(m.data.length * 4);
    for (let i = 0; i < m.data.length; i++) (data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = m.data[i]), (data[i * 4 + 3] = 255);
    return { area, image: { width: area.width, height: area.height, data }, cover: sel ? readMask(tiles, sel, area).data : undefined };
  }
  const g = t.grid;
  const area = sel ? (doc.selection ? roundIRect(doc.selection) : canvasRect(doc)) : g.bounds ? { ...g.bounds, x: g.bounds.x + g.x, y: g.bounds.y + g.y } : null;
  if (!area || area.width <= 0 || area.height <= 0) return null;
  return { area, image: readRGBA(tiles, g, area), cover: sel ? readMask(tiles, sel, area).data : undefined };
}

/** Grid for a computed result, blended by selection coverage like applyToLayer. */
export function resultGrid(e: Editor, t: PixelTarget, src: TargetPixels, out: RGBA8): TileGrid {
  const { cover, image } = src;
  if (t.kind !== 'pixels') {
    const next = new Uint8Array(image.width * image.height);
    for (let i = 0; i < next.length; i++) {
      const old = image.data[i * 4],
        v = out.data[i * 4];
      next[i] = cover ? old + ((v - old) * cover[i]) / 255 : v;
    }
    return writeRect(e.assets.tiles, t.grid, 0, 0, { width: image.width, height: image.height, data: next });
  }
  if (cover) {
    const d = out.data,
      s = image.data;
    for (let i = 0; i < cover.length; i++) {
      const k = cover[i] / 255;
      if (k >= 1) continue;
      for (let c = 0; c < 4; c++) d[i * 4 + c] = s[i * 4 + c] + (d[i * 4 + c] - s[i * 4 + c]) * k;
    }
  }
  return writeRect(e.assets.tiles, t.grid, src.area.x, src.area.y, out);
}

/** Document with a temporary adjustment layer clipped to `targetId`. */
export function clippedPreviewDoc(e: Editor, targetId: string, adj: Adjustment): PhotoDocument {
  const doc = e.doc;
  const temp: Layer = { ...layer('adjustment', 'Preview', doc.width, doc.height), id: PREVIEW_ID, clipped: true, adjustment: adjustmentSpec(adj) };
  const sel = selectionGrid(doc, e.assets.tiles);
  if (sel) temp.maskGrid = sel;
  const insert = (layers: Layer[]): Layer[] => {
    const i = layers.findIndex((l) => l.id === targetId);
    if (i >= 0) return [...layers.slice(0, i + 1), temp, ...layers.slice(i + 1)];
    return layers.map((l) => (l.children.length ? { ...l, children: insert(l.children) } : l));
  };
  return { ...doc, layers: insert(doc.layers) };
}

// ----- Dialog shell -----

export type Shell = { dialog: HTMLDialogElement; body: HTMLElement; preview: HTMLInputElement; status: HTMLElement; result: Promise<boolean>; close: () => void };
export function openShell(e: Editor, title: string, opts: { wide?: boolean } = {}): Shell {
  const shield = h('div', { class: 'adj-shield' });
  const dialog = h('dialog', { class: `adj-dialog ${opts.wide ? 'adj-wide' : ''}`, 'aria-label': title });
  // Fields clamp and round their own entries, so the browser's step check
  // must not block OK (Black & White starts between whole percents).
  dialog.innerHTML = `<form method="dialog" novalidate><header class="adj-dialog-head"><h2>${escapeXML(title)}</h2></header><div class="adj-dialog-main"><div class="adj-body"></div></div><footer class="adj-dialog-foot dialog-footer"><label class="adj-check"><input type="checkbox" class="adj-preview" checked><span>Preview</span></label><p class="adj-status" aria-live="polite"></p><button type="button" value="cancel" class="secondary adj-cancel">Cancel</button><button type="submit" class="primary" value="ok">OK</button></footer></form>`;
  document.body.append(shield, dialog);
  const body = dialog.querySelector<HTMLElement>('.adj-body')!,
    preview = dialog.querySelector<HTMLInputElement>('.adj-preview')!,
    status = dialog.querySelector<HTMLElement>('.adj-status')!;
  let resolve!: (ok: boolean) => void;
  const result = new Promise<boolean>((r) => (resolve = r));
  let open = true;
  const finish = (ok: boolean) => {
    if (!open) return;
    open = false;
    cancelPick();
    window.removeEventListener('keydown', keys, true);
    dialog.close();
    dialog.remove();
    shield.remove();
    resolve(ok);
  };
  // While open, keyboard input belongs to the dialog: Enter confirms, Escape
  // cancels (unless an eyedropper is armed), app shortcuts stay inactive.
  const keys = (ev: KeyboardEvent) => {
    if (picking()) return;
    const inDialog = dialog.contains(ev.target as Node);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    } else if (ev.key === 'Enter' && !(ev.target as HTMLElement).closest('button,textarea,select,[role=application]')) {
      ev.preventDefault();
      ev.stopPropagation();
      (ev.target as HTMLInputElement).dispatchEvent?.(new Event('change', { bubbles: true }));
      finish(true);
    } else if (!inDialog) {
      ev.stopPropagation();
    }
  };
  window.addEventListener('keydown', keys, true);
  dialog.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    finish(true);
  });
  dialog.querySelector('.adj-cancel')!.addEventListener('click', () => finish(false));
  shield.addEventListener('pointerdown', () => {
    if (!picking()) dialog.querySelector<HTMLElement>('.primary')?.focus();
  });
  // Drag by the title bar.
  const head = dialog.querySelector<HTMLElement>('.adj-dialog-head')!;
  head.addEventListener('pointerdown', (ev) => {
    const r = dialog.getBoundingClientRect();
    const dx = ev.clientX - r.left,
      dy = ev.clientY - r.top;
    const move = (m: PointerEvent) => {
      dialog.style.left = `${Math.max(0, Math.min(innerWidth - 80, m.clientX - dx))}px`;
      dialog.style.top = `${Math.max(0, Math.min(innerHeight - 40, m.clientY - dy))}px`;
      dialog.style.right = 'auto';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  dialog.show();
  // Start on the primary button: Enter confirms, Tab reaches the settings.
  dialog.querySelector<HTMLElement>('.primary')?.focus({ preventScroll: true });
  void e;
  return { dialog, body, preview, status, result, close: () => finish(false) };
}

/** Latest-wins scheduler: at most one job runs; newer requests replace queued ones. */
export function latest() {
  let queued: (() => Promise<void>) | undefined,
    running = false;
  return (job: () => Promise<void>) => {
    queued = job;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued) {
          const j = queued;
          queued = undefined;
          await j().catch(() => {});
        }
      } finally {
        running = false;
      }
    })();
  };
}

function restore(e: Editor) {
  delete e.settings.quickMaskPreview;
  e.update();
}

const sourceFor = (src: TargetPixels): SourceImage => ({
  image: src.image,
  x: src.area.x,
  y: src.area.y,
  hist: histograms(src.image, src.cover ? { width: src.image.width, height: src.image.height, data: src.cover } : undefined),
});

// ----- Adjustment kind dialogs -----

export async function adjustmentDialog<K extends AdjustmentKind>(e: Editor, kind: K, initial?: AdjustmentParamsMap[K]) {
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const src = readTarget(e, target);
  if (!src) return e.message('The layer is empty.');
  const label = ADJUSTMENT_LABELS[kind];
  const shell = openShell(e, label, { wide: kind === 'curves' || kind === 'levels' || kind === 'hue-saturation' || kind === 'gradient-map' });
  // Clarity & Dehaze and Grain read neighboring pixels: clipped to a masked
  // layer, the GPU would see the hidden part as transparent while OK adjusts
  // the pixels under the mask too, so those preview the CPU result.
  const masked = target.kind === 'pixels' && !!target.layer.maskGrid && !target.layer.maskDisabled;
  const gpu = target.kind === 'pixels' && !target.layer.clipped && !(masked && isSpatialKind(kind));
  const schedule = latest();
  const source = sourceFor(src);
  const host: AdjustHost<K> = {
    e,
    kind,
    params: initial ?? defaultParams(kind),
    ui: {},
    dialog: true,
    change() {
      if (shell.preview.checked) refresh();
    },
    source: async () => source,
    async pick() {
      const pt = await pickPoint(e);
      return pt ? sampleAt(src.image, pt[0] - src.area.x, pt[1] - src.area.y) : null;
    },
    rerender() {
      shell.body.innerHTML = '';
      kindEditors[kind](shell.body, host as never);
    },
  };
  const adjustment = () => ({ kind, params: host.params }) as Adjustment;
  // Spatial kinds see where the pixels sit in the document.
  const placement = (r: IRect) => ({ x: r.x, y: r.y, docWidth: e.doc.width, docHeight: e.doc.height });
  const refresh = () => {
    if (gpu) {
      e.preview(clippedPreviewDoc(e, (target as { layer: Layer }).layer.id, adjustment()));
      return;
    }
    const adj = structuredClone(adjustment());
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      const out = await adjustInWorker(src.image, adj, placement(src.area));
      if (!shell.dialog.isConnected) return;
      shell.status.textContent = '';
      if (!shell.preview.checked) return;
      const doc = previewTarget(e, target, resultGrid(e, target, src, out));
      e.overlay();
      e.preview(doc);
    });
  };
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : restore(e)));
  host.rerender();
  refresh();
  const ok = await shell.result;
  restore(e);
  if (!ok) return noteDialogCancelled();
  const adj = structuredClone(adjustment());
  await applyToLayer(e, label, (image, rect) => adjustInWorker(image, adj, placement(rect)));
  recordStep(e, `adjust.${kind}`, { params: structuredClone(adj.params) });
}
/** Apply an adjustment with given settings, without its dialog (actions, scripts). */
export async function applyAdjustment(e: Editor, kind: AdjustmentKind, params: Record<string, unknown>) {
  const adj = specAdjustment({ kind, params });
  if (!adj) return;
  await applyToLayer(e, ADJUSTMENT_LABELS[kind], (image, rect) => adjustInWorker(image, adj, { x: rect.x, y: rect.y, docWidth: e.doc.width, docHeight: e.doc.height }));
}

// ----- Parameter dialogs (operations that are not adjustment kinds) -----

/** Settings from an action step or a script, checked against the operation's
 * parameters; anything missing or out of range falls back to the default. */
function operationValues(specs: ParamSpec[], given: Record<string, unknown>): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    const v = given[s.key];
    if (s.type === 'number') out[s.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
    else if (s.type === 'checkbox') out[s.key] = typeof v === 'boolean' ? v : s.default;
    else if (s.type === 'select') out[s.key] = typeof v === 'string' && s.options.some((o) => o.value === v) ? v : s.default;
    else if (s.type === 'color') out[s.key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : s.default;
    else out[s.key] = s.default;
  }
  return out;
}

/** An operation's dialog, starting from `initial` settings when given; with
 * `given` settings (actions, scripts) it applies them directly instead. */
export async function operationDialog(e: Editor, op: { id: string; label: string; params: ParamSpec[] }, extra?: (body: HTMLElement, values: ParamValues, changed: () => void, pick: () => Promise<[number, number, number] | null>) => void, given?: Record<string, unknown>, initial?: Record<string, unknown>) {
  const context = (): OperationContext => ({ foreground: hexRgb(e.color), background: hexRgb(e.background), scale: 1 });
  if (given) {
    const v = operationValues(op.params, given);
    await applyToLayer(e, op.label.replace(/…$/, ''), (image) => operationInWorker(image, op.id, v, context()));
    return;
  }
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const src = readTarget(e, target);
  if (!src) return e.message('The layer is empty.');
  const shell = openShell(e, op.label.replace(/…$/, ''));
  const values: ParamValues = initial ? operationValues(op.params, initial) : Object.fromEntries(op.params.map((p) => [p.key, p.default]));
  const schedule = latest();
  const refresh = () => {
    if (!shell.preview.checked) return;
    const v = { ...values };
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      const out = await operationInWorker(src.image, op.id, v, context());
      if (!shell.dialog.isConnected) return;
      shell.status.textContent = '';
      if (!shell.preview.checked) return;
      const doc = previewTarget(e, target, resultGrid(e, target, src, out));
      e.overlay();
      e.preview(doc);
    });
  };
  const pick = async () => {
    const pt = await pickPoint(e);
    return pt ? sampleAt(src.image, pt[0] - src.area.x, pt[1] - src.area.y) : null;
  };
  extra?.(shell.body, values, refresh, pick);
  for (const p of op.params) {
    if (p.type === 'number')
      shell.body.append(
        slider({ label: p.label, min: p.min, max: p.max, step: p.step ?? 1, value: values[p.key] as number, unit: p.unit, onInput: (v, commit) => ((values[p.key] = v), commit && refresh()) }).el,
      );
    else if (p.type === 'checkbox') shell.body.append(checkbox(p.label, values[p.key] as boolean, (v) => ((values[p.key] = v), refresh())).el);
    else if (p.type === 'select') shell.body.append(select(p.label, p.options.map((o) => [o.value, o.label]), values[p.key] as string, (v) => ((values[p.key] = v), refresh())).el);
    else if (p.type === 'color' && !extra) {
      const l = h('label', { class: 'adj-color' }, `<span>${escapeXML(p.label)}</span><input type="color" value="${values[p.key]}">`);
      l.querySelector('input')!.addEventListener('change', (ev) => ((values[p.key] = (ev.target as HTMLInputElement).value), refresh()));
      shell.body.append(l);
    }
  }
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : restore(e)));
  refresh();
  const ok = await shell.result;
  restore(e);
  if (!ok) return noteDialogCancelled();
  const v = { ...values };
  await applyToLayer(e, op.label.replace(/…$/, ''), (image) => operationInWorker(image, op.id, v, context()));
  recordStep(e, op.id, { params: v });
}

/** Sampled-color control for Replace Color: swatch, color field and eyedropper. */
export function sampledColorControl(key: string) {
  return (body: HTMLElement, values: ParamValues, changed: () => void, pick: () => Promise<[number, number, number] | null>) => {
    const row = h('div', { class: 'adj-row' });
    row.innerHTML = `<label class="adj-color"><span>Color</span><input type="color" value="${values[key]}" aria-label="Color to replace"></label>`;
    const input = row.querySelector('input')!;
    input.addEventListener('change', () => ((values[key] = input.value), changed()));
    const b = h('button', { type: 'button', class: 'icon-button adj-dropper', title: 'Sample the color to replace from the image', 'aria-label': 'Sample color', 'aria-pressed': 'false' }, svg('pipette', 15));
    b.addEventListener('click', async () => {
      if (b.getAttribute('aria-pressed') === 'true') return cancelPick();
      b.setAttribute('aria-pressed', 'true');
      const c = await pick();
      b.setAttribute('aria-pressed', 'false');
      if (!c) return;
      values[key] = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
      input.value = values[key] as string;
      changed();
    });
    row.append(b);
    body.append(row);
  };
}

// ----- Match Color -----

/** Match Color: transfer the color statistics of another layer or open
 * document onto the target, or just neutralize/scale its own colors. */
export async function matchColorDialog(e: Editor) {
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const src = readTarget(e, target);
  if (!src) return e.message('The layer is empty.');
  const shell = openShell(e, 'Match Color');
  const own = labStats(src.image, src.cover);
  const options: [string, string][] = [['', 'None']];
  for (const l of allLayers(e.doc.layers))
    if (l.kind !== 'group' && l.kind !== 'adjustment' && l.visible && (target.kind !== 'pixels' || l.id !== target.layer.id)) options.push([`layer:${l.id}`, `Layer: ${l.name}`]);
  for (const s of e.sessions) if (s !== e.session && s.hasDocument) options.push([`doc:${s.id}`, `Document: ${s.doc.name} (merged)`]);
  const o: MatchOptions = { ...DEFAULT_MATCH };
  let source: LabStats | null = null;
  const statsCache = new Map<string, LabStats>();
  let picks = 0;
  let measuring: Promise<void> = Promise.resolve();
  const loadSource = async (key: string) => {
    if (!key) return null;
    let st = statsCache.get(key);
    if (st) return st;
    let image: RGBA8 | undefined;
    if (key.startsWith('layer:')) {
      const l = findLayer(e.doc.layers, key.slice(6));
      if (l) image = await layerRGBA(e, l);
    } else {
      const s = e.sessions.find((x) => x.id === key.slice(4));
      if (s) image = toRGBA8(await e.renderer.documentPixels(s.doc, s.assets), s.doc.width, s.doc.height);
    }
    if (!image) return null;
    st = labStats(image);
    statsCache.set(key, st);
    return st;
  };
  const adjustment = (): Adjustment => ({ kind: 'color-lookup', params: { source: { type: 'lut', name: 'Match Color', lut: matchColorLut(own, source, o) }, amount: 100 } });
  const schedule = latest();
  const refresh = () => {
    if (!shell.preview.checked) return;
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      const out = await adjustInWorker(src.image, adjustment());
      if (!shell.dialog.isConnected) return;
      shell.status.textContent = '';
      if (!shell.preview.checked) return;
      e.preview(previewTarget(e, target, resultGrid(e, target, src, out)));
      e.overlay();
    });
  };
  shell.body.append(
    select('Source', options, '', (v) => {
      // Measuring takes a while; only the source chosen last is used.
      const mine = ++picks;
      shell.status.textContent = v ? 'Measuring…' : '';
      measuring = loadSource(v).then(
        (st) => {
          if (mine !== picks) return;
          source = st;
          shell.status.textContent = '';
          refresh();
        },
        () => {
          if (mine !== picks) return;
          source = null;
          shell.status.textContent = 'The source cannot be measured.';
          refresh();
        },
      );
    }).el,
    slider({ label: 'Luminance', min: 1, max: 200, value: o.luminance, onInput: (v, c) => ((o.luminance = v), c && refresh()) }).el,
    slider({ label: 'Color Intensity', min: 0, max: 200, value: o.intensity, onInput: (v, c) => ((o.intensity = v), c && refresh()) }).el,
    slider({ label: 'Fade', min: 0, max: 100, value: o.fade, onInput: (v, c) => ((o.fade = v), c && refresh()) }).el,
    checkbox('Neutralize', o.neutralize, (v) => ((o.neutralize = v), refresh())).el,
  );
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : restore(e)));
  refresh();
  const ok = await shell.result;
  restore(e);
  if (!ok) return;
  // OK while the chosen source is still being measured applies that source.
  await measuring;
  const adj = adjustment();
  await applyToLayer(e, 'Match Color', (image) => adjustInWorker(image, adj));
}
