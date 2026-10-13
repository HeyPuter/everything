// Image → Upscale…: enlarge the whole document with Enhanced Upscale (an
// edge-directed method that runs in a worker and works offline), with a
// side-by-side comparison against bicubic. Optionally, Puter's AI service
// re-renders the visible image at the new size as an extra layer on top; that
// pass is generative, so it stays a separate layer the user can compare,
// mask or delete.
import type { Editor } from '../../editor';
import { allLayers, type Layer } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { selectionGrid } from '../../model/selection';
import { emptyGrid, gridDocBounds, gridFromImage, readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import { aiUpscale, toAIError, UPSCALE_INPUT_MAX_SIDE, UPSCALE_MODEL } from '../../imaging/ai/puter-ai';
import { resize } from '../../imaging/filters/resample';
import { enhancedUpscale } from '../../imaging/filters/upscale';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { openShell } from '../adjust/dialog';
import { checkbox, h, slider } from '../adjust/ui';
import { commitResampled, maskRegion, scaleRect } from '../transform/image-size';
import { ensureSignedIn } from '../retouch/ai';
import { mergedImage } from '../retouch/source';
import { drawImage } from '../retouch/workspace';
import { withProgress } from '../retouch/client';
import { givenParams, runJob, withTask } from './client';
import { recordStep } from '../filters/record';
import { maxPercent, upscaleSize } from './place';
import { recordGeneration } from '../generations/record';
import './assist.css';

// The most detailed block of the image (sum of luma gradients on a coarse
// grid), so the comparison shows something worth comparing.
function detailBlock(img: RGBA8, size: number): IRect {
  const { width: w, height: hh, data: d } = img;
  const bw = Math.min(size, w), bh = Math.min(size, hh);
  let best = -1, bx = Math.max(0, (w - bw) >> 1), by = Math.max(0, (hh - bh) >> 1);
  const step = Math.max(1, Math.floor(size / 2));
  const g = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  for (let y = 0; y + bh <= hh; y += step)
    for (let x = 0; x + bw <= w; x += step) {
      let s = 0;
      for (let yy = y + 1; yy < y + bh; yy += 2)
        for (let xx = x + 1; xx < x + bw; xx += 2) {
          const i = (yy * w + xx) * 4;
          s += Math.abs(g(i) - g(i - 4)) + Math.abs(g(i) - g(i - w * 4));
        }
      if (s > best) [best, bx, by] = [s, x, y];
    }
  return { x: bx, y: by, width: bw, height: bh };
}
function crop(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}

type Settings = { percent: number; detail: number; ai: boolean };
const remembered: Settings = { percent: 200, detail: 50, ai: false };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export async function upscaleDialog(e: Editor, arg?: unknown) {
  e.transform.apply();
  e.modal?.apply();
  const doc = e.doc, W = doc.width, H = doc.height;
  const limit = maxPercent(W, H);
  if (limit <= 100) return e.message('The image is already at the size limit (8192 pixels per side, 24 megapixels).');
  const given = givenParams(arg);
  if (given) {
    // Recorded actions replay the offline upscale only (never the AI pass).
    const percent = Math.round(num(given.percent, 101, 800, 200));
    if (!upscaleSize(W, H, percent).fits) return e.message(`Upscaling to ${percent}% would exceed 8192 pixels per side or 24 megapixels.`);
    return runUpscale(e, { percent, detail: num(given.detail, 0, 100, 50), ai: false });
  }
  // Generation History's Reuse Settings opens the dialog with `{ prefill }`.
  const pre = arg && typeof arg === 'object' ? (arg as { prefill?: Partial<Settings> }).prefill : undefined;
  const s: Settings = { ...remembered, percent: Math.min(remembered.percent, limit) };
  if (pre && typeof pre === 'object') {
    if (typeof pre.percent === 'number') s.percent = Math.round(num(pre.percent, 101, limit, s.percent));
    if (typeof pre.detail === 'number') s.detail = num(pre.detail, 0, 100, s.detail);
    if (typeof pre.ai === 'boolean') s.ai = pre.ai;
  }
  const shell = openShell(e, 'Upscale');
  shell.dialog.classList.add('assist-wide');
  shell.preview.closest('label')!.hidden = true;
  shell.body.classList.add('assist-form');
  const ok = shell.dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const presets = h('div', { class: 'assist-scale', role: 'group', 'aria-label': 'Scale' });
  const custom = h('input', { type: 'number', min: '101', max: String(limit), step: '1', 'aria-label': 'Scale percent' }) as HTMLInputElement;
  const readout = h('p', { class: 'assist-readout' }), note = h('p', { class: 'assist-note' });
  const before = h('canvas', { width: '160', height: '160', 'aria-label': 'Bicubic enlargement' }) as HTMLCanvasElement;
  const after = h('canvas', { width: '160', height: '160', 'aria-label': 'Enhanced Upscale' }) as HTMLCanvasElement;
  const compare = h('div', { class: 'assist-compare' });
  const fig = (c: HTMLCanvasElement, t: string) => {
    const f = h('figure');
    f.append(c, h('figcaption', {}, t));
    return f;
  };
  compare.append(fig(before, 'Bicubic'), fig(after, 'Enhanced Upscale'));
  const aiNote = h('p', { class: 'assist-note' });
  aiNote.textContent =
    `Also sends the visible image (up to ${UPSCALE_INPUT_MAX_SIDE} px on the longer side) to Puter’s AI service after you press OK, and adds its re-rendered version as a separate layer on top. ` +
    'This is generative: it can invent or change fine detail, and providers return at most about 4K pixels, so very large results are enlarged further. Needs a Puter account and may use credits.';
  const sync = () => {
    const sz = upscaleSize(W, H, s.percent);
    readout.innerHTML = `New size: <strong>${sz.width} × ${sz.height} px</strong> <span class="assist-note">(was ${W} × ${H})</span>`;
    note.className = sz.fits ? 'assist-note' : 'assist-note warn';
    note.textContent = sz.fits ? 'Every pixel layer, mask, channel and the selection are enlarged; type, shapes and embedded objects scale without loss.' : `Too large: documents are limited to 8192 pixels per side and 24 megapixels (at most ${limit}% here).`;
    ok.disabled = !sz.fits;
    custom.value = String(s.percent);
    presets.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.p) === s.percent)));
    aiNote.hidden = !s.ai;
    void drawCompare();
  };
  for (const p of [150, 200, 300, 400]) {
    const b = h('button', { type: 'button', class: 'secondary', 'data-p': String(p) }, `${p / 100}×`);
    b.disabled = p > limit;
    b.title = p > limit ? 'Beyond the document size limit' : `${p}%`;
    b.addEventListener('click', () => {
      s.percent = p;
      sync();
    });
    presets.append(b);
  }
  custom.addEventListener('change', () => {
    s.percent = Math.max(101, Math.min(800, Math.round(Number(custom.value) || 200)));
    sync();
  });
  const row = h('div', { class: 'assist-row' });
  row.append(h('span', {}, 'Scale'), presets);
  const row2 = h('div', { class: 'assist-row' });
  const pct = h('span');
  pct.append(custom, document.createTextNode(' %'));
  row2.append(h('span', {}, 'Custom'), pct);
  shell.body.append(
    row,
    row2,
    readout,
    note,
    slider({ label: 'Detail', min: 0, max: 100, unit: '%', value: s.detail, onInput: (v, c) => ((s.detail = v), c && void drawCompare()) }).el,
    h('p', { class: 'assist-section' }, 'Comparison at 100%'),
    compare,
    h('p', { class: 'assist-section' }, 'AI'),
    checkbox('Add an AI detail layer (Puter, generative)', s.ai, (v) => ((s.ai = v), sync())).el,
    aiNote,
  );
  // Comparison: the most detailed block of the merged image at the new scale.
  const composite = mergedImage(e);
  let drawn = 0;
  const drawCompare = async () => {
    const ticket = ++drawn;
    const img = await composite;
    if (ticket !== drawn || !shell.dialog.isConnected) return;
    const f = s.percent / 100, size = Math.max(8, Math.ceil(160 / f));
    const r = detailBlock(img, size), src = crop(img, r);
    const ow = Math.round(r.width * f), oh = Math.round(r.height * f);
    const bic = resize(src, ow, oh, 'bicubic');
    let enh: RGBA8;
    try {
      enh = await runJob<RGBA8>(undefined, 'upscale', { img: crop(img, r), width: ow, height: oh, opts: { sharpen: s.detail / 100 } });
    } catch {
      enh = enhancedUpscale(src, ow, oh, { sharpen: s.detail / 100 });
    }
    if (ticket !== drawn) return;
    for (const [c, im] of [[before, bic], [after, enh]] as const) {
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, 160, 160);
      g.imageSmoothingEnabled = false;
      drawImage(g, im, 0, 0, ow, oh);
    }
  };
  sync();
  const confirmed = await shell.result;
  if (!confirmed) return;
  Object.assign(remembered, s);
  recordStep(e, 'image.upscale', { params: { percent: s.percent, detail: s.detail } });
  // Sign in now, while the click still counts as a user gesture.
  let aiReady = false;
  if (s.ai)
    try {
      await ensureSignedIn();
      aiReady = true;
    } catch (error) {
      e.message(toAIError(error).message);
    }
  await runUpscale(e, s, aiReady ? await composite : undefined);
}

/** Enlarge every grid of the document in the worker, then commit once. */
async function runUpscale(e: Editor, s: Settings, aiSource?: RGBA8) {
  const doc = e.doc, store = e.assets.tiles;
  const { width: nw, height: nh, fits } = upscaleSize(doc.width, doc.height, s.percent);
  if (!fits) return;
  const sx = nw / doc.width, sy = nh / doc.height;
  // The AI request runs while the classic upscale is computed.
  const aiCtrl = new AbortController();
  const aiJob = aiSource ? aiUpscale(aiSource, nw, nh, { signal: aiCtrl.signal }).catch((error) => toAIError(error)) : undefined;
  const opts = { sharpen: s.detail / 100 };
  const layers = allLayers(doc.layers);
  type Kind = 'pixels' | 'mask' | 'live-source' | 'live-mask';
  const work: { id: string; kind: Kind; grid: TileGrid }[] = [];
  for (const l of layers) {
    if (l.kind === 'pixel' && l.pixels) work.push({ id: l.id, kind: 'pixels', grid: l.pixels });
    if (l.maskGrid) work.push({ id: l.id, kind: 'mask', grid: l.maskGrid });
    if (l.liveSource) work.push({ id: l.id, kind: 'live-source', grid: l.liveSource });
    if (l.liveMask) work.push({ id: l.id, kind: 'live-mask', grid: l.liveMask });
  }
  const sel = selectionGrid(doc, store);
  const result = await withTask(e, 'Upscaling', async (job) => {
    const pixels = new Map<string, TileGrid>(), masks = new Map<string, TileGrid>();
    const live = new Map<string, { source?: TileGrid; mask?: TileGrid }>();
    const liveOf = (id: string) => live.get(id) ?? live.set(id, {}).get(id)!;
    const total = work.length + (sel ? 1 : 0) + (doc.channels?.length ?? 0) || 1;
    let k = 0;
    const range = (): [number, number] => [k / total, (k + 1) / total];
    const upMask = async (grid: TileGrid): Promise<TileGrid> => {
      const b = maskRegion(grid);
      if (!b) return grid;
      const nb = scaleRect(b, sx, sy);
      const m = await runJob<Mask8>(job, 'upscale-mask', { mask: readMask(store, grid, b), width: nb.width, height: nb.height }, range());
      return writeRect(store, { ...emptyGrid(1), fill: grid.fill }, nb.x, nb.y, m);
    };
    const upPixels = async (grid: TileGrid): Promise<TileGrid> => {
      const b = gridDocBounds(grid);
      if (!b) return grid;
      const nb = scaleRect(b, sx, sy);
      const img = await runJob<RGBA8>(job, 'upscale', { img: readRGBA(store, grid, b), width: nb.width, height: nb.height, opts }, range());
      return gridFromImage(store, img, nb.x, nb.y);
    };
    for (const w of work) {
      if (w.kind === 'pixels') pixels.set(w.id, await upPixels(w.grid));
      else if (w.kind === 'mask') masks.set(w.id, await upMask(w.grid));
      else if (w.kind === 'live-source') liveOf(w.id).source = await upPixels(w.grid);
      else liveOf(w.id).mask = await upMask(w.grid);
      k++;
    }
    const selection = sel ? await upMask(sel) : null;
    if (sel) k++;
    const channels = doc.channels ? [] as NonNullable<typeof doc.channels> : undefined;
    for (const c of doc.channels ?? []) {
      channels!.push({ ...c, grid: await upMask(c.grid) });
      k++;
    }
    return { pixels, masks, live, selection, channels };
  });
  if (!result) {
    aiCtrl.abort();
    return;
  }
  commitResampled(e, 'Upscale', nw, nh, result);
  e.fit();
  e.update();
  if (!aiJob) return e.message(`Upscaled to ${nw} × ${nh} px.`);
  // The AI layer arrives afterwards; the classic result is already in place.
  const ai = await withProgress(e, 'Waiting for the AI detail layer', async (job) => {
    job.signal.addEventListener('abort', () => aiCtrl.abort());
    const out = await aiJob;
    if (!(out instanceof Error)) return { native: { width: out.width, height: out.height }, image: await runJob<RGBA8>(job, 'resize', { img: out, width: nw, height: nh }) };
    return out;
  });
  if (!ai) return;
  if (ai instanceof Error) return e.message(`Upscaled to ${nw} × ${nh} px. The AI detail layer failed: ${ai.message}`);
  const l: Layer = newPixelLayer('AI Upscale (generative)', e.doc, gridFromImage(e.assets.tiles, ai.image));
  l.generated = { kind: 'upscale', prompt: 'Re-render at higher resolution', model: UPSCALE_MODEL };
  void recordGeneration(e, { kind: 'upscale', prompt: 'Re-render at higher resolution', model: UPSCALE_MODEL, settings: { percent: s.percent, detail: s.detail, ai: true, dialog: 'upscale' }, placement: { x: 0, y: 0, width: nw, height: nh } }, ai.image);
  e.command('AI Upscale Layer', (d) => d.layers.push(l));
  e.selectLayers([l.id]);
  e.update();
  const smaller = ai.native.width < nw || ai.native.height < nh;
  e.message(`Upscaled to ${nw} × ${nh} px and added the AI layer on top${smaller ? ` (the service returned ${ai.native.width} × ${ai.native.height} px, enlarged to fit)` : ''}.`);
}
