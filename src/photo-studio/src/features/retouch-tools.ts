import type { Editor } from '../editor';
import { registerTool, type Tool } from '../app/registry';
import { strokeTool, brushOptions, bindBrushOptions, brushFor } from './paint';
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
import type { PaintTarget } from '../engine/paint';
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
    const sample = gridSampler(e, target.grid);
    const t = new Uint8ClampedArray(4);
    if (kind === 'smudge') {
      // The tip carries the colors it passes over along the stroke.
      const finger = new SmudgeFinger(brushFor('smudge-tool').size, strength);
      return {
        kind: 'custom',
        dab: (cx, cy, size) => finger.dab(cx, cy, size),
        pixel: (x, y, alpha, cur, out) => finger.pixel(x, y, alpha, cur, out),
      };
    }
    return {
      kind: 'process',
      preserveAlpha: true,
      process: (x, y, base, out) => {
        // 3x3 alpha-weighted average from the pre-stroke layer.
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            sample(x + i, y + j, t);
            const w = t[3];
            r += t[0] * w;
            g += t[1] * w;
            b += t[2] * w;
            a += w;
          }
        if (!a) {
          out.set(base);
          return;
        }
        r /= a;
        g /= a;
        b /= a;
        if (kind === 'blur') {
          out[0] = base[0] + (r - base[0]) * strength;
          out[1] = base[1] + (g - base[1]) * strength;
          out[2] = base[2] + (b - base[2]) * strength;
        } else {
          out[0] = base[0] + (base[0] - r) * strength * 2;
          out[1] = base[1] + (base[1] - g) * strength * 2;
          out[2] = base[2] + (base[2] - b) * strength * 2;
        }
        out[3] = base[3];
      },
    };
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
    const protect = e.settings.protectTones !== false;
    return {
      kind: 'process',
      preserveAlpha: true,
      process: (_x, _y, base, out) => {
        const r = base[0], g = base[1], b = base[2];
        if (kind === 'sponge') {
          const l = lum(r, g, b);
          const k = saturate ? 1 + exposure : 1 - exposure;
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
        for (let c = 0; c < 3; c++) {
          const v = base[c] / 255;
          let n = kind === 'dodge' ? v + (1 - v) * amount : v * (1 - amount);
          // Protecting tones keeps hues from shifting by scaling channels together.
          if (protect && kind === 'dodge') n = Math.min(1, v * (1 + amount * 1.2) + amount * 0.05);
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
    ? `<label>Mode <select id="sponge-mode"><option value="desaturate">Desaturate</option><option value="saturate" ${e.settings.spongeMode === 'saturate' ? 'selected' : ''}>Saturate</option></select></label><label>Flow <input id="tone-exposure" type="number" min="1" max="100" value="${Number(e.settings.toneExposure ?? 50)}">%</label>`
    : `<label>Range <select id="tone-range">${['shadows', 'midtones', 'highlights'].map((r) => `<option value="${r}" ${(e.settings.toneRange ?? 'midtones') === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></label><label>Exposure <input id="tone-exposure" type="number" min="1" max="100" value="${Number(e.settings.toneExposure ?? 50)}">%</label><label class="transform-setting"><input type="checkbox" id="protect-tones" ${e.settings.protectTones !== false ? 'checked' : ''}>Protect Tones</label>`;
const bindTone = (e: Editor, el: HTMLElement) => {
  el.querySelector<HTMLSelectElement>('#tone-range')?.addEventListener('change', (ev) => (e.settings.toneRange = (ev.target as HTMLSelectElement).value));
  el.querySelector<HTMLSelectElement>('#sponge-mode')?.addEventListener('change', (ev) => (e.settings.spongeMode = (ev.target as HTMLSelectElement).value));
  bindNumberField(el, '#tone-exposure', () => Number(e.settings.toneExposure ?? 50), (v) => (e.settings.toneExposure = Math.max(1, Math.min(100, v))));
  el.querySelector<HTMLInputElement>('#protect-tones')?.addEventListener('change', (ev) => (e.settings.protectTones = (ev.target as HTMLInputElement).checked));
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
  const sample = gridSampler(e, target.grid);
  const t = new Uint8ClampedArray(4);
  let current = ref;
  let lastPointer: unknown;
  return {
    kind: 'process',
    process: (_x, _y, base, out) => {
      if (mode === 'continuous' && e.pointerInfo !== lastPointer) {
        lastPointer = e.pointerInfo;
        if (e.pointerInfo && sample(e.pointerInfo.x, e.pointerInfo.y, t)) current = [t[0], t[1], t[2]];
      }
      out.set(base);
      const d = colorDistance(base, current);
      // Soft edge around the tolerance limit.
      const k = d <= tol ? 1 : d <= tol + 20 ? 1 - (d - tol) / 20 : 0;
      out[3] = base[3] * (1 - k);
    },
  };
}
function colorReplaceTarget(e: Editor, target: PixelTarget, p: CanvasPointer): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The Color Replacement Tool works on pixel layers.');
    return;
  }
  const tol = Number(e.settings.replaceTolerance ?? 30) * 2.55;
  const { ref } = sampledColor(e, target, p);
  const fg = hexRgb(e.color);
  return {
    kind: 'process',
    preserveAlpha: true,
    process: (_x, _y, base, out) => {
      out.set(base);
      if (colorDistance(base, ref) > tol) return;
      // Color blend: keep the pixel's luminance, take the foreground's hue/saturation.
      const l = lum(base[0], base[1], base[2]),
        fl = lum(fg[0], fg[1], fg[2]);
      for (let c = 0; c < 3; c++) out[c] = fg[c] + (l - fl);
    },
  };
}

export function installRetouchTools(_e: Editor) {
  registerTool(
    cloneTool(),
    withOptions(strokeTool('blur-tool', 'Blur Tool', 'blur-tool', 'focus', '', 'Blur Tool', {}, focusTarget('blur')), strengthField('blurStrength'), bindStrength('blurStrength')),
    withOptions(strokeTool('sharpen-tool', 'Sharpen Tool', 'sharpen-tool', 'focus', '', 'Sharpen Tool', {}, focusTarget('sharpen')), strengthField('sharpenStrength'), bindStrength('sharpenStrength')),
    withOptions(strokeTool('smudge-tool', 'Smudge Tool', 'smudge', 'focus', '', 'Smudge Tool', {}, focusTarget('smudge')), strengthField('smudgeStrength'), bindStrength('smudgeStrength')),
    withOptions(strokeTool('dodge', 'Dodge Tool', 'dodge', 'tone', 'O', 'Dodge Tool', {}, toneTarget('dodge')), toneFields(false), bindTone),
    withOptions(strokeTool('burn', 'Burn Tool', 'burn', 'tone', 'O', 'Burn Tool', {}, toneTarget('burn')), toneFields(false), bindTone),
    withOptions(strokeTool('sponge', 'Sponge Tool', 'sponge', 'tone', 'O', 'Sponge Tool', {}, toneTarget('sponge')), toneFields(true), bindTone),
    withOptions(
      strokeTool('background-eraser', 'Background Eraser Tool', 'eraser-background', 'eraser', 'E', 'Background Eraser', {}, backgroundEraserTarget),
      (e) => `<label>Sampling <select id="bg-sampling"><option value="continuous" ${e.settings.bgSampling === 'continuous' ? 'selected' : ''}>Continuous</option><option value="once" ${(e.settings.bgSampling ?? 'once') === 'once' ? 'selected' : ''}>Once</option><option value="swatch" ${e.settings.bgSampling === 'swatch' ? 'selected' : ''}>Background Swatch</option></select></label><label>Tolerance <input id="bg-tolerance" type="number" min="0" max="100" value="${Number(e.settings.bgTolerance ?? 50)}">%</label>`,
      (e, el) => {
        el.querySelector<HTMLSelectElement>('#bg-sampling')?.addEventListener('change', (ev) => (e.settings.bgSampling = (ev.target as HTMLSelectElement).value));
        bindNumberField(el, '#bg-tolerance', () => Number(e.settings.bgTolerance ?? 50), (v) => (e.settings.bgTolerance = Math.max(0, Math.min(100, v))));
      },
    ),
    withOptions(
      strokeTool('color-replacement', 'Color Replacement Tool', 'color-replace', 'brush', 'B', 'Color Replacement', {}, colorReplaceTarget),
      (e) => `<label>Tolerance <input id="replace-tolerance" type="number" min="0" max="100" value="${Number(e.settings.replaceTolerance ?? 30)}">%</label>`,
      (e, el) => bindNumberField(el, '#replace-tolerance', () => Number(e.settings.replaceTolerance ?? 30), (v) => (e.settings.replaceTolerance = Math.max(0, Math.min(100, v)))),
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
        const target = await pixelTarget(e, { allowMask: false, create: false });
        if (!target || target.kind !== 'pixels') return;
        const region = await wandMask(e, x, y);
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
