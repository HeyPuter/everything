// Image > Mode: conversions between RGB, Grayscale, CMYK, Lab, Indexed,
// Bitmap and Duotone, the Indexed color table and bit depth. See convert.ts
// for how modes are represented (pixels stay document RGB, constrained to
// the mode's gamut).
import type { Editor } from '../../editor';
import { mapDocumentGeometry, type ColorMode, type DuotoneInkSpec, type PhotoDocument } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { formDialog } from '../../ui/dialog';
import {
  builtinProfile,
  convertMode,
  curveTable,
  indexedToRGBA,
  toIndexed,
  toHex,
  type BitmapOptions,
  type DuotoneInk,
  type IndexedOptions,
} from '../../color/color-management';
import type { DitherKind, ForcedColors, PaletteKind } from '../../color/indexed';
import type { BitmapMethod, HalftoneShape } from '../../color/bitmap';
import { cmykMap, duotoneMap, grayMap, labMap, mapHex, nearestPaletteHex, type PixelMap } from './convert';
import { colorSettings, docGrayProfile, docProfile, ensureProfile, storedRef } from './profiles';
import { assertSameDocument, flatComposite, flattenTo, mapDocument, reportText, requireEightBit } from './docops';
import { pickColor } from './picker';
import { displayLut, proofState, resetDisplay } from './proof';
import { convertToMultichannel, leaveMultichannel } from './multichannel';

export const MODE_NAMES: Record<ColorMode, string> = {
  rgb: 'RGB Color', grayscale: 'Grayscale', cmyk: 'CMYK Color', lab: 'Lab Color', indexed: 'Indexed Color', bitmap: 'Bitmap', duotone: 'Duotone', multichannel: 'Multichannel',
};
export const modeOf = (doc: PhotoDocument): ColorMode => doc.mode ?? 'rgb';

/** Which conversions are available from the current mode (Bitmap and
 * Duotone only from Grayscale; Indexed from RGB/Gray). */
export function modeEnabled(doc: PhotoDocument, target: ColorMode): boolean {
  const m = modeOf(doc);
  if (m === target) return target === 'duotone' || target === 'indexed';
  if (m === 'bitmap') return target === 'grayscale';
  if (m === 'multichannel') return ['rgb', 'grayscale', 'cmyk', 'lab'].includes(target);
  if (target === 'multichannel') return ['rgb', 'cmyk', 'grayscale', 'duotone'].includes(m);
  if (target === 'bitmap') return m === 'grayscale';
  if (target === 'duotone') return m === 'grayscale';
  if (target === 'indexed') return m === 'rgb' || m === 'grayscale' || m === 'duotone';
  return true;
}

function inks(doc: PhotoDocument): DuotoneInk[] {
  return (doc.modeData?.inks ?? []).map((i) => ({ name: i.name, color: hexRgb(i.color), curve: i.curve }));
}
const hexRgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)) as [number, number, number];
const then = (a: PixelMap | null, b: PixelMap | null): PixelMap | null => (a && b ? (img) => b(a(img)) : a ?? b);

function clearModeData(d: PhotoDocument) {
  delete d.modeData;
}

/** Run a mode conversion command. */
export async function convertToMode(e: Editor, target: ColorMode) {
  if (!e.hasDocument || !requireEightBit(e)) return;
  const doc = e.doc;
  const from = modeOf(doc);
  if (!modeEnabled(doc, target)) {
    e.message(target === 'bitmap' || target === 'duotone' ? `Convert to Grayscale before converting to ${MODE_NAMES[target]}.` : `${MODE_NAMES[target]} is not available from ${MODE_NAMES[from]}.`);
    return;
  }
  const s = colorSettings();
  const dp = docProfile(doc);
  // Leaving Duotone renders the inks into the pixels first (except to Gray).
  const bake = from === 'duotone' && target !== 'grayscale' && target !== 'duotone' ? duotoneMap(dp, docGrayProfile(doc), inks(doc)) : null;
  const done = (text: string) => e.message(text);
  // Leaving Multichannel starts from the shown composite of the inks.
  const leave = (d: PhotoDocument) => {
    if (from === 'multichannel') leaveMultichannel(d);
  };
  switch (target) {
    case 'rgb': {
      const r = await mapDocument(e, 'Convert to RGB Color', bake ?? ((img) => img), bake ? 'constrain' : 'convert', (d) => {
        leave(d);
        delete d.mode;
        clearModeData(d);
      });
      return done(`Converted to RGB Color.${bake ? reportText(r) : ''}`);
    }
    case 'grayscale': {
      const grayRef = s.gray;
      const gray = docGrayProfile({ ...doc, mode: 'grayscale', modeData: { profile: grayRef } });
      const map = from === 'duotone' || from === 'bitmap' ? null : grayMap(dp, gray, s.intent, s.bpc);
      e.message('Converting to Grayscale…');
      const r = await mapDocument(e, 'Convert to Grayscale', map ?? ((img) => img), 'constrain', (d) => {
        leave(d);
        d.mode = 'grayscale';
        d.modeData = { profile: storedRef(grayRef) };
      });
      return done(`Converted to Grayscale (${gray.name}).${reportText(r)}`);
    }
    case 'cmyk': {
      e.message('Preparing the CMYK profile…');
      const cmyk = await ensureProfile(s.cmyk);
      assertSameDocument(e, doc);
      if (cmyk.colorSpace !== 'CMYK') return done('The working CMYK profile is not a CMYK profile; check Edit > Color Settings.');
      const map = then(bake, cmykMap(dp, cmyk, s.intent, s.bpc))!;
      const r = await mapDocument(e, 'Convert to CMYK Color', map, 'constrain', (d) => {
        leave(d);
        d.mode = 'cmyk';
        d.modeData = { profile: storedRef(s.cmyk) };
      });
      return done(`Converted to CMYK Color (${cmyk.name}). Colors are limited to what this press condition can print.${reportText(r)}`);
    }
    case 'lab': {
      const map = then(bake, labMap(dp, builtinProfile('lab-d50'), 'relative'))!;
      const r = await mapDocument(e, 'Convert to Lab Color', map, 'constrain', (d) => {
        leave(d);
        d.mode = 'lab';
        clearModeData(d);
      });
      return done(`Converted to Lab Color.${reportText(r)}`);
    }
    case 'indexed':
      return indexedDialog(e, bake);
    case 'bitmap':
      return bitmapDialog(e);
    case 'duotone':
      return duotoneDialog(e);
    case 'multichannel':
      return convertToMultichannel(e);
  }
}

// ----- Indexed -----
const PALETTES: [PaletteKind | 'previous', string][] = [
  ['exact', 'Exact'], ['web', 'Web'], ['uniform', 'Uniform'], ['adaptive', 'Local (Adaptive)'], ['perceptual', 'Local (Perceptual)'], ['previous', 'Previous'],
];
let lastIndexed = { palette: 'adaptive', colors: 256, forced: 'blackwhite', transparency: 'yes', matte: 'white', dither: 'diffusion', amount: 75 };
async function indexedDialog(e: Editor, bake: PixelMap | null) {
  const doc = e.doc;
  const previous = doc.modeData?.palette;
  const v = await formDialog('Indexed Color', [
    { name: 'palette', label: 'Palette', value: lastIndexed.palette, type: 'select', options: PALETTES.filter(([k]) => k !== 'previous' || previous).map(([k, l]) => [k, l]) },
    { name: 'colors', label: 'Colors', value: lastIndexed.colors, type: 'number', min: 2, max: 256, step: 1 },
    { name: 'forced', label: 'Forced colors', value: lastIndexed.forced, type: 'select', options: [['none', 'None'], ['blackwhite', 'Black and White'], ['primaries', 'Primaries'], ['web', 'Web']] },
    { name: 'transparency', label: 'Transparency', value: lastIndexed.transparency, type: 'checkbox' },
    { name: 'matte', label: 'Matte', value: lastIndexed.matte, type: 'select', options: [['white', 'White'], ['black', 'Black'], ['foreground', 'Foreground color'], ['background', 'Background color']] },
    { name: 'dither', label: 'Dither', value: lastIndexed.dither, type: 'select', options: [['none', 'None'], ['diffusion', 'Diffusion'], ['pattern', 'Pattern'], ['noise', 'Noise']] },
    { name: 'amount', label: 'Dither amount (%)', value: lastIndexed.amount, type: 'number', min: 0, max: 100, step: 1 },
  ], 'OK', 'The image is flattened into one layer whose colors all come from the palette. Exact uses the image colors when there are few enough.');
  if (!v) return;
  lastIndexed = { palette: v.palette, colors: Number(v.colors), forced: v.forced, transparency: v.transparency, matte: v.matte, dither: v.dither, amount: Number(v.amount) };
  const matte = v.matte === 'black' ? [0, 0, 0] : v.matte === 'foreground' ? hexRgb(e.color) : v.matte === 'background' ? hexRgb(e.background) : [255, 255, 255];
  const opts: IndexedOptions = {
    palette: v.palette === 'previous' ? 'custom' : (v.palette as PaletteKind),
    customPalette: v.palette === 'previous' ? previous!.map(hexRgb) : undefined,
    colors: Math.max(2, Math.min(256, Math.round(Number(v.colors)) || 256)),
    forced: v.forced as ForcedColors,
    transparency: v.transparency === 'yes',
    matte: matte as [number, number, number],
    dither: v.dither as DitherKind,
    ditherAmount: Math.max(0, Math.min(100, Number(v.amount))),
    seed: 1,
  };
  let img = await flatComposite(e);
  assertSameDocument(e, doc);
  if (bake) img = bake(img);
  const res = toIndexed(img, opts);
  const rgba = indexedToRGBA(res);
  const palette: string[] = [];
  for (let i = 0; i < res.colors; i++) palette.push(toHex([res.palette[i * 3], res.palette[i * 3 + 1], res.palette[i * 3 + 2]]));
  flattenTo(e, 'Convert to Indexed Color', 'Index', rgba, (d) => {
    d.mode = 'indexed';
    d.modeData = { palette, transparentIndex: res.transparentIndex };
  });
  e.message(`Converted to Indexed Color: ${res.colors - (res.transparentIndex >= 0 ? 1 : 0)} colors${res.transparentIndex >= 0 ? ' plus transparency' : ''}.`);
}

/** Image > Mode > Color Table: edit palette entries; pixels follow. */
export async function colorTableDialog(e: Editor) {
  const doc = e.doc;
  const palette = doc.modeData?.palette;
  if (doc.mode !== 'indexed' || !palette) return;
  const tIndex = doc.modeData?.transparentIndex ?? -1;
  const next = [...palette];
  const dialog = document.createElement('dialog');
  dialog.className = 'color-table-dialog';
  const render = () =>
    next
      .map((c, i) => `<button type="button" class="ct-swatch ${i === tIndex ? 'transparent' : ''}" data-i="${i}" style="--swatch:${c}" title="${i === tIndex ? 'Transparent entry' : `${i}: ${c}`}" aria-label="Palette entry ${i} ${i === tIndex ? 'transparent' : c}" ${i === tIndex ? 'disabled' : ''}></button>`)
      .join('');
  dialog.innerHTML = `<form method="dialog"><h2>Color Table</h2><p>${palette.length} entries. Click an entry to change it; pixels using that entry change with it.</p><div class="ct-grid">${render()}</div><div class="dialog-actions"><button type="button" class="ct-cancel">Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  e.root.append(dialog);
  const ok = await new Promise<boolean>((resolve) => {
    dialog.querySelector('.ct-grid')!.addEventListener('click', async (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-i]');
      if (!b) return;
      const i = Number(b.dataset.i);
      const c = await pickColor(e, next[i], `Color Table Entry ${i}`);
      if (c) {
        next[i] = c;
        b.style.setProperty('--swatch', c);
        b.title = `${i}: ${c}`;
        b.setAttribute('aria-label', `Palette entry ${i} ${c}`);
      }
    });
    dialog.querySelector('.ct-cancel')!.addEventListener('click', () => resolve(false));
    dialog.addEventListener('cancel', () => resolve(false));
    dialog.querySelector('form')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      resolve(true);
    });
    dialog.showModal();
  });
  dialog.close();
  dialog.remove();
  if (!ok || next.every((c, i) => c === palette[i])) return;
  // Exact-match remap: indexed pixels are palette colors by construction.
  const remap = new Map<number, number>();
  next.forEach((c, i) => {
    if (c !== palette[i]) remap.set(parseInt(palette[i].slice(1), 16), parseInt(c.slice(1), 16));
  });
  const map: PixelMap = (img) => {
    const out = new Uint8ClampedArray(img.data);
    for (let i = 0; i < out.length; i += 4) {
      if (!out[i + 3]) continue;
      const to = remap.get((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
      if (to === undefined) continue;
      out[i] = to >> 16;
      out[i + 1] = (to >> 8) & 255;
      out[i + 2] = to & 255;
    }
    return { width: img.width, height: img.height, data: out };
  };
  await mapDocument(e, 'Color Table', map, 'convert', (d) => {
    d.modeData = { ...d.modeData, palette: next };
  });
}

// ----- Bitmap -----
let lastBitmap = { resolution: 0, method: 'diffusion', frequency: 53, angle: 45, shape: 'round' };
async function bitmapDialog(e: Editor) {
  const doc = e.doc;
  const inRes = doc.resolution ? (doc.resolution.horizontalResolutionUnit === 'PPCM' ? doc.resolution.horizontalResolution * 2.54 : doc.resolution.horizontalResolution) : 72;
  const v = await formDialog('Bitmap', [
    { name: 'resolution', label: `Output resolution (pixels/inch; input ${Math.round(inRes)})`, value: lastBitmap.resolution || Math.round(inRes), type: 'number', min: 1, max: 4000 },
    { name: 'method', label: 'Method', value: lastBitmap.method, type: 'select', options: [['threshold', '50% Threshold'], ['pattern', 'Pattern Dither'], ['diffusion', 'Diffusion Dither'], ['halftone', 'Halftone Screen']] },
    { name: 'frequency', label: 'Halftone frequency (lines/inch)', value: lastBitmap.frequency, type: 'number', min: 1, max: 999 },
    { name: 'angle', label: 'Halftone angle (degrees)', value: lastBitmap.angle, type: 'number', min: -180, max: 180 },
    { name: 'shape', label: 'Halftone shape', value: lastBitmap.shape, type: 'select', options: [['round', 'Round'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['square', 'Square'], ['cross', 'Cross'], ['diamond', 'Diamond']] },
  ], 'OK', 'The image is flattened into black and white pixels. Halftone settings apply to the halftone screen method.');
  if (!v) return;
  const outRes = Math.max(1, Number(v.resolution) || inRes);
  lastBitmap = { resolution: outRes, method: v.method, frequency: Number(v.frequency) || 53, angle: Number(v.angle) || 0, shape: v.shape };
  const w2 = Math.max(1, Math.round((doc.width * outRes) / inRes)),
    h2 = Math.max(1, Math.round((doc.height * outRes) / inRes));
  if (w2 > 8192 || h2 > 8192 || w2 * h2 > 24_000_000) {
    e.message(`At ${outRes} pixels/inch the image would be ${w2} × ${h2} px, above the 8192 px / 24 megapixel limit. Choose a lower output resolution.`);
    return;
  }
  const opts: BitmapOptions = {
    method: v.method as BitmapMethod,
    inputResolution: inRes,
    outputResolution: outRes,
    frequency: lastBitmap.frequency,
    angle: lastBitmap.angle,
    shape: v.shape as HalftoneShape,
  };
  const img = await flatComposite(e);
  assertSameDocument(e, doc);
  const res = convertMode(img, 'rgb', 'bitmap', { docProfile: docProfile(doc), grayProfile: docGrayProfile(doc), bitmap: opts });
  if (res.mode !== 'bitmap') return;
  const data = new Uint8ClampedArray(res.width * res.height * 4);
  for (let p = 0; p < res.bits.length; p++) {
    const c = res.bits[p] ? 0 : 255;
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = c;
    data[p * 4 + 3] = 255;
  }
  flattenTo(e, 'Convert to Bitmap', 'Bitmap', { width: res.width, height: res.height, data }, (d) => {
    // Guides, paths, annotations and slices follow the new pixel size.
    const sx = res.width / d.width,
      sy = res.height / d.height;
    mapDocumentGeometry(d, (x, y) => [x * sx, y * sy]);
    d.width = res.width;
    d.height = res.height;
    d.mode = 'bitmap';
    d.modeData = { bitmap: { method: opts.method!, resolution: outRes, frequency: opts.frequency, angle: opts.angle, shape: opts.shape } };
    d.resolution = { ...(d.resolution ?? { horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolutionUnit: 'PPI', heightUnit: 'Inches' }), horizontalResolution: outRes, verticalResolution: outRes, horizontalResolutionUnit: 'PPI', verticalResolutionUnit: 'PPI' } as PhotoDocument['resolution'];
  });
  e.fit();
  e.message(`Converted to Bitmap at ${outRes} pixels/inch (${res.width} × ${res.height} px).`);
}

// ----- Duotone -----
const DUO_TYPES = ['Monotone', 'Duotone', 'Tritone', 'Quadtone'];
const DEFAULT_INKS: DuotoneInkSpec[] = [
  { name: 'Black', color: '#000000' },
  { name: 'Warm Brown', color: '#8a5a2b', curve: [[0, 0], [50, 35], [100, 75]] },
  { name: 'Slate Blue', color: '#4a6a8f', curve: [[0, 0], [50, 25], [100, 55]] },
  { name: 'Sand', color: '#d9c48f', curve: [[0, 0], [50, 30], [100, 50]] },
];
const curveText = (c?: [number, number][]) => (c?.length ? c : [[0, 0], [100, 100]]).map(([x, y]) => `${x}:${y}`).join(' ');
function parseCurve(text: string): [number, number][] | null {
  const pts = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((p) => p.split(':').map(Number));
  if (pts.length < 2 || pts.length > 16 || pts.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 100))) return null;
  return pts as [number, number][];
}
function curvePath(curve: [number, number][]) {
  const t = curveTable(curve, 51);
  return 'M' + Array.from(t, (v, i) => `${i * 2} ${100 - v * 100}`).join(' L');
}
async function duotoneDialog(e: Editor) {
  const doc = e.doc;
  const editing = doc.mode === 'duotone';
  let list: DuotoneInkSpec[] = editing && doc.modeData?.inks?.length ? doc.modeData.inks.map((i) => ({ ...i })) : [{ ...DEFAULT_INKS[0] }, { ...DEFAULT_INKS[1] }];
  const dialog = document.createElement('dialog');
  dialog.className = 'duotone-dialog';
  e.root.append(dialog);
  const grayRef = editing ? (doc.modeData?.profile ?? colorSettings().gray) : (doc.modeData?.profile ?? colorSettings().gray);
  const previewDoc = (): PhotoDocument => ({ ...doc, mode: 'duotone', modeData: { profile: grayRef, inks: list } });
  const preview = () => {
    try {
      e.renderer.setDisplayLut(displayLut(previewDoc(), proofState(e.session)));
      e.preview(doc);
    } catch {
      /* Preview is best effort. */
    }
  };
  const render = () => {
    dialog.innerHTML = `<form method="dialog"><h2>Duotone Options</h2>
      <label class="dialog-field">Type<select class="duo-type">${DUO_TYPES.map((t, i) => `<option value="${i + 1}" ${i + 1 === list.length ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${list
        .map(
          (ink, i) => `<div class="duo-ink" data-i="${i}">
        <svg class="duo-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${curvePath(parseCurve(curveText(ink.curve)) ?? [[0, 0], [100, 100]])}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
        <button type="button" class="duo-color" style="--swatch:${ink.color}" aria-label="Ink ${i + 1} color ${ink.color}" title="Ink color"></button>
        <label>Ink ${i + 1}<input class="duo-name" value="${escapeXML(ink.name)}" maxlength="64" aria-label="Ink ${i + 1} name"></label>
        <label>Curve (tone%:ink%)<input class="duo-curve-text" value="${curveText(ink.curve)}" aria-label="Ink ${i + 1} curve" spellcheck="false"></label>
      </div>`,
        )
        .join('')}
      <p>Inks overprint in order; a straight curve prints the ink in proportion to the gray tone. The preview updates on the canvas.</p>
      <div class="dialog-actions"><button type="button" class="duo-cancel">Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  };
  render();
  preview();
  const ok = await new Promise<boolean>((resolve) => {
    dialog.addEventListener('change', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.matches('.duo-type')) {
        const n = Number((t as HTMLSelectElement).value);
        list = list.slice(0, n);
        while (list.length < n) list.push({ ...DEFAULT_INKS[list.length] });
        render();
        // The form was rebuilt: keep the keyboard on the Type field.
        dialog.querySelector<HTMLSelectElement>('.duo-type')?.focus();
        preview();
      }
    });
    dialog.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      const row = t.closest<HTMLElement>('.duo-ink');
      if (!row) return;
      const ink = list[Number(row.dataset.i)];
      if (t.matches('.duo-name')) ink.name = t.value || `Ink ${Number(row.dataset.i) + 1}`;
      if (t.matches('.duo-curve-text')) {
        const c = parseCurve(t.value);
        t.setCustomValidity(c ? '' : 'Use 2-16 points like 0:0 50:40 100:100 (values 0-100).');
        if (c) {
          ink.curve = c;
          row.querySelector('path')!.setAttribute('d', curvePath(c));
          preview();
        }
      }
    });
    dialog.addEventListener('click', async (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.duo-color');
      if (!b) return;
      const i = Number(b.closest<HTMLElement>('.duo-ink')!.dataset.i);
      const c = await pickColor(e, list[i].color, `Ink ${i + 1} Color`);
      if (c) {
        list[i].color = c;
        b.style.setProperty('--swatch', c);
        preview();
      }
    });
    dialog.addEventListener('cancel', () => resolve(false));
    dialog.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).matches('.duo-cancel')) resolve(false);
    });
    dialog.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!(ev.target as HTMLFormElement).reportValidity()) return;
      resolve(true);
    });
    dialog.showModal();
  });
  dialog.close();
  dialog.remove();
  // Hand the display back to the regular sync (re-applied on update).
  e.renderer.setDisplayLut(null);
  resetDisplay();
  if (!ok) {
    e.update();
    return;
  }
  const inksOut = list.map((i) => ({ name: i.name.slice(0, 64), color: i.color, ...(i.curve ? { curve: i.curve } : {}) }));
  e.command(editing ? 'Duotone Options' : 'Convert to Duotone', (d) => {
    d.mode = 'duotone';
    d.modeData = { profile: storedRef(grayRef), inks: inksOut };
  });
  e.message(`${DUO_TYPES[inksOut.length - 1]} with ${inksOut.map((i) => i.name).join(', ')}.`);
}

// ----- Painting colors follow the mode -----
let grayCache: { key: string; levels: (hex: string) => string } | undefined;
/** Constrain a painting color to the document's mode (gray, black/white or
 * the palette), so tools add only colors the mode can hold. */
export function constrainColor(doc: PhotoDocument, hex: string): string {
  const m = modeOf(doc);
  if (m === 'indexed' && doc.modeData?.palette?.length) return nearestPaletteHex(doc.modeData.palette, hex);
  if (m === 'grayscale' || m === 'duotone' || m === 'bitmap') {
    const dp = docProfile(doc),
      gp = docGrayProfile(doc);
    const key = `${dp.key}|${gp.key}`;
    if (grayCache?.key !== key) {
      const s = colorSettings();
      const map = grayMap(dp, gp, s.intent, s.bpc);
      grayCache = { key, levels: (h) => mapHex(map, h) };
    }
    const g = grayCache.levels(hex);
    if (m !== 'bitmap') return g;
    return parseInt(g.slice(1, 3), 16) < 128 ? '#000000' : '#ffffff';
  }
  return hex;
}
