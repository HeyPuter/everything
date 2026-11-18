// Edit → Sky Replacement…: swap the sky for a generated sky or an image.
// The sky region is the active selection, or is found with the same
// detection as Select → Sky. The result is a group of editable layers: the
// new sky (masked), plus foreground lighting and color layers that tint the
// landscape toward the new sky.
import type { Editor } from '../../editor';
import { layer, type Layer, type PhotoDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { emptyGrid, gridFromImage, writeRect } from '../../model/tiles';
import { selectionCoverage, selectionGrid } from '../../model/selection';
import { escapeXML } from '../../model/assets';
import { SKY_PRESETS, foregroundLightMask, renderSky, skyHorizon, skyLight, type SkyPlacement } from '../../imaging/sky/sky';
import type { Mask8, RGBA8 } from '../../imaging/types';
import { latest, openShell } from '../adjust/dialog';
import { checkbox, h, select, slider } from '../adjust/ui';
import { compositeRGBA, previewTiles, rgbHex } from '../pixels';
import { heavy } from '../retouch/client';
import { decodeFile } from '../files/open';
import { previewJob } from './client';
import { copyImage } from './sources';

type SkySettings = {
  source: string; // preset id or 'custom'
  shift: number;
  fade: number;
  brightness: number;
  temperature: number;
  scale: number;
  flip: boolean;
  offsetX: number;
  offsetY: number;
  lightingMode: 'multiply' | 'screen';
  lighting: number;
  color: number;
  output: 'layers' | 'merged';
};
const DEFAULTS: SkySettings = { source: 'fair', shift: 0, fade: 6, brightness: 0, temperature: 0, scale: 100, flip: false, offsetX: 0, offsetY: 0, lightingMode: 'multiply', lighting: 40, color: 50, output: 'layers' };
let remembered: SkySettings = { ...DEFAULTS };

const thumbs = new Map<string, string>();
function presetThumb(id: string) {
  let url = thumbs.get(id);
  if (!url) {
    const p = SKY_PRESETS.find((s) => s.id === id)!;
    const img = renderSky(p, 96, 54, 7);
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 54;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), 96, 54), 0, 0);
    url = c.toDataURL();
    thumbs.set(id, url);
  }
  return url;
}

type Parts = { sky: RGBA8; skyMask: Mask8; light: [number, number, number]; fgMask: Mask8 };

/** The replacement as layers (bottom to top inside the group). */
function buildLayers(e: Editor, s: SkySettings, parts: Parts): Layer[] {
  const doc = e.doc,
    tiles = e.assets.tiles;
  const hex = rgbHex(...parts.light);
  const fg = writeRect(tiles, emptyGrid(1), 0, 0, parts.fgMask);
  const lighting = layer('solid', 'Foreground Lighting', doc.width, doc.height);
  lighting.color = hex;
  lighting.blend = s.lightingMode;
  lighting.opacity = (s.lighting / 100) * 0.6;
  lighting.maskGrid = fg;
  const color = layer('solid', 'Foreground Color', doc.width, doc.height);
  color.color = hex;
  color.blend = 'color';
  color.opacity = (s.color / 100) * 0.4;
  color.maskGrid = fg;
  const sky = newPixelLayer('Sky', doc, gridFromImage(tiles, parts.sky));
  sky.maskGrid = writeRect(tiles, emptyGrid(1), 0, 0, parts.skyMask);
  return [lighting, color, sky];
}
function group(doc: PhotoDocument, children: Layer[]): Layer {
  const g = layer('group', 'Sky Replacement', doc.width, doc.height);
  g.blend = 'pass through';
  g.children = children;
  return g;
}

export async function skyReplacementDialog(e: Editor) {
  const doc0 = e.doc;
  let skyMask: Mask8 | undefined;
  const selected = selectionGrid(doc0, e.assets.tiles);
  if (selected) skyMask = selectionCoverage(doc0, e.assets.tiles);
  else {
    const found = await heavy<Mask8>(e, 'Finding the sky', 'sky', async () => ({ img: copyImage(await compositeRGBA(e)) }));
    if (!found) return;
    if (!found.data.some((v) => v > 127)) return e.message('No sky was found along the top of the image. Select the sky first, then try again.');
    skyMask = found;
  }
  const W = doc0.width,
    H = doc0.height;
  const horizon = skyHorizon(skyMask);
  const s: SkySettings = { ...remembered };
  let custom: RGBA8 | null = null;
  const bases = new Map<string, Promise<RGBA8>>();
  // Generated skies are rendered once per preset at a size that covers the sky.
  const base = (id: string) => {
    if (id === 'custom' && custom) return Promise.resolve(custom);
    let p = bases.get(id);
    if (!p) {
      const w = Math.min(2400, W),
        hh = Math.max(16, Math.round((w * Math.max(horizon, H * 0.3)) / W));
      p = previewJob<RGBA8>('sky-render', { preset: id, width: w, height: hh, seed: 7 });
      bases.set(id, p);
    }
    return p;
  };
  const shell = openShell(e, 'Sky Replacement', { wide: true });
  const tiles = previewTiles(e);
  shell.body.classList.add('comp-form');
  const schedule = latest();
  let parts: Parts | null = null;
  const compute = async (): Promise<Parts> => {
    const sky0 = await base(s.source === 'custom' && !custom ? 'fair' : s.source);
    const placement: SkyPlacement = { scale: s.scale / 100, flip: s.flip, offsetX: s.offsetX / 100, offsetY: s.offsetY / 100 };
    const [sky, mask] = await Promise.all([
      previewJob<RGBA8>('sky-layer', { sky: copyImage(sky0), width: W, height: H, placement, horizon, brightness: s.brightness, temperature: s.temperature }),
      previewJob<Mask8>('sky-mask', { mask: { width: W, height: H, data: new Uint8Array(skyMask!.data) }, shift: s.shift, fade: s.fade }),
    ]);
    return { sky, skyMask: mask, light: skyLightColor(sky, mask, horizon), fgMask: foregroundLightMask(mask, horizon) };
  };
  const refresh = () => {
    parts = null;
    if (!shell.preview.checked) return;
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      try {
        const p = await compute();
        parts = p;
        if (!shell.dialog.isConnected) return;
        shell.status.textContent = '';
        if (shell.preview.checked) {
          const layers = buildLayers(e, s, p);
          tiles.show(...layers.flatMap((l) => [l.pixels, l.maskGrid]).filter((g) => !!g));
          e.preview({ ...e.doc, selection: null, selectionMask: null, layers: [...e.doc.layers, group(e.doc, layers)] });
        }
      } catch (error) {
        shell.status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  };
  const changed = (commit: boolean) => commit && refresh();
  // Sky choice: thumbnails of the generated skies plus a custom image.
  const grid = h('div', { class: 'comp-sky-grid', role: 'radiogroup', 'aria-label': 'Sky' });
  const renderGrid = () => {
    grid.innerHTML =
      SKY_PRESETS.map((p) => `<button type="button" role="radio" aria-checked="${s.source === p.id}" data-sky="${p.id}" title="${escapeXML(p.label)}"><img alt="" src="${presetThumb(p.id)}"><span>${escapeXML(p.label)}</span></button>`).join('') +
      `<button type="button" role="radio" aria-checked="${s.source === 'custom'}" data-sky="custom" title="Use an image of a sky"><span class="comp-sky-add">${custom ? 'Your image' : 'Choose image…'}</span></button>`;
  };
  grid.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-sky]');
    if (!b) return;
    const id = b.dataset.sky!;
    if (id === 'custom') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          custom = (await decodeFile(f, f.name)).image;
          s.source = 'custom';
          renderGrid();
          refresh();
        } catch (error) {
          shell.status.textContent = error instanceof Error ? error.message : String(error);
        }
      };
      input.click();
      return;
    }
    s.source = id;
    renderGrid();
    refresh();
  });
  if (s.source === 'custom') s.source = DEFAULTS.source;
  renderGrid();
  const section = (t: string) => h('h3', { class: 'comp-section' }, escapeXML(t));
  shell.body.append(
    grid,
    section('Sky Edge'),
    slider({ label: 'Shift Edge', min: -100, max: 100, unit: 'px', value: s.shift, onInput: (v, c) => ((s.shift = v), changed(c)) }).el,
    slider({ label: 'Fade Edge', min: 0, max: 100, unit: 'px', value: s.fade, onInput: (v, c) => ((s.fade = v), changed(c)) }).el,
    section('Sky Adjustments'),
    slider({ label: 'Brightness', min: -100, max: 100, value: s.brightness, onInput: (v, c) => ((s.brightness = v), changed(c)) }).el,
    slider({ label: 'Temperature', min: -100, max: 100, value: s.temperature, track: 'linear-gradient(90deg,#4a7bd8,#ddd,#e0a040)', onInput: (v, c) => ((s.temperature = v), changed(c)) }).el,
    slider({ label: 'Scale', min: 25, max: 300, unit: '%', value: s.scale, onInput: (v, c) => ((s.scale = v), changed(c)) }).el,
    slider({ label: 'Horizontal Position', min: -50, max: 50, unit: '%', value: s.offsetX, onInput: (v, c) => ((s.offsetX = v), changed(c)) }).el,
    slider({ label: 'Vertical Position', min: -50, max: 50, unit: '%', value: s.offsetY, onInput: (v, c) => ((s.offsetY = v), changed(c)) }).el,
    checkbox('Flip', s.flip, (v) => ((s.flip = v), refresh())).el,
    section('Foreground Adjustments'),
    select('Lighting Mode', [['multiply', 'Multiply'], ['screen', 'Screen']], s.lightingMode, (v) => ((s.lightingMode = v as SkySettings['lightingMode']), refresh())).el,
    slider({ label: 'Lighting Adjustment', min: 0, max: 100, value: s.lighting, onInput: (v, c) => ((s.lighting = v), changed(c)) }).el,
    slider({ label: 'Color Adjustment', min: 0, max: 100, value: s.color, onInput: (v, c) => ((s.color = v), changed(c)) }).el,
    section('Output'),
    select('Output To', [['layers', 'New Layers'], ['merged', 'Duplicate Layer (merged)']], s.output, (v) => (s.output = v as SkySettings['output'])).el,
  );
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : e.update()));
  refresh();
  const ok = await shell.result;
  e.update();
  // OK builds its own layers.
  tiles.release();
  if (!ok) return;
  remembered = { ...s, source: s.source === 'custom' ? DEFAULTS.source : s.source };
  const p = parts ?? (await compute());
  const children = buildLayers(e, s, p);
  if (s.output === 'merged') {
    // Flatten the replacement over the visible image into one new layer.
    const preview = { ...e.doc, selection: null, selectionMask: null, layers: [...e.doc.layers, group(e.doc, children)] };
    const merged = await compositeRGBA(e, preview);
    const l = newPixelLayer('Sky Replacement', e.doc, gridFromImage(e.assets.tiles, merged));
    e.command('Sky Replacement', (d) => {
      d.layers.push(l);
      d.selection = null;
      d.selectionMask = null;
    });
    e.selectLayers([l.id]);
  } else {
    const g = group(e.doc, children);
    e.command('Sky Replacement', (d) => {
      d.layers.push(g);
      d.selection = null;
      d.selectionMask = null;
    });
    e.selectLayers([g.id]);
  }
  e.update();
}

function skyLightColor(sky: RGBA8, mask: Mask8, horizon: number): [number, number, number] {
  return skyLight(sky, mask, horizon).map((v) => Math.round(v)) as [number, number, number];
}

