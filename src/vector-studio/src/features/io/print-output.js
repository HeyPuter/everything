/**
 * Print output beyond plain composite vectors: host-based separations (one
 * grayscale page per printed ink), print as bitmap, simulated overprints,
 * negative and mirrored (emulsion down) film output, press proofing of the
 * output, copies, collation and reverse order. Shared by the Print dialog
 * and print presets.
 *
 * Settings (besides the layout settings of print-layout.js):
 *   copies, collate, reverse
 *   mode           'composite' | 'separations'
 *   emulsion       'up' | 'down' (mirrored)
 *   image          'positive' | 'negative'
 *   color          'color' | 'gray' (composite)
 *   spotToProcess  print spot colors on the process plates
 *   overprintBlack black fills and strokes print over the inks below
 *   skipPlates     plate ids not to print ('c', 'm', 'y', 'k' or spot ids)
 *   textMode       'text' | 'outlines'
 *   colorHandling  'browser' | 'proof' (simulate the printer profile)
 *   printerProfile 'document' | a CMYK press id; intent
 *   bitmap, bitmapPpi   print as bitmap
 *   overprints     'discard' | 'simulate'
 *   flattener      transparency flattener preset name (resolution of simulated output)
 */
import { PRINT_DEFAULTS, normalizePrint } from './print-settings.js';
import { exportSVG } from './svg-export.js';
import { printView } from './print.js';
import { renderRegion } from './raster.js';
import { separatePixel, documentCmykProfile, cmykProfile, colorSettings, INK_NAMES, PROCESS_INKS } from '../prepress/color-management.js';
import { spotInks, inkUsage, plateView } from '../prepress/separations.js';
import { cmykProofBody } from '../prepress/proof.js';
import { getPreset } from '../prepress/presets.js';

export { PRINT_DEFAULTS, normalizePrint };

/** Whether pages print as images rather than vectors. */
export function rasterOutput(st) {
  return st.mode === 'separations' || st.bitmap || st.overprints === 'simulate';
}

/** The press profile output uses. */
export function outputProfile(app, doc, st) {
  return st.printerProfile && st.printerProfile !== 'document' ? st.printerProfile : documentCmykProfile(app, doc);
}

/** Every plate the document can print: [{ id, name, spot }]. */
export function documentPlates(app, doc, st) {
  const profile = outputProfile(app, doc, st);
  const used = inkUsage(doc, profile);
  const process = PROCESS_INKS.map((k) => ({ id: k, name: INK_NAMES[k], spot: false, used: used.process.has(k) }));
  const spots = st.spotToProcess ? [] : spotInks(doc).map((s) => ({ id: s.id, name: s.name, spot: true, used: used.spots.has(s.id) }));
  return [...process, ...spots];
}

/** Plates a job prints: composite is one plate; separations skip unchecked inks. */
export function printPlates(app, doc, st) {
  if (st.mode !== 'separations') return [{ id: 'composite', name: '', spot: false }];
  const skip = new Set(st.skipPlates || []);
  return documentPlates(app, doc, st).filter((p) => !skip.has(p.id));
}

/** Pages in printing order: [{ page, plate, n }] with plates, copies, collation and reverse order applied. */
export function pageSequence(pages, plates, st) {
  const one = [];
  pages.forEach((page, n) => plates.forEach((plate) => one.push({ page, plate, n })));
  if (st.reverse) one.reverse();
  const copies = Math.max(1, st.copies || 1);
  if (copies === 1) return one;
  if (st.collate) return Array.from({ length: copies }, () => one).flat();
  return one.flatMap((p) => Array.from({ length: copies }, () => p));
}

/** Resolution of raster output (bitmap, simulated overprints, separations). */
export function rasterPpi(app, st) {
  if (st.bitmap) return st.bitmapPpi;
  const p = getPreset(app, 'flattener', st.flattener);
  return p?.values.lineArtPpi || 300;
}

/** The document view a plate renders from. */
function sourceFor(doc, st, plate) {
  let src = printView(doc, st.layers);
  if (st.overprintBlack) src = overprintBlackView(src);
  if (plate.id === 'composite' || !plate.spot) return st.mode === 'separations' && !st.spotToProcess ? plateView(src, 'process') : src;
  return plateView(src, plate.id);
}

const isBlack = (p) => p?.type === 'solid' && (/^#0{6}$/i.test(p.color || '') || (p.cmyk && p.cmyk.k >= 100 && !p.cmyk.c && !p.cmyk.m && !p.cmyk.y));

/** Black fills and strokes set to overprint. */
export function overprintBlackView(doc) {
  const memo = new Map();
  const view = {
    get: (id) => {
      if (memo.has(id)) return memo.get(id);
      let n = doc.get(id);
      if (n && (isBlack(n.fill) || isBlack(n.stroke))) n = { ...n, overprintFill: n.overprintFill || isBlack(n.fill), overprintStroke: n.overprintStroke || isBlack(n.stroke) };
      memo.set(id, n);
      return n;
    },
    has: (id) => doc.has(id),
    assets: doc.assets,
    get root() {
      return doc.root;
    },
    name: doc.name,
    artboards: doc.artboards,
    nodes: doc.nodes,
    walk: (fn, id = 'root', depth = 0) => {
      const n = view.get(id);
      if (!n) return;
      if (id !== 'root' && fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) view.walk(fn, c, depth + 1);
    },
  };
  return view;
}

/** Plate densities as gray (white = no ink) for a process plate, in place. */
export function processPlatePixels(data, profile, index) {
  const out = new Float32Array(4);
  for (let i = 0; i < data.length; i += 4) {
    separatePixel(profile, data[i], data[i + 1], data[i + 2], out);
    const v = Math.round((1 - out[index]) * 255);
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return data;
}

/** Render one tile's document rect for a plate into a canvas at `ppi`. */
export async function renderPlateTile(app, doc, rect, plate, st, ppi) {
  const max = 6000;
  const scale = Math.min(ppi / 72, max / Math.max(rect.w, 1), max / Math.max(rect.h, 1));
  const src = sourceFor(doc, st, plate);
  const canvas = await renderRegion(src, rect, { scale, background: '#ffffff', antialias: true, overprint: st.overprints === 'simulate' || st.overprintBlack });
  if (plate.id !== 'composite' && !plate.spot) {
    const ctx = canvas.getContext('2d');
    try {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (img?.data?.length === canvas.width * canvas.height * 4) {
        processPlatePixels(img.data, outputProfile(app, doc, st), PROCESS_INKS.indexOf(plate.id));
        ctx.putImageData(img, 0, 0);
      }
    } catch {
      /* tainted or unavailable: print the plate's source */
    }
  }
  return canvas;
}

async function canvasURL(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((r) => canvas.toBlob ? canvas.toBlob(r, 'image/png') : r(null));
  return blob && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
}

const num = (v) => String(Math.round(v * 1000) / 1000);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function marksMarkup(marks, label) {
  let out = '';
  for (const m of marks) {
    if (m.kind === 'line') out += `<line x1="${num(m.x1)}" y1="${num(m.y1)}" x2="${num(m.x2)}" y2="${num(m.y2)}" stroke="#000" stroke-width="${num(m.w)}"/>`;
    else if (m.kind === 'registration') {
      out += `<g fill="none" stroke="#000" stroke-width="${num(m.w)}"><circle cx="${num(m.x)}" cy="${num(m.y)}" r="${num(m.r)}"/><circle cx="${num(m.x)}" cy="${num(m.y)}" r="${num(m.r / 2)}"/>`;
      out += `<line x1="${num(m.x - m.r * 1.5)}" y1="${num(m.y)}" x2="${num(m.x + m.r * 1.5)}" y2="${num(m.y)}"/><line x1="${num(m.x)}" y1="${num(m.y - m.r * 1.5)}" x2="${num(m.x)}" y2="${num(m.y + m.r * 1.5)}"/></g>`;
    } else if (m.kind === 'swatch') out += `<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(m.w)}" height="${num(m.h)}" fill="${m.color}"/>`;
    else if (m.kind === 'text') out += `<text x="${num(m.x)}" y="${num(m.y)}" font-family="sans-serif" font-size="${num(m.size)}" fill="#000">${esc(label ? `${m.text}  ${label}` : m.text)}</text>`;
  }
  return out;
}

/** Filter primitives simulating the printer profile, or '' for none. */
export function outputProofFilter(app, doc, st) {
  if (st.colorHandling !== 'proof' || st.mode === 'separations') return '';
  return cmykProofBody(outputProfile(app, doc, st), { intent: st.intent, bpc: colorSettings(app).bpc });
}

/**
 * Print-ready DOM for laid-out pages with every output option applied.
 * Returns { root, urls } (blob URLs to revoke after printing).
 */
export async function buildPrintOutput(app, editor, pages, st, { outlines = null, onProgress } = {}) {
  const doc = editor.doc;
  const plates = printPlates(app, doc, st);
  const seq = pageSequence(pages, plates, st);
  const raster = rasterOutput(st);
  const ppi = rasterPpi(app, st);
  const proof = outputProofFilter(app, doc, st);
  const root = document.createElement('div');
  root.className = 'io-print-root';
  root.setAttribute('aria-hidden', 'true');
  const urls = [];
  const cache = new Map();
  let done = 0;
  for (const [i, item] of seq.entries()) {
    const { page: p, plate } = item;
    const el = document.createElement('div');
    el.className = 'io-print-page';
    el.style.page = `vs-page-${i}`;
    el.style.width = `${p.w}pt`;
    el.style.height = `${p.h}pt`;
    let body = '';
    for (const [k, t] of p.tiles.entries()) {
      const key = `${plate.id}|${t.rect.x},${t.rect.y},${t.rect.w},${t.rect.h}`;
      let art = cache.get(key);
      if (art === undefined) {
        if (raster) {
          const canvas = await renderPlateTile(app, doc, t.rect, plate, st, ppi);
          const url = await canvasURL(canvas);
          if (url) urls.push(url);
          art = { url };
        } else {
          art = { svg: exportSVG(printView(doc, st.layers), { rect: t.rect, responsive: true, minify: true, precision: 3, textMode: outlines ? 'outlines' : 'text', outlines, writeIds: false, idPrefix: `p${i}t${k}-` }) };
        }
        cache.set(key, art);
        onProgress?.(++done);
      }
      const w = num(t.rect.w * t.s);
      const hh = num(t.rect.h * t.s);
      if (art.url) body += `<image href="${art.url}" x="${num(t.x)}" y="${num(t.y)}" width="${w}" height="${hh}" preserveAspectRatio="none"/>`;
      else if (art.svg) body += art.svg.replace(/^<\?xml[^>]*>\s*/, '').replace(/^<svg\b/, `<svg x="${num(t.x)}" y="${num(t.y)}" width="${w}" height="${hh}" preserveAspectRatio="none" overflow="hidden"`);
    }
    const art = proof ? `<defs><filter id="pp-out-${i}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${proof}</filter></defs><g filter="url(#pp-out-${i})">${body}</g>` : body;
    const mirror = st.emulsion === 'down' ? ` transform="translate(${num(p.w)} 0) scale(-1 1)"` : '';
    const content = `<g${mirror}>${art}${marksMarkup(p.marks || [], plate.name)}</g>`;
    el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(p.w)}pt" height="${num(p.h)}pt" viewBox="0 0 ${num(p.w)} ${num(p.h)}">${content}</svg>`;
    const filters = [];
    if (st.mode === 'composite' && st.color === 'gray') filters.push('grayscale(1)');
    if (st.image === 'negative') filters.push('invert(1)');
    if (filters.length) el.style.filter = filters.join(' ');
    root.append(el);
  }
  return { root, urls, count: seq.length };
}

/** Options and warnings for the Summary pane. */
export function printSummary(app, editor, pages, st) {
  const doc = editor.doc;
  const plates = printPlates(app, doc, st);
  const seq = pageSequence(pages, plates, st);
  const yes = (b) => (b ? 'On' : 'Off');
  const marks = Object.entries(st.marks || {}).filter(([, v]) => v).map(([k]) => ({ trim: 'trim', registration: 'registration', colorBars: 'color bars', pageInfo: 'page information' })[k]);
  const options = [
    ['Pages', `${pages.length} page${pages.length === 1 ? '' : 's'}${st.mode === 'separations' ? ` × ${plates.length} plate${plates.length === 1 ? '' : 's'}` : ''}${st.copies > 1 ? ` × ${st.copies} copies` : ''} = ${seq.length} sheet${seq.length === 1 ? '' : 's'}`],
    ['Media', pages[0] ? `${Math.round(pages[0].w)} × ${Math.round(pages[0].h)} pt` : '—'],
    ['Scaling', { none: 'Do not scale', fit: 'Fit to page', custom: `${st.scale}%`, tile: `Tile at ${st.scale}%` }[st.scaling]],
    ["Printer's marks", marks.length ? `${marks.join(', ')} (${st.markType === 'japanese' ? 'Japanese' : 'Roman'})` : 'None'],
    ['Mode', st.mode === 'separations' ? `Separations: ${plates.map((p) => p.name).join(', ') || 'no plates'}` : st.color === 'gray' ? 'Composite grayscale' : 'Composite color'],
    ['Emulsion', st.emulsion === 'down' ? 'Down (mirrored)' : 'Up (right reading)'],
    ['Image', st.image === 'negative' ? 'Negative' : 'Positive'],
    ['Text', st.textMode === 'outlines' ? 'Converted to outlines' : 'Printed as text'],
    ['Color handling', st.colorHandling === 'proof' && st.mode !== 'separations' ? `Simulate ${cmykProfile(outputProfile(app, doc, st)).label}` : 'Browser and printer'],
    ['Print as bitmap', st.bitmap ? `${st.bitmapPpi} ppi` : 'Off'],
    ['Overprints', st.overprints === 'simulate' ? 'Simulate' : 'Discard'],
    ['Overprint black', yes(st.overprintBlack)],
    ['Flattener preset', st.flattener],
  ];
  const warnings = [];
  const spots = spotInks(doc);
  if (spots.length && (st.mode === 'composite' || st.spotToProcess)) warnings.push(`${spots.length} spot color${spots.length === 1 ? '' : 's'} will print as process color.`);
  let overprinting = 0;
  doc.walk((n) => {
    if (n.overprintFill || n.overprintStroke) overprinting++;
  });
  if (overprinting && st.overprints === 'discard' && st.mode === 'composite') warnings.push(`${overprinting} object${overprinting === 1 ? '' : 's'} set to overprint will knock out; choose Simulate under Overprints to see them mixed.`);
  if (pages.some((p) => p.tiles.some((t) => t.x < -0.5 || t.y < -0.5 || t.x + t.rect.w * t.s > p.w + 0.5 || t.y + t.rect.h * t.s > p.h + 0.5))) warnings.push('The artwork extends beyond the media and will be cut off.');
  if (st.mode === 'separations' && !plates.length) warnings.push('No plates are selected to print.');
  if (rasterOutput(st)) warnings.push(`Pages print as images at ${rasterPpi(app, st)} ppi.`);
  return { options, warnings };
}
