import type { Editor } from '../editor';
import { registerTool, registerCommand, type Tool } from '../app/registry';
import type { CanvasPointer } from '../app/pointer';
import type { DocumentSession } from '../app/session';
import { brushSizeStep } from '../app/shortcuts';
import { StrokeSession, type BrushTip, type PaintMode, type PaintTarget, type BrushDynamics } from '../engine/paint';
import { smudgeSpacing } from '../engine/smudge';
import { pixelTarget, previewTarget, commitTarget, hexRgb, type PixelTarget } from './pixels';
import { selectionGrid, canvasRect } from '../model/selection';
import { layerLock } from '../model/locks';
import { readMask, readRGBA, writeRect } from '../model/tiles';
import { bindTolerance, wandMask } from './selection';
import { escapeXML } from '../model/assets';
import { svg } from '../app/icons';
import { blendColor, blendModes, hash01 } from '../imaging/blend/modes';
import { currentPattern, effectsState, patternThumb } from './effects/state';
import { openPatternPicker } from './effects/controls';
import { brushPreviewShown } from './view-extras';
import { patternPreviewOn } from './view-modes';
import { iconCursor } from './preferences/cursors';
import { bindNumberField } from './paint-tools/fields';
import { historyPaintTarget } from './history-tools';
import { sampleColorAt } from './layer-tools';

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
    s = { size: id === 'pencil' ? 3 : 30, hardness: id === 'pencil' ? 1 : 0.8, spacing: 0.1, roundness: 1, angle: 0, opacity: 1, flow: 1, mode: id === 'color-replacement' ? 'color' : 'normal', smoothing: 0.1, dynamics: {}, airbrush: false };
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
// Tools that pick the foreground color with Alt-click, and the pick in progress.
const EYEDROP_TOOLS = new Set(['brush', 'pencil', 'color-replacement']);
let eyedrop: { previous: string } | undefined;
/** The ring shown while picking: the new color above, the previous below. */
function samplingRing(e: Editor, p: CanvasPointer) {
  const rect = e.el('#viewport').getBoundingClientRect();
  const x = p.clientX - rect.left,
    y = p.clientY - rect.top,
    r = 34;
  const arc = (from: number, color: string) =>
    `<path d="M${x - r} ${y}A${r} ${r} 0 0 ${from} ${x + r} ${y}" fill="none" stroke="${escapeXML(color)}" stroke-width="14"/>`;
  e.screenOverlayContent = `<g class="sampling-ring"><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="16"/>${arc(1, e.color)}${arc(0, eyedrop?.previous ?? e.color)}<circle cx="${x}" cy="${y}" r="${r + 7}" fill="none" stroke="#fff" stroke-opacity=".7"/><circle cx="${x}" cy="${y}" r="${r - 7}" fill="none" stroke="#fff" stroke-opacity=".7"/></g>`;
  e.screenOverlay();
}
// Where each tool's last stroke ended, per document (Shift-click continues it).
const lastPoints = new WeakMap<DocumentSession, Map<string, [number, number]>>();
function lastPoint(e: Editor) {
  let points = lastPoints.get(e.session);
  if (!points) lastPoints.set(e.session, (points = new Map()));
  return points;
}

// Which brush controls a tool's options bar shows: only those that change
// what the tool does (Dodge and Burn have Exposure instead of Opacity and
// Flow; Blur and Smudge have Strength and their own short list of modes).
export type BrushControls = {
  hardness?: boolean;
  // Paint modes offered; false hides the Mode menu.
  modes?: readonly PaintMode[] | false;
  opacity?: boolean;
  flow?: boolean;
  airbrush?: boolean;
  angle?: boolean;
  // Number keys set this instead of the opacity (and flow) when opacity is hidden.
  numberKey?: (e: Editor, value: number) => void;
};
const PAINT_MODES: PaintMode[] = ['normal', 'dissolve', 'behind', 'clear', ...blendModes.slice(2).map((m) => m.id)];
export const FOCUS_MODES: readonly PaintMode[] = ['normal', 'darken', 'lighten', 'hue', 'saturation', 'color', 'luminosity'];
export const COLOR_REPLACE_MODES: readonly PaintMode[] = ['hue', 'saturation', 'color', 'luminosity'];
const pct = (key: string) => (e: Editor, v: number) => (e.settings[key] = Math.max(1, Math.round(v * 100)));
const focusControls: BrushControls = { modes: FOCUS_MODES, opacity: false, flow: false, airbrush: false };
const brushControlTable: Record<string, BrushControls> = {
  pencil: { hardness: false, flow: false, airbrush: false },
  'color-replacement': { modes: COLOR_REPLACE_MODES, opacity: false, flow: false, airbrush: false, numberKey: pct('replaceTolerance') },
  'background-eraser': { modes: false, opacity: false, flow: false, airbrush: false, numberKey: pct('bgTolerance') },
  'blur-tool': { ...focusControls, numberKey: pct('blurStrength') },
  'sharpen-tool': { ...focusControls, numberKey: pct('sharpenStrength') },
  'smudge-tool': { ...focusControls, numberKey: pct('smudgeStrength') },
  dodge: { modes: false, opacity: false, flow: false, numberKey: pct('toneExposure') },
  burn: { modes: false, opacity: false, flow: false, numberKey: pct('toneExposure') },
  sponge: { modes: false, opacity: false, flow: false, numberKey: pct('toneExposure') },
};
export type EraserMode = 'brush' | 'pencil' | 'block';
export const eraserMode = (e: Editor): EraserMode => (e.settings.eraserMode === 'pencil' || e.settings.eraserMode === 'block' ? e.settings.eraserMode : 'brush');
/** The brush controls a tool shows (the Eraser's depend on its mode). */
export function brushControls(e: Editor, id: string): BrushControls {
  if (id === 'eraser') {
    const m = eraserMode(e);
    if (m === 'block') return { modes: false, hardness: false, opacity: false, flow: false, airbrush: false, angle: false };
    return m === 'pencil' ? { modes: false, hardness: false, flow: false, airbrush: false } : { modes: false };
  }
  return brushControlTable[id] ?? {};
}
// The eraser's Pencil and Block modes paint hard, aliased dabs; Block dabs are square.
const aliasedTip = (e: Editor, id: string) => id === 'pencil' || (id === 'eraser' && eraserMode(e) !== 'brush');

export function brushOptions(e: Editor, id: string, extra = '') {
  const s = brushFor(id);
  const c = brushControls(e, id);
  const modes = c.modes === false ? [] : (c.modes ?? PAINT_MODES);
  const label = (m: PaintMode) => blendModes.find((b) => b.id === m)?.label ?? m[0].toUpperCase() + m.slice(1);
  // Short lists (Blur, Smudge) keep Darken and Lighten together.
  const groupOf = (m: PaintMode) => {
    const g = m === 'behind' || m === 'clear' ? 0 : (blendModes.find((b) => b.id === m)?.group ?? 0);
    return modes.length < 10 && g === 2 ? 1 : g;
  };
  const modeMenu = modes.length
    ? `<label>Mode <select id="brush-mode" aria-label="Brush blend mode">${modes.map((m, i) => `${i > 0 && groupOf(m) !== groupOf(modes[i - 1]) ? '<option disabled>──────────</option>' : ''}<option value="${m}" ${s.mode === m ? 'selected' : ''}>${label(m)}</option>`).join('')}</select></label>`
    : '';
  const eraser =
    id === 'eraser'
      ? `<label>Mode <select id="eraser-mode" aria-label="Eraser mode">${(['brush', 'pencil', 'block'] as const).map((m) => `<option value="${m}" ${eraserMode(e) === m ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></label>`
      : '';
  const hardness = c.hardness !== false;
  return `<button class="brush-preview" data-brush-popover="${id}" title="Brush settings" aria-label="Brush preset and size"><span class="brush-dot" style="--size:${Math.min(22, 4 + Math.sqrt(s.size) * 1.6)}px;--hard:${hardness ? s.hardness : 1}"></span><span>${Math.round(s.size)}</span></button>
<label>Size <input id="brush-size" type="number" min="1" max="5000" value="${Math.round(s.size)}" aria-label="Brush size (px)"> px</label>
${hardness ? `<label>Hardness <input id="brush-hardness" type="number" min="0" max="100" value="${Math.round(s.hardness * 100)}" aria-label="Brush hardness (%)">%</label>` : ''}
${modeMenu}${eraser}
${c.opacity === false ? '' : `<label>Opacity <input id="brush-opacity" type="number" min="1" max="100" value="${Math.round(s.opacity * 100)}" aria-label="Brush opacity (%)">%</label>
<button class="icon-button toggle" id="pressure-opacity" aria-pressed="${!!s.dynamics.pressureOpacity}" title="Pressure controls opacity" aria-label="Pressure controls opacity">${svg('pressure-opacity', 16)}</button>`}
${c.flow === false ? '' : `<label>Flow <input id="brush-flow" type="number" min="1" max="100" value="${Math.round(s.flow * 100)}" aria-label="Brush flow (%)">%</label>`}${c.airbrush === false ? '' : `<button class="icon-button toggle" id="airbrush" aria-pressed="${s.airbrush}" title="Airbrush build-up" aria-label="Airbrush">${svg('airbrush', 16)}</button>`}
<label>Smoothing <input id="brush-smoothing" type="number" min="0" max="100" value="${Math.round(s.smoothing * 100)}" aria-label="Smoothing (%)">%</label>
${c.angle === false ? '' : `<label title="Angle of the brush tip">Angle <input id="brush-angle" type="number" min="-180" max="180" value="${Math.round(s.angle)}" aria-label="Brush angle (degrees)">°</label>`}
<button class="icon-button toggle" id="pressure-size" aria-pressed="${!!s.dynamics.pressureSize}" title="Pressure controls size" aria-label="Pressure controls size">${svg('pressure-size', 16)}</button>${id === 'pencil' ? `<label class="transform-setting" title="Strokes that start on the foreground color paint the background color"><input type="checkbox" id="pencil-auto-erase" ${e.settings.pencilAutoErase ? 'checked' : ''}>Auto Erase</label>` : ''}${id === 'eraser' ? `<label class="transform-setting" title="Restore the History Brush source state instead of erasing to transparency"><input type="checkbox" id="erase-to-history" ${e.settings.eraseToHistory ? 'checked' : ''}>Erase to History</label>` : ''}${extra}`;
}
export function bindBrushOptions(e: Editor, el: HTMLElement, id: string) {
  const s = brushFor(id);
  const num = (sel: string, get: () => number, set: (v: number) => void) => bindNumberField(el, sel, get, set, () => e.options());
  num('#brush-size', () => s.size, (v) => (s.size = Math.max(1, Math.min(5000, v))));
  num('#brush-hardness', () => s.hardness * 100, (v) => (s.hardness = Math.max(0, Math.min(1, v / 100))));
  num('#brush-opacity', () => s.opacity * 100, (v) => (s.opacity = Math.max(0.01, Math.min(1, v / 100))));
  num('#brush-flow', () => s.flow * 100, (v) => (s.flow = Math.max(0.01, Math.min(1, v / 100))));
  num('#brush-smoothing', () => s.smoothing * 100, (v) => (s.smoothing = Math.max(0, Math.min(1, v / 100))));
  num('#brush-angle', () => s.angle, (v) => (s.angle = Math.max(-180, Math.min(180, Math.round(v)))));
  el.querySelector<HTMLSelectElement>('#eraser-mode')?.addEventListener('change', (ev) => {
    e.settings.eraserMode = (ev.target as HTMLSelectElement).value;
    e.options();
  });
  el.querySelector<HTMLInputElement>('#pencil-auto-erase')?.addEventListener('change', (ev) => (e.settings.pencilAutoErase = (ev.target as HTMLInputElement).checked));
  el.querySelector<HTMLInputElement>('#erase-to-history')?.addEventListener('change', (ev) => (e.settings.eraseToHistory = (ev.target as HTMLInputElement).checked));
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
// Closes the open brush popover (the brush button toggles it); true when it was shown.
let closePopover: ((refocus?: boolean) => boolean) | undefined;
function openBrushPopover(e: Editor, id: string, anchor: HTMLElement) {
  if (closePopover?.()) return;
  const s = brushFor(id);
  const pop = document.createElement('div');
  pop.className = 'brush-popover popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Brush settings');
  pop.innerHTML = `<label>Size <input type="range" min="1" max="1000" value="${s.size}" data-k="size"><output>${Math.round(s.size)} px</output></label><label>Hardness <input type="range" min="0" max="100" value="${s.hardness * 100}" data-k="hardness"><output>${Math.round(s.hardness * 100)}%</output></label><label>Angle <input type="range" min="-180" max="180" value="${s.angle}" data-k="angle"><output>${s.angle}°</output></label><label>Roundness <input type="range" min="1" max="100" value="${s.roundness * 100}" data-k="roundness"><output>${Math.round(s.roundness * 100)}%</output></label><label>Spacing <input type="range" min="1" max="200" value="${s.spacing * 100}" data-k="spacing"><output>${Math.round(s.spacing * 100)}%</output></label><div class="preset-list" role="listbox" aria-label="Brush presets">${brushPresets.map((p, i) => `<button role="option" data-preset="${i}">${escapeXML(p.name)}</button>`).join('')}</div>`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  pop.querySelector<HTMLInputElement>('input')?.focus();
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
    dismiss(true);
  });
  const dismiss = (refocus: boolean) => {
    closePopover = undefined;
    pop.remove();
    document.removeEventListener('pointerdown', close, true);
    e.options();
    // The options bar was redrawn: return focus to the new brush button.
    if (refocus) document.querySelector<HTMLElement>(`[data-brush-popover="${id}"]`)?.focus();
  };
  const close = (ev: Event) => {
    // The brush button's own click toggles the popover.
    if (!pop.contains(ev.target as Node) && !(ev.target as Element).closest?.('[data-brush-popover]')) dismiss(false);
  };
  pop.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    dismiss(true);
  });
  closePopover = (refocus = true) => {
    const shown = pop.isConnected;
    dismiss(shown && refocus);
    return shown;
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
}

function paintTargetFor(e: Editor, id: string, target: PixelTarget, p: CanvasPointer): PaintTarget | undefined {
  const s = brushFor(id);
  // Auto Erase: a pencil stroke that starts on the foreground color paints the background color.
  const autoErase = id === 'pencil' && !!e.settings.pencilAutoErase && startsOnForeground(e, target, p);
  if (target.kind !== 'pixels') {
    const hex = id === 'eraser' || autoErase ? e.background : e.color;
    const [r, g, b] = hexRgb(hex);
    return { kind: 'mask', value: Math.round(r * 0.299 + g * 0.587 + b * 0.114) };
  }
  const preserveAlpha = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
  if (id === 'eraser' && e.settings.eraseToHistory) return historyPaintTarget(e, target, 'normal');
  if (id === 'eraser') return { kind: 'color', rgb: hexRgb(e.background), mode: 'normal', erase: !preserveAlpha, preserveAlpha };
  return { kind: 'color', rgb: hexRgb(autoErase ? e.background : e.color), mode: s.mode, preserveAlpha };
}
function startsOnForeground(e: Editor, target: PixelTarget, p: CanvasPointer) {
  const x = Math.floor(p.x),
    y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return false;
  const [r, g, b] = hexRgb(e.color);
  if (target.kind !== 'pixels') {
    const v = readMask(e.assets.tiles, target.grid, { x, y, width: 1, height: 1 }).data[0];
    return Math.abs(v - Math.round(r * 0.299 + g * 0.587 + b * 0.114)) <= 1;
  }
  const d = readRGBA(e.assets.tiles, target.grid, { x, y, width: 1, height: 1 }).data;
  return d[3] > 0 && Math.abs(d[0] - r) <= 1 && Math.abs(d[1] - g) <= 1 && Math.abs(d[2] - b) <= 1;
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
      // Number keys set the opacity, with Shift the flow (or the tool's own
      // strength, exposure or tolerance when it has no opacity).
      e.settings.numberKey = (value: number, shift: boolean) => {
        const c = brushControls(e, id);
        if (c.opacity === false) {
          if (!c.numberKey || shift) return false;
          c.numberKey(e, value);
        } else if (shift) brushFor(id).flow = value;
        else brushFor(id).opacity = value;
        e.options();
        return true;
      };
    },
    deactivate: (e) => {
      closePopover?.(false);
      endStroke(e, id);
      e.screenOverlayContent = '';
      e.screenOverlay();
      delete e.settings.numberKey;
    },
    pointerDown: async (e, p) => {
      // Alt-click (Option-click) picks the foreground color from the image.
      if (p.alt && EYEDROP_TOOLS.has(id)) {
        eyedrop = { previous: e.color };
        await sampleColorAt(e, p);
        samplingRing(e, p);
        return;
      }
      // A stroke still running (its release never came, or another pointer
      // pressed) is stored first, so it is neither lost nor left airbrushing.
      if (active?.session) finish(e, active, id);
      const a: Active = { queue: [p], label: history };
      active = a;
      const target = await pixelTarget(e);
      if (!target || active !== a) {
        active = undefined;
        return;
      }
      const s = brushFor(id);
      let paint = makeTarget ? makeTarget(e, target, p) : paintTargetFor(e, id, target, p);
      if (!paint) {
        active = undefined;
        return;
      }
      // Locked transparency holds for every tool, whatever its own target asks.
      if (target.kind === 'pixels' && paint.kind !== 'mask' && !paint.preserveAlpha && layerLock(e.doc.layers, target.layer.id, 'transparency'))
        paint = { ...paint, preserveAlpha: true };
      const sel = target.kind === 'quick-mask' ? null : selectionGrid(e.doc, e.assets.tiles);
      const controls = brushControls(e, id);
      const aliased = aliasedTip(e, id),
        block = id === 'eraser' && eraserMode(e) === 'block';
      a.target = target;
      a.session = new StrokeSession(e.assets.tiles, target.grid, {
        // The mixer brush carries paint in its tip; dabs one pixel apart keep
        // the dragged paint continuous instead of stepping in bands.
        tip: { ...s, ...(block ? { angle: 0, roundness: 1, square: true } : {}), hardness: aliased ? 1 : s.hardness, aliased, size: s.size, spacing: id === 'mixer-brush' ? Math.min(s.spacing, 1 / Math.max(1, s.size)) : id === 'smudge-tool' ? Math.min(s.spacing, smudgeSpacing) : s.spacing },
        dynamics: s.dynamics,
        opacity: controls.opacity === false ? 1 : s.opacity,
        flow: controls.flow === false ? 1 : s.flow,
        target: paint,
        selection: sel,
        seed: (Math.random() * 2 ** 31) | 0,
        // Paint stops at the canvas edge: strokes never store hidden pixels beyond it.
        clip: canvasRect(e.doc),
        ...(patternPreviewOn(e) ? { wrap: { width: e.doc.width, height: e.doc.height } } : {}),
      });
      // Shift-click continues with a straight line from the previous stroke.
      const prev = lastPoint(e).get(id);
      if (p.shift && prev) a.session.addPoint(prev[0], prev[1], p.pressure);
      const queue = a.queue;
      a.queue = [];
      for (const q of queue) addSample(e, a, q);
      if (s.airbrush && controls.airbrush !== false) a.timer = window.setInterval(() => {
        if (a.last) {
          a.session!.hold();
          e.preview(previewTarget(e, a.target!, a.session!.grid));
        }
      }, 50);
      if (a.done) finish(e, a, id);
    },
    pointerMove: (e, p) => {
      if (eyedrop) {
        void sampleColorAt(e, p).then(() => eyedrop && samplingRing(e, p));
        return;
      }
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
    pointerUp: (e, p) => {
      if (eyedrop) {
        eyedrop = undefined;
        cursor(e, id, p);
        return;
      }
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
/** Another tool or document is taking over mid-stroke: the stroke is stored
 * in the document it was painted in (a stroke still starting is dropped). */
function endStroke(e: Editor, id: string) {
  const a = active;
  if (!a) return;
  if (a.session) finish(e, a, id);
  else active = undefined;
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
    lastPoint(e).set(id, a.last);
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
  const block = id === 'eraser' && eraserMode(e) === 'block';
  e.screenOverlayContent = brushCursorMarkup(e, x, y, block ? { size: s.size, roundness: 1, angle: 0, square: true } : s, aliasedTip(e, id) || brushControls(e, id).hardness === false ? 1 : s.hardness);
  e.screenOverlay();
}
const crossAt = (x: number, y: number, arm: number, gap: number) =>
  `M${x - arm} ${y}h${arm - gap}M${x + gap} ${y}h${arm - gap}M${x} ${y - arm}v${arm - gap}M${x} ${y + gap}v${arm - gap}`;
/** Screen-space cursor for a brush under Preferences → Cursors: a precise
 * crosshair, the tip outline where the brush is at least half strength
 * ("normal") or at its full size, optionally with a center crosshair. */
export function brushCursorMarkup(e: Editor, x: number, y: number, s: { size: number; roundness: number; angle: number; square?: boolean }, hardness: number) {
  const mode = e.preferences.paintCursor;
  if (mode === 'standard') return '';
  const full = Math.max(1, (s.size * e.zoom) / 2);
  const r = mode === 'normal' ? Math.max(1, full * (0.5 + hardness / 2)) : full;
  const cross = (arm: number, gap: number) => `<path d="${crossAt(x, y, arm, gap)}" class="brush-cursor-cross-outer"/><path d="${crossAt(x, y, arm, gap)}" class="brush-cursor-cross"/>`;
  // With View > Show > Brush Preview off, a crosshair marks the exact center.
  if (mode === 'precise' || r < 3 || !brushPreviewShown(e)) return cross(6, 2);
  const t = tipTransform(e, x, y, s.angle);
  if (s.square) {
    const box = `x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" transform="${t}"`;
    return `<rect ${box} class="brush-cursor-outer" fill="none"/><rect ${box} class="brush-cursor" fill="none"/>` + (e.preferences.paintCrosshair ? cross(Math.min(8, r - 1), 0) : '');
  }
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

/** Paint Bucket: fills the region of similar color under the click with the
 * foreground, background or current pattern, in a paint mode. */
function bucketTool(): Tool {
  const fillModes: PaintMode[] = PAINT_MODES;
  const mode = (e: Editor): PaintMode => (fillModes.includes(e.settings.bucketMode as PaintMode) ? (e.settings.bucketMode as PaintMode) : 'normal');
  return {
    id: 'bucket',
    label: 'Paint Bucket Tool',
    key: 'G',
    icon: 'paint-bucket',
    group: 'fill',
    cursor: () => 'crosshair',
    options: (e) => {
      const source = e.settings.bucketSource === 'background' || e.settings.bucketSource === 'pattern' ? e.settings.bucketSource : 'foreground';
      const pat = source === 'pattern' ? currentPattern(e) : undefined;
      const m = mode(e);
      const label = (v: PaintMode) => blendModes.find((b) => b.id === v)?.label ?? v[0].toUpperCase() + v.slice(1);
      return `<label>Fill <select id="bucket-source">${[['foreground', 'Foreground'], ['background', 'Background'], ['pattern', 'Pattern']].map(([v, l]) => `<option value="${v}" ${source === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${source === 'pattern' ? `<button type="button" class="pattern-swatch" data-bucket-pattern title="${escapeXML(pat?.name ?? 'Pattern')} — click to choose" aria-label="Pattern">${pat ? `<img src="${patternThumb(pat, 24)}" alt="">` : ''}</button>` : ''}<label>Mode <select id="bucket-mode" aria-label="Fill blend mode">${fillModes.map((v) => `<option value="${v}" ${m === v ? 'selected' : ''}>${label(v)}</option>`).join('')}</select></label><label>Opacity <input id="bucket-opacity" type="number" min="1" max="100" value="${Math.round(Number(e.settings.bucketOpacity ?? 1) * 100)}">%</label><label>Tolerance <input id="tolerance" type="number" value="${e.tolerance}" min="0" max="255"></label><label class="transform-setting"><input id="bucket-anti-alias" type="checkbox" ${e.settings.antiAlias !== false ? 'checked' : ''}>Anti-alias</label><label class="transform-setting"><input id="wand-contiguous" type="checkbox" ${e.settings.contiguous !== false ? 'checked' : ''}>Contiguous</label><label class="transform-setting"><input id="wand-all" type="checkbox" ${e.settings.sampleAllLayers ? 'checked' : ''}>All Layers</label>`;
    },
    bindOptions: ({ e, el }) => {
      el.querySelector<HTMLSelectElement>('#bucket-source')?.addEventListener('change', (ev) => {
        e.settings.bucketSource = (ev.target as HTMLSelectElement).value;
        e.options();
      });
      el.querySelector<HTMLElement>('[data-bucket-pattern]')?.addEventListener('click', (ev) =>
        openPatternPicker(e, ev.currentTarget as HTMLElement, effectsState.patternId, (pid) => {
          effectsState.patternId = pid;
          e.options();
          e.dock?.update();
        }),
      );
      el.querySelector<HTMLSelectElement>('#bucket-mode')?.addEventListener('change', (ev) => (e.settings.bucketMode = (ev.target as HTMLSelectElement).value));
      bindNumberField(el, '#bucket-opacity', () => Number(e.settings.bucketOpacity ?? 1) * 100, (v) => (e.settings.bucketOpacity = Math.max(0.01, Math.min(1, v / 100))));
      bindTolerance(e, el);
      el.querySelector<HTMLInputElement>('#bucket-anti-alias')?.addEventListener('change', (ev) => (e.settings.antiAlias = (ev.target as HTMLInputElement).checked));
      el.querySelector<HTMLInputElement>('#wand-contiguous')?.addEventListener('change', (ev) => (e.settings.contiguous = (ev.target as HTMLInputElement).checked));
      el.querySelector<HTMLInputElement>('#wand-all')?.addEventListener('change', (ev) => (e.settings.sampleAllLayers = (ev.target as HTMLInputElement).checked));
    },
    activate: (e) => {
      e.settings.numberKey = (value: number, shift: boolean) => {
        if (shift) return false;
        e.settings.bucketOpacity = value;
        e.options();
        return true;
      };
    },
    deactivate: (e) => {
      delete e.settings.numberKey;
    },
    pointerDown: async (e, p) => {
      if (p.alt) {
        await sampleColorAt(e, p);
        return;
      }
      const x = Math.floor(p.x),
        y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;
      const target = await pixelTarget(e);
      if (!target) return;
      const region = await wandMask(e, x, y);
      // In Quick Mask mode the mask is the selection being edited.
      const sel = target.kind === 'quick-mask' ? null : selectionGrid(e.doc, e.assets.tiles);
      const area = canvasRect(e.doc);
      const cover = sel ? readMask(e.assets.tiles, sel, area).data : undefined;
      const source = e.settings.bucketSource;
      const pattern = source === 'pattern' ? currentPattern(e) : undefined;
      if (source === 'pattern' && !pattern) return;
      const rgb = hexRgb(source === 'background' ? e.background : e.color);
      const opacity = Number(e.settings.bucketOpacity ?? 1);
      const m = mode(e);
      // Fill color at a pixel: the pattern repeats from the document origin.
      const col = [rgb[0], rgb[1], rgb[2], 1];
      const colorAt = (i: number) => {
        if (!pattern) return col;
        const t = pattern.tile,
          u = (i % area.width) % t.width,
          v = Math.floor(i / area.width) % t.height,
          j = (v * t.width + u) * 4;
        col[0] = t.data[j];
        col[1] = t.data[j + 1];
        col[2] = t.data[j + 2];
        col[3] = t.data[j + 3] / 255;
        return col;
      };
      const seed = (Math.random() * 2 ** 31) | 0;
      const coverage = (i: number) => {
        let k = (region.data[i] / 255) * opacity * (cover ? cover[i] / 255 : 1);
        if (k && m === 'dissolve') k = hash01(i % area.width, Math.floor(i / area.width), seed) < k ? 1 : 0;
        return k;
      };
      if (target.kind !== 'pixels') {
        const mk = readMask(e.assets.tiles, target.grid, area);
        for (let i = 0; i < mk.data.length; i++) {
          const k = coverage(i);
          if (!k) continue;
          const c = colorAt(i);
          const v = m === 'clear' ? 0 : Math.round(c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114);
          mk.data[i] += (v - mk.data[i]) * k * c[3];
        }
        commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, mk), 'Paint Bucket');
        return;
      }
      const preserve = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
      const img = readRGBA(e.assets.tiles, target.grid, area);
      const d = img.data;
      const bc = [0, 0, 0],
        sc = [0, 0, 0],
        o = [0, 0, 0];
      const blend = m !== 'normal' && m !== 'dissolve' && m !== 'behind' && m !== 'clear' ? m : undefined;
      for (let i = 0; i < region.data.length; i++) {
        const c = colorAt(i);
        const k = coverage(i) * c[3];
        if (!k) continue;
        const j = i * 4;
        const ba = d[j + 3] / 255;
        if (m === 'clear' || m === 'behind') {
          // Clear erases and Behind fills only under existing paint:
          // neither applies with locked transparency.
          if (preserve) continue;
          if (m === 'clear') d[j + 3] = d[j + 3] * (1 - k);
          else {
            const oa = ba + k * (1 - ba);
            for (let ch = 0; ch < 3; ch++) d[j + ch] = (d[j + ch] * ba + c[ch] * k * (1 - ba)) / oa;
            d[j + 3] = oa * 255;
          }
          continue;
        }
        let mr = c[0],
          mg = c[1],
          mb = c[2];
        if (blend && ba) {
          for (let ch = 0; ch < 3; ch++) {
            bc[ch] = d[j + ch] / 255;
            sc[ch] = c[ch] / 255;
          }
          blendColor(blend, bc, sc, o);
          // The blended color applies where the backdrop exists.
          mr += (o[0] * 255 - mr) * ba;
          mg += (o[1] * 255 - mg) * ba;
          mb += (o[2] * 255 - mb) * ba;
        }
        if (preserve) {
          d[j] += (mr - d[j]) * k;
          d[j + 1] += (mg - d[j + 1]) * k;
          d[j + 2] += (mb - d[j + 2]) * k;
          continue;
        }
        const oa = k + ba * (1 - k);
        d[j] = (mr * k + d[j] * ba * (1 - k)) / oa;
        d[j + 1] = (mg * k + d[j + 1] * ba * (1 - k)) / oa;
        d[j + 2] = (mb * k + d[j + 2] * ba * (1 - k)) / oa;
        d[j + 3] = oa * 255;
      }
      commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, img), 'Paint Bucket');
    },
  };
}

export function installPaint(_e: Editor) {
  registerTool(
    strokeTool('brush', 'Brush Tool', 'paintbrush', 'brush', 'B', 'Brush Tool'),
    strokeTool('pencil', 'Pencil Tool', 'pencil', 'brush', 'B', 'Pencil'),
    strokeTool('eraser', 'Eraser Tool', 'eraser', 'eraser', 'E', 'Eraser'),
    bucketTool(),
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
