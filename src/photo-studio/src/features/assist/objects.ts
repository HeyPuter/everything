// Layer → Mask All Objects…: detect every distinct object (see
// imaging/segment/objects) and turn each into a mask: masked copies of the
// selected layer in a group, empty masked groups for adjustments, or saved
// selections (alpha channels). Detection runs once in a worker; the minimum
// size filters the found objects instantly.
import type { Editor } from '../../editor';
import { findLayer, insertLayerAt, layer as newLayer, type Layer, type PhotoDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { emptyGrid, gridFromImage, readMask, writeRect, type TileGrid } from '../../model/tiles';
import type { DetectedObject } from '../../imaging/segment/objects';
import type { RGBA8 } from '../../imaging/types';
import { openShell } from '../adjust/dialog';
import { h, select, slider } from '../adjust/ui';
import { layerRGBA } from '../pixels';
import { mergedImage } from '../retouch/source';
import { cancelPreviews, givenParams, previewJob, runJob, withTask } from './client';
import { recordStep } from '../filters/record';
import './assist.css';

type Output = 'copies' | 'groups' | 'channels';
const remembered = { minSize: 0.5, output: 'copies' as Output, source: 'layer' as 'layer' | 'merged' };
// Layers whose pixels can be copied per object.
const copyable = (l: Layer | undefined): l is Layer => !!l && l.kind !== 'group' && l.kind !== 'adjustment';

/** Objects at least `minPercent` % of the image, largest first. */
export function filterObjects(all: DetectedObject[], minPercent: number) {
  return all.filter((o) => o.area * 100 >= minPercent);
}

/** Distinct, evenly spaced overlay colors. */
const hue = (k: number) => (k * 137.508) % 360;
function drawOverlay(c: HTMLCanvasElement, img: RGBA8, objects: DetectedObject[]) {
  const s = Math.min(1, 320 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), hh = Math.max(1, Math.round(img.height * s));
  c.width = w;
  c.height = hh;
  const g = c.getContext('2d')!;
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  g.drawImage(src, 0, 0, w, hh);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, 0, w, hh);
  objects.forEach((o, k) => {
    // Tint each object's mask in its color.
    const m = new OffscreenCanvas(o.rect.width, o.rect.height), mg = m.getContext('2d')!;
    const id = mg.createImageData(o.rect.width, o.rect.height);
    const [r, gg, b] = hslRgb(hue(k), 0.85, 0.55);
    for (let i = 0; i < o.mask.data.length; i++) id.data.set([r, gg, b, Math.round(o.mask.data[i] * 0.75)], i * 4);
    mg.putImageData(id, 0, 0);
    g.drawImage(m, o.rect.x * s, o.rect.y * s, o.rect.width * s, o.rect.height * s);
    g.strokeStyle = `hsl(${hue(k)} 85% 65%)`;
    g.lineWidth = 1;
    g.strokeRect(o.rect.x * s + 0.5, o.rect.y * s + 0.5, o.rect.width * s - 1, o.rect.height * s - 1);
    g.fillStyle = '#fff';
    g.font = '600 11px system-ui, sans-serif';
    g.fillText(String(k + 1), o.rect.x * s + 4, o.rect.y * s + 13);
  });
}
function hslRgb(hh: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + hh / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Document-space mask grid of one object, intersected with `base` if given. */
function objectGrid(e: Editor, o: DetectedObject, base?: TileGrid): TileGrid {
  let m = o.mask;
  if (base) {
    const b = readMask(e.assets.tiles, base, o.rect);
    m = { width: m.width, height: m.height, data: m.data.map((v, i) => Math.min(v, b.data[i])) };
  }
  return writeRect(e.assets.tiles, emptyGrid(1), o.rect.x, o.rect.y, m);
}

/** Build the output as one history step. */
export function applyObjects(e: Editor, objects: DetectedObject[], output: Output, source: Layer | undefined, merged?: RGBA8) {
  const doc = e.doc;
  if (output === 'channels') {
    const base = doc.channels?.length ?? 0;
    e.command('Mask All Objects', (d) => {
      d.channels = [...(d.channels ?? []), ...objects.map((o, k) => ({ id: crypto.randomUUID(), name: `Object ${k + 1}`, grid: objectGrid(e, o) }))];
    });
    e.update();
    return e.message(`Saved ${objects.length} object ${objects.length === 1 ? 'selection' : 'selections'} as channels ${base + 1}–${base + objects.length} (Select → Load Selection).`);
  }
  const mergedGrid = merged && gridFromImage(e.assets.tiles, merged);
  const children: Layer[] = objects.map((o, k) => {
    let l: Layer;
    if (output === 'groups') {
      l = newLayer('group', `Object ${k + 1}`, doc.width, doc.height);
      l.blend = 'pass through';
      l.maskGrid = objectGrid(e, o);
    } else if (source) {
      l = { ...structuredClone(source), id: crypto.randomUUID(), name: `${source.name} – Object ${k + 1}`, background: undefined, linkGroup: undefined, clipped: undefined };
      l.maskGrid = objectGrid(e, o, source.maskGrid);
      l.maskDisabled = undefined;
    } else {
      l = newPixelLayer(`Object ${k + 1}`, doc, mergedGrid!);
      l.maskGrid = objectGrid(e, o);
    }
    return l;
  });
  // Object 1 (the largest) ends up at the top of the group in the Layers panel.
  const group = newLayer('group', 'Objects', doc.width, doc.height);
  group.blend = 'pass through';
  group.children = children.reverse();
  const anchor = source?.id;
  e.command('Mask All Objects', (d: PhotoDocument) => {
    const insert = (layers: Layer[]): boolean => {
      const i = layers.findIndex((x) => x.id === anchor);
      if (i >= 0) {
        insertLayerAt(layers, i + 1, group);
        return true;
      }
      return layers.some((x) => insert(x.children));
    };
    if (!anchor || !insert(d.layers)) d.layers.push(group);
  });
  e.selectLayers([group.id]);
  e.update();
  e.message(`Added ${objects.length} masked ${output === 'groups' ? 'groups' : 'layers'} in the group “Objects”.`);
}

export async function maskAllObjectsDialog(e: Editor, arg?: unknown) {
  e.transform.apply();
  const selected = e.layer;
  const canCopy = copyable(selected);
  const given = givenParams(arg);
  if (given) {
    const output: Output = given.output === 'groups' || given.output === 'channels' ? given.output : 'copies';
    const useLayer = given.source !== 'merged' && canCopy;
    const minSize = typeof given.minSize === 'number' && Number.isFinite(given.minSize) ? Math.min(20, Math.max(0.05, given.minSize)) : 0.5;
    const found = await withTask(e, 'Finding objects', async (job) => {
      const img = useLayer ? await layerRGBA(e, { ...selected!, opacity: 1, maskGrid: undefined, mask: null, style: undefined }) : await mergedImage(e);
      return runJob<DetectedObject[]>(job, 'objects', { img: { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }, opts: { minSize: minSize / 100, maxObjects: 32 } });
    });
    if (!found) return;
    if (!found.length) return e.message('No distinct objects were found.');
    const merged = output === 'copies' && !useLayer ? await mergedImage(e) : undefined;
    return applyObjects(e, found, output, useLayer || (output === 'groups' && canCopy) ? selected : undefined, merged);
  }
  let source: 'layer' | 'merged' = canCopy ? remembered.source : 'merged';
  const shell = openShell(e, 'Mask All Objects');
  shell.dialog.classList.add('assist-wide');
  shell.preview.closest('label')!.hidden = true;
  shell.body.classList.add('assist-form');
  const ok = shell.dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
  ok.disabled = true;
  const view = h('div', { class: 'assist-objects' });
  const canvas = h('canvas', { width: '320', height: '200', role: 'img', 'aria-label': 'Detected objects' }) as HTMLCanvasElement;
  view.append(canvas);
  const readout = h('p', { class: 'assist-readout', 'aria-live': 'polite' });
  const s = { ...remembered };
  let all: DetectedObject[] = [];
  let image: RGBA8 | undefined;
  const shown = () => filterObjects(all, s.minSize);
  const refresh = () => {
    if (!image) return;
    const list = shown();
    drawOverlay(canvas, image, list);
    readout.innerHTML = all.length ? `<strong>${list.length}</strong> ${list.length === 1 ? 'object' : 'objects'} (${all.length - list.length} below the minimum size)` : 'No distinct objects were found.';
    ok.disabled = !list.length;
  };
  const detect = async () => {
    ok.disabled = true;
    readout.textContent = 'Finding objects…';
    cancelPreviews();
    try {
      const img = source === 'layer' && canCopy ? await layerRGBA(e, { ...selected!, opacity: 1, maskGrid: undefined, mask: null, style: undefined }) : await mergedImage(e);
      image = img;
      all = await previewJob<DetectedObject[]>('objects', { img: { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }, opts: { minSize: 0.0005, maxObjects: 32 } });
      if (!shell.dialog.isConnected) return;
      refresh();
    } catch (error) {
      if (shell.dialog.isConnected && !(error instanceof Error && error.name === 'CancelledError')) readout.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  const sourceSelect = select(
    'Analyze',
    canCopy ? [['layer', `Layer “${selected!.name}”`], ['merged', 'All visible layers']] : [['merged', 'All visible layers']],
    source,
    (v) => {
      source = v as typeof source;
      s.source = source;
      void detect();
    },
  );
  const outputs: [string, string][] = [
    ['copies', canCopy ? 'Masked copies of the layer' : 'Masked copies of the visible image'],
    ['groups', 'Empty masked groups (for adjustments)'],
    ['channels', 'Saved selections (channels)'],
  ];
  shell.body.append(
    sourceSelect.el,
    view,
    readout,
    slider({ label: 'Minimum Size', min: 0.05, max: 20, step: 0.05, log: true, unit: '% of image', value: s.minSize, onInput: (v) => ((s.minSize = v), refresh()) }).el,
    select('Create', outputs, s.output, (v) => (s.output = v as Output)).el,
    h('p', { class: 'assist-note' }, 'Objects are found by how they stand out from a background that reaches the image edges. Touching objects of similar color stay together.'),
  );
  void detect();
  const confirmed = await shell.result;
  cancelPreviews();
  if (!confirmed) return;
  Object.assign(remembered, s);
  recordStep(e, 'layer.mask-all-objects', { params: { minSize: s.minSize, output: s.output, source } });
  const list = shown();
  if (!list.length) return;
  const src = s.output === 'copies' && source === 'layer' && canCopy ? findLayer(e.doc.layers, selected!.id) : undefined;
  const merged = s.output === 'copies' && !src ? await mergedImage(e) : undefined;
  applyObjects(e, list, s.output, src ?? (s.output === 'groups' && canCopy ? selected : undefined), merged);
}
