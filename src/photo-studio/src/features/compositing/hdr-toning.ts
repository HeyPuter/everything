// Image → Adjustments → HDR Toning…: local tone mapping with a live preview.
// On 8 and 16-bit documents it adjusts the target layer like the other
// adjustments; on a 32-bit document it tone-maps the merged high-dynamic-range
// image into a flattened 8-bit document (one undoable step).
import type { Editor } from '../../editor';
import { DEFAULT_HDR_TONING, TONING_CURVES, toningCurveTable, type HdrToningParams } from '../../imaging/adjust/hdr-toning';
import { srgbToLinear } from '../../imaging/adjust/color-math';
import type { ParamValues, RGBA8, RGBAF } from '../../imaging/types';
import type { PhotoDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { applyToLayer, hexRgb, pixelTarget, previewTarget, previewTiles } from '../pixels';
import { latest, openShell, readTarget, resultGrid } from '../adjust/dialog';
import { operationInWorker } from '../adjust/worker-client';
import { h, select, slider } from '../adjust/ui';
import { previewJob, runJob, withTask } from './client';
import { recordStep } from '../filters/record';

let remembered: HdrToningParams = { ...DEFAULT_HDR_TONING };

const values = (p: HdrToningParams): ParamValues => {
  const v: ParamValues = { ...p };
  if (!TONING_CURVES[p.curve]) {
    v.curvePoints = p.curve;
    v.curve = 'linear';
  }
  return v;
};

/** Controls for every HDR Toning setting; `changed(commit)` fires on edits. */
export function toningControls(body: HTMLElement, p: HdrToningParams, changed: (commit: boolean) => void) {
  const section = (title: string) => body.append(h('h3', { class: 'comp-section' }, title));
  const num = (key: keyof HdrToningParams, label: string, min: number, max: number, step = 1, unit?: string) => {
    const s = slider({ label, min, max, step, unit, value: p[key] as number, onInput: (v, commit) => (((p as Record<string, unknown>)[key] = v), changed(commit)) });
    body.append(s.el);
    return s;
  };
  const method = select('Method', [['local', 'Local Adaptation'], ['exposure-gamma', 'Exposure and Gamma'], ['highlight-compression', 'Highlight Compression'], ['equalize', 'Equalize Histogram']], p.method, (v) => {
    p.method = v as HdrToningParams['method'];
    sync();
    changed(true);
  });
  body.append(method.el);
  const local = h('div', { class: 'comp-group' });
  const keep = body;
  body = local;
  section('Edge Glow');
  num('radius', 'Radius', 1, 500, 1, 'px');
  num('strength', 'Strength', 0.1, 4, 0.05);
  body = keep;
  body.append(local);
  section('Tone and Detail');
  num('gamma', 'Gamma', 0.1, 2, 0.01);
  num('exposure', 'Exposure', -5, 5, 0.05, 'EV');
  const detail = h('div', { class: 'comp-group' });
  body = detail;
  num('detail', 'Detail', -100, 300, 1, '%');
  section('Advanced');
  num('shadow', 'Shadows', -100, 100, 1, '%');
  num('highlight', 'Highlights', -100, 100, 1, '%');
  body = keep;
  body.append(detail);
  num('vibrance', 'Vibrance', -100, 100, 1, '%');
  num('saturation', 'Saturation', -100, 100, 1, '%');
  section('Toning Curve');
  body.append(curveEditor(p, changed));
  // Glow, detail and the tonal controls apply to Local Adaptation only.
  const sync = () => {
    local.hidden = p.method !== 'local';
    detail.hidden = p.method !== 'local';
  };
  sync();
}

/** A small curve editor: drag points, click to add, double-click to remove,
 * with presets. Writes JSON points (or a preset name) into `p.curve`. */
function curveEditor(p: HdrToningParams, changed: (commit: boolean) => void) {
  const wrap = h('div', { class: 'comp-curve' });
  const options: [string, string][] = [...Object.entries(TONING_CURVES).map(([k, c]) => [k, c.label] as [string, string]), ['custom', 'Custom']];
  let points: [number, number][] = (TONING_CURVES[p.curve]?.points ?? safePoints(p.curve)).map((q) => [q[0], q[1]]);
  const preset = select('Preset', options, TONING_CURVES[p.curve] ? p.curve : 'custom', (v) => {
    if (v === 'custom') return;
    points = TONING_CURVES[v].points.map((q) => [q[0], q[1]]);
    p.curve = v;
    draw();
    changed(true);
  });
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('viewBox', '0 0 256 256');
  svgEl.setAttribute('class', 'comp-curve-graph');
  svgEl.setAttribute('role', 'application');
  svgEl.setAttribute('aria-label', 'Toning curve: drag points, click to add, double-click to remove');
  wrap.append(preset.el, svgEl);
  const draw = () => {
    const t = toningCurveTable(JSON.stringify(points));
    let d = '';
    for (let i = 0; i < 256; i += 3) d += `${i ? 'L' : 'M'}${i} ${255 - t[i]}`;
    d += `L255 ${255 - t[255]}`;
    svgEl.innerHTML = `<path d="M64 0V256M128 0V256M192 0V256M0 64H256M0 128H256M0 192H256" class="comp-curve-grid"/><path d="M0 256L256 0" class="comp-curve-diagonal"/><path d="${d}" class="comp-curve-line"/>${points.map(([x, y], i) => `<circle cx="${x}" cy="${255 - y}" r="5" data-i="${i}" class="comp-curve-point"/>`).join('')}`;
  };
  const toCurve = (ev: PointerEvent): [number, number] => {
    const r = svgEl.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(255, ((ev.clientX - r.left) / r.width) * 255))), Math.round(Math.max(0, Math.min(255, 255 - ((ev.clientY - r.top) / r.height) * 255)))];
  };
  const commitCustom = (commit: boolean) => {
    points.sort((a, b) => a[0] - b[0]);
    p.curve = JSON.stringify(points);
    preset.select.value = 'custom';
    draw();
    changed(commit);
  };
  svgEl.addEventListener('pointerdown', (ev) => {
    const [x, y] = toCurve(ev);
    let i = Number((ev.target as Element).getAttribute('data-i') ?? -1);
    if (i < 0) {
      // Add a point on the curve under the pointer.
      if (points.some((q) => Math.abs(q[0] - x) < 6)) return;
      points.push([x, y]);
      points.sort((a, b) => a[0] - b[0]);
      i = points.findIndex((q) => q[0] === x && q[1] === y);
      commitCustom(false);
    }
    svgEl.setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => {
      const [mx, my] = toCurve(m);
      const lo = i > 0 ? points[i - 1][0] + 1 : 0,
        hi = i < points.length - 1 ? points[i + 1][0] - 1 : 255;
      points[i] = [Math.max(lo, Math.min(hi, mx)), my];
      commitCustom(false);
    };
    const up = () => {
      svgEl.removeEventListener('pointermove', move);
      svgEl.removeEventListener('pointerup', up);
      commitCustom(true);
    };
    svgEl.addEventListener('pointermove', move);
    svgEl.addEventListener('pointerup', up);
  });
  svgEl.addEventListener('dblclick', (ev) => {
    const i = Number((ev.target as Element).getAttribute('data-i') ?? -1);
    if (i <= 0 || i >= points.length - 1) return;
    points.splice(i, 1);
    commitCustom(true);
  });
  draw();
  return wrap;
}
function safePoints(curve: string): [number, number][] {
  try {
    const v = JSON.parse(curve);
    if (Array.isArray(v) && v.length >= 2) return v;
  } catch {
    /* Fall through to linear. */
  }
  return TONING_CURVES.linear.points;
}

/** Float composite of a 32-bit document in linear light. */
async function linearComposite(e: Editor): Promise<RGBAF> {
  const doc = e.doc;
  const samples = await e.renderer.documentPixels({ ...doc, selection: null }, e.assets);
  const data = samples instanceof Float32Array ? new Float32Array(samples) : Float32Array.from(samples, (v) => v / 255);
  const linear = (doc.bitsPerChannel ?? 8) === 32 && (doc.iccUntaggedProfile || !doc.iccProfile);
  if (!linear)
    for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] = data[i] <= 1 ? srgbToLinear(Math.max(0, data[i])) : Math.pow(data[i], 2.2);
  return { width: doc.width, height: doc.height, data };
}

/** Flattened 8-bit document holding a tone-mapped result. */
function tonedDocument(e: Editor, image: RGBA8): PhotoDocument {
  const l = newPixelLayer('Background', e.doc, gridFromImage(e.assets.tiles, image));
  const d: PhotoDocument = { ...e.doc, layers: [l] };
  delete d.bitsPerChannel;
  delete d.iccProfile;
  delete d.iccUntaggedProfile;
  return d;
}

export async function hdrToningDialog(e: Editor, arg?: unknown) {
  // Recorded steps carry their settings as { params }.
  const given = (arg as { params?: Partial<HdrToningParams> } | undefined)?.params;
  const p: HdrToningParams = { ...remembered, ...given };
  const deep = (e.doc.bitsPerChannel ?? 8) === 32;
  if (deep) return deepToning(e, p, !!given);
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const src = readTarget(e, target);
  if (!src) return e.message('The layer is empty.');
  const context = () => ({ foreground: hexRgb(e.color), background: hexRgb(e.background), scale: 1 });
  if (!given) {
    const shell = openShell(e, 'HDR Toning', { wide: true });
    const tiles = previewTiles(e, target.grid);
    shell.body.classList.add('comp-form');
    const schedule = latest();
    const refresh = () => {
      if (!shell.preview.checked) return;
      const v = values(p);
      schedule(async () => {
        shell.status.textContent = 'Rendering…';
        const out = await operationInWorker(src.image, 'adjust.hdr-toning', v, context());
        if (!shell.dialog.isConnected) return;
        shell.status.textContent = '';
        if (!shell.preview.checked) return;
        e.preview(previewTarget(e, target, tiles.show(resultGrid(e, target, src, out))));
      });
    };
    toningControls(shell.body, p, (commit) => commit && refresh());
    shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : e.update()));
    refresh();
    const ok = await shell.result;
    delete e.settings.quickMaskPreview;
    e.update();
    tiles.release();
    if (!ok) return;
    remembered = { ...p };
  }
  const v = values(p);
  if (!given) recordStep(e, 'adjust.hdr-toning', { params: { ...p } });
  await applyToLayer(e, 'HDR Toning', (image) => operationInWorker(image, 'adjust.hdr-toning', v, context()));
}

async function deepToning(e: Editor, p: HdrToningParams, direct: boolean) {
  const hdr = await linearComposite(e);
  const copy = () => ({ width: hdr.width, height: hdr.height, data: new Float32Array(hdr.data) });
  if (!direct) {
    const shell = openShell(e, 'HDR Toning', { wide: true });
    shell.body.classList.add('comp-form');
    shell.body.prepend(h('p', { class: 'comp-note' }, 'This 32-bit document is merged and converted to 8 bits per channel with these settings.'));
    const schedule = latest();
    const refresh = () => {
      if (!shell.preview.checked) return;
      const params = { ...p };
      schedule(async () => {
        shell.status.textContent = 'Rendering…';
        const out = await previewJob<RGBA8>('tone-map', { hdr: copy(), params });
        if (!shell.dialog.isConnected) return;
        shell.status.textContent = '';
        if (shell.preview.checked) e.preview(tonedDocument(e, out));
      });
    };
    toningControls(shell.body, p, (commit) => commit && refresh());
    shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : e.update()));
    refresh();
    const ok = await shell.result;
    e.update();
    if (!ok) return;
    remembered = { ...p };
    recordStep(e, 'adjust.hdr-toning', { params: { ...p } });
  }
  const out = await withTask(e, 'HDR Toning', (job) => runJob<RGBA8>(job, 'tone-map', { hdr: copy(), params: { ...p } }));
  if (!out) return;
  const doc = tonedDocument(e, out);
  e.command('HDR Toning', (d) => {
    d.layers = doc.layers;
    delete d.bitsPerChannel;
    delete d.iccProfile;
    delete d.iccUntaggedProfile;
  });
  e.selectLayers([doc.layers[0].id]);
  e.update();
  e.message('Tone-mapped to 8 bits per channel.');
}

