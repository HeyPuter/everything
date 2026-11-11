import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { layerLock } from '../../model/locks';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { renderGradientInto, type GradientType } from '../../imaging/gradient/gradient';
import { gradientToCss } from '../../imaging/gradient/edit';
import { compositeRGBA8 } from '../../imaging/blend/composite';
import type { BlendMode } from '../../imaging/blend/modes';
import { commitTarget, pixelTarget, previewTarget, type PixelTarget } from '../pixels';
import { blendOptions, openGradientPicker } from './controls';
import { colors, effectsState, resolveGradient } from './state';

// Gradient tool: drag to set the start and end of the current gradient
// (Shift constrains to 45 degree steps). The result previews live and is
// applied to the target layer within the selection; on masks and Quick Mask
// the gradient paints its luminance.
const typeGlyph: Record<GradientType, string> = {
  linear: '<rect x="3" y="5" width="18" height="14" rx="2" fill="url(#fxg-l)"/>',
  radial: '<rect x="3" y="5" width="18" height="14" rx="2" fill="url(#fxg-r)"/>',
  angle: '<rect x="3" y="5" width="18" height="14" rx="2" fill="url(#fxg-l)"/><path d="M12 12 21 12" stroke="currentColor"/><path d="M12 12a5 5 0 1 0 5-0.1" fill="none" stroke="currentColor"/>',
  reflected: '<rect x="3" y="5" width="18" height="14" rx="2" fill="url(#fxg-x)"/>',
  diamond: '<rect x="3" y="5" width="18" height="14" rx="2" fill="currentColor" fill-opacity=".15"/><path d="M12 6 18 12 12 18 6 12Z" fill="url(#fxg-r)" stroke="currentColor" stroke-width="1"/>',
};
const defs = '<defs><linearGradient id="fxg-l"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient><linearGradient id="fxg-x"><stop offset="0" stop-color="currentColor" stop-opacity="0"/><stop offset=".5" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient><radialGradient id="fxg-r"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs>';
const glyph = (t: GradientType) => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">${defs}${typeGlyph[t]}</svg>`;
const typeLabels: Record<GradientType, string> = { linear: 'Linear', radial: 'Radial', angle: 'Angle', reflected: 'Reflected', diamond: 'Diamond' };

type Drag = {
  target: PixelTarget;
  region: IRect;
  base: RGBA8 | Mask8;
  cover?: Mask8;
  preserveAlpha: boolean;
  start: { x: number; y: number };
  end: { x: number; y: number };
  preview?: TileGrid;
  frame?: number;
};
let drag: Drag | undefined;
let pending: { start: { x: number; y: number } } | undefined;

/** Applies the current gradient between two points over `d.region`. */
function compose(e: Editor, d: Drag): RGBA8 | Mask8 {
  const o = effectsState.tool;
  const r = d.region;
  const grad: RGBA8 = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
  renderGradientInto(grad, resolveGradient(e, effectsState.gradient), {
    type: o.type, start: d.start, end: d.end, reverse: o.reverse, dither: o.dither, method: o.method, ...colors(e),
  }, { x: r.x, y: r.y });
  const g = grad.data;
  if (!o.transparency) for (let i = 3; i < g.length; i += 4) g[i] = 255;
  if (d.base.data instanceof Uint8Array) {
    // Masks receive the gradient's gray value, weighted by its alpha.
    const m = d.base as Mask8, out = new Uint8Array(m.data);
    const cover = d.cover?.data;
    for (let i = 0; i < out.length; i++) {
      const k = (g[i * 4 + 3] / 255) * o.opacity * (cover ? cover[i] / 255 : 1);
      if (!k) continue;
      const v = 0.299 * g[i * 4] + 0.587 * g[i * 4 + 1] + 0.114 * g[i * 4 + 2];
      out[i] = m.data[i] + (v - m.data[i]) * k;
    }
    return { width: m.width, height: m.height, data: out };
  }
  const base = d.base as RGBA8;
  const out: RGBA8 = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  compositeRGBA8(out, grad, o.mode, o.opacity, d.cover);
  if (d.preserveAlpha) for (let i = 3; i < out.data.length; i += 4) out.data[i] = base.data[i];
  return out;
}
function constrain(start: { x: number; y: number }, p: CanvasPointer) {
  if (!p.shift) return { x: p.x, y: p.y };
  const dx = p.x - start.x, dy = p.y - start.y;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len };
}
function dropPreview(e: Editor, d: Drag) {
  // Preview tiles that the committed grid does not share are freed right away.
  if (!d.preview) return;
  const keep = new Set(Object.values(d.target.grid.tiles));
  for (const id of Object.values(d.preview.tiles)) if (!keep.has(id)) e.assets.tiles.delete(id);
  d.preview = undefined;
}
function schedule(e: Editor, d: Drag) {
  if (d.frame) return;
  d.frame = requestAnimationFrame(() => {
    d.frame = 0;
    if (drag !== d) return;
    const out = compose(e, d);
    const grid = writeRect(e.assets.tiles, d.target.grid, d.region.x, d.region.y, out);
    dropPreview(e, d);
    d.preview = grid;
    e.preview(previewTarget(e, d.target, grid));
    e.overlay();
  });
}
export const gradientTool: Tool = {
  id: 'gradient',
  label: 'Gradient Tool',
  key: 'G',
  icon: 'gradient',
  group: 'fill',
  cursor: () => 'crosshair',
  options: (e) => {
    const o = effectsState.tool;
    return `<button type="button" class="gradient-swatch tool-gradient" data-gradient-pick style="background:${gradientToCss(effectsState.gradient, colors(e))}, var(--fx-checker)" title="Click to choose or edit the gradient" aria-label="Gradient"></button>
<span class="gradient-types" role="group" aria-label="Gradient type">${(Object.keys(typeLabels) as GradientType[]).map((t) => `<button type="button" class="icon-button toggle" data-gradient-type="${t}" aria-pressed="${o.type === t}" title="${typeLabels[t]} Gradient" aria-label="${typeLabels[t]} gradient">${glyph(t)}</button>`).join('')}</span>
<label>Mode <select id="gradient-mode" aria-label="Gradient blend mode">${blendOptions(o.mode)}</select></label>
<label>Opacity <input id="gradient-opacity" type="number" min="1" max="100" value="${Math.round(o.opacity * 100)}" aria-label="Gradient opacity (%)">%</label>
<label class="transform-setting"><input id="gradient-reverse" type="checkbox" ${o.reverse ? 'checked' : ''}>Reverse</label>
<label class="transform-setting"><input id="gradient-dither" type="checkbox" ${o.dither ? 'checked' : ''}>Dither</label>
<label class="transform-setting"><input id="gradient-transparency" type="checkbox" ${o.transparency ? 'checked' : ''}>Transparency</label>
<label>Method <select id="gradient-method" aria-label="Interpolation method"><option value="perceptual" ${o.method === 'perceptual' ? 'selected' : ''}>Perceptual</option><option value="linear" ${o.method === 'linear' ? 'selected' : ''}>Linear</option><option value="classic" ${o.method === 'classic' ? 'selected' : ''}>Classic</option></select></label>`;
  },
  bindOptions: ({ e, el }) => {
    const o = effectsState.tool;
    el.querySelector<HTMLElement>('[data-gradient-pick]')?.addEventListener('click', (ev) =>
      openGradientPicker(e, ev.currentTarget as HTMLElement, effectsState.gradient, (g) => {
        effectsState.gradient = g;
        e.options();
        e.dock?.update();
      }),
    );
    el.querySelectorAll<HTMLElement>('[data-gradient-type]').forEach((b) =>
      b.addEventListener('click', () => {
        o.type = b.dataset.gradientType as GradientType;
        e.options();
      }),
    );
    const on = (sel: string, f: (t: HTMLInputElement) => void) => el.querySelector<HTMLInputElement>(sel)?.addEventListener('change', (ev) => f(ev.target as HTMLInputElement));
    on('#gradient-mode', (t) => (o.mode = t.value as BlendMode));
    on('#gradient-opacity', (t) => {
      // Out-of-range entries clamp to 1–100%; a blank or invalid entry keeps the opacity. The field shows what applies.
      const v = Number(t.value);
      if (t.value.trim() !== '' && Number.isFinite(v)) o.opacity = Math.max(0.01, Math.min(1, v / 100));
      t.value = String(Math.round(o.opacity * 100));
    });
    on('#gradient-reverse', (t) => (o.reverse = t.checked));
    on('#gradient-dither', (t) => (o.dither = t.checked));
    on('#gradient-transparency', (t) => (o.transparency = t.checked));
    on('#gradient-method', (t) => (o.method = t.value as typeof o.method));
  },
  activate: (e) => {
    e.settings.numberKey = (value: number) => {
      effectsState.tool.opacity = value;
      e.options();
      return true;
    };
  },
  deactivate: (e) => {
    delete e.settings.numberKey;
    if (drag) cancel(e);
  },
  pointerDown: async (e, p) => {
    const start = { x: p.x, y: p.y };
    pending = { start };
    const target = await pixelTarget(e);
    if (!target || pending?.start !== start) return;
    pending = undefined;
    const doc = e.doc;
    const sel = target.kind === 'quick-mask' ? null : selectionGrid(doc, e.assets.tiles);
    const region = sel ? selectionBounds(doc, sel) : canvasRect(doc);
    if (!region || region.width <= 0 || region.height <= 0) return;
    const base = target.kind === 'pixels' ? readRGBA(e.assets.tiles, target.grid, region) : readMask(e.assets.tiles, target.grid, region);
    drag = {
      target, region, base, start, end: start,
      cover: sel ? readMask(e.assets.tiles, sel, region) : undefined,
      preserveAlpha: target.kind === 'pixels' && !!layerLock(doc.layers, target.layer.id, 'transparency'),
    };
    e.toolBusy = true;
    e.overlay();
  },
  pointerMove: (e, p) => {
    if (!drag) return;
    drag.end = constrain(drag.start, p);
    schedule(e, drag);
  },
  pointerUp: (e, p) => {
    pending = undefined;
    const d = drag;
    if (!d) return;
    d.end = constrain(d.start, p);
    cancelAnimationFrame(d.frame ?? 0);
    drag = undefined;
    e.toolBusy = false;
    dropPreview(e, d);
    delete e.settings.quickMaskPreview;
    if (Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) < 1) {
      e.preview(e.doc);
      e.overlay();
      return;
    }
    const out = compose(e, d);
    commitTarget(e, d.target, writeRect(e.assets.tiles, d.target.grid, d.region.x, d.region.y, out), 'Gradient');
  },
  keyDown: (e, ev) => {
    if (ev.key === 'Escape' && drag) {
      cancel(e);
      return true;
    }
    return false;
  },
  overlay: (e) => {
    if (!drag) return '';
    const { start: s, end: t } = drag;
    const w = 1 / e.zoom;
    return `<g class="gradient-guide"><line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#000" stroke-width="${3 * w}"/><line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#fff" stroke-width="${w}"/><circle cx="${s.x}" cy="${s.y}" r="${4 * w}" fill="#fff" stroke="#000" stroke-width="${w}"/><circle cx="${t.x}" cy="${t.y}" r="${4 * w}" fill="#fff" stroke="#000" stroke-width="${w}"/></g>`;
  },
};
function cancel(e: Editor) {
  const d = drag;
  drag = undefined;
  pending = undefined;
  e.toolBusy = false;
  if (!d) return;
  cancelAnimationFrame(d.frame ?? 0);
  dropPreview(e, d);
  delete e.settings.quickMaskPreview;
  e.preview(e.doc);
  e.overlay();
}
