import type { Editor } from '../editor';
import { registerTool, type Tool } from '../app/registry';
import { strokeTool, brushOptions, bindBrushOptions, brushFor, FOCUS_MODES, COLOR_REPLACE_MODES } from './paint';
import { blendColor, type BlendMode } from '../imaging/blend/modes';
import { commitTarget, hexRgb, pixelTarget, type PixelTarget } from './pixels';
import type { CanvasPointer } from '../app/pointer';
import { svg } from '../app/icons';
import type { Sampler } from '../imaging/retouch/clone-transform';
import {
  activeSource,
  cloneSourceChanged,
  cloneState,
  currentLayerSampler,
  currentSourcePoint,
  ignoreAdjustments,
  sampleMode,
  setSource,
  sourceMarker,
  sourceOverlay,
  strokeAnchor,
  strokeSampler,
  warmSource,
  type CloneSource,
  type SampleMode,
} from './clone-source/state';
import { bindSampleOptions, sampleOptions } from './clone-source/options';
import type { LiveReader, PaintMode, PaintTarget } from '../engine/paint';
import { SmudgeFinger } from '../engine/smudge';
import { TILE, tileKey, readRGBA, writeRect, type TileGrid } from '../model/tiles';
import { canvasRect, selectionGrid } from '../model/selection';
import { readMask } from '../model/tiles';
import { bindTolerance, wandMask } from './selection';
import { bindNumberField } from './paint-tools/fields';
import { layerLock } from '../model/locks';

// Sampling helpers over a committed (immutable) grid or a composite snapshot.
function gridSampler(e: Editor, grid: TileGrid) {
  const store = e.assets.tiles;
  return (x: number, y: number, out: Uint8ClampedArray) => {
    const lx = Math.floor(x) - grid.x,
      ly = Math.floor(y) - grid.y;
    const id = grid.tiles[tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))];
    if (!id) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return false;
    }
    const d = store.get(id),
      i = ((((ly % TILE) + TILE) % TILE) * TILE + (((lx % TILE) + TILE) % TILE)) * 4;
    out[0] = d[i];
    out[1] = d[i + 1];
    out[2] = d[i + 2];
    out[3] = d[i + 3];
    return true;
  };
}
// ----- Clone Stamp -----
// Sources, offsets and transforms live in the Clone Source panel's state
// (features/clone-source); a stroke prepares its sampler before painting.
type CloneStroke = { anchor: [number, number]; sampler?: Sampler; mode: SampleMode; src: CloneSource };
let cloneStroke: CloneStroke | undefined;
// Pointer events that arrive while a stroke's source is being prepared.
let clonePreparing: { moves: CanvasPointer[]; up?: CanvasPointer } | undefined;
const cloneTool = (): Tool => {
  const base = strokeTool('clone-stamp', 'Clone Stamp Tool', 'stamp', 'stamp', 'S', 'Clone Stamp', {}, (e, target) => {
    if (target.kind !== 'pixels') {
      e.message('Clone Stamp paints on pixel layers.');
      return;
    }
    const st = cloneStroke;
    if (!st) return;
    // Current-layer sampling reads the target's committed (pre-stroke) pixels.
    const sampler = st.sampler ?? currentLayerSampler(e, st.src, st.anchor, target.layer);
    if (!sampler) return;
    return { kind: 'color', rgb: [0, 0, 0], mode: brushFor('clone-stamp').mode, source: sampler };
  });
  const finishPrepare = () => {
    const pending = clonePreparing;
    clonePreparing = undefined;
    return pending;
  };
  return {
    ...base,
    options: (e) => brushOptions(e, 'clone-stamp', `<label class="transform-setting"><input type="checkbox" id="clone-aligned" ${e.settings.cloneAligned !== false ? 'checked' : ''}>Aligned</label>${sampleOptions('clone-sample', sampleMode(e, 'clone'))}<button class="icon-button toggle" id="clone-ignore-adj" aria-pressed="${ignoreAdjustments(e)}" title="Ignore adjustment layers when sampling" aria-label="Ignore adjustment layers when sampling">${svg('layers-2', 16)}</button><button class="icon-button" id="clone-panel" title="Clone Source panel" aria-label="Open the Clone Source panel">${svg('copy-plus', 16)}</button>`),
    bindOptions: ({ e, el }) => {
      bindBrushOptions(e, el, 'clone-stamp');
      bindSampleOptions(e, el, 'clone');
    },
    activate: (e) => {
      base.activate?.(e);
      warmSource(e, sampleMode(e, 'clone'));
    },
    deactivate: (e, reason) => {
      // A stroke still preparing its source never starts.
      clonePreparing = undefined;
      cloneStroke = undefined;
      return base.deactivate?.(e, reason);
    },
    pointerDown: async (e, p) => {
      if (p.alt) {
        await setSource(e, p.x, p.y, 'clone');
        e.message('Clone source set.');
        e.overlay();
        return;
      }
      const src = activeSource();
      if (!src) {
        e.message('Alt-click (Option-click) to define a source point to clone from.');
        return;
      }
      const mode = sampleMode(e, 'clone');
      const anchor = strokeAnchor(src, [p.x, p.y], e.settings.cloneAligned !== false);
      cloneSourceChanged();
      const st: CloneStroke = { anchor, mode, src };
      cloneStroke = st;
      if (mode !== 'current' || src.sessionId !== e.session.id) {
        const layer = e.layer;
        if (!layer) return;
        clonePreparing = { moves: [] };
        const sampler = await strokeSampler(e, src, anchor, mode, layer);
        const pending = finishPrepare();
        if (!sampler || cloneStroke !== st) return;
        st.sampler = sampler;
        const started = base.pointerDown!(e, p);
        for (const q of pending?.moves ?? []) base.pointerMove!(e, q);
        if (pending?.up) void base.pointerUp!(e, pending.up);
        await started;
        return;
      }
      return base.pointerDown!(e, p);
    },
    pointerMove: (e, p) => {
      if (clonePreparing) {
        clonePreparing.moves.push(...(p.coalesced ?? [p]));
        return;
      }
      base.pointerMove!(e, p);
      if (e.toolBusy || cloneState.overlay.show) e.overlay();
    },
    hover: (e, p) => {
      base.hover!(e, p);
      if (cloneState.overlay.show && activeSource()) e.overlay();
    },
    pointerUp: async (e, p) => {
      if (clonePreparing) {
        clonePreparing.up = p;
        return;
      }
      await base.pointerUp!(e, p);
      warmSource(e, sampleMode(e, 'clone'));
    },
    overlay: (e) => {
      const src = activeSource();
      if (!src) return '';
      const painting = !!cloneStroke && e.toolBusy;
      return sourceOverlay(e, 'clone', brushFor('clone-stamp').size, painting, painting ? cloneStroke!.anchor : undefined) + (src.sessionId === e.session.id || painting ? sourceMarker(e, currentSourcePoint(e, src, painting, cloneStroke?.anchor)) : '');
    },
  };
};

// ----- Focus and toning tools (process existing pixels) -----
function lum(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function focusTarget(kind: 'blur' | 'sharpen' | 'smudge') {
  return (e: Editor, target: PixelTarget): PaintTarget | undefined => {
    if (target.kind !== 'pixels') {
      e.message('This tool works on pixel layers.');
      return;
    }
    const strength = Number(e.settings[`${kind}Strength`] ?? 50) / 100;
    const t = new Uint8ClampedArray(4);
    const b = brushFor(`${kind}-tool`);
    const blend = modeBlender(b.mode);
    if (kind === 'smudge') {
      // The tip carries the colors it passes over along the stroke; with
      // Finger Painting each stroke starts with the foreground color on it.
      const finger = new SmudgeFinger(b.size, strength, e.settings.fingerPainting ? hexRgb(e.color) : undefined);
      return {
        kind: 'custom',
        dab: (cx, cy, size) => finger.dab(cx, cy, size),
        pixel: (x, y, alpha, cur, out) => {
          finger.pixel(x, y, alpha, cur, out);
          blend?.(cur, out);
        },
      };
    }
    // The 3x3 average reads the pixels as the stroke has left them, so the
    // effect builds up while scrubbing. Dabs overlap about 1/spacing times;
    // each applies the share that makes one pass about the chosen strength.
    const share = 1 - Math.pow(1 - Math.min(1, strength), Math.min(1, Math.max(0.01, b.spacing)));
    let read: LiveReader | undefined;
    return {
      kind: 'custom',
      preserveAlpha: true,
      dab: (_cx, _cy, _size, live) => (read = live),
      pixel: (x, y, alpha, cur, out) => {
        out[0] = cur[0];
        out[1] = cur[1];
        out[2] = cur[2];
        out[3] = cur[3];
        let r = 0, g = 0, bl = 0, a = 0;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            if (!read!(x + i, y + j, t)) continue;
            const w = t[3];
            r += t[0] * w;
            g += t[1] * w;
            bl += t[2] * w;
            a += w;
          }
        if (!a) return;
        const k = Math.min(1, alpha * share) * (kind === 'blur' ? 1 : -2);
        out[0] = cur[0] + (r / a - cur[0]) * k;
        out[1] = cur[1] + (g / a - cur[1]) * k;
        out[2] = cur[2] + (bl / a - cur[2]) * k;
        blend?.(cur, out);
      },
    };
  };
}
/** Applies a focus tool's mode to its result: Darken and Lighten keep only
 * darker or lighter results, Hue, Saturation, Color and Luminosity take only
 * that component of the result. Undefined for Normal. */
export function modeBlender(mode: PaintMode) {
  if (mode === 'normal' || !FOCUS_MODES.includes(mode) || mode === 'behind' || mode === 'clear' || mode === 'dissolve') return undefined;
  const bc = [0, 0, 0],
    sc = [0, 0, 0],
    o = [0, 0, 0];
  return (cur: ArrayLike<number>, out: Uint8ClampedArray) => {
    for (let c = 0; c < 3; c++) {
      bc[c] = cur[c] / 255;
      sc[c] = out[c] / 255;
    }
    blendColor(mode, bc, sc, o);
    out[0] = o[0] * 255;
    out[1] = o[1] * 255;
    out[2] = o[2] * 255;
  };
}
function toneTarget(kind: 'dodge' | 'burn' | 'sponge') {
  return (e: Editor, target: PixelTarget): PaintTarget | undefined => {
    if (target.kind !== 'pixels') {
      e.message('This tool works on pixel layers.');
      return;
    }
    const range = (e.settings.toneRange as string) ?? 'midtones';
    const exposure = Number(e.settings.toneExposure ?? 50) / 100;
    const saturate = e.settings.spongeMode !== 'desaturate';
    const vibrance = e.settings.spongeVibrance !== false;
    const protect = e.settings.protectTones !== false;
    return {
      kind: 'process',
      preserveAlpha: true,
      process: (_x, _y, base, out) => {
        const r = base[0], g = base[1], b = base[2];
        if (kind === 'sponge') {
          const l = lum(r, g, b);
          let k = saturate ? 1 + exposure : 1 - exposure;
          if (vibrance && saturate) {
            // Vibrance: muted colors gain most, and no channel clips.
            const mx = Math.max(r, g, b),
              mn = Math.min(r, g, b);
            k = 1 + exposure * (1 - (mx - mn) / 255);
            if (mx > l) k = Math.min(k, (255 - l) / (mx - l));
            if (mn < l) k = Math.min(k, l / (l - mn));
            k = Math.max(1, k);
          }
          out[0] = l + (r - l) * k;
          out[1] = l + (g - l) * k;
          out[2] = l + (b - l) * k;
          out[3] = base[3];
          return;
        }
        const l = lum(r, g, b) / 255;
        // Weight by tonal range so shadows, midtones or highlights change most.
        const w = range === 'shadows' ? (1 - l) ** 2 : range === 'highlights' ? l ** 2 : 1 - Math.abs(l - 0.5) * 2;
        const amount = exposure * Math.max(0, w) * 0.5;
        // Protecting tones scales the channels together toward the dodged
        // lightness, stopping before any channel clips, so hues do not shift.
        let gain = 0;
        if (protect && kind === 'dodge' && l > 0) {
          gain = (l + (1 - l) * amount) / l;
          const top = Math.max(r, g, b) / 255;
          if (top * gain > 1) gain = Math.max(1, 1 / top);
        }
        for (let c = 0; c < 3; c++) {
          const v = base[c] / 255;
          const n = gain ? v * gain : kind === 'dodge' ? v + (1 - v) * amount : v * (1 - amount);
          out[c] = n * 255;
        }
        out[3] = base[3];
      },
    };
  };
}
function withOptions(tool: Tool, extra: (e: Editor) => string, bind: (e: Editor, el: HTMLElement) => void): Tool {
  return {
    ...tool,
    options: (e) => brushOptions(e, tool.id, extra(e)),
    bindOptions: ({ e, el }) => {
      bindBrushOptions(e, el, tool.id);
      bind(e, el);
    },
  };
}
const strengthField = (key: string) => (e: Editor) => `<label>Strength <input id="tool-strength" type="number" min="1" max="100" value="${Number(e.settings[key] ?? 50)}">%</label>`;
const bindStrength = (key: string) => (e: Editor, el: HTMLElement) =>
  bindNumberField(el, '#tool-strength', () => Number(e.settings[key] ?? 50), (v) => (e.settings[key] = Math.max(1, Math.min(100, v))));
const toneFields = (sponge: boolean) => (e: Editor) =>
  sponge
    ? `<label>Mode <select id="sponge-mode"><option value="desaturate">Desaturate</option><option value="saturate" ${e.settings.spongeMode === 'saturate' ? 'selected' : ''}>Saturate</option></select></label><label>Flow <input id="tone-exposure" type="number" min="1" max="100" value="${Number(e.settings.toneExposure ?? 50)}">%</label><label class="transform-setting" title="Saturating raises muted colors most and never clips a channel"><input type="checkbox" id="sponge-vibrance" ${e.settings.spongeVibrance !== false ? 'checked' : ''}>Vibrance</label>`
    : `<label>Range <select id="tone-range">${['shadows', 'midtones', 'highlights'].map((r) => `<option value="${r}" ${(e.settings.toneRange ?? 'midtones') === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></label><label>Exposure <input id="tone-exposure" type="number" min="1" max="100" value="${Number(e.settings.toneExposure ?? 50)}">%</label><label class="transform-setting"><input type="checkbox" id="protect-tones" ${e.settings.protectTones !== false ? 'checked' : ''}>Protect Tones</label>`;
const bindTone = (e: Editor, el: HTMLElement) => {
  el.querySelector<HTMLSelectElement>('#tone-range')?.addEventListener('change', (ev) => (e.settings.toneRange = (ev.target as HTMLSelectElement).value));
  el.querySelector<HTMLSelectElement>('#sponge-mode')?.addEventListener('change', (ev) => (e.settings.spongeMode = (ev.target as HTMLSelectElement).value));
  bindNumberField(el, '#tone-exposure', () => Number(e.settings.toneExposure ?? 50), (v) => (e.settings.toneExposure = Math.max(1, Math.min(100, v))));
  el.querySelector<HTMLInputElement>('#protect-tones')?.addEventListener('change', (ev) => (e.settings.protectTones = (ev.target as HTMLInputElement).checked));
  el.querySelector<HTMLInputElement>('#sponge-vibrance')?.addEventListener('change', (ev) => (e.settings.spongeVibrance = (ev.target as HTMLInputElement).checked));
};

// ----- Erasers and color replacement -----
function colorDistance(a: Uint8ClampedArray | number[], b: Uint8ClampedArray | number[]) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}
// Sampled under the pointer-down point: a touch or pen tap has no hover before it.
function sampledColor(e: Editor, target: PixelTarget & { kind: 'pixels' }, p: CanvasPointer) {
  const sample = gridSampler(e, target.grid);
  const t = new Uint8ClampedArray(4);
  sample(p.x, p.y, t);
  return { sample, ref: [t[0], t[1], t[2]] };
}
function backgroundEraserTarget(e: Editor, target: PixelTarget, p: CanvasPointer): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The Background Eraser works on pixel layers.');
    return;
  }
  if (layerLock(e.doc.layers, target.layer.id, 'transparency')) {
    e.message('Unlock transparent pixels to use the Background Eraser.');
    return;
  }
  const tol = Number(e.settings.bgTolerance ?? 50) * 2.55;
  const mode = (e.settings.bgSampling as string) ?? 'once';
  const ref = mode === 'swatch' ? hexRgb(e.background) : sampledColor(e, target, p).ref;
  const current = continuousSample(e, target, ref, mode === 'continuous');
  const fg = e.settings.bgProtectForeground ? hexRgb(e.color) : undefined;
  return {
    kind: 'process',
    process: (_x, _y, base, out) => {
      out.set(base);
      // Protect Foreground Color keeps pixels close to the foreground color.
      if (fg && colorDistance(base, fg) <= tol) return;
      const d = colorDistance(base, current());
      // Soft edge around the tolerance limit.
      const k = d <= tol ? 1 : d <= tol + 20 ? 1 - (d - tol) / 20 : 0;
      out[3] = base[3] * (1 - k);
    },
  };
}
/** The reference color of a sampling stroke: with Continuous sampling it
 * follows the color under the pointer. */
function continuousSample(e: Editor, target: PixelTarget & { kind: 'pixels' }, ref: number[], continuous: boolean) {
  if (!continuous) return () => ref;
  const sample = gridSampler(e, target.grid);
  const t = new Uint8ClampedArray(4);
  let current = ref;
  let lastPointer: unknown;
  return () => {
    if (e.pointerInfo !== lastPointer) {
      lastPointer = e.pointerInfo;
      if (e.pointerInfo && sample(e.pointerInfo.x, e.pointerInfo.y, t)) current = [t[0], t[1], t[2]];
    }
    return current;
  };
}
function colorReplaceTarget(e: Editor, target: PixelTarget, p: CanvasPointer): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The Color Replacement Tool works on pixel layers.');
    return;
  }
  const tol = Number(e.settings.replaceTolerance ?? 30) * 2.55;
  const sampling = (e.settings.replaceSampling as string) ?? 'continuous';
  const ref = sampling === 'swatch' ? hexRgb(e.background) : sampledColor(e, target, p).ref;
  const current = continuousSample(e, target, ref, sampling === 'continuous');
  const antiAlias = e.settings.replaceAntiAlias !== false;
  const fg = hexRgb(e.color);
  const mode = brushFor('color-replacement').mode;
  const blend = (COLOR_REPLACE_MODES.includes(mode) ? mode : 'color') as BlendMode;
  const bc = [0, 0, 0],
    sc = [fg[0] / 255, fg[1] / 255, fg[2] / 255],
    o = [0, 0, 0];
  return {
    kind: 'process',
    preserveAlpha: true,
    process: (_x, _y, base, out) => {
      out.set(base);
      const d = colorDistance(base, current());
      // Anti-alias: a soft edge just past the tolerance limit.
      const k = d <= tol ? 1 : antiAlias && d <= tol + 20 ? 1 - (d - tol) / 20 : 0;
      if (!k) return;
      for (let c = 0; c < 3; c++) bc[c] = base[c] / 255;
      // Hue, Saturation, Color or Luminosity of the foreground replaces the pixel's own.
      blendColor(blend, bc, sc, o);
      for (let c = 0; c < 3; c++) out[c] = base[c] + (o[c] * 255 - base[c]) * k;
    },
  };
}
const samplingSelect = (id: string, value: string) =>
  `<label>Sampling <select id="${id}">${[['continuous', 'Continuous'], ['once', 'Once'], ['swatch', 'Background Swatch']].map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;

export function installRetouchTools(_e: Editor) {
  registerTool(
    cloneTool(),
    withOptions(strokeTool('blur-tool', 'Blur Tool', 'blur-tool', 'focus', '', 'Blur Tool', {}, focusTarget('blur')), strengthField('blurStrength'), bindStrength('blurStrength')),
    withOptions(strokeTool('sharpen-tool', 'Sharpen Tool', 'sharpen-tool', 'focus', '', 'Sharpen Tool', {}, focusTarget('sharpen')), strengthField('sharpenStrength'), bindStrength('sharpenStrength')),
    withOptions(
      strokeTool('smudge-tool', 'Smudge Tool', 'smudge', 'focus', '', 'Smudge Tool', {}, focusTarget('smudge')),
      (e) => `${strengthField('smudgeStrength')(e)}<label class="transform-setting" title="Start each stroke with the foreground color on the tip"><input type="checkbox" id="finger-painting" ${e.settings.fingerPainting ? 'checked' : ''}>Finger Painting</label>`,
      (e, el) => {
        bindStrength('smudgeStrength')(e, el);
        el.querySelector<HTMLInputElement>('#finger-painting')?.addEventListener('change', (ev) => (e.settings.fingerPainting = (ev.target as HTMLInputElement).checked));
      },
    ),
    withOptions(strokeTool('dodge', 'Dodge Tool', 'dodge', 'tone', 'O', 'Dodge Tool', {}, toneTarget('dodge')), toneFields(false), bindTone),
    withOptions(strokeTool('burn', 'Burn Tool', 'burn', 'tone', 'O', 'Burn Tool', {}, toneTarget('burn')), toneFields(false), bindTone),
    withOptions(strokeTool('sponge', 'Sponge Tool', 'sponge', 'tone', 'O', 'Sponge Tool', {}, toneTarget('sponge')), toneFields(true), bindTone),
    withOptions(
      strokeTool('background-eraser', 'Background Eraser Tool', 'eraser-background', 'eraser', 'E', 'Background Eraser', {}, backgroundEraserTarget),
      (e) => `${samplingSelect('bg-sampling', (e.settings.bgSampling as string) ?? 'once')}<label>Tolerance <input id="bg-tolerance" type="number" min="0" max="100" value="${Number(e.settings.bgTolerance ?? 50)}">%</label><label class="transform-setting" title="Never erase pixels close to the foreground color"><input type="checkbox" id="bg-protect-fg" ${e.settings.bgProtectForeground ? 'checked' : ''}>Protect Foreground Color</label>`,
      (e, el) => {
        el.querySelector<HTMLSelectElement>('#bg-sampling')?.addEventListener('change', (ev) => (e.settings.bgSampling = (ev.target as HTMLSelectElement).value));
        el.querySelector<HTMLInputElement>('#bg-protect-fg')?.addEventListener('change', (ev) => (e.settings.bgProtectForeground = (ev.target as HTMLInputElement).checked));
        bindNumberField(el, '#bg-tolerance', () => Number(e.settings.bgTolerance ?? 50), (v) => (e.settings.bgTolerance = Math.max(0, Math.min(100, v))));
      },
    ),
    withOptions(
      strokeTool('color-replacement', 'Color Replacement Tool', 'color-replace', 'brush', 'B', 'Color Replacement', {}, colorReplaceTarget),
      (e) => `${samplingSelect('replace-sampling', (e.settings.replaceSampling as string) ?? 'continuous')}<label>Tolerance <input id="replace-tolerance" type="number" min="0" max="100" value="${Number(e.settings.replaceTolerance ?? 30)}">%</label><label class="transform-setting"><input type="checkbox" id="replace-anti-alias" ${e.settings.replaceAntiAlias !== false ? 'checked' : ''}>Anti-alias</label>`,
      (e, el) => {
        bindNumberField(el, '#replace-tolerance', () => Number(e.settings.replaceTolerance ?? 30), (v) => (e.settings.replaceTolerance = Math.max(0, Math.min(100, v))));
        el.querySelector<HTMLSelectElement>('#replace-sampling')?.addEventListener('change', (ev) => (e.settings.replaceSampling = (ev.target as HTMLSelectElement).value));
        el.querySelector<HTMLInputElement>('#replace-anti-alias')?.addEventListener('change', (ev) => (e.settings.replaceAntiAlias = (ev.target as HTMLInputElement).checked));
      },
    ),
    {
      id: 'magic-eraser',
      label: 'Magic Eraser Tool',
      key: 'E',
      icon: 'eraser-magic',
      group: 'eraser',
      cursor: () => 'crosshair',
      options: (e) =>
        `<label>Tolerance <input id="tolerance" type="number" value="${e.tolerance}" min="0" max="255"></label><label class="transform-setting"><input id="wand-contiguous" type="checkbox" ${e.settings.contiguous !== false ? 'checked' : ''}>Contiguous</label><label class="transform-setting"><input id="wand-all" type="checkbox" ${e.settings.sampleAllLayers ? 'checked' : ''}>Sample All Layers</label>`,
      bindOptions: ({ e, el }) => {
        bindTolerance(e, el);
        el.querySelector<HTMLInputElement>('#wand-contiguous')?.addEventListener('change', (ev) => (e.settings.contiguous = (ev.target as HTMLInputElement).checked));
        el.querySelector<HTMLInputElement>('#wand-all')?.addEventListener('change', (ev) => (e.settings.sampleAllLayers = (ev.target as HTMLInputElement).checked));
      },
      pointerDown: async (e, p) => {
        const x = Math.floor(p.x),
          y = Math.floor(p.y);
        if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;
        const session = e.session;
        const target = await pixelTarget(e, { allowMask: false, create: false });
        if (!target || target.kind !== 'pixels') return;
        const region = await wandMask(e, x, y);
        // Another document was shown meanwhile: do not erase in it.
        if (e.session !== session) return;
        const area = canvasRect(e.doc);
        const sel = selectionGrid(e.doc, e.assets.tiles);
        const cover = sel ? readMask(e.assets.tiles, sel, area).data : undefined;
        const img = readRGBA(e.assets.tiles, target.grid, area);
        // With transparency locked the region takes the background color instead.
        const fill = layerLock(e.doc.layers, target.layer.id, 'transparency') ? hexRgb(e.background) : undefined;
        for (let i = 0; i < region.data.length; i++) {
          const k = (region.data[i] / 255) * (cover ? cover[i] / 255 : 1);
          if (!fill) img.data[i * 4 + 3] *= 1 - k;
          else if (k) for (let c = 0; c < 3; c++) img.data[i * 4 + c] += (fill[c] - img.data[i * 4 + c]) * k;
        }
        commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, img), 'Magic Eraser');
      },
    },
  );
}
