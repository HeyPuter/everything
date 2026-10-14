/**
 * The Draw tab's pen gallery: pens, pencils and highlighters, each with its own colour and thickness,
 * kept in this browser's storage so the gallery comes back as the user left it. Pen buttons are drawn
 * here (original drawings) in the pen's own colour.
 */
import { el } from '../ui/dom.js';
import { openMenu, closeMenu } from '../ui/menu.js';
import { PX_PER_MM } from '../engine/ink-geometry.js';
import { icon } from '../ui/icons.js';

const check = () => icon('check', 16, 2.2);

const STORAGE_KEY = 'documents.draw.pens.v1';
const MAX_PENS = 12;

export const TOOL_LABELS = { pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter' };
/** Thickness choices in millimetres. */
export const PEN_WIDTHS = { pen: [0.25, 0.35, 0.5, 0.75, 1, 1.5, 2, 3.5], pencil: [0.5, 1, 1.5, 2, 3], highlighter: [2, 4, 6, 8, 10, 12] };
/** The palette: ink colours for pens and pencils, bright translucent ones for highlighters. */
export const INK_COLORS = [
  ['000000', 'Black'], ['FFFFFF', 'White'], ['7F7F7F', 'Gray'], ['C00000', 'Dark Red'], ['FF0000', 'Red'], ['FF6A00', 'Orange'], ['FFC000', 'Gold'], ['FFFF00', 'Yellow'],
  ['92D050', 'Light Green'], ['00B050', 'Green'], ['00B0F0', 'Light Blue'], ['0070C0', 'Blue'], ['002060', 'Navy'], ['7030A0', 'Purple'], ['FF66CC', 'Pink'], ['8B5A2B', 'Brown'],
];
export const HIGHLIGHT_INKS = [['FFFF00', 'Yellow'], ['00FF00', 'Bright Green'], ['00FFFF', 'Turquoise'], ['FF00FF', 'Pink'], ['FF9900', 'Orange'], ['3399FF', 'Blue'], ['FF3333', 'Red'], ['B4A7D6', 'Lavender']];
const colorName = hex => [...INK_COLORS, ...HIGHLIGHT_INKS].find(([c]) => c === hex)?.[1] || `#${hex}`;

export const DEFAULT_PENS = Object.freeze([
  { id: 'pen-black', tool: 'pen', color: '000000', width: 0.5 },
  { id: 'pen-red', tool: 'pen', color: 'C00000', width: 0.5 },
  { id: 'pen-blue', tool: 'pen', color: '0070C0', width: 0.75 },
  { id: 'pencil-gray', tool: 'pencil', color: '595959', width: 1 },
  { id: 'highlighter-yellow', tool: 'highlighter', color: 'FFFF00', width: 6 },
]);

const valid = pen => pen && TOOL_LABELS[pen.tool] && /^[0-9A-F]{6}$/.test(pen.color) && Number.isFinite(pen.width) && pen.width > 0 && pen.width <= 20 && typeof pen.id === 'string';

/** The saved gallery, or the defaults. Storage can be unavailable (private windows, previews). */
export function loadPens(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(saved?.pens) && saved.pens.length && saved.pens.every(valid)) return { pens: saved.pens.slice(0, MAX_PENS), active: saved.active };
  } catch { /* fall through to the defaults */ }
  return { pens: DEFAULT_PENS.map(p => ({ ...p })), active: DEFAULT_PENS[0].id };
}
export function savePens(state, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify({ pens: state.pens, active: state.active })); } catch { /* storage is a convenience */ }
}

export const penLabel = pen => `${TOOL_LABELS[pen.tool]}: ${colorName(pen.color)}, ${pen.width} mm`;
/** The pen's nominal ink width in page pixels. */
export const penWidthPx = pen => pen.width * PX_PER_MM;

/** A pen drawn in its own colour: a barrel, its nib, and a stroke of its ink beneath. */
export function penIconSvg(pen, size = 32) {
  const c = `#${pen.color}`, light = /^(FFFFFF|FFFF00|00FFFF|00FF00|92D050|FFC000)$/.test(pen.color);
  const edge = light ? 'currentColor' : c;
  const swatchHeight = pen.tool === 'highlighter' ? 3.5 : Math.max(1.2, Math.min(3, pen.width * 1.2));
  let body;
  if (pen.tool === 'highlighter') {
    body = `<path d="M12.6 2.6l3.8 3.8-6.3 6.3-3.8-3.8z" fill="var(--draw-pen-body, #e8eaed)" stroke="currentColor" stroke-width=".9" stroke-linejoin="round"/>`
      + `<path d="M6.3 8.9l3.8 3.8-1.6 1.6-3.8-3.8z" fill="${c}" stroke="${edge}" stroke-width=".7"/><path d="M4.7 10.5l3.8 3.8-3.1.4-1.2-1.2z" fill="${c}" stroke="${edge}" stroke-width=".7" stroke-linejoin="round"/>`;
  } else if (pen.tool === 'pencil') {
    body = `<path d="M13.4 2.4l3.2 3.2-8.4 8.4-3.2-3.2z" fill="var(--draw-pen-body, #e8eaed)" stroke="currentColor" stroke-width=".9" stroke-linejoin="round"/>`
      + `<path d="M11.8 4l3.2 3.2" stroke="${c}" stroke-width="1.6"/><path d="M5 10.8l3.2 3.2-4.6 1.4z" fill="#e9c48a" stroke="currentColor" stroke-width=".8" stroke-linejoin="round"/><path d="M4.1 13.2l1.7 1.7-2.2.5z" fill="${c}"/>`;
  } else {
    body = `<path d="M14.2 2.2l3.6 3.6-8.6 8.6-3.6-3.6z" fill="var(--draw-pen-body, #e8eaed)" stroke="currentColor" stroke-width=".9" stroke-linejoin="round"/>`
      + `<path d="M12.6 3.8l3.6 3.6" stroke="${c}" stroke-width="1.8"/><path d="M5.6 10.8l3.6 3.6-5.2 1.6z" fill="${c}" stroke="${edge}" stroke-width=".7" stroke-linejoin="round"/>`;
  }
  const swatch = `<rect x="2" y="${18.6 - swatchHeight}" width="16" height="${swatchHeight}" rx="${Math.min(1, swatchHeight / 2)}" fill="${c}"${pen.tool === 'highlighter' ? ' fill-opacity=".75"' : ''}${light ? ' stroke="currentColor" stroke-width=".4"' : ''}/>`;
  return `<svg class="draw-pen-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}${swatch}</svg>`;
}

/**
 * The settings menu for one pen: thickness, colour (palette or any colour) and removal.
 * onChange(patch) applies a change; onRemove() removes the pen.
 */
export function openPenSettings({ anchor, pen, canRemove, onChange, onRemove, pointer = false }) {
  const colors = pen.tool === 'highlighter' ? HIGHLIGHT_INKS : INK_COLORS;
  const swatch = ([hex, name]) => el('button.swatch.draw-pen-swatch', { type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-label': name, title: name,
    'aria-checked': String(pen.color === hex), style: { background: `#${hex}` }, onclick: () => { closeMenu(); onChange({ color: hex }); } });
  const grid = el('div.menu-custom-grid', { role: 'group', 'aria-label': `${TOOL_LABELS[pen.tool]} colors`, dataset: { columns: '8' } }, colors.map(swatch));
  const picker = el('input', { type: 'color', value: `#${pen.color.toLowerCase()}`, 'aria-label': 'Custom ink color', hidden: true,
    onchange: () => { const hex = picker.value.replace('#', '').toUpperCase(); if (/^[0-9A-F]{6}$/.test(hex)) onChange({ color: hex }); picker.remove(); } });
  const preview = width => { const line = el('span.draw-width-preview', { 'aria-hidden': 'true' }); line.style.height = `${Math.max(1, Math.min(14, width * PX_PER_MM))}px`; line.style.background = `#${pen.color}`; if (pen.tool === 'highlighter') line.style.opacity = '.6'; return line; };
  return openMenu({ anchor, label: `${TOOL_LABELS[pen.tool]} settings`, className: 'draw-pen-menu', pointer, minWidth: 240, items: [
    { header: 'Thickness' },
    ...PEN_WIDTHS[pen.tool].map(width => ({ custom: el('button.menu-item.draw-width-item', { type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(pen.width === width),
      onclick: () => { closeMenu(); onChange({ width }); } }, el('span.menu-icon', { 'aria-hidden': 'true', html: pen.width === width ? check() : '' }), el('span.menu-label', {}, `${width} mm`), preview(width)) })),
    { separator: true }, { header: 'Color' }, { custom: grid },
    { label: 'More Colors…', onSelect: () => { document.body.append(picker); picker.click(); } },
    { separator: true },
    { label: 'Remove Pen', icon: 'deleteShape', disabled: !canRemove, onSelect: onRemove },
  ] });
}

/** A new pen of a kind, with that kind's usual colour and thickness. */
export function newPen(tool) {
  const base = { pen: { color: '000000', width: 0.5 }, pencil: { color: '595959', width: 1 }, highlighter: { color: 'FFFF00', width: 6 } }[tool];
  return { id: `${tool}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tool, ...base };
}
