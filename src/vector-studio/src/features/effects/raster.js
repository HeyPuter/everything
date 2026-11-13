/**
 * Rasterizing: Effect > Document Raster Effects Settings, the live
 * Effect > Rasterize appearance and Object > Rasterize.
 *
 * The document's raster settings ({ colorModel, resolution, background,
 * antialias, padding }) live on the root (resolution as root.rasterResolution, the
 * rest as root.rasterOptions). A Rasterize effect either uses them (and is
 * updated whenever they change) or carries its own.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { registerContentEffect } from '../../render/effects.js';
import { registerEffectType } from '../paint/effects-model.js';
import { selectionBounds, inflate, visualBounds } from '../../model/geometry.js';
import { createImage, createGroup, createCompound, createPath } from '../../model/nodes.js';
import { geometryLeaves, subpathsOf } from '../geometry/nodes-io.js';
import { openEffectDialog, choiceField, checkField, selectRow, numberRow, group } from './dialog-kit.js';

export const RESOLUTIONS = Object.freeze([
  { value: 72, label: 'Screen (72 ppi)' },
  { value: 150, label: 'Medium (150 ppi)' },
  { value: 300, label: 'High (300 ppi)' },
]);

export const COLOR_MODELS = Object.freeze([
  { value: 'rgb', label: 'RGB' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'bitmap', label: 'Bitmap (black and white)' },
]);

const DOC_DEFAULTS = Object.freeze({ colorModel: 'rgb', resolution: 72, background: 'transparent', antialias: true, padding: 0 });

/** The document's raster effects settings. */
export function docRasterSettings(doc) {
  const r = doc.root;
  const o = r.rasterOptions || {};
  const res = Number(r.rasterResolution);
  return {
    colorModel: COLOR_MODELS.some((m) => m.value === o.colorModel) ? o.colorModel : 'rgb',
    resolution: Number.isFinite(res) && res >= 36 && res <= 2400 ? res : DOC_DEFAULTS.resolution,
    background: o.background === 'white' ? 'white' : 'transparent',
    antialias: o.antialias !== false,
    padding: Number.isFinite(o.padding) ? Math.max(0, o.padding) : DOC_DEFAULTS.padding,
  };
}

/** Store new document raster settings and update the Rasterize effects that follow them (inside a transaction). */
export function setDocRasterSettings(doc, s) {
  const cur = docRasterSettings(doc);
  const next = { ...cur, ...s };
  doc.updateRoot({ rasterResolution: next.resolution, rasterOptions: { colorModel: next.colorModel, background: next.background, antialias: next.antialias, padding: next.padding } });
  doc.walk((n) => {
    if (!n.effects?.some((e) => e.type === 'rasterize' && e.useDocument)) return;
    doc.update(n.id, { effects: n.effects.map((e) => (e.type === 'rasterize' && e.useDocument ? { ...e, ...next } : e)) });
  });
}

registerEffectType('rasterize', {
  label: 'Rasterize',
  command: 'effect.rasterize',
  defaults: { useDocument: true, ...DOC_DEFAULTS },
  ranges: { resolution: [36, 2400], padding: [0, 10000] },
  enums: { background: ['transparent', 'white'], colorModel: COLOR_MODELS.map((m) => m.value) },
  describe: (e) => `Rasterize (${e.colorModel && e.colorModel !== 'rgb' ? `${COLOR_MODELS.find((m) => m.value === e.colorModel).label.split(' ')[0]}, ` : ''}${e.resolution} ppi)`,
});

function makeCanvas(w, hgt) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, hgt);
  return Object.assign(document.createElement('canvas'), { width: w, height: hgt });
}

/** The box of non-transparent pixels in a canvas, or null. */
function alphaBox(ctx, w, hgt) {
  let data;
  try {
    data = ctx.getImageData(0, 0, w, hgt).data;
  } catch {
    return null;
  }
  if (!data || data.length < w * hgt * 4) return null;
  let x0 = w;
  let y0 = hgt;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < hgt; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Convert pixels to a color model in place: grayscale keeps luminance;
 * bitmap makes every pixel black or white (and fully opaque or clear).
 */
export function convertPixels(d, model) {
  if (model !== 'grayscale' && model !== 'bitmap') return d;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const v = model === 'bitmap' ? (lum >= 128 ? 255 : 0) : Math.round(lum);
    d[i] = d[i + 1] = d[i + 2] = v;
    if (model === 'bitmap') d[i + 3] = d[i + 3] >= 128 ? 255 : 0;
  }
  return d;
}

function convertCanvas(ctx, w, hgt, model) {
  if (model !== 'grayscale' && model !== 'bitmap') return;
  try {
    const img = ctx.getImageData(0, 0, w, hgt);
    convertPixels(img.data, model);
    ctx.putImageData(img, 0, 0);
  } catch {
    /* unreadable canvas: keep the colors */
  }
}

/**
 * The live Rasterize appearance: the artwork is resampled at the effect's
 * resolution (visible as pixels when zoomed in past it), optionally on a
 * white background reaching `padding` around it, and with hard edges when
 * anti-aliasing is off.
 */
export function rasterizeLayer(layer, e, scale, pool, info) {
  const src = layer.canvas;
  const W = src.width;
  const H = src.height;
  const out = pool.acquire(W, H);
  const c = out.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (e.background === 'white') {
    const box = alphaBox(layer.ctx, W, H);
    if (box) {
      const pad = Math.max(0, e.padding || 0) * scale;
      c.fillStyle = '#ffffff';
      c.fillRect(box.x - pad, box.y - pad, box.w + 2 * pad, box.h + 2 * pad);
    }
  }
  const f = (Math.max(36, e.resolution || 72) / 72) / Math.max(1e-6, scale);
  if (f < 0.999) {
    // The pixel grid starts at the object's corner rather than the layer's (which is cut at the
    // screen edge), so the pixels stay on the artwork while panning. (sx, sy): the first cell's corner.
    const cell = 1 / f;
    let sx = 0;
    let sy = 0;
    const vb = info?.node && info.doc && info.transform ? visualBounds(info.doc, info.node) : null;
    if (vb) {
      const m = info.transform;
      const phase = (v) => {
        const r = ((v % cell) + cell) % cell;
        return r > 1e-6 ? r - cell : 0;
      };
      sx = phase(m.a * vb.x + m.c * vb.y + m.e - (info.x || 0));
      sy = phase(m.b * vb.x + m.d * vb.y + m.f - (info.y || 0));
    }
    const w = Math.max(1, Math.ceil((W - sx) * f));
    const hh = Math.max(1, Math.ceil((H - sy) * f));
    const tmp = makeCanvas(w, hh);
    const t = tmp.getContext('2d');
    t.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in t) t.imageSmoothingQuality = 'high';
    t.drawImage(src, 0, 0, W, H, -sx * f, -sy * f, W * f, H * f);
    if (e.antialias === false) harden(t, w, hh);
    convertCanvas(t, w, hh, e.colorModel);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, w, hh, sx, sy, w * cell, hh * cell);
    c.imageSmoothingEnabled = true;
  } else {
    c.drawImage(src, 0, 0);
    if (e.antialias === false) harden(c, W, H);
    convertCanvas(c, W, H, e.colorModel);
  }
  return out;
}

function harden(ctx, w, hgt) {
  try {
    const img = ctx.getImageData(0, 0, w, hgt);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    ctx.putImageData(img, 0, 0);
  } catch {
    /* unreadable canvas: keep the edges */
  }
}

registerContentEffect('rasterize', rasterizeLayer);

// ---- dialogs ----

/** Shared raster option controls. `useDoc` adds the "use document settings" switch. */
function rasterControls(start, unit, { useDoc = false, clip = null, onChange }) {
  const preset = RESOLUTIONS.some((r) => r.value === start.resolution) ? String(start.resolution) : 'other';
  const resOptions = [...(useDoc ? [{ value: 'document', label: 'Use Document Settings' }] : []), ...RESOLUTIONS.map((r) => ({ value: String(r.value), label: r.label })), { value: 'other', label: 'Other' }];
  const model = selectRow({ label: 'Color Model', value: start.colorModel || 'rgb', options: COLOR_MODELS, onChange });
  const res = selectRow({ label: 'Resolution', value: useDoc && start.useDocument ? 'document' : preset, options: resOptions, onChange: () => sync() });
  const other = numberRow({ label: 'Pixels per inch', value: start.resolution, min: 36, max: 2400, integer: true, onInput: onChange });
  const bg = choiceField({ label: 'Background', value: start.background, options: [{ value: 'white', label: 'White' }, { value: 'transparent', label: 'Transparent' }], onChange });
  const aa = checkField({ label: 'Anti-aliasing', value: start.antialias, onChange });
  const pad = numberRow({ label: 'Add around object', value: start.padding, kind: 'length', unit, min: 0, max: 10000, onInput: onChange });
  const clipBox = clip ? checkField({ label: 'Create clipping mask', value: clip.value, onChange }) : null;
  const sync = () => {
    const v = res.get();
    other.el.hidden = v !== 'other';
    const docMode = v === 'document';
    for (const el of [model.el, bg.el, aa.el, pad.el]) {
      el.classList.toggle('fx-disabled', docMode);
      if (docMode) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    }
    for (const i of [model.select, ...bg.el.querySelectorAll('input'), ...aa.el.querySelectorAll('input'), pad.field]) i.disabled = docMode;
    onChange?.();
  };
  sync();
  const els = [model.el, res.el, other.el, group('Background', bg.el), group('Options', aa.el, ...(clipBox ? [clipBox.el] : []), pad.el)];
  const read = () => {
    const v = res.get();
    return {
      colorModel: model.get(),
      useDocument: v === 'document',
      resolution: v === 'other' || v === 'document' ? other.get() : Number(v),
      background: bg.get(),
      antialias: aa.get(),
      padding: pad.get(),
      ...(clipBox ? { clip: clipBox.get() } : {}),
    };
  };
  return { els, read, focus: () => model.select };
}

/** Effect > Document Raster Effects Settings. */
export async function rasterSettingsDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const start = docRasterSettings(ed.doc);
  const ctl = rasterControls(start, ed.doc.root.units || 'pt', {});
  const res = await openDialog({
    title: 'Document Raster Effects Settings',
    className: 'fx-dialog',
    body: h('div.fx-body', h('p.fx-note', 'Used by raster effects that follow the document, and offered when rasterizing.'), ...ctl.els),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ctl.read() }],
    initialFocus: ctl.focus,
  });
  if (!res) return false;
  ed.doc.transact('Document Raster Effects Settings', () => setDocRasterSettings(ed.doc, res));
  return true;
}

/** Effect > Rasterize (a live raster appearance). */
export function rasterizeEffectDialog(app, opts = {}) {
  return openEffectDialog(app, 'rasterize', {
    ...opts,
    build(ctx) {
      const docS = docRasterSettings(ctx.doc);
      const start = ctx.start.useDocument ? { ...ctx.start, ...docS } : ctx.start;
      const ctl = rasterControls(start, ctx.unit, { useDoc: true, onChange: ctx.changed });
      return {
        body: h('div.fx-body', ...ctl.els),
        read: () => {
          const v = ctl.read();
          return v.useDocument ? { ...v, ...docRasterSettings(ctx.doc), useDocument: true } : v;
        },
        focus: ctl.focus,
      };
    },
  });
}

// ---- Object > Rasterize ----

async function blobToDataURL(blob) {
  if (typeof FileReader === 'undefined') {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    return `data:${blob.type};base64,${btoa(s)}`;
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Render ids at `ppi` into a PNG data URL: { data, width, height }. */
export async function renderToImage(doc, ids, rect, { ppi, background, antialias, colorModel = 'rgb' }) {
  const { renderRegion } = await import('../io/raster.js');
  const canvas = await renderRegion(doc, rect, { scale: ppi / 72, background: background === 'white' ? '#ffffff' : null, antialias, ids });
  convertCanvas(canvas.getContext('2d'), canvas.width, canvas.height, colorModel);
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { data: await blobToDataURL(blob), width: canvas.width, height: canvas.height };
}

/**
 * Replace objects by one image of them (inside the caller's flow; opens
 * its own transaction). `render` is replaceable for tests. Returns the new
 * node's id.
 */
export async function rasterizeObjects(editor, ids, opts, render = renderToImage) {
  const doc = editor.doc;
  if (doc.readOnly || doc.tx || opts.signal?.aborted) return null;
  const ordered = doc.sortByPaintOrder(ids.filter((id) => doc.get(id)));
  if (!ordered.length) return null;
  const vb = selectionBounds(doc, ordered, true);
  if (!vb || !(vb.w > 0) || !(vb.h > 0)) return null;
  // A group can stay unchanged while a child is edited. Capture the entire
  // input tree before rendering yields, so the image never replaces newer art.
  const snap = new Map();
  for (const id of ordered) for (const n of [doc.get(id), ...doc.descendants(id)]) snap.set(n.id, n);
  const rect = inflate(vb, Math.max(0, opts.padding || 0));
  const img = await render(doc, ordered, rect, { ppi: opts.resolution, background: opts.background, antialias: opts.antialias, colorModel: opts.colorModel });
  if (doc.readOnly || doc.tx || opts.signal?.aborted) return null;
  for (const [id, node] of snap) if (doc.get(id) !== node) return null;
  // Moving a parent layer can reorder the inputs without changing them.
  if (doc.sortByPaintOrder(ordered).some((id, i) => id !== ordered[i])) return null;
  const assetId = uid('img');
  doc.assets.set(assetId, { mime: 'image/png', data: img.data, name: 'Rasterized artwork' });
  const top = doc.get(ordered[ordered.length - 1]);
  const image = createImage(assetId, img.width, img.height, [rect.w / img.width, 0, 0, rect.h / img.height, rect.x, rect.y]);
  let out = null;
  doc.transact('Rasterize', () => {
    const parent = doc.get(top.parent);
    let index = parent.children.indexOf(top.id) + 1;
    // A clipping mask from the objects' own outlines keeps the image's edges crisp.
    const clipPath = opts.clip ? clipOutline(doc, ordered) : null;
    if (clipPath) {
      const g = createGroup([], { clip: true });
      out = doc.insert(g, parent.id, index);
      doc.insert(image, g.id);
      doc.insert(clipPath.node, g.id, Infinity, clipPath.descendants);
    } else out = doc.insert(image, parent.id, index);
    for (const id of ordered) doc.remove(id);
  });
  editor.select([out.id]);
  return out.id;
}

/** A compound path of every path outline in the objects (no paint), or null. */
function clipOutline(doc, ids) {
  const subs = geometryLeaves(doc, ids).flatMap((n) => subpathsOf(doc, n)).filter((s) => s.closed);
  if (!subs.length) return null;
  if (subs.length === 1) return { node: createPath(subs[0].anchors, true, { fill: null, stroke: null }), descendants: [] };
  const comp = createCompound([], { fill: null, stroke: null });
  const kids = subs.map((s) => ({ ...createPath(s.anchors, true, { fill: null, stroke: null }), parent: comp.id }));
  comp.children = kids.map((k) => k.id);
  return { node: comp, descendants: kids };
}

/** Object > Rasterize dialog. */
export async function rasterizeObjectDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const ids = ed.topSelection().filter((id) => ed.doc.get(id)?.type !== 'layer');
  if (!ids.length) return false;
  // Nothing visible (an empty group, an unstroked straight line): say so up front.
  const vb = selectionBounds(ed.doc, ids, true);
  if (!vb || !(vb.w > 0) || !(vb.h > 0)) {
    app.notify('There is no visible artwork to rasterize.');
    return false;
  }
  const last = app.prefs?.get?.('rasterizeObject');
  const start = { ...docRasterSettings(ed.doc), clip: false, ...(last || {}) };
  const ctl = rasterControls(start, ed.doc.root.units || 'pt', { clip: { value: start.clip } });
  const controller = new AbortController();
  const selection = [...ed.selection], isolation = ed.isolation;
  let closeDialog = null;
  const check = () => {
    if (controller.signal.aborted) return false;
    if (app.editor === ed && app.editors.includes(ed) && !ed.doc.readOnly &&
        (!app.home || app.home.hidden) && ed.isolation === isolation &&
        ed.selection.size === selection.length && selection.every((id) => ed.selection.has(id)) &&
        ids.every((id) => ed.doc.has(id) && !ed.doc.isLocked(id) && !ed.doc.isHidden(id))) return true;
    controller.abort();
    closeDialog?.(null);
    return false;
  };
  const offs = ['active-editor', 'closed', 'show-home'].map((event) => app.on(event, check));
  for (const event of ['selection', 'isolation']) offs.push(ed.on(event, check));
  offs.push(ed.on('doc-change', (event) => { if (event.commit) check(); }));
  if (app.collab) offs.push(app.collab.on('role', check));
  try {
    const res = await openDialog({
      title: 'Rasterize',
      className: 'fx-dialog',
      body: h('div.fx-body', ...ctl.els),
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ctl.read() }],
      initialFocus: ctl.focus,
      onOpen: ({ close }) => { closeDialog = close; if (!check()) close(null); },
    });
    closeDialog = null;
    if (!res || !check()) return false;
    app.prefs?.set?.('rasterizeObject', res);
    const id = await rasterizeObjects(ed, ids, { ...res, signal: controller.signal });
    if (!id && !controller.signal.aborted) app.notify('Rasterize was canceled because the artwork changed.');
    return Boolean(id);
  } catch (err) {
    app.notify(err?.message || 'The artwork could not be rasterized.', { error: true });
    return false;
  } finally {
    for (const off of offs) off();
  }
}

