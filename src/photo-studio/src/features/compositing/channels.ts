// Image → Apply Image… and Image → Calculations…: blend a layer, the merged
// image or a single channel (from this or another open document of the same
// size) into the target layer, or combine two channels into a new channel,
// document or selection. Both preview live on the canvas.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { allLayers, findLayer, type Layer } from '../../model/document';
import { canvasRect, selectionCoverage, selectionGrid } from '../../model/selection';
import { emptyGrid, readMask, readRGBA, writeRect } from '../../model/tiles';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { escapeXML } from '../../model/assets';
import { channelBlends, channelPlane, type ChannelBlend, type ChannelOptions, type SourceChannel, type TargetChannel } from '../../imaging/channels/apply';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { commitTarget, pixelTarget, previewTarget, roundIRect, toRGBA8, type PixelTarget } from '../pixels';
import { latest, openShell, previewTiles, resultGrid } from '../adjust/dialog';
import { checkbox, h, select, slider } from '../adjust/ui';
import { commitSelectionMask } from '../selection';
import { previewJob } from './client';
import { openDocument } from './sources';

type Pick = { session: string; layer: string; channel: string; invert: boolean };
const MERGED = 'merged';

/** Open documents with the same pixel size as the current one. */
function sameSize(e: Editor) {
  return e.sessions.filter((s) => s.hasDocument && s.doc.width === e.doc.width && s.doc.height === e.doc.height);
}
function layerOptions(s: DocumentSession): [string, string][] {
  return [[MERGED, 'Merged'], ...allLayers(s.doc.layers).filter((l) => l.kind !== 'adjustment').reverse().map((l) => [l.id, l.name] as [string, string])];
}
function channelOptions(s: DocumentSession, layerId: string, rgb: boolean): [string, string][] {
  const out: [string, string][] = rgb ? [['rgb', 'RGB']] : [];
  out.push(['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['gray', 'Gray'], ['alpha', 'Transparency']);
  const l = layerId === MERGED ? undefined : findLayer(s.doc.layers, layerId);
  if (l?.maskGrid) out.push(['mask', 'Layer Mask']);
  if (s.doc.selection) out.push(['selection', 'Selection']);
  for (const c of s.doc.channels ?? []) out.push([`channel:${c.id}`, c.name]);
  return out;
}

/** Reads source images and planes at document size, cached per dialog. */
class Sources {
  private images = new Map<string, Promise<RGBA8>>();
  constructor(private e: Editor) {}
  session(id: string) {
    return this.e.sessions.find((s) => s.id === id) ?? this.e.session;
  }
  image(p: Pick): Promise<RGBA8> {
    const key = `${p.session}/${p.layer}`;
    let v = this.images.get(key);
    if (!v) {
      v = this.read(this.session(p.session), p.layer);
      this.images.set(key, v);
    }
    return v;
  }
  private async read(s: DocumentSession, layerId: string): Promise<RGBA8> {
    const e = this.e,
      doc = s.doc;
    if (layerId === MERGED) return toRGBA8(await e.renderer.documentPixels({ ...doc, selection: null }, s.assets), doc.width, doc.height);
    const l = findLayer(doc.layers, layerId);
    if (!l) throw new Error('The source layer no longer exists.');
    if (l.kind === 'pixel' && l.pixels) return readRGBA(s.assets.tiles, l.pixels, canvasRect(doc));
    const plain: Layer = { ...l, visible: true, opacity: 1, blend: 'normal', maskGrid: undefined, mask: null, style: undefined };
    return toRGBA8(await e.renderer.layerPixels(plain, doc, s.assets), doc.width, doc.height);
  }
  /** One channel as a plane of codes; inversion is applied by the math. */
  async plane(p: Pick): Promise<Uint8Array> {
    const s = this.session(p.session),
      doc = s.doc,
      rect = canvasRect(doc);
    if (p.channel === 'selection') return selectionCoverage(doc, s.assets.tiles).data;
    if (p.channel.startsWith('channel:')) {
      const c = doc.channels?.find((x) => `channel:${x.id}` === p.channel);
      if (!c) throw new Error('The channel no longer exists.');
      return readMask(s.assets.tiles, c.grid, rect).data;
    }
    if (p.channel === 'mask') {
      const l = findLayer(doc.layers, p.layer);
      if (!l?.maskGrid) throw new Error('The layer has no mask.');
      return readMask(s.assets.tiles, l.maskGrid, rect).data;
    }
    return channelPlane(await this.image(p), p.channel as Exclude<SourceChannel, 'rgb'>);
  }
}

/** Document / layer / channel / invert pickers; `onChange` after each edit. */
function sourcePicker(e: Editor, title: string, p: Pick, rgb: boolean, onChange: () => void) {
  const box = h('fieldset', { class: 'comp-source' });
  box.innerHTML = `<legend>${escapeXML(title)}</legend>`;
  const render = () => {
    for (const el of [...box.children]) if (el.tagName !== 'LEGEND') el.remove();
    const s = e.sessions.find((x) => x.id === p.session) ?? e.session;
    const docs = sameSize(e).map((x) => [x.id, x.doc.name] as [string, string]);
    const layers = layerOptions(s);
    if (!layers.some(([v]) => v === p.layer)) p.layer = MERGED;
    const chans = channelOptions(s, p.layer, rgb);
    if (!chans.some(([v]) => v === p.channel)) p.channel = chans[0][0];
    box.append(
      select('Document', docs, p.session, (v) => ((p.session = v), render(), onChange())).el,
      select('Layer', layers, p.layer, (v) => ((p.layer = v), render(), onChange())).el,
      select('Channel', chans, p.channel, (v) => ((p.channel = v), onChange())).el,
      checkbox('Invert', p.invert, (v) => ((p.invert = v), onChange())).el,
    );
  };
  render();
  return box;
}

function blendControls(o: ChannelOptions, onChange: (commit: boolean) => void) {
  const wrap = h('div', { class: 'comp-group' });
  const arith = h('div', { class: 'comp-group' });
  const sync = () => (arith.hidden = o.blend !== 'add' && o.blend !== 'subtract');
  wrap.append(
    select('Blending', channelBlends.map((b) => [b.id, b.label] as [string, string]), o.blend, (v) => ((o.blend = v as ChannelBlend), sync(), onChange(true))).el,
    slider({ label: 'Opacity', min: 0, max: 100, unit: '%', value: Math.round(o.opacity * 100), onInput: (v, c) => ((o.opacity = v / 100), onChange(c)) }).el,
    arith,
  );
  arith.append(
    slider({ label: 'Scale', min: 1, max: 2, step: 0.001, value: o.scale ?? 1, onInput: (v, c) => ((o.scale = v), onChange(c)) }).el,
    slider({ label: 'Offset', min: -255, max: 255, value: o.offset ?? 0, onInput: (v, c) => ((o.offset = v), onChange(c)) }).el,
  );
  sync();
  return wrap;
}

/** Optional mask picker (any channel of a same-size document). */
function maskControls(e: Editor, m: { on: boolean; pick: Pick }, onChange: () => void) {
  const wrap = h('div', { class: 'comp-group' });
  const picker = sourcePicker(e, 'Mask', m.pick, false, onChange);
  picker.hidden = !m.on;
  wrap.append(checkbox('Mask', m.on, (v) => ((m.on = v), (picker.hidden = !v), onChange())).el, picker);
  return wrap;
}

const crop = (plane: Uint8Array, docW: number, r: IRect) => {
  if (r.x === 0 && r.y === 0 && r.width === docW) return plane.slice(0, r.width * r.height);
  const out = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) out.set(plane.subarray((r.y + y) * docW + r.x, (r.y + y) * docW + r.x + r.width), y * r.width);
  return out;
};
const cropImage = (img: RGBA8, r: IRect): RGBA8 => {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
};
const invertPlane = (p: Uint8Array) => p.map((v) => 255 - v);

/** The target's pixels over the whole canvas (or the selection bounds). */
function targetPixels(e: Editor, t: PixelTarget) {
  const doc = e.doc,
    tiles = e.assets.tiles;
  const sel = selectionGrid(doc, tiles);
  if (t.kind !== 'pixels') {
    const area = canvasRect(doc);
    const m = readMask(tiles, t.grid, area);
    const data = new Uint8ClampedArray(m.data.length * 4);
    for (let i = 0; i < m.data.length; i++) (data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = m.data[i]), (data[i * 4 + 3] = 255);
    return { area, image: { width: area.width, height: area.height, data }, cover: sel ? readMask(tiles, sel, area).data : undefined };
  }
  const area = sel && doc.selection ? roundIRect(doc.selection) : canvasRect(doc);
  return { area, image: readRGBA(tiles, t.grid, area), cover: sel ? readMask(tiles, sel, area).data : undefined };
}

export const canApply = (e: Editor) => e.hasDocument && !!e.layer && e.selectedIds.size === 1 && e.layer.kind !== 'group' && (e.layer.kind !== 'adjustment' || e.editingMask);

export async function applyImageDialog(e: Editor) {
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const src = targetPixels(e, target);
  const W = e.doc.width;
  const sources = new Sources(e);
  const pick: Pick = { session: e.session.id, layer: MERGED, channel: target.kind === 'pixels' ? 'rgb' : 'gray', invert: false };
  const mask = { on: false, pick: { session: e.session.id, layer: MERGED, channel: 'gray', invert: false } as Pick };
  const o: ChannelOptions = { blend: 'multiply', opacity: 1, scale: 1, offset: 0, preserveTransparency: false };
  let channel: TargetChannel = 'rgb';
  const shell = openShell(e, 'Apply Image', { wide: true });
  const tiles = previewTiles(e, target);
  shell.body.classList.add('comp-form');
  const schedule = latest();
  let last: RGBA8 | null = null;
  const compute = async () => {
    const area = src.area;
    let source: RGBA8 | Uint8Array;
    if (pick.channel === 'rgb') source = cropImage(await sources.image(pick), area);
    else source = crop(await sources.plane(pick), W, area);
    let m: Uint8Array | undefined;
    if (mask.on) {
      m = crop(await sources.plane(mask.pick), W, area);
      if (mask.pick.invert) m = invertPlane(m);
    }
    const targetCopy = { width: src.image.width, height: src.image.height, data: new Uint8ClampedArray(src.image.data) };
    return previewJob<RGBA8>('apply-image', { target: targetCopy, source, channel: target.kind === 'pixels' ? channel : 'rgb', opts: { ...o, invert: pick.invert, mask: m } });
  };
  const refresh = () => {
    if (!shell.preview.checked) return;
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      try {
        const out = await compute();
        last = out;
        if (!shell.dialog.isConnected) return;
        shell.status.textContent = '';
        if (shell.preview.checked) {
          const copy = { ...out, data: new Uint8ClampedArray(out.data) };
          e.preview(previewTarget(e, target, tiles.show(resultGrid(e, target, src, copy))));
        }
      } catch (error) {
        shell.status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  };
  const changed = () => {
    last = null;
    refresh();
  };
  const name = target.kind === 'quick-mask' ? 'Quick Mask' : target.kind === 'mask' ? `${target.layer.name} (Mask)` : target.layer.name;
  shell.body.append(sourcePicker(e, 'Source', pick, target.kind === 'pixels', changed));
  const targetRow = h('div', { class: 'comp-target' }, `<span>Target</span><strong>${escapeXML(name)}</strong>`);
  shell.body.append(targetRow);
  if (target.kind === 'pixels') shell.body.append(select('Target channel', [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], channel, (v) => ((channel = v as TargetChannel), changed())).el);
  shell.body.append(blendControls(o, (commit) => commit && changed()));
  if (target.kind === 'pixels') shell.body.append(checkbox('Preserve transparency', !!o.preserveTransparency, (v) => ((o.preserveTransparency = v), changed())).el);
  shell.body.append(maskControls(e, mask, changed));
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : e.update()));
  refresh();
  const ok = await shell.result;
  delete e.settings.quickMaskPreview;
  e.update();
  tiles.release();
  if (!ok) return;
  const out = last ?? (await compute());
  commitTarget(e, target, resultGrid(e, target, src, out), 'Apply Image');
}

type CalcResult = 'channel' | 'document' | 'selection';

export async function calculationsDialog(e: Editor) {
  const W = e.doc.width,
    H = e.doc.height;
  const sources = new Sources(e);
  const a: Pick = { session: e.session.id, layer: MERGED, channel: 'gray', invert: false };
  const b: Pick = { session: e.session.id, layer: MERGED, channel: 'gray', invert: false };
  const mask = { on: false, pick: { session: e.session.id, layer: MERGED, channel: 'gray', invert: false } as Pick };
  const o: ChannelOptions = { blend: 'multiply', opacity: 1, scale: 1, offset: 0 };
  let result = 'channel' as CalcResult;
  const shell = openShell(e, 'Calculations', { wide: true });
  shell.body.classList.add('comp-form');
  const schedule = latest();
  let last: Uint8Array | null = null;
  const compute = async () => {
    const pa = await sources.plane(a),
      pb = await sources.plane(b);
    let m: Uint8Array | undefined;
    if (mask.on) {
      m = await sources.plane(mask.pick);
      if (mask.pick.invert) m = invertPlane(m);
      else m = m.slice();
    }
    return previewJob<Uint8Array>('calculate', { a: pa.slice(), b: pb.slice(), opts: { ...o, invert: a.invert, invertB: b.invert, mask: m } });
  };
  const previewId = 'calculations-preview';
  const refresh = () => {
    if (!shell.preview.checked) return;
    schedule(async () => {
      shell.status.textContent = 'Rendering…';
      try {
        const plane = await compute();
        last = plane;
        if (!shell.dialog.isConnected) return;
        shell.status.textContent = '';
        if (!shell.preview.checked) return;
        // Show the result as an opaque gray layer above everything.
        const img = grayImage(plane, W, H);
        const l = { ...newPixelLayer('Calculations', e.doc, gridFromImage(e.assets.tiles, img)), id: previewId };
        e.preview({ ...e.doc, layers: [...e.doc.layers, l] });
      } catch (error) {
        shell.status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  };
  const changed = () => {
    last = null;
    refresh();
  };
  shell.body.append(sourcePicker(e, 'Source 1', a, false, changed), sourcePicker(e, 'Source 2', b, false, changed), blendControls(o, (c) => c && changed()), maskControls(e, mask, changed));
  shell.body.append(select('Result', [['channel', 'New Channel'], ['document', 'New Document'], ['selection', 'Selection']], result, (v) => (result = v as CalcResult)).el);
  shell.preview.addEventListener('change', () => (shell.preview.checked ? refresh() : e.update()));
  refresh();
  const ok = await shell.result;
  e.update();
  if (!ok) return;
  const plane = last ?? (await compute());
  const m: Mask8 = { width: W, height: H, data: plane };
  if (result === 'selection') commitSelectionMask(e, m, 'replace', 'Calculations');
  else if (result === 'channel') {
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, m);
    const n = (e.doc.channels?.length ?? 0) + 1;
    e.command('Calculations', (d) => {
      d.channels = [...(d.channels ?? []), { id: crypto.randomUUID(), name: `Alpha ${n}`, grid }];
    });
    e.message(`Saved the result as channel “Alpha ${n}”.`);
  } else {
    const img = grayImage(plane, W, H);
    await openDocument(e, `${e.doc.name} calculations`, W, H, (doc, s) => [newPixelLayer('Background', doc, gridFromImage(s.assets.tiles, img))]);
  }
}

function grayImage(plane: Uint8Array, w: number, h: number): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < plane.length; i++) (data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = plane[i]), (data[i * 4 + 3] = 255);
  return { width: w, height: h, data };
}
