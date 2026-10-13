/**
 * Separations: which inks a document uses and what each printing plate
 * carries.
 *
 * Process plates (C, M, Y, K) come from the rendered artwork, separated
 * pixel by pixel with the document's press model (color-management.js).
 * Spot inks are swatches marked as spot colors ({ spot: true }); objects
 * painted with them print on a plate of their own instead of the process
 * plates. A spot plate is rendered from a view of the document whose paints
 * are remapped: the spot's paints become gray by tint (black = solid ink),
 * every other paint becomes white (it knocks the spot ink out), or nothing
 * when the object overprints. The process pass knocks spot-colored objects
 * out the same way.
 *
 * The Separations Preview shows the chosen plates on the canvas in their
 * ink colors (a canvas post-process, see ink-gl.js).
 *
 * Spot ink options (the Spot Colors dialog): a spot swatch can print as
 * process instead (`printAsProcess`) and can carry a CMYK equivalent
 * (`spotCmyk` { c, m, y, k } in percent). doc.root.spotColors.definition
 * picks what process builds of spot inks use: 'lab' (the ink's on-screen
 * color through the press model, the default) or 'cmyk' (each ink's CMYK
 * equivalent, where it has one).
 */
import { exportView } from '../io/export-view.js';
import { RASTER_EFFECTS } from '../../render/effects.js';
import { drawArtwork } from '../../render/draw.js';
import { multiply, apply } from '../../lib/matrix.js';
import { platesFor, profileColors, blackPoint, buildLut, documentCmykProfile, cmykProfile, PROCESS_INKS } from './color-management.js';
import { runInkPass, inkPixels, gpuAvailable } from './ink-gl.js';
import { separatePixel } from './color-management.js';

const hex3 = (hex) => {
  const n = parseInt(String(hex || '#000000').slice(1), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const grayHex = (v) => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${c}${c}${c}`;
};

/** A spot color swatch, whether it prints on its own plate or as process. */
export function isSpotSwatch(sw) {
  return Boolean(sw && (sw.spot || sw.colorType === 'spot') && sw.paint?.type === 'solid');
}

/** A spot ink that prints on a plate of its own. */
export function isSpot(sw) {
  return isSpotSwatch(sw) && !sw.printAsProcess;
}

/** Whether process builds of spot inks use their CMYK equivalents. */
export function spotsUseCmyk(doc) {
  return doc.root.spotColors?.definition === 'cmyk';
}

const validCmyk = (c) => Boolean(c && ['c', 'm', 'y', 'k'].every((k) => Number.isFinite(c[k])));

/** The document's spot inks: [{ id, name, color, cmyk? }] in swatch order (cmyk: the CMYK equivalent in use). */
export function spotInks(doc) {
  const useCmyk = spotsUseCmyk(doc);
  return (doc.root.swatches || []).filter(isSpot).map((s) => ({ id: s.id, name: s.name || 'Spot', color: s.paint.color, ...(useCmyk && validCmyk(s.spotCmyk) ? { cmyk: { ...s.spotCmyk } } : {}) }));
}

/**
 * CMYK equivalents of every spot swatch for process output (spot inks
 * converted to process, or printing as process): Map id -> { c, m, y, k,
 * color }. Empty unless the document uses CMYK equivalents.
 */
export function spotEquivalents(doc) {
  const out = new Map();
  if (!spotsUseCmyk(doc)) return out;
  for (const s of doc.root.swatches || []) if (isSpotSwatch(s) && validCmyk(s.spotCmyk)) out.set(s.id, { ...s.spotCmyk, color: s.paint.color });
  return out;
}

/** How much of a spot ink a color linked to it carries (0..1): an explicit tint, or how far the color is from white toward the ink. */
export function spotTint(color, inkColor, tint = null) {
  if (Number.isFinite(tint)) return Math.max(0, Math.min(1, tint));
  const c = hex3(color);
  const s = hex3(inkColor);
  let num = 0;
  let den = 0;
  for (let i = 0; i < 3; i++) {
    num += (1 - c[i]) * (1 - s[i]);
    den += (1 - s[i]) ** 2;
  }
  return den < 1e-6 ? 1 : Math.max(0, Math.min(1, num / den));
}

const spotOf = (doc, swatchId) => {
  if (!swatchId) return null;
  const sw = (doc.root.swatches || []).find((s) => s.id === swatchId);
  return isSpot(sw) ? sw : null;
};

function forEachPaint(n, fn) {
  for (const key of ['fill', 'stroke']) if (n[key]) fn(n[key], key);
  if (n.type === 'text' && n.runs) for (const r of n.runs) for (const key of ['fill', 'stroke']) if (r[key]) fn(r[key], key);
}

const usageCache = new WeakMap();
/**
 * Inks the document's visible artwork uses: { process: Set of 'c'|'m'|'y'|'k', spots: Set of swatch ids }.
 * Images count as using every process ink.
 */
export function inkUsage(doc, profile) {
  const key = `${doc.nodes?.version}|${profile}`;
  const hit = usageCache.get(doc);
  if (hit?.key === key) return hit.value;
  const process = new Set();
  const spots = new Set();
  const colors = new Set();
  const view = exportView(doc);
  const visit = (n) => {
    if (!n || n.hidden) return;
    if (n.type === 'image') PROCESS_INKS.forEach((k) => process.add(k));
    forEachPaint(n, (p) => {
      if (p.type === 'solid') {
        const sp = spotOf(doc, p.swatchId);
        if (sp) spots.add(sp.id);
        else colors.add(p.color);
      } else if (p.stops) {
        for (const s of p.stops) {
          const sp = spotOf(doc, s.swatchId);
          if (sp) spots.add(sp.id);
          else colors.add(s.color);
        }
      } else PROCESS_INKS.forEach((k) => process.add(k));
    });
    if (n.type === 'mesh' || n.points) PROCESS_INKS.forEach((k) => process.add(k));
    if (n.children) for (const c of n.children) visit(view.get(c));
  };
  for (const id of doc.root.children) visit(view.get(id));
  for (const c of colors) {
    const pl = platesFor(hex3(c), profile);
    PROCESS_INKS.forEach((k, i) => {
      if (pl[i] > 0.005) process.add(k);
    });
  }
  const value = { process, spots };
  usageCache.set(doc, { key, value });
  return value;
}

// ---- plate views ----

/**
 * A read-only view of the document with paints remapped for one pass:
 *   'process'  spot-colored paint knocks out (white) or vanishes (overprint)
 *   spot id    that spot's paint as gray by tint; other paint knocks out
 */
export function plateView(doc, plate) {
  const base = exportView(doc);
  const memo = new Map();
  const remapPaint = (n, p, key) => {
    if (!p) return p;
    const over = key === 'stroke' ? n.overprintStroke : n.overprintFill;
    if (p.type === 'solid') {
      const sp = spotOf(doc, p.swatchId);
      if (plate === 'process') return sp ? (over ? null : { type: 'solid', color: '#ffffff', opacity: p.opacity }) : p;
      if (sp?.id === plate) return { type: 'solid', color: grayHex(1 - spotTint(p.color, sp.paint.color, p.tint)), opacity: p.opacity };
      return over ? null : { type: 'solid', color: '#ffffff', opacity: p.opacity };
    }
    if (p.stops) {
      if (plate === 'process') {
        if (!p.stops.some((s) => spotOf(doc, s.swatchId))) return p;
        return { ...p, stops: p.stops.map((s) => (spotOf(doc, s.swatchId) ? { ...s, color: '#ffffff' } : s)) };
      }
      return { ...p, stops: p.stops.map((s) => {
        const sp = spotOf(doc, s.swatchId);
        return { ...s, color: sp?.id === plate ? grayHex(1 - spotTint(s.color, sp.paint.color)) : '#ffffff' };
      }) };
    }
    // Patterns and other paints print in process inks only.
    return plate === 'process' ? p : over ? null : { type: 'solid', color: '#ffffff' };
  };
  const remap = (n) => {
    if (!n || n.type === 'layer' || n.type === 'root' || n.type === 'group') return n;
    if (plate !== 'process' && n.type === 'image') {
      // Images print in process inks: on a spot plate they knock out their area.
      const t = n.transform || [1, 0, 0, 1, 0, 0];
      const pts = [[0, 0], [n.width, 0], [n.width, n.height], [0, n.height]].map(([x, y]) => apply(t, x, y));
      return { id: n.id, type: 'path', parent: n.parent, anchors: pts.map((q) => ({ x: q.x, y: q.y, ix: q.x, iy: q.y, ox: q.x, oy: q.y })), closed: true, fill: { type: 'solid', color: '#ffffff' }, stroke: null, strokeWidth: 0, opacity: n.opacity ?? 1, blendMode: 'normal', hidden: n.hidden };
    }
    if (n.type !== 'path' && n.type !== 'compound' && n.type !== 'text') return plate === 'process' ? n : { ...n, hidden: true };
    const out = { ...n };
    out.fill = remapPaint(n, n.fill, 'fill');
    out.stroke = remapPaint(n, n.stroke, 'stroke');
    if (n.type === 'text' && n.runs) out.runs = n.runs.map((r) => ({ ...r, ...(r.fill ? { fill: remapPaint(n, r.fill, 'fill') } : {}), ...(r.stroke ? { stroke: remapPaint(n, r.stroke, 'stroke') } : {}) }));
    // Colored glows and shadows are process color; spot plates leave them out.
    if (plate !== 'process' && n.effects?.length) out.effects = n.effects.filter((e) => !RASTER_EFFECTS.has(e.type));
    return out;
  };
  const view = {
    get: (id) => {
      if (memo.has(id)) return memo.get(id);
      const n = remap(base.get(id));
      memo.set(id, n);
      return n;
    },
    has: (id) => base.has(id),
    assets: doc.assets,
    root: doc.root,
    name: doc.name,
    artboards: doc.artboards,
    walk: (fn, id = 'root', depth = 0) => {
      const n = view.get(id);
      if (!n) return;
      if (id !== 'root' && fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) view.walk(fn, c, depth + 1);
    },
  };
  return view;
}

const viewCache = new WeakMap();
function cachedPlateView(doc, plate) {
  let per = viewCache.get(doc);
  const version = doc.nodes?.version;
  if (!per || per.version !== version || per.root !== doc.root) {
    per = { version, root: doc.root, views: new Map() };
    viewCache.set(doc, per);
  }
  if (!per.views.has(plate)) per.views.set(plate, plateView(doc, plate));
  return per.views.get(plate);
}

// ---- preview state ----

export const DEFAULT_SEPARATIONS = Object.freeze({ on: false, hidden: [], usedOnly: true, single: false });

export function separationState(editor) {
  return { ...DEFAULT_SEPARATIONS, ...(editor?.viewOptions?.separations || {}) };
}

export function setSeparationState(editor, patch) {
  editor.setViewOption('separations', { ...separationState(editor), ...patch });
}

/** Plates listed in the panel: [{ id: 'c'|'m'|'y'|'k'|spot id, name, color, spot }]. */
export function listedPlates(app, editor) {
  const doc = editor.doc;
  const profile = documentCmykProfile(app, doc);
  const st = separationState(editor);
  const used = st.usedOnly ? inkUsage(doc, profile) : null;
  const { inks } = profileColors(profile);
  const toHex = (c) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
  const process = PROCESS_INKS.map((k, i) => ({ id: k, name: { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' }[k], color: toHex(inks[i]), spot: false }));
  const spots = spotInks(doc).filter((s) => !used || used.spots.has(s.id)).map((s) => ({ ...s, spot: true }));
  return [...process, ...spots];
}

// ---- rendering ----

function makeCanvas(w, h) {
  return typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h);
}

/** Render a plate view into a canvas the size of the art canvas, on white. */
function renderPass(canvas, editor, docView, overprint) {
  const { view } = editor;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  drawArtwork(ctx, docView, { viewRect: view.visibleRect(4), outline: false, hairline: 1 / view.zoom, outlineColor: '#000000', scale: view.zoom * view.dpr, overprint });
}

const passCanvases = new Map();
function passCanvas(key, w, h) {
  let c = passCanvases.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = makeCanvas(w, h);
    passCanvases.set(key, c);
  }
  return c;
}

/** Separation preview parameters for the GPU/CPU pass. */
export function inkParams(app, editor) {
  const doc = editor.doc;
  const profileId = documentCmykProfile(app, doc);
  const profile = cmykProfile(profileId);
  const st = separationState(editor);
  const hidden = new Set(st.hidden);
  const { inks } = profileColors(profileId);
  const plates = listedPlates(app, editor);
  const spots = plates.filter((p) => p.spot);
  const visible = plates.filter((p) => !hidden.has(p.id));
  let single = -1;
  if (st.single && visible.length === 1) {
    const v = visible[0];
    single = v.spot ? 4 + spots.indexOf(v) : PROCESS_INKS.indexOf(v.id);
  }
  return {
    mode: 'separations',
    profileId,
    lut: buildLut(`sep:${profileId}`, 17, (rgb) => platesFor(rgb, profileId)),
    show: PROCESS_INKS.map((k) => !hidden.has(k)),
    absorb: inks.map((c) => c.map((v) => 1 - v)),
    gain: profile.gain,
    blackRel: blackPoint(profileId),
    single,
    spots: spots.map((s) => ({ id: s.id, absorb: hex3(s.color).map((v) => 1 - v), show: !hidden.has(s.id) })),
  };
}

/** Clip the device context to the artboards (document space under the view transform). */
function clipToArtboards(ctx, editor) {
  const { view, doc } = editor;
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.beginPath();
  for (const a of doc.artboards) ctx.rect(a.x, a.y, a.w, a.h);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The canvas post-process (viewHooks.postArt): replace the artwork on the
 * artboards by the visible plates.
 */
export function drawSeparations(app, ctx, editor) {
  const st = separationState(editor);
  if (!st.on || !editor.doc.artboards.length) return false;
  const canvas = ctx.canvas;
  const w = canvas.width;
  const hgt = canvas.height;
  const params = inkParams(app, editor);
  const doc = editor.doc;
  const overprint = Boolean(editor.viewOptions.overprint);
  // The process plates come from the artwork with spot colors knocked out (or the canvas itself when there are none).
  let source = canvas;
  if (params.spots.length || editor.viewOptions.transparencyGrid) {
    source = passCanvas('process', w, hgt);
    renderPass(source, editor, cachedPlateView(doc, 'process'), overprint);
  }
  const spotCanvases = params.spots.slice(0, 8).map((s, i) => {
    const c = passCanvas(`spot${i}`, w, hgt);
    renderPass(c, editor, cachedPlateView(doc, s.id), overprint);
    return c;
  });
  params.spots = params.spots.slice(0, 8).map((s, i) => ({ ...s, canvas: spotCanvases[i] }));
  let result = gpuAvailable() ? runInkPass(source, params) : null;
  if (!result) result = cpuPass(source, params, spotCanvases);
  if (!result) return false;
  ctx.save();
  clipToArtboards(ctx, editor);
  ctx.drawImage(result, 0, 0, w, hgt);
  ctx.restore();
  return true;
}

/** CPU fallback: the pass at up to ~1.5 megapixels, scaled back up. */
function cpuPass(source, params, spotCanvases) {
  const scale = Math.min(1, Math.sqrt(1.5e6 / (source.width * source.height)));
  const w = Math.max(1, Math.round(source.width * scale));
  const hgt = Math.max(1, Math.round(source.height * scale));
  const read = (c, key) => {
    const t = passCanvas(key, w, hgt);
    const tc = t.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.drawImage(c, 0, 0, w, hgt);
    try {
      return { canvas: t, img: tc.getImageData(0, 0, w, hgt) };
    } catch {
      return null;
    }
  };
  const main = read(source, 'cpu-main');
  if (!main?.img?.data || main.img.data.length !== w * hgt * 4) return null;
  const spots = params.spots.map((s, i) => ({ ...s, data: read(spotCanvases[i], `cpu-spot${i}`)?.img?.data || new Uint8ClampedArray(w * hgt * 4).fill(255) }));
  inkPixels(main.img.data, { ...params, spots }, (r, g, b, out) => separatePixel(params.profileId, r, g, b, out));
  main.canvas.getContext('2d').putImageData(main.img, 0, 0);
  return main.canvas;
}

/**
 * Ink coverage at a document point: { c, m, y, k, spots: [{ id, name, value }] }
 * in percent, from one-pixel renders of the process and spot passes.
 */
export function inkAt(app, editor, x, y) {
  const doc = editor.doc;
  const profile = documentCmykProfile(app, doc);
  const { view } = editor;
  const k = view.zoom * view.dpr;
  const sample = (docView) => {
    const c = passCanvas('sample', 1, 1);
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    ctx.setTransform(k, 0, 0, k, 0.5 - x * k, 0.5 - y * k);
    drawArtwork(ctx, docView, { viewRect: { x: x - 2 / k, y: y - 2 / k, w: 4 / k, h: 4 / k }, outline: false, hairline: 1 / view.zoom, scale: k, overprint: Boolean(editor.viewOptions.overprint) });
    try {
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    } catch {
      return [1, 1, 1];
    }
  };
  const inks = spotInks(doc);
  const rgb = sample(inks.length ? cachedPlateView(doc, 'process') : doc);
  const plates = platesFor(rgb, profile);
  const pct = (v) => Math.round(v * 1000) / 10;
  return {
    c: pct(plates[0]),
    m: pct(plates[1]),
    y: pct(plates[2]),
    k: pct(plates[3]),
    spots: inks.map((s) => ({ id: s.id, name: s.name, value: pct(1 - sample(cachedPlateView(doc, s.id))[0]) })),
  };
}
