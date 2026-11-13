// Image > Image Size: pixel dimensions, print size and resolution with
// optional resampling of every pixel layer, mask, channel and selection.
import type { Editor } from '../../editor';
import { allLayers, assertSize, resizeDocument, type PhotoDocument } from '../../model/document';
import { setLayerPixels, setLivePixels } from '../../model/pixel-layer';
import { remapCompPositions } from '../../model/layer-comps';
import { setDocumentResolution } from '../../model/text-layer';
import { emptyGrid, gridDocBounds, gridFromImage, readMask, readRGBA, writeRect, type TileGrid, type TileStore } from '../../model/tiles';
import { applySelection, selectionGrid } from '../../model/selection';
import { resize, type ResizeMethod } from '../../imaging/filters/resample';
import type { IRect, RGBA8 } from '../../imaging/types';
import { svg } from '../../app/icons';
import { compositeRGBA } from '../pixels';
import { automaticMethod, formatBytes, fromPixels, imageBytes, isPhysical, maskFromRGBA, ppcmToPpi, ppiToPpcm, rgbaFromMask, toPixels, type LengthUnit } from './math';
import { docPpi, fmt, openDialog, resolutionInfo, unitOptions } from './dialog';
import { noteDialogCancelled, paramsOf, recordStep } from '../action-settings';

export type ResampleChoice = 'automatic' | ResizeMethod;
export const RESAMPLE_METHODS: [ResampleChoice, string][] = [
  ['automatic', 'Automatic'],
  ['preserve-details', 'Preserve Details (enlargement)'],
  ['bicubic-smoother', 'Bicubic Smoother (enlargement)'],
  ['bicubic-sharper', 'Bicubic Sharper (reduction)'],
  ['bicubic', 'Bicubic (smooth gradients)'],
  ['bilinear', 'Bilinear'],
  ['nearest', 'Nearest Neighbor (hard edges)'],
];
export function resolveMethod(choice: ResampleChoice, ow: number, oh: number, w: number, h: number): ResizeMethod {
  return choice === 'automatic' ? automaticMethod(ow, oh, w, h) : choice;
}
/** Scale a document-space rectangle, keeping edges on whole pixels. */
export function scaleRect(r: IRect, sx: number, sy: number): IRect {
  const x = Math.round(r.x * sx),
    y = Math.round(r.y * sy);
  return { x, y, width: Math.max(1, Math.round((r.x + r.width) * sx) - x), height: Math.max(1, Math.round((r.y + r.height) * sy) - y) };
}
function resizeGrid(store: TileStore, grid: TileGrid, sx: number, sy: number, method: ResizeMethod): TileGrid {
  if (grid.channels === 4) {
    const b = gridDocBounds(grid);
    if (!b) return grid;
    const nb = scaleRect(b, sx, sy);
    return gridFromImage(store, resize(readRGBA(store, grid, b), nb.width, nb.height, method), nb.x, nb.y);
  }
  // Masks: resample the stored region; absent tiles keep the fill value.
  const keys = Object.keys(grid.tiles);
  if (!keys.length) return grid;
  const b = grid.fill ? tileRect(grid) : gridDocBounds(grid);
  if (!b) return grid;
  const nb = scaleRect(b, sx, sy);
  const m = maskFromRGBA(resize(rgbaFromMask(readMask(store, grid, b)), nb.width, nb.height, method));
  return writeRect(store, { ...emptyGrid(1), fill: grid.fill }, nb.x, nb.y, m);
}
function tileRect(grid: TileGrid): IRect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const k of Object.keys(grid.tiles)) {
    const [tx, ty] = k.split(',').map(Number);
    x0 = Math.min(x0, tx);
    y0 = Math.min(y0, ty);
    x1 = Math.max(x1, tx + 1);
    y1 = Math.max(y1, ty + 1);
  }
  return { x: x0 * 256 + grid.x, y: y0 * 256 + grid.y, width: (x1 - x0) * 256, height: (y1 - y0) * 256 };
}
/** Resample the document to width x height (one history step). */
export function resampleDocument(e: Editor, width: number, height: number, method: ResizeMethod, ppi?: number, unit: 'PPI' | 'PPCM' = 'PPI', scaleStyles = true) {
  const doc = e.doc,
    store = e.assets.tiles;
  assertSize(width, height);
  const sx = width / doc.width,
    sy = height / doc.height;
  const pixels = new Map<string, TileGrid>(),
    masks = new Map<string, TileGrid>(),
    live: ResampledGrids['live'] = new Map();
  for (const l of allLayers(doc.layers)) {
    if (l.kind === 'pixel' && l.pixels) pixels.set(l.id, resizeGrid(store, l.pixels, sx, sy, method));
    if (l.maskGrid) masks.set(l.id, resizeGrid(store, l.maskGrid, sx, sy, method));
    if (l.liveSource || l.liveMask)
      live.set(l.id, { source: l.liveSource && resizeGrid(store, l.liveSource, sx, sy, method), mask: l.liveMask && resizeGrid(store, l.liveMask, sx, sy, method) });
  }
  const sel = selectionGrid(doc, store);
  const selection = sel ? resizeGrid(store, sel, sx, sy, method) : null;
  const quickMask = doc.quickMask && resizeGrid(store, doc.quickMask, sx, sy, method);
  const channels = doc.channels?.map((c) => ({ ...c, grid: resizeGrid(store, c.grid, sx, sy, method) }));
  commitResampled(e, 'Image Size', width, height, { pixels, masks, live, selection, quickMask, channels }, ppi, unit, undefined, scaleStyles);
}
export type ResampledGrids = {
  pixels: Map<string, TileGrid>;
  masks: Map<string, TileGrid>;
  // Live Filter sources and filter masks of pixel layers.
  live?: Map<string, { source?: TileGrid; mask?: TileGrid }>;
  selection: TileGrid | null;
  quickMask?: TileGrid;
  channels?: NonNullable<PhotoDocument['channels']>;
};
/** Store resampled layer, mask, selection and channel grids as one history
 * step that resizes the document (other layers scale their transforms). */
export function commitResampled(e: Editor, label: string, width: number, height: number, g: ResampledGrids, ppi?: number, unit: 'PPI' | 'PPCM' = 'PPI', extra?: (d: PhotoDocument) => void, scaleStyles = true) {
  const before = e.doc;
  const sx = width / before.width,
    sy = height / before.height;
  e.command(label, (d) => {
    resizeDocument(d, width, height, scaleStyles);
    for (const l of allLayers(d.layers)) {
      const p = g.pixels.get(l.id);
      const lv = g.live?.get(l.id);
      if (p && lv?.source) setLivePixels(l, p, d, lv.source, lv.mask);
      else if (p) setLayerPixels(l, p, d);
      const m = g.masks.get(l.id);
      if (m) l.maskGrid = m;
    }
    if (g.channels) d.channels = g.channels;
    if (g.quickMask) d.quickMask = g.quickMask;
    applySelection(d, g.selection);
    // Resampled pixel layers get new tile origins.
    remapCompPositions(before, d, (x, y) => [x * sx, y * sy]);
    if (ppi) setDocumentResolution(d, resolutionInfo(d, ppi, unit));
    extra?.(d);
  });
}
/** The stored region of a mask grid (whole tiles; absent tiles keep the fill). */
export function maskRegion(grid: TileGrid): IRect | null {
  return Object.keys(grid.tiles).length ? (grid.fill ? tileRect(grid) : gridDocBounds(grid)) : null;
}

type State = { w: number; h: number; ppi: number; wu: LengthUnit; hu: LengthUnit; resUnit: 'PPI' | 'PPCM'; constrain: boolean; resample: boolean; method: ResampleChoice; scaleStyles: boolean };
type SizeSettings = { width: number; height: number; ppi: number; resUnit: 'PPI' | 'PPCM'; resample: boolean; method: ResampleChoice; scaleStyles: boolean };
/** Settings recorded by an action: sizes in pixels, or in percent with
 * `unit: 'percent'`; without `resolution` the document keeps its own. */
function sizeSettings(v: Record<string, unknown>, doc: PhotoDocument, fallback: ResampleChoice): SizeSettings {
  const percent = v.unit === 'percent';
  const size = (n: unknown, base: number) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? (percent ? (base * n) / 100 : n) : base);
  const unit = doc.resolution?.horizontalResolutionUnit ?? 'PPI';
  return {
    width: size(v.width, doc.width),
    height: size(v.height, doc.height),
    ppi: typeof v.resolution === 'number' && Number.isFinite(v.resolution) && v.resolution >= 1 ? Math.min(30000, v.resolution) : docPpi(doc),
    resUnit: v.resolution === undefined ? unit : v.resolutionUnit === 'PPCM' ? 'PPCM' : 'PPI',
    resample: v.resample !== false,
    method: RESAMPLE_METHODS.some(([m]) => m === v.method) ? (v.method as ResampleChoice) : fallback,
    scaleStyles: v.scaleStyles !== false,
  };
}
function applyImageSize(e: Editor, s: SizeSettings) {
  const doc = e.doc,
    ow = doc.width,
    oh = doc.height;
  const pw = Math.max(1, Math.round(s.width)),
    ph = Math.max(1, Math.round(s.height));
  const resolutionChanged = Math.abs(s.ppi - docPpi(doc)) > 1e-6 || s.resUnit !== (doc.resolution?.horizontalResolutionUnit ?? 'PPI');
  if (s.resample && (pw !== ow || ph !== oh)) {
    resampleDocument(e, pw, ph, resolveMethod(s.method, ow, oh, pw, ph), resolutionChanged || doc.resolution ? s.ppi : undefined, s.resUnit, s.scaleStyles);
    e.fit();
  } else if (resolutionChanged) e.command('Image Size', (d) => setDocumentResolution(d, resolutionInfo(d, s.ppi, s.resUnit)));
}

export async function imageSizeDialog(e: Editor, arg?: unknown) {
  e.transform.apply();
  e.modal?.apply();
  // Settings from an action step or a script apply without the dialog.
  const given = paramsOf(arg);
  if (given) return applyImageSize(e, sizeSettings(given, e.doc, e.preferences.interpolation));
  const doc = e.doc;
  const ow = doc.width,
    oh = doc.height,
    bits = doc.bitsPerChannel ?? 8;
  const ppi0 = docPpi(doc);
  const saved = (e.settings.imageSize as Partial<State> | undefined) ?? {};
  const st: State = {
    w: ow,
    h: oh,
    ppi: ppi0,
    wu: saved.wu ?? 'px',
    hu: saved.hu ?? 'px',
    resUnit: doc.resolution?.horizontalResolutionUnit ?? 'PPI',
    constrain: true,
    resample: saved.resample ?? true,
    method: saved.method ?? e.preferences.interpolation,
    scaleStyles: saved.scaleStyles ?? true,
  };
  const initial = paramsOf(arg, 'initial');
  if (initial) {
    const s = sizeSettings(initial, doc, st.method);
    Object.assign(st, { w: s.width, h: s.height, ppi: s.ppi, resUnit: s.resUnit, resample: s.resample, method: s.method, scaleStyles: s.scaleStyles });
    st.constrain = Math.abs(s.width / s.height - ow / oh) < 1e-3;
  }
  const composite = compositeRGBA(e).catch(() => undefined);
  const html = `<form method="dialog" class="image-size"><h2>Image Size</h2>
    <div class="is-layout">
      <figure class="is-preview"><canvas width="168" height="168" aria-label="Preview at 100%"></canvas><figcaption>Preview (100%)</figcaption></figure>
      <div class="is-fields">
        <p class="is-readout">Image Size: <strong data-is="size"></strong> <span data-is="was"></span></p>
        <p class="is-readout">Dimensions: <strong data-is="dims"></strong></p>
        <div class="is-grid">
          <span class="is-link-bracket" aria-hidden="true"></span>
          <label for="is-w">Width</label><input id="is-w" type="number" min="0" step="any" required><select id="is-wu" aria-label="Width unit"></select>
          <button type="button" class="icon-button toggle is-link" aria-pressed="true" title="Constrain proportions" aria-label="Constrain proportions">${svg('link', 15)}</button>
          <label for="is-h">Height</label><input id="is-h" type="number" min="0" step="any" required><select id="is-hu" aria-label="Height unit"></select>
          <label for="is-res">Resolution</label><input id="is-res" type="number" min="1" step="any" required><select id="is-resu" aria-label="Resolution unit"><option value="PPI">Pixels/Inch</option><option value="PPCM">Pixels/Centimeter</option></select>
        </div>
        <div class="is-resample"><label><input id="is-resample" type="checkbox"> Resample</label><select id="is-method" aria-label="Resample method">${RESAMPLE_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <label class="is-scale-styles" title="Resize layer effects (shadows, strokes, glows…) with the image"><input id="is-scale-styles" type="checkbox"> Scale Styles</label>
        <p class="is-note" data-is="note"></p>
      </div>
    </div>
    <div class="dialog-actions"><button type="button" data-dialog-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  let previewTimer = 0;
  const ok = await openDialog(html, 'ts-image-size', (form) => {
    const $ = <T extends HTMLElement>(sel: string) => form.querySelector<T>(sel)!;
    const w = $<HTMLInputElement>('#is-w'),
      h = $<HTMLInputElement>('#is-h'),
      res = $<HTMLInputElement>('#is-res');
    const wu = $<HTMLSelectElement>('#is-wu'),
      hu = $<HTMLSelectElement>('#is-hu'),
      resu = $<HTMLSelectElement>('#is-resu');
    const resample = $<HTMLInputElement>('#is-resample'),
      method = $<HTMLSelectElement>('#is-method'),
      link = $<HTMLButtonElement>('.is-link');
    const canvas = $<HTMLCanvasElement>('canvas');
    const sync = (except?: HTMLElement) => {
      const pw = Math.max(1, Math.round(st.w)),
        ph = Math.max(1, Math.round(st.h));
      if (except !== w) w.value = fmt(fromPixels(st.w, st.wu, st.ppi, ow), st.wu);
      if (except !== h) h.value = fmt(fromPixels(st.h, st.hu, st.ppi, oh), st.hu);
      if (except !== res) res.value = String(Math.round((st.resUnit === 'PPCM' ? ppiToPpcm(st.ppi) : st.ppi) * 1000) / 1000);
      wu.innerHTML = unitOptions(st.wu);
      hu.innerHTML = unitOptions(st.hu);
      resu.value = st.resUnit;
      resample.checked = st.resample;
      method.value = st.method;
      method.disabled = !st.resample;
      $<HTMLInputElement>('#is-scale-styles').disabled = !st.resample;
      link.setAttribute('aria-pressed', String(st.constrain || !st.resample));
      link.disabled = !st.resample;
      // Without resampling the pixel grid is fixed: only print size changes.
      w.disabled = !st.resample && !isPhysical(st.wu);
      h.disabled = !st.resample && !isPhysical(st.hu);
      form.classList.toggle('is-linked', st.constrain || !st.resample);
      const now = imageBytes(pw, ph, bits),
        was = imageBytes(ow, oh, bits);
      $('[data-is="size"]').textContent = formatBytes(now);
      $('[data-is="was"]').textContent = now !== was ? `(was ${formatBytes(was)})` : '';
      $('[data-is="dims"]').textContent = `${pw} px × ${ph} px`;
      const tooBig = pw > 8192 || ph > 8192 || pw * ph > 24_000_000;
      $('[data-is="note"]').textContent = tooBig ? 'Use dimensions up to 8192 pixels and 24 megapixels.' : st.resample ? `Resample with ${RESAMPLE_METHODS.find(([v]) => v === st.method)![1].replace(/ \(.*\)/, '')}${st.method === 'automatic' ? ` (${labelFor(resolveMethod('automatic', ow, oh, pw, ph))})` : ''}.` : 'Pixel dimensions stay the same; only the print size and resolution change.';
      (form.querySelector('[type=submit]') as HTMLButtonElement).disabled = tooBig;
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => void drawPreview(canvas, composite, ow, oh, st), 120);
    };
    const onLength = (axis: 'w' | 'h') => () => {
      const input = axis === 'w' ? w : h;
      const v = Number(input.value);
      if (!(v > 0)) return;
      const unit = axis === 'w' ? st.wu : st.hu,
        base = axis === 'w' ? ow : oh;
      if (st.resample) {
        const px = toPixels(v, unit, st.ppi, base);
        if (axis === 'w') {
          st.w = px;
          if (st.constrain) st.h = (px * oh) / ow;
        } else {
          st.h = px;
          if (st.constrain) st.w = (px * ow) / oh;
        }
      } else if (isPhysical(unit)) {
        // Fixed pixels: the typed print size sets the resolution.
        st.ppi = base / toPixels(v, unit, 1, base);
      }
      sync(input);
    };
    w.addEventListener('input', onLength('w'));
    h.addEventListener('input', onLength('h'));
    res.addEventListener('input', () => {
      const v = Number(res.value);
      if (!(v > 0)) return;
      const ppi = st.resUnit === 'PPCM' ? ppcmToPpi(v) : v;
      // Resampling keeps the print size, so pixel dimensions follow the resolution.
      if (st.resample) {
        st.w = (st.w * ppi) / st.ppi;
        st.h = (st.h * ppi) / st.ppi;
      }
      st.ppi = ppi;
      sync(res);
    });
    wu.addEventListener('change', () => {
      st.wu = wu.value as LengthUnit;
      if (st.constrain || !st.resample) st.hu = st.wu;
      sync();
    });
    hu.addEventListener('change', () => {
      st.hu = hu.value as LengthUnit;
      if (st.constrain || !st.resample) st.wu = st.hu;
      sync();
    });
    resu.addEventListener('change', () => {
      st.resUnit = resu.value as 'PPI' | 'PPCM';
      sync();
    });
    resample.addEventListener('change', () => {
      st.resample = resample.checked;
      if (!st.resample) {
        st.w = ow;
        st.h = oh;
      }
      sync();
    });
    method.addEventListener('change', () => {
      st.method = method.value as ResampleChoice;
      sync();
    });
    const scaleStyles = $<HTMLInputElement>('#is-scale-styles');
    scaleStyles.checked = st.scaleStyles;
    scaleStyles.addEventListener('change', () => (st.scaleStyles = scaleStyles.checked));
    link.addEventListener('click', () => {
      st.constrain = !st.constrain;
      if (st.constrain) st.h = (st.w * oh) / ow;
      sync();
    });
    sync();
  });
  clearTimeout(previewTimer);
  if (!ok) return noteDialogCancelled();
  e.settings.imageSize = { wu: st.wu, hu: st.hu, resample: st.resample, method: st.method, scaleStyles: st.scaleStyles };
  const resolutionChanged = Math.abs(st.ppi - ppi0) > 1e-6 || st.resUnit !== (doc.resolution?.horizontalResolutionUnit ?? 'PPI');
  applyImageSize(e, { width: st.w, height: st.h, ppi: st.ppi, resUnit: st.resUnit, resample: st.resample, method: st.method, scaleStyles: st.scaleStyles });
  // Sizes given in percent replay as percent of each document's size.
  const percent = st.wu === 'percent' && st.hu === 'percent';
  recordStep(e, 'image.image-size', {
    params: {
      ...(percent ? { width: (st.w / ow) * 100, height: (st.h / oh) * 100, unit: 'percent' } : { width: Math.max(1, Math.round(st.w)), height: Math.max(1, Math.round(st.h)) }),
      ...(resolutionChanged ? { resolution: st.ppi, resolutionUnit: st.resUnit } : {}),
      resample: st.resample,
      method: st.method,
      scaleStyles: st.scaleStyles,
    },
  });
}
const labelFor = (m: ResizeMethod) => RESAMPLE_METHODS.find(([v]) => v === m)?.[1].replace(/ \(.*\)/, '') ?? m;
/** 100% view of the image center after resampling with the chosen method. */
async function drawPreview(canvas: HTMLCanvasElement, composite: Promise<RGBA8 | undefined>, ow: number, oh: number, st: State) {
  const img = await composite;
  const ctx = canvas.getContext('2d');
  if (!img || !ctx) return;
  const W = canvas.width,
    H = canvas.height;
  const pw = Math.max(1, Math.round(st.resample ? st.w : ow)),
    ph = Math.max(1, Math.round(st.resample ? st.h : oh));
  const fx = pw / ow,
    fy = ph / oh;
  const method = st.resample ? resolveMethod(st.method, ow, oh, pw, ph) : 'nearest';
  // Source region covering the view plus filter margins.
  const margin = 4;
  const rw = Math.min(ow, Math.ceil(W / fx) + margin * 2),
    rh = Math.min(oh, Math.ceil(H / fy) + margin * 2);
  const rx = Math.max(0, Math.min(ow - rw, Math.round(ow / 2 - rw / 2))),
    ry = Math.max(0, Math.min(oh - rh, Math.round(oh / 2 - rh / 2)));
  const region: RGBA8 = { width: rw, height: rh, data: new Uint8ClampedArray(rw * rh * 4) };
  for (let y = 0; y < rh; y++) region.data.set(img.data.subarray(((ry + y) * ow + rx) * 4, ((ry + y) * ow + rx + rw) * 4), y * rw * 4);
  const out = resize(region, Math.max(1, Math.round(rw * fx)), Math.max(1, Math.round(rh * fy)), method);
  const ox = Math.round((out.width - W) / 2),
    oy = Math.round((out.height - H) / 2);
  const view = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = x + ox,
        sy = y + oy;
      const o = (y * W + x) * 4;
      // Checkerboard behind transparency.
      const check = ((x >> 3) + (y >> 3)) & 1 ? 204 : 255;
      let r = check,
        g = check,
        b = check;
      if (sx >= 0 && sy >= 0 && sx < out.width && sy < out.height) {
        const i = (sy * out.width + sx) * 4,
          a = out.data[i + 3] / 255;
        r = out.data[i] * a + check * (1 - a);
        g = out.data[i + 1] * a + check * (1 - a);
        b = out.data[i + 2] * a + check * (1 - a);
      }
      view.data[o] = r;
      view.data[o + 1] = g;
      view.data[o + 2] = b;
      view.data[o + 3] = 255;
    }
  ctx.putImageData(view, 0, 0);
}
