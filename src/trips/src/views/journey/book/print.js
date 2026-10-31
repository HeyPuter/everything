// Print to PDF: a same-origin blank frame stamped light holds only the printed pages (pages or spreads, optional
// bleed and crop marks), sized with `@page`, and prints itself; the app never prints behind it.
import tokensCss from '../../../styles/tokens.css?inline';
import bookCss from './book.css?inline';
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { withIcon } from './icons.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t, locale } from '../../../lib/i18n/index.js';
import { BLEED_MM, pageSize, sheetSize } from '../../../lib/book/formats.js';
import { createSheet } from './sheet.js';
import { countryShapes } from './travel-svg.js';
import { sheetName } from './rail.js';
import { countText } from './stats.js';

const MARK_MM = 8;
const OPTIONS_KEY = 'trips:book:print';
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isPrintKey = (event) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'p';

function readOptions() {
  try { const value = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function writeOptions(value) { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(value)); } catch { /* storage may be off */ } }

/** Printed pages for sheets: `[{sheet, page, half: 'left'|'right'|null, w, h}]` in mm of trim. */
export function printPages(sheets, book, { spreads = false } = {}) {
  const page = pageSize(book);
  const out = [];
  for (const sheet of sheets) {
    if (sheet.page.kind === 'spread' && !spreads) {
      out.push({ sheet, half: 'left', w: page.w, h: page.h }, { sheet, half: 'right', w: page.w, h: page.h });
    } else {
      const size = sheetSize(book, sheet.page.kind);
      out.push({ sheet, half: null, w: size.w, h: size.h });
    }
  }
  return out;
}

function marks(trimW, trimH, offset) {
  const nodes = [];
  const length = MARK_MM - 2;
  const corners = [[offset, offset], [offset + trimW, offset], [offset, offset + trimH], [offset + trimW, offset + trimH]];
  for (const [x, y] of corners) {
    const left = x === offset;
    const top = y === offset;
    nodes.push(el('span.pp-mark.h', { style: { insetInlineStart: `${left ? x - BLEED_MM - length - 1 : x + BLEED_MM + 1}mm`, insetBlockStart: `${y}mm`, width: `${length}mm` } }));
    nodes.push(el('span.pp-mark.v', { style: { insetBlockStart: `${top ? y - BLEED_MM - length - 1 : y + BLEED_MM + 1}mm`, insetInlineStart: `${x}mm`, height: `${length}mm` } }));
  }
  return nodes;
}

/** The printed document: one `section.pp` per printed page plus the `@page` rules for their sizes. */
export function printDocument({ book, pages, crop, ctx, palette }) {
  const sizes = new Map();
  const sheetsMade = [];
  const body = el('div.pp-doc');
  for (const item of pages) {
    const offset = crop ? MARK_MM + BLEED_MM : 0;
    const bleed = crop ? BLEED_MM : 0;
    const paperW = item.w + offset * 2;
    const paperH = item.h + offset * 2;
    const key = `${paperW}x${paperH}`;
    if (!sizes.has(key)) sizes.set(key, `bk${sizes.size}`);
    const full = sheetSize(book, item.sheet.page.kind);
    const shift = item.half === 'right' ? full.w / 2 : 0;
    const sheet = createSheet({ book, page: item.sheet.page, mode: 'print', ctx, palette });
    sheetsMade.push(sheet);
    const holder = el('div.pp-sheet', { style: { insetInlineStart: `${bleed - shift}mm`, insetBlockStart: `${bleed}mm`, width: `${full.w}mm` } }, sheet.element);
    const clip = el('div.pp-clip', { style: { insetInlineStart: `${offset - bleed}mm`, insetBlockStart: `${offset - bleed}mm`, width: `${item.w + bleed * 2}mm`, height: `${item.h + bleed * 2}mm` } }, holder);
    body.append(el('section.pp', { dataset: { size: sizes.get(key) }, 'aria-label': sheetName(item.sheet), style: { width: `${paperW}mm`, height: `${paperH}mm` } },
      clip, ...(crop ? marks(item.w, item.h, offset) : [])));
  }
  const rules = [...sizes].map(([key, name]) => {
    const [w, h] = key.split('x');
    return `@page ${name} { size: ${w}mm ${h}mm; margin: 0; } .pp[data-size="${name}"] { page: ${name}; }`;
  });
  const [first] = sizes.keys();
  if (first) { const [w, h] = first.split('x'); rules.unshift(`@page { size: ${w}mm ${h}mm; margin: 0; }`); }
  return { body, css: rules.join('\n'), sheets: sheetsMade };
}

/** Opens the print dialog for a book. `ctx()` is the editor's render context. */
export async function openBookPrint({ book, shape, sheetIndex = 0, ctx, palette, title }) {
  const saved = readOptions();
  const state = { range: saved.range === 'current' ? 'current' : 'all', spreads: saved.spreads === true, crop: saved.crop === true };
  const frameHost = el('div.bk-print-preview');
  const status = el('p.bk-muted', { role: 'status' }, t('book.print.preparing'));
  const radios = (name, value, items, onChange) => {
    const legendId = uid('bk-legend');
    return el('fieldset.bk-group', { 'aria-labelledby': legendId }, el('legend', { id: legendId }, t(`book.print.${name}`)),
      items.map((item) => el('label.check-field', {}, el('input', { type: 'radio', name: `${name}-${legendId}`, value: item.value, checked: value === item.value, onchange: () => onChange(item.value) }), el('span', {}, item.label))));
  };
  const form = el('div.bk-print-options',
    {}, radios('range', state.range, [{ value: 'all', label: t('book.print.all') }, { value: 'current', label: t('book.print.current') }], (value) => { state.range = value; void refresh(); }),
    radios('layout', state.spreads ? 'spreads' : 'pages', [{ value: 'pages', label: t('book.print.pages') }, { value: 'spreads', label: t('book.print.spreads') }], (value) => { state.spreads = value === 'spreads'; void refresh(); }),
    el('label.check-field', {}, el('input', { type: 'checkbox', checked: state.crop, onchange: (event) => { state.crop = event.target.checked; void refresh(); } }), el('span', {}, t('book.print.crop'))),
    el('p.bk-muted', {}, t('book.print.hint')), status);
  const printButton = withIcon(button(t('book.print.print'), { variant: 'primary', disabled: true, onclick: () => print() }), 'print');
  const dialog = openModal({ title: t('book.print.title'), content: el('div.bk-print', {}, form, frameHost), actions: [button(t('ui.close'), { onclick: () => dialog.close() }), printButton], wide: true });
  const iframe = el('iframe.bk-print-frame', { title: t('book.print.preview') });
  frameHost.append(iframe);
  const loaded = new Promise((resolve) => { iframe.addEventListener('load', resolve, { once: true }); });
  await Promise.race([loaded, delay(1500)]);
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) { status.textContent = t('book.print.failed'); return; }
  doc.documentElement.lang = locale;
  doc.documentElement.dataset.theme = 'light';
  const base = doc.createElement('style');
  base.textContent = `${tokensCss}\n${bookCss}`;
  const pageRules = doc.createElement('style');
  doc.head.append(base, pageRules);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } else if (isPrintKey(event)) { event.preventDefault(); print(); }
  });
  dialog.panel.addEventListener('keydown', (event) => { if (isPrintKey(event)) { event.preventDefault(); event.stopPropagation(); print(); } });
  let made = [];
  let run = 0;
  const shapes = await countryShapes();

  async function refresh() {
    const mine = ++run;
    writeOptions(state);
    printButton.disabled = true;
    status.textContent = t('book.print.preparing');
    const sheets = state.range === 'current' ? shape.sheets.filter((sheet) => sheet.index === sheetIndex) : shape.sheets;
    const pending = [];
    const renderCtx = () => ({ ...ctx(), shapes, track: (promise) => pending.push(promise) });
    for (const sheet of made) sheet.destroy();
    const { body, css, sheets: built } = printDocument({ book, pages: printPages(sheets, book, { spreads: state.spreads }), crop: state.crop, ctx: renderCtx, palette });
    made = built;
    pageRules.textContent = css;
    doc.title = title;
    doc.body.replaceChildren(body);
    await Promise.race([Promise.allSettled(pending), delay(20_000)]);
    const images = [...doc.images].filter((image) => !image.complete);
    if (images.length) await Promise.race([Promise.all(images.map((image) => new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); }))), delay(15_000)]);
    if (mine !== run) return;
    const widest = Math.max(...[...body.children].map((node) => parseFloat(node.style.width) || 0));
    const zoom = Math.min(1, Math.max(0.15, (iframe.clientWidth - 48) / ((widest * 96) / 25.4)));
    doc.documentElement.style.setProperty('--preview-zoom', String(Math.round(zoom * 1000) / 1000));
    status.textContent = countText('book.print.ready', body.children.length);
    printButton.disabled = false;
  }
  function print() {
    if (printButton.disabled) return;
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { toast(t('book.print.failed')); }
  }
  dialog.closed.then(() => { for (const sheet of made) sheet.destroy(); });
  await refresh();
}
