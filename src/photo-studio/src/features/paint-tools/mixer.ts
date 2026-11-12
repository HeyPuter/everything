// Mixer Brush tool: paints with a loaded reservoir and picks up canvas paint
// (engine/mixer.ts). Alt-click loads the brush from the canvas; the brush can
// reload and clean itself after every stroke.
import type { Editor } from '../../editor';
import { registerCommand, type Tool } from '../../app/registry';
import { svg } from '../../app/icons';
import { showContextMenu } from '../../app/menubar';
import { MixerBrush, mixerPresets, type MixerSettings } from '../../engine/mixer';
import type { PaintTarget } from '../../engine/paint';
import { findLayer, type PhotoDocument } from '../../model/document';
import { readRGBA } from '../../model/tiles';
import type { RGBA8 } from '../../imaging/types';
import { bindBrushOptions, brushFor, strokeTool } from '../paint';
import { compositeRGBA, hexRgb, rgbHex, type PixelTarget } from '../pixels';
import { layersBelow } from '../clone-source/state';
import { escapeXML } from '../../model/assets';
import { bindNumberField } from './fields';

const ID = 'mixer-brush';
let brush: MixerBrush | undefined;
// True after Alt-click loaded the brush by hand (kept for the next stroke).
let manualLoad = false;
const pct = (e: Editor, key: string, d: number) => Number(e.settings[key] ?? d);
export function mixerSettings(e: Editor): MixerSettings {
  return { wet: pct(e, 'mixerWet', 50) / 100, load: pct(e, 'mixerLoad', 50) / 100, mix: pct(e, 'mixerMix', 50) / 100, flow: brushFor(ID).flow };
}
function mixer(e: Editor) {
  if (!brush) {
    brush = new MixerBrush(brushFor(ID).size);
    brush.loadColor(hexRgb(e.color));
  }
  brush.resize(brushFor(ID).size);
  return brush;
}
const loadAfter = (e: Editor) => e.settings.mixerLoadAfter !== false;
const cleanAfter = (e: Editor) => e.settings.mixerCleanAfter !== false;
const sampleAll = (e: Editor) => e.settings.mixerSampleAll === true;

// "Sample All Layers" picks up the merged image of the layers below the target.
const docIds = new WeakMap<object, number>();
let nextId = 1;
let below: { key: string; img: RGBA8 } | undefined;
function belowKey(e: Editor) {
  let id = docIds.get(e.doc);
  if (!id) docIds.set(e.doc, (id = nextId++));
  return `${id}:${e.layer?.id}`;
}
async function warmBelow(e: Editor) {
  const l = e.layer;
  if (!sampleAll(e) || !l || !e.hasDocument) return;
  const key = belowKey(e);
  if (below?.key === key) return;
  const layers = layersBelow(e.doc.layers, l.id);
  if (!layers) return;
  // The target layer itself is the wet canvas; hide it from the backdrop.
  const hide = (list: PhotoDocument['layers']): PhotoDocument['layers'] => list.map((x) => (x.id === l.id ? { ...x, visible: false } : x.kind === 'group' ? { ...x, children: hide(x.children) } : x));
  const img = await compositeRGBA(e, { ...e.doc, layers: hide(layers) });
  below = { key, img };
}

function mixerTarget(e: Editor, target: PixelTarget): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The Mixer Brush paints on pixel layers.');
    return;
  }
  const b = mixer(e);
  b.lift();
  if (loadAfter(e) && !manualLoad) b.loadColor(hexRgb(e.color));
  const s = mixerSettings(e);
  const back = sampleAll(e) && below?.key === belowKey(e) ? below.img : undefined;
  const under = new Uint8ClampedArray(4);
  return {
    kind: 'custom',
    dab: (cx, cy) => b.dab(cx, cy, s),
    pixel: (x, y, alpha, cur, out) => {
      if (back && x >= 0 && y >= 0 && x < back.width && y < back.height) {
        // The wet layer over the merged image below it.
        const i = (y * back.width + x) * 4,
          a = cur[3] / 255,
          ba = (back.data[i + 3] / 255) * (1 - a),
          oa = a + ba;
        for (let c = 0; c < 3; c++) under[c] = oa > 0 ? (cur[c] * a + back.data[i + c] * ba) / oa : 0;
        under[3] = oa * 255;
      } else under.set(cur);
      b.pixel(x, y, alpha, cur, under, s, out);
    },
  };
}

/** Alt-click: load the brush with the pixels under the tip (or their average). */
async function loadFromCanvas(e: Editor, x: number, y: number) {
  const b = mixer(e);
  const size = Math.max(1, Math.round(brushFor(ID).size));
  const r = { x: Math.round(x - size / 2), y: Math.round(y - size / 2), width: size, height: size };
  let img: RGBA8;
  if (sampleAll(e)) img = cropTo(await compositeRGBA(e), r);
  else {
    const l = e.layer && findLayer(e.doc.layers, e.layer.id);
    img = l?.pixels ? readRGBA(e.assets.tiles, l.pixels, r) : cropTo(await compositeRGBA(e), r);
  }
  if (e.settings.mixerSolidOnly === true) {
    let rr = 0, g = 0, bb = 0, a = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const w = img.data[i + 3];
      rr += img.data[i] * w;
      g += img.data[i + 1] * w;
      bb += img.data[i + 2] * w;
      a += w;
    }
    if (!a) return e.message('There is no paint under the brush to load.');
    b.loadColor([rr / a, g / a, bb / a]);
  } else b.loadImage(img.data, img.width, img.height);
  manualLoad = true;
  e.options();
}
function cropTo(img: RGBA8, r: { x: number; y: number; width: number; height: number }): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const sx = x + r.x,
        sy = y + r.y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * r.width + x) * 4);
    }
  return { width: r.width, height: r.height, data: out };
}

function options(e: Editor) {
  const s = brushFor(ID);
  const loaded = brush?.loadedColor();
  const preset = String(e.settings.mixerPreset ?? 'custom');
  const field = (id: string, label: string, value: number, title: string) =>
    `<label title="${title}">${label} <input id="${id}" type="number" min="0" max="100" value="${Math.round(value)}" aria-label="${title} (%)">%</label>`;
  const toggle = (id: string, icon: string, on: boolean, title: string) => `<button class="icon-button toggle" id="${id}" aria-pressed="${on}" title="${title}" aria-label="${title}">${svg(icon, 16)}</button>`;
  return `<button class="brush-preview" data-brush-popover="${ID}" title="Brush settings" aria-label="Brush preset and size"><span class="brush-dot" style="--size:${Math.min(22, 4 + Math.sqrt(s.size) * 1.6)}px;--hard:${s.hardness}"></span><span>${Math.round(s.size)}</span></button>
<label>Size <input id="brush-size" type="number" min="1" max="5000" value="${Math.round(s.size)}" aria-label="Brush size (px)"> px</label>
<label>Hardness <input id="brush-hardness" type="number" min="0" max="100" value="${Math.round(s.hardness * 100)}" aria-label="Brush hardness (%)">%</label>
<button class="mixer-swatch" id="mixer-load-menu" title="Brush load: click for Load, Clean and options" aria-label="Brush load" aria-haspopup="menu">${loaded ? `<span style="background:${rgbHex(loaded[0], loaded[1], loaded[2])}"></span>` : '<span class="empty"></span>'}${svg('chevron-down', 12)}</button>
${toggle('mixer-load-after', 'brush-load', loadAfter(e), 'Load the brush after each stroke')}${toggle('mixer-clean-after', 'brush-clean', cleanAfter(e), 'Clean the brush after each stroke')}
<label>Mix <select id="mixer-preset" aria-label="Wet, load and mix combination">${mixerPresets.map((p) => `<option value="${p.id}" ${p.id === preset ? 'selected' : ''}>${escapeXML(p.label)}</option>`).join('')}</select></label>
${field('mixer-wet', 'Wet', pct(e, 'mixerWet', 50), 'Paint picked up from the canvas')}${field('mixer-load', 'Load', pct(e, 'mixerLoad', 50), 'Paint loaded in the reservoir')}${field('mixer-mix', 'Mix', pct(e, 'mixerMix', 50), 'Canvas paint in the mix')}
<label>Flow <input id="brush-flow" type="number" min="1" max="100" value="${Math.round(s.flow * 100)}" aria-label="Brush flow (%)">%</label><button class="icon-button toggle" id="airbrush" aria-pressed="${s.airbrush}" title="Airbrush build-up" aria-label="Airbrush">${svg('airbrush', 16)}</button>
<label>Smoothing <input id="brush-smoothing" type="number" min="0" max="100" value="${Math.round(s.smoothing * 100)}" aria-label="Smoothing (%)">%</label>
<label class="transform-setting"><input type="checkbox" id="mixer-all" ${sampleAll(e) ? 'checked' : ''}>Sample All Layers</label>
<button class="icon-button toggle" id="pressure-size" aria-pressed="${!!s.dynamics.pressureSize}" title="Pressure controls size" aria-label="Pressure controls size">${svg('pressure-size', 16)}</button>`;
}
function bind(e: Editor, el: HTMLElement) {
  bindBrushOptions(e, el, ID);
  const num = (id: string, key: string) =>
    bindNumberField(el, `#${id}`, () => pct(e, key, 50), (v) => {
      e.settings[key] = Math.max(0, Math.min(100, v));
      e.settings.mixerPreset = 'custom';
      e.options();
    });
  num('mixer-wet', 'mixerWet');
  num('mixer-load', 'mixerLoad');
  num('mixer-mix', 'mixerMix');
  el.querySelector<HTMLSelectElement>('#mixer-preset')?.addEventListener('change', (ev) => {
    const p = mixerPresets.find((x) => x.id === (ev.target as HTMLSelectElement).value);
    e.settings.mixerPreset = p?.id ?? 'custom';
    if (p?.settings) Object.assign(e.settings, { mixerWet: p.settings.wet * 100, mixerLoad: p.settings.load * 100, mixerMix: p.settings.mix * 100 });
    e.options();
  });
  const flip = (id: string, key: string, def: boolean) =>
    el.querySelector(`#${id}`)?.addEventListener('click', () => {
      e.settings[key] = !(e.settings[key] === undefined ? def : e.settings[key]);
      e.options();
    });
  flip('mixer-load-after', 'mixerLoadAfter', true);
  flip('mixer-clean-after', 'mixerCleanAfter', true);
  el.querySelector<HTMLInputElement>('#mixer-all')?.addEventListener('change', (ev) => {
    e.settings.mixerSampleAll = (ev.target as HTMLInputElement).checked;
    void warmBelow(e);
  });
  el.querySelector<HTMLElement>('#mixer-load-menu')?.addEventListener('click', (ev) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(e, r.left, r.bottom + 2, ['mixer.load', 'mixer.clean', '-', 'mixer.solid-only']);
  });
}

export function mixerBrushTool(): Tool {
  const base = strokeTool(ID, 'Mixer Brush Tool', 'mixer-brush', 'brush', 'B', 'Mixer Brush', {}, mixerTarget);
  return {
    ...base,
    options,
    bindOptions: ({ e, el }) => bind(e, el),
    activate: (e) => {
      base.activate?.(e);
      void warmBelow(e);
    },
    pointerDown: async (e, p) => {
      if (p.alt) {
        await loadFromCanvas(e, p.x, p.y);
        return;
      }
      if (sampleAll(e)) await warmBelow(e);
      return base.pointerDown!(e, p);
    },
    pointerUp: async (e, p) => {
      await base.pointerUp!(e, p);
      const b = mixer(e);
      manualLoad = false;
      if (cleanAfter(e)) b.clean(false);
      if (loadAfter(e)) b.loadColor(hexRgb(e.color));
      e.options();
      void warmBelow(e);
    },
  };
}

export function installMixerCommands() {
  registerCommand(
    {
      id: 'mixer.load',
      label: 'Load Brush',
      recordable: false,
      description: 'Fill the Mixer Brush with the foreground color.',
      run: (e) => {
        mixer(e).loadColor(hexRgb(e.color));
        manualLoad = true;
        e.options();
      },
    },
    {
      id: 'mixer.clean',
      label: 'Clean Brush',
      recordable: false,
      description: 'Empty the Mixer Brush reservoir and tip.',
      run: (e) => {
        mixer(e).clean();
        manualLoad = true;
        e.options();
      },
    },
    {
      id: 'mixer.solid-only',
      label: 'Load Solid Colors Only',
      recordable: false,
      checked: (e) => e.settings.mixerSolidOnly === true,
      run: (e) => {
        e.settings.mixerSolidOnly = e.settings.mixerSolidOnly !== true;
      },
    },
  );
}
