// Select > Select and Mask…: a workspace to refine a selection edge. View modes
// show the result against different backgrounds; the Brush adds or removes
// areas, the Refine Edge Brush marks wispy regions for edge-aware matting;
// Global Refinements and Decontaminate Colors run through refineEdge in the
// worker on a proxy for the preview and at full size for the output.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { formatShortcut } from '../../app/shortcuts';
import { commitSelectionMask } from '../selection';
import { compositeRGBA, layerRGBA } from '../pixels';
import { containerOf, findLayer, type Layer } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { applySelection } from '../../model/selection';
import { emptyGrid, gridFromImage, readMask, writeRect } from '../../model/tiles';
import { edtSquared } from '../../imaging/segment/mask-ops';
import { CancelledError, mask8, type Mask8, type RGBA8 } from '../../imaging/types';
import { buffersOf, channel, withProgress } from './client';
import { downscaleImage, fitSize, outlinePath, resizeMask, strokeMask, type Pt, type RefineSettings } from './logic';
import { mergedImage, selectionMask } from './source';
import { bindRanges, checker, field, openWorkspace, options, range } from './workspace';

type ViewMode = 'onion' | 'ants' | 'overlay' | 'black' | 'white' | 'bw' | 'layers';
type Output = 'selection' | 'mask' | 'layer' | 'layer-mask' | 'document';
type Stroke = { points: Pt[]; size: number; kind: 'add' | 'subtract' | 'refine' };
const viewModes: [ViewMode, string, string][] = [
  ['onion', 'Onion Skin', 'O'],
  ['ants', 'Marching Ants', 'M'],
  ['overlay', 'Overlay', 'V'],
  ['black', 'On Black', 'A'],
  ['white', 'On White', 'T'],
  ['bw', 'Black & White', 'K'],
  ['layers', 'On Layers', 'Y'],
];
const blank: RefineSettings = { radius: 0, adaptiveRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0, decontaminate: 0 };
let remembered = { settings: { ...blank }, view: 'onion' as ViewMode, opacity: 50, output: 'selection' as Output, decon: false, deconAmount: 100 };

function applyStrokes(base: Mask8, brushed: Mask8, strokes: Stroke[], scale: number) {
  for (const s of strokes) {
    const pts = s.points.map(([x, y]) => [x * scale, y * scale] as Pt);
    const size = Math.max(1, s.size * scale);
    const R = { x: 0, y: 0, width: base.width, height: base.height };
    const m = strokeMask(pts, size, s.kind === 'refine' ? 0.5 : 0.9, R);
    const t = s.kind === 'refine' ? brushed : base;
    for (let i = 0; i < m.data.length; i++) {
      const v = m.data[i];
      if (!v) continue;
      t.data[i] = s.kind === 'subtract' ? Math.min(t.data[i], 255 - v) : Math.max(t.data[i], v);
    }
  }
}
function scaledSettings(s: RefineSettings, k: number): RefineSettings {
  return { ...s, radius: s.radius * k, smooth: s.smooth * k, feather: s.feather * k };
}
/** Pixels within the edge detection radius of the selection edge (Show Edge). */
function edgeBand(m: Mask8, radius: number): Uint8Array {
  const n = m.data.length,
    inF = new Uint8Array(n),
    outF = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    inF[i] = m.data[i] >= 128 ? 1 : 0;
    outF[i] = 1 - inF[i];
  }
  const dIn = edtSquared(outF, m.width, m.height),
    dOut = edtSquared(inF, m.width, m.height),
    r2 = Math.max(1, radius) ** 2,
    band = new Uint8Array(n);
  for (let i = 0; i < n; i++) band[i] = (inF[i] ? dIn[i] : dOut[i]) <= r2 ? 1 : 0;
  return band;
}

export async function openSelectAndMask(e: Editor, fromMask = false) {
  const layer = e.layer;
  const W = e.doc.width,
    H = e.doc.height;
  // The refined layer's own pixels are what Decontaminate and layer outputs use.
  const useLayer = !!layer && layer.kind !== 'group' && layer.kind !== 'adjustment';
  const read = await withProgress(e, 'Reading the image', async () => ({
    img: useLayer ? await layerRGBA(e, { ...layer!, maskGrid: undefined, mask: null, opacity: 1 }) : await mergedImage(e),
    // Layers below the refined one, for the On Layers view.
    below: useLayer ? await compositeRGBA(e, hideLayer(e, layer!.id)) : undefined,
  }));
  if (!read) return;
  const { img, below } = read;
  // Opened from a layer mask (double-click in Layers): refine that mask.
  const maskStart = fromMask && layer?.maskGrid ? readMask(e.assets.tiles, layer.maskGrid, { x: 0, y: 0, width: W, height: H }) : undefined;
  if (maskStart && layer?.maskInverted) for (let i = 0; i < maskStart.data.length; i++) maskStart.data[i] = 255 - maskStart.data[i];
  const start = maskStart ?? selectionMask(e) ?? mask8(W, H);
  const [pw, ph] = fitSize(W, H, 900);
  const k = pw / W;
  const proxy = downscaleImage(img, pw, ph);
  const proxyBelow = below ? downscaleImage(below, pw, ph) : undefined;
  const proxyStart = resizeMask(start, pw, ph);
  const s: RefineSettings = { ...remembered.settings };
  let view: ViewMode = remembered.view;
  let opacity = remembered.opacity;
  let output: Output = maskStart ? 'mask' : remembered.output;
  let decon = remembered.decon;
  let deconAmount = remembered.deconAmount;
  let showEdge = false,
    showOriginal = false;
  let tool: 'brush' | 'refine' = 'brush';
  let size = Math.max(10, Math.round(Math.max(W, H) / 30));
  const strokes: Stroke[] = [];
  const ws = openWorkspace(
    'Select and Mask',
    'sm-workspace',
    `<div class="rw-body">
  <div class="rw-tools" role="toolbar" aria-label="Select and Mask tools">
    <button id="sm-brush" class="rw-tool" aria-pressed="true" title="Brush: paint to add, Alt-paint to remove (B)">${svg('paintbrush', 16)}</button>
    <button id="sm-refine" class="rw-tool" aria-pressed="false" title="Refine Edge Brush: paint over hair and soft edges (R)">${svg('feather', 16)}</button>
    <label class="rw-tool-size" title="Brush size (px), [ and ]">${svg('circle', 12)}<input id="sm-size" type="number" min="1" max="2000" value="${size}" aria-label="Brush size"></label>
    <button id="sm-undo" class="rw-tool" title="Undo the last brush stroke (${formatShortcut('Mod+Z')})" disabled>${svg('undo-2', 16)}</button>
  </div>
  <div class="rw-stage single"><div class="rw-view" id="sm-view"><div class="sm-cursor" hidden></div></div><small class="sm-status" id="sm-status" role="status"></small></div>
  <aside class="rw-side">
    <h4>View Mode</h4>
    ${field('View', options('sm-view-mode', view, viewModes.map(([v, l, key]) => [v, `${l} (${key})`])))}
    <label class="rw-check"><input type="checkbox" id="sm-show-edge">Show Edge (J)</label>
    <label class="rw-check"><input type="checkbox" id="sm-show-original">Show Original (P)</label>
    ${field('Opacity / Transparency', range('sm-opacity', 0, 100, opacity))}
    <h4>Edge Detection</h4>
    ${field('Radius (px)', range('sm-radius', 0, 250, s.radius))}
    <label class="rw-check"><input type="checkbox" id="sm-adaptive" ${s.adaptiveRadius ? 'checked' : ''}>Adaptive Radius</label>
    <h4>Global Refinements</h4>
    ${field('Smooth', range('sm-smooth', 0, 100, s.smooth))}
    ${field('Feather (px)', range('sm-feather', 0, 250, s.feather, 0.5))}
    ${field('Contrast (%)', range('sm-contrast', 0, 100, s.contrast))}
    ${field('Shift Edge (%)', range('sm-shift', -100, 100, s.shiftEdge))}
    <h4>Output Settings</h4>
    <label class="rw-check"><input type="checkbox" id="sm-decon" ${decon ? 'checked' : ''}>Decontaminate Colors</label>
    ${field('Amount (%)', range('sm-decon-amount', 0, 100, deconAmount))}
    ${field('Output To', options('sm-output', output, [['selection', 'Selection'], ['mask', 'Layer Mask'], ['layer', 'New Layer'], ['layer-mask', 'New Layer with Layer Mask'], ['document', 'New Document']]))}
  </aside>
</div>
<footer class="rw-footer"><button id="sm-reset" type="button">Reset</button><span class="rw-spacer"></span><button id="sm-cancel" type="button">Cancel</button><button id="sm-ok" type="button" class="primary">OK</button></footer>`,
  );
  const host = ws.q('#sm-view');
  const canvas = document.createElement('canvas');
  canvas.className = 'rw-canvas';
  canvas.width = pw;
  canvas.height = ph;
  canvas.setAttribute('aria-label', 'Refined selection preview');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d')!;
  const cursorEl = ws.q('.sm-cursor');
  const status = ws.q('#sm-status');
  let edited = new Uint8Array(proxyStart.data);
  let brushed = new Uint8Array(pw * ph);
  let refined: Mask8 = { width: pw, height: ph, data: new Uint8Array(proxyStart.data) };
  let band: Uint8Array | undefined;
  const checkerCanvas = new OffscreenCanvas(pw, ph);
  checker(checkerCanvas.getContext('2d')!);
  const checkerData = checkerCanvas.getContext('2d')!.getImageData(0, 0, pw, ph).data;

  const draw = () => {
    const m = showOriginal ? proxyStart.data : refined.data;
    const out = new ImageData(pw, ph),
      d = out.data,
      src = proxy.data,
      T = opacity / 100;
    for (let i = 0; i < pw * ph; i++) {
      const o = i * 4,
        a = (m[i] / 255) * (src[o + 3] / 255);
      let r = src[o],
        g = src[o + 1],
        b = src[o + 2];
      if (band && showEdge && !band[i]) {
        d.set([0, 0, 0, 255], o);
        continue;
      }
      switch (view) {
        case 'onion': {
          // Unselected areas fade toward the transparency checkerboard.
          const vis = a + (1 - a) * (1 - T) * (src[o + 3] / 255);
          r = r * vis + checkerData[o] * (1 - vis);
          g = g * vis + checkerData[o + 1] * (1 - vis);
          b = b * vis + checkerData[o + 2] * (1 - vis);
          break;
        }
        case 'overlay': {
          const t = (1 - m[i] / 255) * T;
          r = r * (1 - t) + 255 * t;
          g = g * (1 - t);
          b = b * (1 - t);
          break;
        }
        case 'black':
          r *= a;
          g *= a;
          b *= a;
          break;
        case 'white':
          r = r * a + 255 * (1 - a);
          g = g * a + 255 * (1 - a);
          b = b * a + 255 * (1 - a);
          break;
        case 'bw':
          r = g = b = m[i];
          break;
        case 'layers': {
          const bg = proxyBelow?.data;
          const br = bg ? bg[o] : checkerData[o],
            bgg = bg ? bg[o + 1] : checkerData[o + 1],
            bb = bg ? bg[o + 2] : checkerData[o + 2];
          r = r * a + br * (1 - a);
          g = g * a + bgg * (1 - a);
          b = b * a + bb * (1 - a);
          break;
        }
      }
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    if (view === 'ants') {
      const path = new Path2D(outlinePath({ width: pw, height: ph, data: m }));
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([]);
      ctx.stroke(path);
      ctx.strokeStyle = '#000';
      ctx.setLineDash([4, 4]);
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  };
  let running: AbortController | undefined;
  let timer = 0;
  const refresh = (delay = 120) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      running?.abort();
      const ctrl = new AbortController();
      running = ctrl;
      status.textContent = 'Refining…';
      const settings = scaledSettings({ ...s, decontaminate: 0 }, k);
      const plain = settings.radius < 1 && !settings.smooth && !settings.feather && !settings.contrast && !settings.shiftEdge && !brushed.some((v) => v);
      try {
        if (plain) refined = { width: pw, height: ph, data: new Uint8Array(edited) };
        else {
          const imgCopy = { width: pw, height: ph, data: new Uint8ClampedArray(proxy.data) };
          const mask = { width: pw, height: ph, data: new Uint8Array(edited) };
          const br = { width: pw, height: ph, data: new Uint8Array(brushed) };
          const res = await channel('heavy').call<{ mask: Mask8 }>('refine', { img: imgCopy, mask, settings, brushed: br, brushRadius: refineBrushRadius() * k }, { transfer: buffersOf(imgCopy, mask, br), signal: ctrl.signal });
          if (running !== ctrl) return;
          refined = res.mask;
        }
        band = showEdge ? edgeBand({ width: pw, height: ph, data: edited }, Math.max(2, s.radius * k)) : undefined;
        status.textContent = '';
        draw();
      } catch (error) {
        if (error instanceof CancelledError || ctrl.signal.aborted) return;
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        if (running === ctrl) running = undefined;
      }
    }, delay);
  };
  const refineBrushRadius = () => Math.max(0, ...strokes.filter((x) => x.kind === 'refine').map((x) => x.size / 2));
  draw();
  refresh(0);

  // Painting on the view.
  let painting: Stroke | undefined;
  const docPoint = (ev: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  };
  const moveCursor = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect(),
      hr = host.getBoundingClientRect();
    const px = (size * r.width) / W;
    cursorEl.hidden = false;
    cursorEl.style.width = cursorEl.style.height = `${px}px`;
    cursorEl.style.left = `${ev.clientX - hr.left - px / 2}px`;
    cursorEl.style.top = `${ev.clientY - hr.top - px / 2}px`;
  };
  const paintSegment = (st: Stroke, from: number) => {
    const part = { ...st, points: st.points.slice(Math.max(0, from - 1)) };
    const em = { width: pw, height: ph, data: edited },
      bm = { width: pw, height: ph, data: brushed };
    applyStrokes(em, bm, [part], k);
    if (st.kind !== 'refine') refined = { width: pw, height: ph, data: new Uint8Array(edited) };
    draw();
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    painting = { points: [docPoint(ev)], size, kind: tool === 'refine' ? 'refine' : ev.altKey ? 'subtract' : 'add' };
    paintSegment(painting, 0);
  });
  canvas.addEventListener('pointermove', (ev) => {
    moveCursor(ev);
    if (!painting) return;
    painting.points.push(docPoint(ev));
    paintSegment(painting, painting.points.length - 1);
  });
  canvas.addEventListener('pointerleave', () => (cursorEl.hidden = true));
  const endPaint = () => {
    if (!painting) return;
    strokes.push(painting);
    painting = undefined;
    ws.q<HTMLButtonElement>('#sm-undo').disabled = false;
    refresh(0);
  };
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);
  const replay = () => {
    edited = new Uint8Array(proxyStart.data);
    brushed = new Uint8Array(pw * ph);
    applyStrokes({ width: pw, height: ph, data: edited }, { width: pw, height: ph, data: brushed }, strokes, k);
    ws.q<HTMLButtonElement>('#sm-undo').disabled = !strokes.length;
    refresh(0);
  };
  ws.q('#sm-undo').addEventListener('click', () => {
    strokes.pop();
    replay();
  });
  const setTool = (t: typeof tool) => {
    tool = t;
    ws.q('#sm-brush').setAttribute('aria-pressed', String(t === 'brush'));
    ws.q('#sm-refine').setAttribute('aria-pressed', String(t === 'refine'));
  };
  ws.q('#sm-brush').addEventListener('click', () => setTool('brush'));
  ws.q('#sm-refine').addEventListener('click', () => setTool('refine'));
  const sizeInput = ws.q<HTMLInputElement>('#sm-size');
  sizeInput.addEventListener('change', () => (size = Math.max(1, Math.min(2000, Number(sizeInput.value) || size))));
  const viewSelect = ws.q<HTMLSelectElement>('#sm-view-mode');
  viewSelect.addEventListener('change', () => {
    view = viewSelect.value as ViewMode;
    draw();
  });
  const syncDecon = () => {
    // Color decontamination changes pixels, so it needs a layer or document
    // output; without a layer only the selection can be output.
    const box = ws.q<HTMLInputElement>('#sm-decon');
    box.disabled = !useLayer;
    if (!useLayer) box.checked = decon = false;
    const sel = ws.q<HTMLSelectElement>('#sm-output');
    for (const o of sel.options) o.disabled = (!useLayer && o.value !== 'selection') || (decon && (o.value === 'selection' || o.value === 'mask'));
    if (sel.selectedOptions[0]?.disabled) sel.value = output = useLayer ? 'layer-mask' : 'selection';
    for (const id of ['#sm-decon-amount', '[data-for="sm-decon-amount"]']) ws.q<HTMLInputElement>(id).disabled = !decon;
  };
  syncDecon();
  ws.q<HTMLInputElement>('#sm-decon').addEventListener('change', (ev) => {
    decon = (ev.target as HTMLInputElement).checked;
    syncDecon();
  });
  ws.q<HTMLSelectElement>('#sm-output').addEventListener('change', (ev) => (output = (ev.target as HTMLSelectElement).value as Output));
  const check = (id: string, f: (v: boolean) => void) => ws.q<HTMLInputElement>(id).addEventListener('change', (ev) => f((ev.target as HTMLInputElement).checked));
  check('#sm-adaptive', (v) => {
    s.adaptiveRadius = v;
    refresh();
  });
  check('#sm-show-edge', (v) => {
    showEdge = v;
    refresh(0);
  });
  check('#sm-show-original', (v) => {
    showOriginal = v;
    draw();
  });
  bindRanges(ws.dialog, (id, v) => {
    if (id === 'sm-opacity') {
      opacity = v;
      draw();
      return;
    }
    if (id === 'sm-decon-amount') {
      deconAmount = v;
      return;
    }
    const keyFor: Record<string, keyof RefineSettings> = { 'sm-radius': 'radius', 'sm-smooth': 'smooth', 'sm-feather': 'feather', 'sm-contrast': 'contrast', 'sm-shift': 'shiftEdge' };
    (s as Record<string, number | boolean>)[keyFor[id]] = v;
    refresh();
  });
  const setRange = (id: string, v: number) => {
    ws.q<HTMLInputElement>(`#${id}`).value = String(v);
    ws.q<HTMLInputElement>(`[data-for="${id}"]`).value = String(v);
  };
  ws.q('#sm-reset').addEventListener('click', () => {
    Object.assign(s, blank);
    for (const [id, v] of [['sm-radius', 0], ['sm-smooth', 0], ['sm-feather', 0], ['sm-contrast', 0], ['sm-shift', 0]] as const) setRange(id, v);
    ws.q<HTMLInputElement>('#sm-adaptive').checked = false;
    strokes.length = 0;
    replay();
  });
  ws.dialog.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('input[type=number],select')) return;
    const key = ev.key.toUpperCase();
    const vm = viewModes.find((m) => m[2] === key);
    if (vm && !ev.metaKey && !ev.ctrlKey) {
      view = vm[0];
      viewSelect.value = view;
      draw();
    } else if (key === 'B') setTool('brush');
    else if (key === 'R') setTool('refine');
    else if (key === 'J') ws.q<HTMLInputElement>('#sm-show-edge').click();
    else if (key === 'P') ws.q<HTMLInputElement>('#sm-show-original').click();
    else if (ev.key === '[' || ev.key === ']') {
      size = Math.max(1, Math.min(2000, Math.round(size * (ev.key === ']' ? 1.2 : 1 / 1.2))));
      sizeInput.value = String(size);
    } else if (key === 'Z' && (ev.metaKey || ev.ctrlKey) && strokes.length) {
      strokes.pop();
      replay();
    } else if (ev.key === 'Enter' && !t.closest('button')) ws.q('#sm-ok').click();
    else return;
    ev.preventDefault();
  });
  let accepted = false;
  ws.q('#sm-cancel').addEventListener('click', ws.close);
  ws.q('#sm-ok').addEventListener('click', () => {
    accepted = true;
    ws.close();
  });
  await ws.closed;
  clearTimeout(timer);
  running?.abort();
  remembered = { settings: { ...s }, view, opacity, output, decon, deconAmount };
  if (!accepted) return;

  // Full-resolution output.
  const fullMask = { width: W, height: H, data: new Uint8Array(start.data) };
  const fullBrushed = mask8(W, H);
  applyStrokes(fullMask, fullBrushed, strokes, 1);
  const settings: RefineSettings = { ...s, decontaminate: decon && output !== 'selection' && output !== 'mask' ? deconAmount / 100 : 0 };
  const imgCopy = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  const result = await withProgress(e, 'Select and Mask', (job) =>
    channel('heavy').call<{ mask: Mask8; image?: RGBA8 }>('refine', { img: imgCopy, mask: fullMask, settings, brushed: fullBrushed, brushRadius: refineBrushRadius() }, { transfer: buffersOf(imgCopy, fullMask, fullBrushed), signal: job.signal, progress: job.progress }),
  );
  if (!result) return;
  await output_(e, output, result.mask, result.image ?? img, layer);
}
function hideLayer(e: Editor, id: string) {
  const hide = (ls: Layer[]): Layer[] => ls.map((l) => (l.id === id ? { ...l, visible: false } : l.children.length ? { ...l, children: hide(l.children) } : l));
  return { ...e.doc, layers: hide(e.doc.layers) };
}
async function output_(e: Editor, output: Output, mask: Mask8, image: RGBA8, layer: Layer | undefined) {
  const store = e.assets.tiles;
  if (output === 'selection' || !layer) {
    commitSelectionMask(e, mask, 'replace', 'Select and Mask');
    return;
  }
  const maskGrid = writeRect(store, emptyGrid(1), 0, 0, mask);
  const id = layer.id;
  if (output === 'mask') {
    e.command('Select and Mask', (d) => {
      const t = findLayer(d.layers, id);
      if (!t) return;
      t.mask = null;
      delete t.maskAsset;
      delete t.pixelMask;
      delete t.maskStrokes;
      delete t.maskInverted;
      delete t.maskDisabled;
      t.maskGrid = maskGrid;
      applySelection(d, null);
    });
    return;
  }
  const cut = (): RGBA8 => {
    const out = new Uint8ClampedArray(image.data);
    for (let i = 0; i < mask.data.length; i++) out[i * 4 + 3] = (out[i * 4 + 3] * mask.data[i]) / 255;
    return { width: image.width, height: image.height, data: out };
  };
  if (output === 'document') {
    const pixels = cut();
    const s = e.newSession();
    e.session = s;
    const l = newPixelLayer('Layer 1', pixels, gridFromImage(s.assets.tiles, pixels));
    s.history.reset({ ...s.doc, name: `${layer.name} (Refined)`, width: pixels.width, height: pixels.height, layers: [l], selection: null, selectionMask: null });
    s.hasDocument = true;
    e.selected = l.id;
    e.fit();
    e.update();
    return;
  }
  const withMask = output === 'layer-mask';
  const l = newPixelLayer(`${layer.name} copy`, e.doc, gridFromImage(store, withMask ? image : cut()));
  if (withMask) l.maskGrid = maskGrid;
  l.opacity = layer.opacity;
  l.blend = layer.blend;
  // The source layer is hidden so the result shows.
  e.command('Select and Mask', (d) => {
    const list = containerOf(d.layers, id);
    const t = findLayer(d.layers, id);
    if (!list || !t) return;
    t.visible = false;
    list.splice(list.indexOf(t) + 1, 0, l);
    applySelection(d, null);
  });
  e.selected = l.id;
  e.update();
}

