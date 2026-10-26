// Image export: each page (or the current page or spread) drawn onto a canvas in light colors and saved as PNG.
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { saveBlob } from '../../../lib/download.js';
import { formatNumber } from '../../../lib/format.js';
import { fileUrl } from '../../../lib/files/index.js';
import { sheetSize } from '../../../lib/book/formats.js';
import { elementsOf } from '../../../lib/book/model.js';
import { paintSheet } from '../../../lib/book/raster.js';
import { flagEmoji } from '../../../lib/book/travel.js';
import { bookIcon, withIcon } from './icons.js';
import { countryShapes, countrySvg, mapSvg } from './travel-svg.js';
import { countText, statsText } from './stats.js';
import { printPages } from './print.js';
import { sheetName } from './rail.js';

const MAX_SIDE = 12_000;
const MAX_PIXELS = 100_000_000;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image_failed'));
    image.src = url;
  });
}

async function svgImage(svg, w, h) {
  svg.setAttribute('width', String(Math.max(1, Math.round(w))));
  svg.setAttribute('height', String(Math.max(1, Math.round(h))));
  const text = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try { return await loadImage(url); } finally { URL.revokeObjectURL(url); }
}

/** Loads what each element of a page draws: photos, SVG travel elements and icons, stats and flags. */
async function contents(page, { space, book, ctx, color, pxPerMm }) {
  const size = sheetSize(book, page.kind);
  const map = new Map();
  const colorOrNone = (name, fallback) => color(name ?? fallback) ?? 'transparent';
  await Promise.all(elementsOf(page).map(async (item) => {
    const w = item.w * size.w;
    const h = item.h * size.h;
    try {
      if (item.k === 'photo' && item.file && space.get('file', item.file)) {
        const image = await loadImage(await fileUrl(space, item.file));
        map.set(item.id, { image, w: image.naturalWidth, h: image.naturalHeight });
      } else if (item.k === 'icon') {
        const svg = bookIcon(item.icon, colorOrNone(item.color, 'ink'));
        if (svg) map.set(item.id, { image: await svgImage(svg, w * pxPerMm, h * pxPerMm) });
      } else if (['map', 'route', 'country'].includes(item.k)) {
        const args = { entries: ctx.entries, page, item, w, h, shapes: ctx.shapes, paint: (name, fallback) => colorOrNone(name, fallback) };
        const svg = item.k === 'country' ? countrySvg(args) : mapSvg({ ...args, route: item.k === 'route' });
        map.set(item.id, { image: await svgImage(svg, w * pxPerMm, h * pxPerMm) });
      } else if (item.k === 'stats') map.set(item.id, { text: statsText(ctx.stats, item.stat) });
      else if (item.k === 'flag') map.set(item.id, { text: flagEmoji(item.cc) });
    } catch { /* drawn without it */ }
  }));
  return map;
}

/** Draws one printed page (a single page, or half or all of a spread) to a PNG Blob. */
export async function pageImage({ space, book, target, dpi, ctx, palette }) {
  let pxPerMm = dpi / 25.4;
  const full = sheetSize(book, target.sheet.page.kind);
  const scale = Math.min(1, MAX_SIDE / (target.w * pxPerMm), MAX_SIDE / (target.h * pxPerMm), Math.sqrt(MAX_PIXELS / (target.w * target.h * pxPerMm * pxPerMm)));
  pxPerMm *= scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(target.w * pxPerMm);
  canvas.height = Math.round(target.h * pxPerMm);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  const color = (name) => (name === 'none' ? null : palette.get(name) ?? null);
  const loaded = await contents(target.sheet.page, { space, book, ctx, color, pxPerMm });
  if (target.half === 'right') context.translate(-(full.w / 2) * pxPerMm, 0);
  paintSheet(context, target.sheet.page, { size: full, pxPerMm, color, content: (item) => loaded.get(item.id), bg: book.bg ?? 'surface' });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas_failed'))), 'image/png'));
}

const fileBase = (title) => String(title || 'book').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'book';

/** The export dialog: this page or spread, or every page; 150 or 300 dpi. */
export function openImageExport({ space, book, shape, sheetIndex, ctx, palette, title }) {
  const state = { range: 'current', dpi: 150, split: false };
  const status = el('p.bk-muted', { role: 'status' });
  const radio = (name, items) => {
    const legendId = uid('bk-legend');
    return el('fieldset.bk-group', { 'aria-labelledby': legendId }, el('legend', { id: legendId }, t(`book.image.${name}`)),
      items.map((item) => el('label.check-field', {}, el('input', { type: 'radio', name: `${name}-${legendId}`, checked: state[name] === item.value, onchange: () => { state[name] = item.value; } }), el('span', {}, item.label))));
  };
  const go = withIcon(button(t('book.image.save'), { variant: 'primary', onclick: () => void run() }), 'download');
  const dialog = openModal({ title: t('book.image.title'), content: el('div.bk-print-options', {},
    radio('range', [{ value: 'current', label: t('book.image.current') }, { value: 'all', label: t('book.image.all') }]),
    radio('dpi', [{ value: 150, label: t('book.image.screen') }, { value: 300, label: t('book.image.printQuality') }]),
    el('label.check-field', {}, el('input', { type: 'checkbox', onchange: (event) => { state.split = event.target.checked; } }), el('span', {}, t('book.image.split'))),
    el('p.bk-muted', {}, t('book.image.hint')), status), actions: [button(t('ui.cancel'), { onclick: () => dialog.close() }), go] });

  async function run() {
    go.disabled = true;
    try {
      const shapes = await countryShapes();
      const renderCtx = { ...ctx(), shapes };
      const sheets = state.range === 'current' ? shape.sheets.filter((sheet) => sheet.index === sheetIndex) : shape.sheets;
      const targets = printPages(sheets, book, { spreads: !state.split });
      for (const [index, target] of targets.entries()) {
        status.textContent = t('book.image.progress', { done: formatNumber(index + 1), total: formatNumber(targets.length) });
        const blob = await pageImage({ space, book, target, dpi: state.dpi, ctx: renderCtx, palette });
        const part = target.half ? `-${target.half === 'left' ? target.sheet.numbers[0] : target.sheet.numbers[1]}` : '';
        saveBlob(blob, `${fileBase(title)}-${fileBase(sheetName(target.sheet))}${part}.png`);
      }
      toast(countText('book.image.saved', targets.length));
      dialog.close();
    } catch {
      status.textContent = t('book.image.failed');
      go.disabled = false;
    }
  }
}
