import type { Editor } from '../editor';
import { registerTool, registerCommand, type Tool } from '../app/registry';
import type { CanvasPointer } from '../app/pointer';
import { brushSizeStep } from '../app/shortcuts';
import { StrokeSession, type BrushTip, type PaintMode, type PaintTarget, type BrushDynamics } from '../engine/paint';
import { pixelTarget, previewTarget, commitTarget, hexRgb, type PixelTarget } from './pixels';
import { selectionGrid, canvasRect } from '../model/selection';
import { layerLock } from '../model/locks';
import { readMask, readRGBA, writeRect } from '../model/tiles';
import { wandMask } from './selection';
import { escapeXML } from '../model/assets';
import { svg } from '../app/icons';
import { blendModes } from '../imaging/blend/modes';
import { brushPreviewShown } from './view-extras';
import { patternPreviewOn } from './view-modes';
import { iconCursor } from './preferences/cursors';

export type BrushSettings = BrushTip & {
  opacity: number;
  flow: number;
  mode: PaintMode;
  smoothing: number;
  dynamics: BrushDynamics;
  airbrush: boolean;
};
export const brushPresets: { name: string; tip: Partial<BrushSettings> }[] = [
  { name: 'Soft Round', tip: { hardness: 0, spacing: 0.1, roundness: 1, angle: 0 } },
  { name: 'Hard Round', tip: { hardness: 1, spacing: 0.1, roundness: 1, angle: 0 } },
  { name: 'Soft Round Pressure Size', tip: { hardness: 0, spacing: 0.1, dynamics: { pressureSize: true } } },
  { name: 'Hard Round Pressure Opacity', tip: { hardness: 1, spacing: 0.1, dynamics: { pressureOpacity: true } } },
  { name: 'Flat Angled', tip: { hardness: 0.8, spacing: 0.08, roundness: 0.25, angle: 45 } },
  { name: 'Spatter', tip: { hardness: 0.6, spacing: 0.5, dynamics: { scatter: 1.5, sizeJitter: 0.6, count: 3 } } },
  { name: 'Chalk', tip: { hardness: 0.4, spacing: 0.15, roundness: 0.7, dynamics: { angleJitter: 1, sizeJitter: 0.25, flowJitter: 0.5 } } },
  { name: 'Airbrush Soft', tip: { hardness: 0, spacing: 0.05, flow: 0.1, airbrush: true } },
];
// Each painting tool keeps its own settings, so switching tools leaves the others unchanged.
const settings = new Map<string, BrushSettings>();
export function brushFor(id: string): BrushSettings {
  let s = settings.get(id);
  if (!s) {
    s = { size: id === 'pencil' ? 3 : 30, hardness: id === 'pencil' ? 1 : 0.8, spacing: 0.1, roundness: 1, angle: 0, opacity: 1, flow: 1, mode: 'normal', smoothing: 0.1, dynamics: {}, airbrush: false };
    settings.set(id, s);
  }
  return s;
}

type Active = {
  session?: StrokeSession;
  target?: PixelTarget;
  queue: CanvasPointer[];
  smooth?: [number, number];
  last?: [number, number];
  // Pressure of the latest sample (the smoothing catch-up keeps it).
  pressure?: number;
  label: string;
  done?: boolean;
  timer?: number;
};
let active: Active | undefined;
const lastPoint = new Map<string, [number, number]>();

export function brushOptions(_e: Editor, id: string, extra = '') {
  const s = brushFor(id);
  // Normal, Dissolve, Behind and Clear first, then the layer mode groups.
  const modes: PaintMode[] = ['normal', 'dissolve', 'behind', 'clear', ...blendModes.slice(2).map((m) => m.id)];
  const label = (m: PaintMode) => blendModes.find((b) => b.id === m)?.label ?? m[0].toUpperCase() + m.slice(1);
  const groupOf = (m: PaintMode) => blendModes.find((b) => b.id === m)?.group ?? 0;
  return `<button class="brush-preview" data-brush-popover="${id}" title="Brush settings" aria-label="Brush preset and size"><span class="brush-dot" style="--size:${Math.min(22, 4 + Math.sqrt(s.size) * 1.6)}px;--hard:${s.hardness}"></span><span>${Math.round(s.size)}</span></button>
<label>Size <input id="brush-size" type="number" min="1" max="5000" value="${Math.round(s.size)}" aria-label="Brush size (px)"> px</label>
${id === 'pencil' ? '' : `<label>Hardness <input id="brush-hardness" type="number" min="0" max="100" value="${Math.round(s.hardness * 100)}" aria-label="Brush hardness (%)">%</label>`}
${id === 'eraser' ? '' : `<label>Mode <select id="brush-mode" aria-label="Brush blend mode">${modes.map((m, i) => `${i > 3 && groupOf(m) !== groupOf(modes[i - 1]) || i === 4 ? '<option disabled>──────────</option>' : ''}<option value="${m}" ${s.mode === m ? 'selected' : ''}>${label(m)}</option>`).join('')}</select></label>`}
<label>Opacity <input id="brush-opacity" type="number" min="1" max="100" value="${Math.round(s.opacity * 100)}" aria-label="Brush opacity (%)">%</label>
<button class="icon-button toggle" id="pressure-opacity" aria-pressed="${!!s.dynamics.pressureOpacity}" title="Pressure controls opacity" aria-label="Pressure controls opacity">${svg('pressure-opacity', 16)}</button>
${id === 'pencil' ? '' : `<label>Flow <input id="brush-flow" type="number" min="1" max="100" value="${Math.round(s.flow * 100)}" aria-label="Brush flow (%)">%</label><button class="icon-button toggle" id="airbrush" aria-pressed="${s.airbrush}" title="Airbrush build-up" aria-label="Airbrush">${svg('airbrush', 16)}</button>`}
<label>Smoothing <input id="brush-smoothing" type="number" min="0" max="100" value="${Math.round(s.smoothing * 100)}" aria-label="Smoothing (%)">%</label>
<button class="icon-button toggle" id="pressure-size" aria-pressed="${!!s.dynamics.pressureSize}" title="Pressure controls size" aria-label="Pressure controls size">${svg('pressure-size', 16)}</button>${extra}`;
}
export function bindBrushOptions(e: Editor, el: HTMLElement, id: string) {
  const s = brushFor(id);
  const num = (sel: string, f: (v: number) => void) =>
    el.querySelector<HTMLInputElement>(sel)?.addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v)) f(v);
      e.options();
    });
  num('#brush-size', (v) => (s.size = Math.max(1, Math.min(5000, v))));
  num('#brush-hardness', (v) => (s.hardness = Math.max(0, Math.min(1, v / 100))));
  num('#brush-opacity', (v) => (s.opacity = Math.max(0.01, Math.min(1, v / 100))));
  num('#brush-flow', (v) => (s.flow = Math.max(0.01, Math.min(1, v / 100))));
  num('#brush-smoothing', (v) => (s.smoothing = Math.max(0, Math.min(1, v / 100))));
  el.querySelector<HTMLSelectElement>('#brush-mode')?.addEventListener('change', (ev) => (s.mode = (ev.target as HTMLSelectElement).value as PaintMode));
  const toggle = (sel: string, f: () => void) => el.querySelector<HTMLButtonElement>(sel)?.addEventListener('click', () => {
    f();
    e.options();
  });
  toggle('#pressure-opacity', () => (s.dynamics.pressureOpacity = !s.dynamics.pressureOpacity));
  toggle('#pressure-size', () => (s.dynamics.pressureSize = !s.dynamics.pressureSize));
  toggle('#airbrush', () => (s.airbrush = !s.airbrush));
  el.querySelector<HTMLButtonElement>('[data-brush-popover]')?.addEventListener('click', (ev) => openBrushPopover(e, id, ev.currentTarget as HTMLElement));
}
function openBrushPopover(e: Editor, id: string, anchor: HTMLElement) {
  document.querySelector('.brush-popover')?.remove();
  const s = brushFor(id);
  const pop = document.createElement('div');
  pop.className = 'brush-popover popover';
  pop.innerHTML = `<label>Size <input type="range" min="1" max="1000" value="${s.size}" data-k="size"><output>${Math.round(s.size)} px</output></label><label>Hardness <input type="range" min="0" max="100" value="${s.hardness * 100}" data-k="hardness"><output>${Math.round(s.hardness * 100)}%</output></label><label>Angle <input type="range" min="-180" max="180" value="${s.angle}" data-k="angle"><output>${s.angle}°</output></label><label>Roundness <input type="range" min="1" max="100" value="${s.roundness * 100}" data-k="roundness"><output>${Math.round(s.roundness * 100)}%</output></label><label>Spacing <input type="range" min="1" max="200" value="${s.spacing * 100}" data-k="spacing"><output>${Math.round(s.spacing * 100)}%</output></label><div class="preset-list" role="listbox" aria-label="Brush presets">${brushPresets.map((p, i) => `<button role="option" data-preset="${i}">${escapeXML(p.name)}</button>`).join('')}</div>`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  pop.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    const v = Number(t.value);
    const k = t.dataset.k!;
    if (k === 'size') s.size = v;
    else if (k === 'hardness') s.hardness = v / 100;
    else if (k === 'angle') s.angle = v;
    else if (k === 'roundness') s.roundness = v / 100;
    else if (k === 'spacing') s.spacing = v / 100;
    t.nextElementSibling!.textContent = k === 'size' ? `${v} px` : k === 'angle' ? `${v}°` : `${v}%`;
  });
  pop.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]');
    if (!b) return;
    const p = brushPresets[Number(b.dataset.preset)].tip;
    Object.assign(s, { roundness: 1, angle: 0, spacing: 0.1, airbrush: false, ...p, dynamics: { ...(p.dynamics ?? {}) } });
    pop.remove();
    e.options();
  });
  const close = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener('pointerdown', close, true);
      e.options();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
}

function paintTargetFor(e: Editor, id: string, target: PixelTarget): PaintTarget {
  const s = brushFor(id);
  if (target.kind !== 'pixels') {
    const hex = id === 'eraser' ? e.background : e.color;
    const [r, g, b] = hexRgb(hex);
    return { kind: 'mask', value: Math.round(r * 0.299 + g * 0.587 + b * 0.114) };
  }
  const preserveAlpha = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
  if (id === 'eraser') return { kind: 'color', rgb: hexRgb(e.background), mode: 'normal', erase: !preserveAlpha, preserveAlpha };
  return { kind: 'color', rgb: hexRgb(e.color), mode: s.mode, preserveAlpha };
}
/** Shared stroke lifecycle for brush-like tools. */
export function strokeTool(id: string, label: string, icon: string, group: string, key: string, history: string, extra: Partial<Tool> = {}, makeTarget?: (e: Editor, target: PixelTarget, p: CanvasPointer) => PaintTarget | undefined): Tool {
  return {
    id,
    label,
    key,
    icon,
    group,
    // Preferences → Cursors → Standard shows the tool's icon instead of the tip.
    cursor: (e) => (e.preferences.paintCursor === 'standard' ? iconCursor(icon) : 'none'),
    brush: {
      get: () => brushFor(id),
      set: (e, v) => {
        Object.assign(brushFor(id), v);
        e.options();
      },
    },
    options: (e) => brushOptions(e, id),
    bindOptions: ({ e, el }) => bindBrushOptions(e, el, id),
    activate: (e) => {
      // Number keys set the opacity, with Shift the flow.
      e.settings.numberKey = (value: number, shift: boolean) => {
        if (shift) brushFor(id).flow = value;
        else brushFor(id).opacity = value;
        e.options();
        return true;
      };
    },
    deactivate: (e) => {
      e.screenOverlayContent = '';
      e.screenOverlay();
      delete e.settings.numberKey;
    },
    pointerDown: async (e, p) => {
      const a: Active = { queue: [p], label: history };
      active = a;
      const target = await pixelTarget(e);
      if (!target || active !== a) {
        active = undefined;
        return;
      }
      const s = brushFor(id);
      let paint = makeTarget ? makeTarget(e, target, p) : paintTargetFor(e, id, target);
      if (!paint) {
        active = undefined;
        return;
      }
      // Locked transparency holds for every tool, whatever its own target asks.
      if (target.kind === 'pixels' && paint.kind !== 'mask' && !paint.preserveAlpha && layerLock(e.doc.layers, target.layer.id, 'transparency'))
        paint = { ...paint, preserveAlpha: true };
      const sel = target.kind === 'quick-mask' ? null : selectionGrid(e.doc, e.assets.tiles);
      a.target = target;
      a.session = new StrokeSession(e.assets.tiles, target.grid, {
        // The mixer brush carries paint in its tip; dabs one pixel apart keep
        // the dragged paint continuous instead of stepping in bands.
        tip: { ...s, hardness: id === 'pencil' ? 1 : s.hardness, aliased: id === 'pencil', size: s.size, spacing: id === 'mixer-brush' ? Math.min(s.spacing, 1 / Math.max(1, s.size)) : s.spacing },
        dynamics: s.dynamics,
        opacity: s.opacity,
        flow: id === 'pencil' ? 1 : s.flow,
        target: paint,
        selection: sel,
        seed: (Math.random() * 2 ** 31) | 0,
        // Paint stops at the canvas edge: strokes never store hidden pixels beyond it.
        clip: canvasRect(e.doc),
        ...(patternPreviewOn(e) ? { wrap: { width: e.doc.width, height: e.doc.height } } : {}),
      });
      // Shift-click continues with a straight line from the previous stroke.
      const prev = lastPoint.get(id);
      if (p.shift && prev) a.session.addPoint(prev[0], prev[1], p.pressure);
      const queue = a.queue;
      a.queue = [];
      for (const q of queue) addSample(e, a, q);
      if (s.airbrush) a.timer = window.setInterval(() => {
        if (a.last) {
          a.session!.hold();
          e.preview(previewTarget(e, a.target!, a.session!.grid));
        }
      }, 50);
      if (a.done) finish(e, a, id);
    },
    pointerMove: (e, p) => {
      cursor(e, id, p);
      const a = active;
      if (!a) return;
      if (!a.session) {
        a.queue.push(...(p.coalesced ?? [p]));
        return;
      }
      for (const q of p.coalesced ?? [p]) addSample(e, a, q);
    },
    hover: (e, p) => cursor(e, id, p),
    pointerUp: (e) => {
      const a = active;
      if (!a) return;
      if (!a.session) {
        a.done = true;
        return;
      }
      finish(e, a, id);
    },
    keyDown: (e, ev) => {
      const s = brushFor(id);
      if (ev.key === 'Escape' && active?.session) {
        active.session.cancel();
        clearInterval(active.timer);
        active = undefined;
        // The Quick Mask preview refers to the cancelled stroke's tiles.
        delete e.settings.quickMaskPreview;
        e.preview(e.doc);
        e.overlay();
        return true;
      }
      if (ev.code === 'BracketRight' || ev.code === 'BracketLeft') {
        const up = ev.code === 'BracketRight';
        if (ev.shiftKey) s.hardness = Math.max(0, Math.min(1, s.hardness + (up ? 0.25 : -0.25)));
        else s.size = brushSizeStep(s.size, up);
        e.options();
        if (e.pointerInfo) cursor(e, id, e.pointerInfo);
        return true;
      }
      return false;
    },
    ...extra,
  };
}
function addSample(e: Editor, a: Active, p: CanvasPointer) {
  const s = brushFor(e.tool);
  let x = p.x,
    y = p.y;
  // Exponential smoothing pulls the stroke behind the pointer.
  if (s.smoothing > 0) {
    if (!a.smooth) a.smooth = [x, y];
    const k = 1 - Math.min(0.95, s.smoothing);
    a.smooth = [a.smooth[0] + (x - a.smooth[0]) * k, a.smooth[1] + (y - a.smooth[1]) * k];
    [x, y] = a.smooth;
  }
  a.session!.addPoint(x, y, p.pressure);
  a.last = [x, y];
  a.pressure = p.pressure;
  e.preview(previewTarget(e, a.target!, a.session!.grid));
}
function finish(e: Editor, a: Active, id: string) {
  clearInterval(a.timer);
  active = undefined;
  if (a.last) {
    const p = e.pointerInfo;
    if (p && brushFor(id).smoothing > 0) a.session!.addPoint(p.x, p.y, a.pressure ?? 1);
    lastPoint.set(id, a.last);
  }
  const grid = a.session!.commit();
  delete e.settings.quickMaskPreview;
  commitTarget(e, a.target!, grid, a.label);
}
export function cursor(e: Editor, id: string, p: CanvasPointer) {
  const s = brushFor(id);
  const rect = e.el('#viewport').getBoundingClientRect();
  const x = p.clientX - rect.left,
    y = p.clientY - rect.top;
  e.screenOverlayContent = brushCursorMarkup(e, x, y, s, id === 'pencil' ? 1 : s.hardness);
  e.screenOverlay();
}
const crossAt = (x: number, y: number, arm: number, gap: number) =>
  `M${x - arm} ${y}h${arm - gap}M${x + gap} ${y}h${arm - gap}M${x} ${y - arm}v${arm - gap}M${x} ${y + gap}v${arm - gap}`;
/** Screen-space cursor for a brush under Preferences → Cursors: a precise
 * crosshair, the tip outline where the brush is at least half strength
 * ("normal") or at its full size, optionally with a center crosshair. */
export function brushCursorMarkup(e: Editor, x: number, y: number, s: { size: number; roundness: number; angle: number }, hardness: number) {
  const mode = e.preferences.paintCursor;
  if (mode === 'standard') return '';
  const full = Math.max(1, (s.size * e.zoom) / 2);
  const r = mode === 'normal' ? Math.max(1, full * (0.5 + hardness / 2)) : full;
  const cross = (arm: number, gap: number) => `<path d="${crossAt(x, y, arm, gap)}" class="brush-cursor-cross-outer"/><path d="${crossAt(x, y, arm, gap)}" class="brush-cursor-cross"/>`;
  // With View > Show > Brush Preview off, a crosshair marks the exact center.
  if (mode === 'precise' || r < 3 || !brushPreviewShown(e)) return cross(6, 2);
  const t = tipTransform(e, x, y, s.angle);
  const tip = `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * s.roundness}" transform="${t}" class="brush-cursor-outer"/><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * s.roundness}" transform="${t}" class="brush-cursor"/>`;
  return tip + (e.preferences.paintCrosshair ? cross(Math.min(8, r - 1), 0) : '');
}
// The tip outline follows the view's rotation, mirroring and pixel aspect.
function tipTransform(e: Editor, x: number, y: number, angle: number) {
  const m = e.viewMatrix(),
    k = 1 / e.zoom;
  const linear = [m[0], m[1], m[2], m[3]].map((v) => Math.round(v * k * 1e4) / 1e4);
  if (linear.join() === '1,0,0,1') return `rotate(${angle} ${x} ${y})`;
  return `translate(${x} ${y}) matrix(${linear.join(' ')} 0 0) rotate(${angle}) translate(${-x} ${-y})`;
}

export function installPaint(_e: Editor) {
  registerTool(
    strokeTool('brush', 'Brush Tool', 'paintbrush', 'brush', 'B', 'Brush Tool'),
    strokeTool('pencil', 'Pencil Tool', 'pencil', 'brush', 'B', 'Pencil'),
    strokeTool('eraser', 'Eraser Tool', 'eraser', 'eraser', 'E', 'Eraser'),
    {
      id: 'bucket',
      label: 'Paint Bucket Tool',
      key: 'G',
      icon: 'paint-bucket',
      group: 'fill',
      cursor: () => 'crosshair',
      options: (e) =>
        `<label>Fill <select id="bucket-source"><option value="foreground">Foreground</option><option value="background" ${e.settings.bucketSource === 'background' ? 'selected' : ''}>Background</option></select></label><label>Opacity <input id="bucket-opacity" type="number" min="1" max="100" value="${Math.round(Number(e.settings.bucketOpacity ?? 1) * 100)}">%</label><label>Tolerance <input id="tolerance" type="number" value="${e.tolerance}" min="0" max="255"></label><label class="transform-setting"><input id="wand-contiguous" type="checkbox" ${e.settings.contiguous !== false ? 'checked' : ''}>Contiguous</label><label class="transform-setting"><input id="wand-all" type="checkbox" ${e.settings.sampleAllLayers ? 'checked' : ''}>All Layers</label>`,
      bindOptions: ({ e, el }) => {
        el.querySelector<HTMLSelectElement>('#bucket-source')?.addEventListener('change', (ev) => (e.settings.bucketSource = (ev.target as HTMLSelectElement).value));
        el.querySelector<HTMLInputElement>('#bucket-opacity')?.addEventListener('change', (ev) => (e.settings.bucketOpacity = Math.max(0.01, Math.min(1, Number((ev.target as HTMLInputElement).value) / 100))));
        el.querySelector<HTMLInputElement>('#tolerance')?.addEventListener('change', (ev) => (e.tolerance = Math.max(0, Math.min(255, Number((ev.target as HTMLInputElement).value) || 0))));
        el.querySelector<HTMLInputElement>('#wand-contiguous')?.addEventListener('change', (ev) => (e.settings.contiguous = (ev.target as HTMLInputElement).checked));
        el.querySelector<HTMLInputElement>('#wand-all')?.addEventListener('change', (ev) => (e.settings.sampleAllLayers = (ev.target as HTMLInputElement).checked));
      },
      pointerDown: async (e, p) => {
        const x = Math.floor(p.x),
          y = Math.floor(p.y);
        if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;
        const target = await pixelTarget(e);
        if (!target) return;
        const region = await wandMask(e, x, y);
        const sel = selectionGrid(e.doc, e.assets.tiles);
        const area = canvasRect(e.doc);
        const cover = sel ? readMask(e.assets.tiles, sel, area).data : undefined;
        const rgb = hexRgb(e.settings.bucketSource === 'background' ? e.background : e.color);
        const opacity = Number(e.settings.bucketOpacity ?? 1);
        if (target.kind !== 'pixels') {
          const m = readMask(e.assets.tiles, target.grid, area);
          const v = Math.round(rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114);
          for (let i = 0; i < m.data.length; i++) {
            const k = (region.data[i] / 255) * opacity * (cover ? cover[i] / 255 : 1);
            m.data[i] += (v - m.data[i]) * k;
          }
          commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, m), 'Paint Bucket');
          return;
        }
        const preserve = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
        const img = readRGBA(e.assets.tiles, target.grid, area);
        const d = img.data;
        for (let i = 0; i < region.data.length; i++) {
          const k = (region.data[i] / 255) * opacity * (cover ? cover[i] / 255 : 1);
          if (!k) continue;
          const ba = d[i * 4 + 3] / 255;
          if (preserve) {
            for (let c = 0; c < 3; c++) d[i * 4 + c] += (rgb[c] - d[i * 4 + c]) * k;
            continue;
          }
          const oa = k + ba * (1 - k);
          for (let c = 0; c < 3; c++) d[i * 4 + c] = (rgb[c] * k + d[i * 4 + c] * ba * (1 - k)) / oa;
          d[i * 4 + 3] = oa * 255;
        }
        commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, img), 'Paint Bucket');
      },
    },
  );
  registerCommand({
    id: 'brush.reset',
    label: 'Reset Brush',
    hidden: true,
    run: (e) => {
      settings.delete(e.tool);
      e.options();
    },
  });
}
