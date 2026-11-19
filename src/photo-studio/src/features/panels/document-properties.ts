// Properties for the document (no layer, or the Background layer, selected):
// an editable canvas (size with units, link and anchor, orientation,
// resolution, mode, depth and background fill), rulers and grid, guides, and
// quick actions that run the existing Image commands.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import type { Layer } from '../../model/document';
import { coerceSetting, settingFor } from '../../model/preferences';
import { makeBackground } from '../../model/housekeeping';
import { newPixelLayer } from '../../model/pixel-layer';
import { setDocumentResolution } from '../../model/text-layer';
import { emptyGrid, TILE, writeRect, type TileGrid, type TileStore } from '../../model/tiles';
import { hexRgb } from '../pixels';
import { docPpi, resolutionInfo } from '../transform/dialog';
import { type LengthUnit } from '../transform/math';
import {
  commandButton,
  commandEnabled,
  commandToggle,
  field,
  fieldHandlers,
  section,
  select,
} from './property-fields';
import {
  canvasSizeProblem,
  clamp,
  formatLength,
  formatNumber,
  isLengthUnit,
  orientedSize,
  parseLength,
  parseNumber,
  plannedCanvasSize,
  UNIT_NAMES,
  UNIT_SUFFIX,
} from './property-values';

const MODES: [string, string][] = [
  ['rgb', 'RGB Color'],
  ['cmyk', 'CMYK Color'],
  ['lab', 'Lab Color'],
  ['grayscale', 'Grayscale'],
  ['indexed', 'Indexed Color…'],
  ['duotone', 'Duotone…'],
  ['bitmap', 'Bitmap…'],
  ['multichannel', 'Multichannel'],
];
const ANCHORS: [number, number, string][] = [
  [0, 0, 'top left'],
  [0.5, 0, 'top'],
  [1, 0, 'top right'],
  [0, 0.5, 'left'],
  [0.5, 0.5, 'center'],
  [1, 0.5, 'right'],
  [0, 1, 'bottom left'],
  [0.5, 1, 'bottom'],
  [1, 1, 'bottom right'],
];

// Panel state kept for the session: the canvas unit, link and anchor.
type CanvasState = { unit?: LengthUnit; linked?: boolean; anchor?: [number, number] };
const state = (e: Editor) => (e.settings.propertiesCanvas ??= {}) as CanvasState;
export const canvasUnit = (e: Editor): LengthUnit => {
  const u = state(e).unit ?? e.preferences.rulerUnits;
  return isLengthUnit(u) ? u : 'px';
};
export const canvasAnchor = (e: Editor): [number, number] => {
  const a = state(e).anchor;
  return a && [0, 0.5, 1].includes(a[0]) && [0, 0.5, 1].includes(a[1]) ? a : [0.5, 0.5];
};
const ctx = (e: Editor, key: 'width' | 'height') => ({
  unit: canvasUnit(e),
  ppi: docPpi(e.doc),
  base: e.doc[key],
});

// ----- Background fill -----

const uniform = new Map<string, string | null>();
/** The single opaque color of a pixel grid covering the canvas, or null when
 * it has transparency or more than one color. Cached by tile identity. */
export function uniformColor(
  store: TileStore,
  grid: TileGrid,
  width: number,
  height: number,
): string | null {
  const key = `${width}x${height}|${grid.x},${grid.y}|${Object.entries(grid.tiles)
    .map(([k, id]) => `${k}=${id}:${store.version(id)}`)
    .join(';')}`;
  const hit = uniform.get(key);
  if (hit !== undefined) return hit;
  const result = scanUniform(store, grid, width, height);
  if (uniform.size > 16) uniform.delete(uniform.keys().next().value!);
  uniform.set(key, result);
  return result;
}
function scanUniform(
  store: TileStore,
  grid: TileGrid,
  width: number,
  height: number,
): string | null {
  // Every tile overlapping the canvas must exist (absent tiles are transparent).
  const tx0 = Math.floor((0 - grid.x) / TILE),
    ty0 = Math.floor((0 - grid.y) / TILE),
    tx1 = Math.floor((width - 1 - grid.x) / TILE),
    ty1 = Math.floor((height - 1 - grid.y) / TILE);
  let color = -1;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const id = grid.tiles[`${tx},${ty}`];
      if (!id || !store.has(id)) return null;
      const d = store.get(id);
      const ox = grid.x + tx * TILE,
        oy = grid.y + ty * TILE;
      const x0 = Math.max(0, -ox),
        y0 = Math.max(0, -oy),
        x1 = Math.min(TILE, width - ox),
        y1 = Math.min(TILE, height - oy);
      for (let y = y0; y < y1; y++)
        for (let x = x0, i = (y * TILE + x0) * 4; x < x1; x++, i += 4) {
          if (d[i + 3] !== 255) return null;
          const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          if (color < 0) color = c;
          else if (c !== color) return null;
        }
    }
  return color < 0 ? null : `#${color.toString(16).padStart(6, '0')}`;
}
/** A canvas-sized pixel grid of one color, written in bands to bound memory. */
export function solidGrid(store: TileStore, width: number, height: number, hex: string): TileGrid {
  const [r, g, b] = hexRgb(hex);
  let grid = emptyGrid(4);
  for (let y = 0; y < height; y += TILE) {
    const h = Math.min(TILE, height - y);
    const data = new Uint8ClampedArray(width * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    grid = writeRect(store, grid, 0, y, { width, height: h, data });
  }
  return grid;
}

type Background = { layer?: Layer; color: string | null };
function background(e: Editor): Background {
  const l = e.doc.layers[0];
  if (!l?.background || l.kind !== 'pixel' || !l.pixels) return { color: null };
  return { layer: l, color: uniformColor(e.assets.tiles, l.pixels, e.doc.width, e.doc.height) };
}
const FILL_CHOICES = (e: Editor): [string, string, string][] => [
  ['white', 'White', '#ffffff'],
  ['black', 'Black', '#000000'],
  ['background', 'Background Color', e.background],
  ['foreground', 'Foreground Color', e.color],
];
function fillMarkup(e: Editor) {
  if (e.doc.layers.some((l) => l.artboard))
    return '<p class="pf-note">Each artboard sets its own background.</p>';
  const bg = background(e);
  const choices = FILL_CHOICES(e);
  if (bg.layer && !bg.color)
    return `<div class="pf-fill">${select('fill', 'Background fill', [['image', 'Background layer']], 'image', { disabled: true, title: 'The Background layer has image content; paint on it or convert it to a layer to change it.' })}</div>`;
  const current = !bg.layer
    ? 'transparent'
    : (choices.find(([, , hex]) => hex.toLowerCase() === bg.color)?.[0] ?? 'custom');
  return `<div class="pf-fill">${select(
    'fill',
    'Background fill',
    [
      ['transparent', 'Transparent'],
      ...choices.map(([v, label]): [string, string] => [v, label]),
      ['custom', 'Custom Color'],
    ],
    current,
  )}<input type="color" class="pf-swatch" data-pf="fill-color" aria-label="Background fill color" title="Background fill color" value="${bg.color ?? '#ffffff'}"></div>`;
}
/** Paint the Background layer one color, add one, or remove a plain one. */
export function setBackgroundFill(e: Editor, hex: string | null) {
  const bg = background(e);
  if (bg.layer && !bg.color) return;
  if (!hex) {
    if (bg.layer) e.command('Transparent Background', (d) => void d.layers.splice(0, 1));
    return;
  }
  if (bg.color === hex.toLowerCase()) return;
  const grid = solidGrid(e.assets.tiles, e.doc.width, e.doc.height, hex);
  e.command(bg.layer ? 'Background Fill' : 'New Background', (d) => {
    if (bg.layer) {
      const l = d.layers[0];
      l.pixels = grid;
      return;
    }
    const l = newPixelLayer('Background', d, grid);
    makeBackground(l);
    d.layers.unshift(l);
  });
}

// ----- Markup -----

function canvasSection(e: Editor, locked: boolean) {
  const doc = e.doc;
  const unit = canvasUnit(e);
  const linked = !!state(e).linked;
  const [ax, ay] = canvasAnchor(e);
  const ppi = docPpi(doc);
  const ppcm = doc.resolution?.horizontalResolutionUnit === 'PPCM';
  const mode = doc.mode ?? 'rgb';
  const depth = String(doc.bitsPerChannel ?? 8);
  const cmdOn = (id: string) => commandEnabled(e, id);
  const size = (key: 'width' | 'height', label: string, name: string) =>
    field({
      key: `doc.${key}`,
      label,
      name,
      value: formatLength(doc[key], ctx(e, key)),
      suffix: UNIT_SUFFIX[unit],
      disabled: locked,
      step: unit === 'px' || unit === 'percent' ? 1 : 0.1,
    });
  const portrait = doc.height > doc.width;
  const body = `<div class="pf-canvas">
<button type="button" class="icon-button toggle pf-link" data-pf-link="doc" aria-pressed="${linked}" title="${linked ? 'Width and height keep their proportions (click to unlink)' : 'Link width and height to keep proportions'}" aria-label="Link canvas width and height" ${locked ? 'disabled' : ''}>${svg(linked ? 'link' : 'unlink', 14)}</button>
${size('width', 'W', 'Canvas width')}${select(
    'unit',
    'Canvas units',
    UNIT_NAMES.map(([u, n]) => [u, n]),
    unit,
    { hideLabel: true },
  )}
${size('height', 'H', 'Canvas height')}<div class="pf-orient" role="group" aria-label="Orientation"><button type="button" class="icon-button" data-pf-orient="portrait" aria-pressed="${portrait}" title="Portrait: make the canvas taller than wide" aria-label="Portrait" ${locked || doc.width === doc.height ? 'disabled' : ''}>${svg('orientation-portrait', 15)}</button><button type="button" class="icon-button" data-pf-orient="landscape" aria-pressed="${doc.width > doc.height}" title="Landscape: make the canvas wider than tall" aria-label="Landscape" ${locked || doc.width === doc.height ? 'disabled' : ''}>${svg('orientation-landscape', 15)}</button></div>
</div>
<div class="pf-anchor-row"><span id="pf-anchor-label">Anchor</span><div class="pf-anchor" role="radiogroup" aria-labelledby="pf-anchor-label">${ANCHORS.map(([x, y, name]) => `<button type="button" role="radio" data-pf-anchor="${x},${y}" aria-checked="${x === ax && y === ay}" tabindex="${x === ax && y === ay ? 0 : -1}" title="Grow or shrink from the ${name}" aria-label="${name}"></button>`).join('')}</div><span class="pf-note">Size changes grow or shrink the canvas from the anchor.</span></div>
<div class="pf-res">${field({ key: 'doc.resolution', label: 'Resolution', value: formatNumber(ppcm ? ppi / 2.54 : ppi, 2), name: 'Resolution', disabled: locked, title: 'Changes the print size; pixels stay as they are' })}${select(
    'resolution-unit',
    'Resolution unit',
    [
      ['PPI', 'Pixels/Inch'],
      ['PPCM', 'Pixels/Centimeter'],
    ],
    ppcm ? 'PPCM' : 'PPI',
    { hideLabel: true, disabled: locked },
  )}</div>
${select(
  'mode',
  'Mode',
  MODES.map(([m, label]) => [m, label, m !== mode && !cmdOn(`image.mode-${m}`)]),
  mode,
  { disabled: locked },
)}
${select(
  'depth',
  'Bit depth',
  [
    ['8', '8 Bits/Channel', !cmdOn('image.depth-8')],
    ['16', '16 Bits/Channel', !cmdOn('image.depth-16')],
    ['32', '32 Bits/Channel', !cmdOn('image.depth-32')],
  ],
  depth,
  { disabled: locked },
)}
${fillMarkup(e)}`;
  return section('doc-canvas', 'Canvas', body);
}
function prefSelect(e: Editor, key: string, label: string, hideLabel = false) {
  const def = settingFor(key);
  if (!def || def.type !== 'choice') return '';
  return select(
    `pref.${key}`,
    label,
    def.options.map(([v, n]) => [String(v), n]),
    String((e.preferences as Record<string, unknown>)[key]),
    { hideLabel },
  );
}
const prefColor = (e: Editor, key: string, label: string) =>
  `<label class="pf-color"><span>${label}</span><input type="color" class="pf-swatch" data-pf="pref.${key}" aria-label="${label}" value="${escapeXML(String((e.preferences as Record<string, unknown>)[key]))}"></label>`;
function rulersSection(e: Editor) {
  const p = e.preferences;
  const body = `<div class="pf-checks">${commandToggle(e, 'view.rulers', 'Rulers')}${commandToggle(e, 'view.show-grid', 'Grid')}${commandToggle(e, 'view.snap-grid', 'Snap to grid')}</div>
${prefSelect(e, 'rulerUnits', 'Units')}
<div class="pf-pair">${prefColor(e, 'gridColor', 'Grid color')}${prefSelect(e, 'gridStyle', 'Grid style', true)}</div>
<div class="pf-pair">${field({ key: 'pref.gridEvery', label: 'Every', name: 'Gridline every', value: formatNumber(p.gridEvery, 2), step: 1 })}${prefSelect(e, 'gridUnit', 'Gridline units', true)}</div>
${field({ key: 'pref.gridSubdivisions', label: 'Subdivisions', value: String(p.gridSubdivisions), step: 1 })}`;
  return section('doc-rulers', 'Rulers & Grid', body);
}
function guidesSection(e: Editor) {
  const doc = e.doc;
  const artboards = doc.layers.filter((l) => l.artboard);
  const canvasCount = doc.guides?.length ?? 0;
  const artboardCount = artboards.reduce((n, l) => n + (l.artboard?.guides?.length ?? 0), 0);
  const count = canvasCount + artboardCount;
  const body = `<div class="pf-checks">${commandToggle(e, 'view.show-guides', 'Guides')}${commandToggle(e, 'view.guides-lock', 'Lock guides')}${commandToggle(e, 'view.snap-guides', 'Snap to guides')}${artboards.length ? `${commandToggle(e, 'view.show-canvas-guides', 'Canvas guides')}${commandToggle(e, 'view.show-artboard-guides', 'Artboard guides')}` : ''}</div>
<div class="pf-pair">${prefColor(e, 'guideColor', 'Guide color')}${prefSelect(e, 'guideStyle', 'Guide style', true)}</div>
<p class="pf-note" aria-live="polite">${count ? `${count} guide${count === 1 ? '' : 's'}${artboardCount ? ` (${artboardCount} on artboards)` : ''}` : 'No guides yet. Drag from a ruler or add one here.'}</p>
<div class="pf-actions">${commandButton(e, 'view.guides-new', 'New Guide…', 'plus')}${commandButton(e, 'view.guides-layout', 'New Guide Layout…', 'layout-grid')}${commandButton(e, 'view.guides-from-shape', 'Guides From Shape', 'shapes')}${commandButton(e, 'view.guides-clear', 'Clear Guides', 'trash-2')}</div>`;
  return section('doc-guides', 'Guides', body);
}
/** The layer Remove Background works on from the document view. */
function backgroundTarget(e: Editor): Layer | undefined {
  const pixel = e.doc.layers.filter((l) => l.kind === 'pixel' || l.kind === 'image');
  return e.doc.layers[0]?.background ? e.doc.layers[0] : pixel.length === 1 ? pixel[0] : undefined;
}
function quickActions(e: Editor) {
  const target = backgroundTarget(e);
  const body = `<div class="pf-actions">
<button type="button" class="pf-action" data-pf-action="remove-background" title="Remove the background of ${target ? escapeXML(target.name) : 'the image'}" ${target && commandEnabled(e, 'select.subject') ? '' : 'disabled'}>${svg('eraser-background', 14)}<span>Remove Background</span></button>
${commandButton(e, 'image.trim', 'Trim', 'scissors', { title: 'Trim transparent pixels from the edges' })}
${commandButton(e, 'image.image-size', 'Image Size…', 'scaling')}
${commandButton(e, 'image.canvas-size', 'Canvas Size…', 'expand')}
${commandButton(e, 'image.crop', 'Crop to Selection', 'crop', { title: e.doc.selection ? 'Crop the canvas to the selection' : 'Make a selection to crop to it' })}
${commandButton(e, 'image.reveal-all', 'Reveal All', 'fullscreen', { title: 'Enlarge the canvas to show every layer' })}
${commandButton(e, 'image.rotate-ccw', 'Rotate Left', 'rotate-ccw', { title: 'Rotate the canvas 90° counterclockwise' })}
${commandButton(e, 'image.rotate-cw', 'Rotate Right', 'rotate-cw', { title: 'Rotate the canvas 90° clockwise' })}
${commandButton(e, 'image.flip-horizontal', 'Flip Horizontal', 'flip-horizontal-2', { title: 'Flip the canvas horizontally' })}
${commandButton(e, 'image.flip-vertical', 'Flip Vertical', 'flip-vertical-2', { title: 'Flip the canvas vertically' })}
</div>`;
  return section('doc-actions', 'Quick Actions', body);
}

/** Properties markup for the document; `background` is the selected
 * Background layer, shown as a short layer section on top. */
export function documentProperties(e: Editor, backgroundLayer?: Layer): string {
  const doc = e.displayDoc;
  const busy = !!e.transform.document || !!e.modal;
  const layerPart = backgroundLayer
    ? section(
        'doc-background-layer',
        'Background Layer',
        `<p class="pf-note">The Background layer is locked in place. Convert it to a layer to move it, mask it or make it transparent.</p><div class="pf-actions">${commandButton(e, 'layer.from-background', 'Convert to Layer', 'layers')}${commandButton(e, 'select.subject', 'Select Subject', 'scan-face')}</div>`,
      )
    : '';
  return `<div class="property-body document-properties"><div class="pf-title">${svg('file-image', 14)}<span class="eyebrow">DOCUMENT</span></div><h3 class="pf-docname" title="${escapeXML(doc.name)}">${escapeXML(doc.name)}</h3>
${layerPart}${canvasSection(e, busy)}${rulersSection(e)}${guidesSection(e)}${quickActions(e)}</div>`;
}

// ----- Behavior -----

async function resizeTo(e: Editor, size: { width: number; height: number }) {
  const problem = canvasSizeProblem(size.width, size.height);
  if (problem) return problem;
  await e.runCommand('image.canvas-size', {
    params: {
      width: size.width,
      height: size.height,
      anchor: canvasAnchor(e),
      color: 'background',
    },
  });
}
fieldHandlers.set('doc', {
  commit: async (e, key, text) => {
    const doc = e.doc;
    if (key === 'doc.width' || key === 'doc.height') {
      const k = key === 'doc.width' ? 'width' : 'height';
      const px = parseLength(text, ctx(e, k));
      if (px === undefined) return `Enter a ${k} such as 1200, 4 in or 50%.`;
      const size = plannedCanvasSize(doc, k, px, !!state(e).linked);
      if (!size) return void e.update();
      return resizeTo(e, size);
    }
    if (key === 'doc.resolution') {
      const ppcm = doc.resolution?.horizontalResolutionUnit === 'PPCM';
      const v = parseNumber(text, ['ppi', 'ppcm']);
      if (v === undefined || v <= 0) return 'Enter a resolution greater than 0.';
      const ppi = clamp(ppcm ? v * 2.54 : v, 1, 10000);
      if (Math.abs(ppi - docPpi(doc)) < 1e-9) return;
      e.command('Resolution', (d) =>
        setDocumentResolution(d, resolutionInfo(d, ppi, ppcm ? 'PPCM' : 'PPI')),
      );
    }
  },
});
fieldHandlers.set('pref', {
  commit: (e, key, text) => {
    const k = key.slice(5);
    const def = settingFor(k);
    if (!def) return;
    const n = parseNumber(text);
    const v = n === undefined ? undefined : coerceSetting(def, n);
    if (v === undefined) return 'Enter a number.';
    (e.preferences as Record<string, unknown>)[k] = v;
    e.preferencesChanged();
  },
});

/** Handle a change of a document control; true when it was one. */
export async function documentChange(
  e: Editor,
  t: HTMLInputElement | HTMLSelectElement,
): Promise<boolean> {
  const key = t.dataset.pf;
  if (!key) return false;
  const doc = e.doc;
  if (key === 'unit') {
    if (isLengthUnit(t.value)) state(e).unit = t.value;
    e.update();
  } else if (key === 'resolution-unit') {
    const unit = t.value === 'PPCM' ? 'PPCM' : 'PPI';
    if ((doc.resolution?.horizontalResolutionUnit ?? 'PPI') !== unit)
      e.command('Resolution Unit', (d) =>
        setDocumentResolution(d, resolutionInfo(d, docPpi(d), unit)),
      );
  } else if (key === 'mode') {
    if (t.value !== (doc.mode ?? 'rgb')) await e.runCommand(`image.mode-${t.value}`);
    e.update();
  } else if (key === 'depth') {
    if (Number(t.value) !== (doc.bitsPerChannel ?? 8)) await e.runCommand(`image.depth-${t.value}`);
    e.update();
  } else if (key === 'fill') {
    const choice = FILL_CHOICES(e).find(([v]) => v === t.value);
    if (t.value === 'transparent') setBackgroundFill(e, null);
    else if (choice) setBackgroundFill(e, choice[2]);
    else if (t.value === 'custom')
      t.parentElement?.parentElement
        ?.querySelector<HTMLInputElement>('[data-pf="fill-color"]')
        ?.click();
  } else if (key === 'fill-color') setBackgroundFill(e, t.value);
  else if (key.startsWith('pref.')) {
    const k = key.slice(5);
    const def = settingFor(k);
    const v = def && coerceSetting(def, t.value);
    if (v === undefined) return true;
    (e.preferences as Record<string, unknown>)[k] = v;
    e.preferencesChanged();
  } else return false;
  return true;
}

/** Handle a click on a document control; true when it was one. */
export function documentClick(e: Editor, target: HTMLElement): boolean {
  const link = target.closest<HTMLElement>('[data-pf-link="doc"]');
  if (link) {
    state(e).linked = !state(e).linked;
    e.update();
    return true;
  }
  const orient = target.closest<HTMLElement>('[data-pf-orient]')?.dataset.pfOrient as
    'portrait' | 'landscape' | undefined;
  if (orient) {
    const size = orientedSize(e.doc.width, e.doc.height, orient);
    if (size)
      void resizeTo(e, size).then((p) => {
        if (p) e.message(p);
      });
    return true;
  }
  const anchor = target.closest<HTMLElement>('[data-pf-anchor]');
  if (anchor) {
    const [x, y] = anchor.dataset.pfAnchor!.split(',').map(Number);
    state(e).anchor = [x, y];
    e.update();
    return true;
  }
  if (target.closest('[data-pf-action="remove-background"]')) {
    const l = backgroundTarget(e);
    if (!l) return true;
    void (async () => {
      // Remove Background works on a normal layer.
      if (l.background) {
        e.selectLayers([l.id]);
        await e.runCommand('layer.from-background');
      }
      e.selectLayers([l.id]);
      await e.runCommand('layer.remove-background');
    })();
    return true;
  }
  return false;
}

/** Arrow keys move the anchor like a radio group. */
export function documentKey(e: Editor, ev: KeyboardEvent): boolean {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-pf-anchor]');
  if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return false;
  ev.preventDefault();
  ev.stopPropagation();
  const [x, y] = canvasAnchor(e);
  const step = (v: number, d: number) => clamp(v + d * 0.5, 0, 1);
  const next: [number, number] =
    ev.key === 'ArrowLeft'
      ? [step(x, -1), y]
      : ev.key === 'ArrowRight'
        ? [step(x, 1), y]
        : ev.key === 'ArrowUp'
          ? [x, step(y, -1)]
          : [x, step(y, 1)];
  state(e).anchor = next;
  e.update();
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`#properties [data-pf-anchor="${next[0]},${next[1]}"]`)
      ?.focus(),
  );
  return true;
}
