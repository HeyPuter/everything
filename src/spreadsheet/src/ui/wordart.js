/**
 * Insert ▸ Text ▸ WordArt: a gallery of text effects. A pick inserts a borderless text box of large,
 * styled text (fill, outline, shadow or glow, in the workbook theme's colours) at the active cell and
 * opens it for typing. It is an ordinary text box, so it moves, sizes, prints and saves as one does.
 */
import { el } from './dom.js';
import { openMenu } from './menu.js';
import { openTextBoxDialog } from './textboxdialog.js';
import { textBoxStyle } from '../core/charts.js';
import { tintRgb } from '../core/font-color.js';
import { workbookTheme } from '../core/workbook-theme.js';
import { fontKeyFor } from '../core/format.js';

const shade = (hex, t) => `#${tintRgb(hex.slice(1), t)}`;

/** The gallery's styles against the theme's colours (index order: lt1, dk1, lt2, dk2, accent1–6). */
export function wordArtStyles(colors) {
  const [paper, ink, , ink2, a1, a2, , a4, a5, a6] = colors;
  return [
    { key: 'ink-shadow', label: 'Ink with shadow', style: { color: ink, bold: false, effects: { shadow: '#000000' } } },
    { key: 'accent-outline', label: 'Accent with outline', style: { color: a1, bold: true, effects: { outline: shade(a1, -0.5), outlineWidth: 1 } } },
    { key: 'hollow', label: 'Hollow accent', style: { color: paper, bold: true, effects: { outline: a2, outlineWidth: 1.5 } } },
    { key: 'glow', label: 'Glowing accent', style: { color: a4, bold: true, effects: { glow: shade(a4, 0.6) } } },
    { key: 'paper-shadow', label: 'Paper on accent, with shadow', style: { color: paper, bold: true, effects: { outline: a1, outlineWidth: 1, shadow: '#000000' } } },
    { key: 'deep-shadow', label: 'Bold with deep shadow', style: { color: a6, bold: true, effects: { shadow: shade(a6, -0.5) } } },
    { key: 'soft-glow', label: 'Text with soft glow', style: { color: ink2, bold: false, effects: { glow: shade(a5, 0.6) } } },
    { key: 'plain-accent', label: 'Plain accent', style: { color: a5, bold: false } },
  ];
}

export const WORDART_TEXT = 'Your text here';

/** The box WordArt's text takes, a line for each line typed: WordArt fits its shape to its text rather than wrapping it. */
export function wordArtSize(text, size) {
  const lines = String(text).split('\n');
  return { w: Math.round(Math.max(...lines.map(l => [...l].length)) * size * 0.56) + 32, h: Math.round(lines.length * size * 1.6) + 16 };
}

/** Insert a WordArt text box of `key`'s style at the active cell and open it to be typed over. */
export function insertWordArt(ctx, key) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return null;
  if (wb.isProtected(sheetId)) return null;
  const theme = workbookTheme(wb);
  const def = wordArtStyles(theme.colors).find(s => s.key === key);
  if (!def) return null;
  const size = 40;
  const style = { size, italic: false, bg: null, align: 'center', valign: 'middle', border: false,
    font: fontKeyFor(theme.minor, { literal: true }) || undefined, ...def.style };
  const a = ctx.active();
  const id = wb.addChart(sheetId, { type: 'text', text: WORDART_TEXT, style, anchor: { r: a.r, c: a.c }, dx: 4, dy: 4, ...wordArtSize(WORDART_TEXT, size) });
  if (!id) return null;
  ctx.grid.selectChart?.(id);
  const textbox = wb.sheet(sheetId)?.charts.find(c => c.id === id);
  // The text typed over the sample takes the box it needs, not the sample's.
  if (textbox) openTextBoxDialog(ctx, { textbox, fit: (text, st) => wordArtSize(text, st.size) });
  return id;
}

/** Insert ▸ Text ▸ WordArt: the gallery, each sample drawn in its own style. */
export function openWordArtMenu(ctx, anchor) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return null;
  const theme = workbookTheme(ctx.wb);
  const tile = def => el('button.wordart-tile', {
    type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': def.label, title: def.label,
    onclick: () => { menu.close(); insertWordArt(ctx, def.key); },
  }, el('span.wordart-sample', { 'aria-hidden': 'true', style: textBoxStyle({ style: { ...def.style, size: 30, font: fontKeyFor(theme.minor, { literal: true }) } }) }, 'A'));
  const grid = el('div.wordart-gallery', { role: 'group', 'aria-label': 'WordArt styles', 'data-cols': 4 }, ...wordArtStyles(theme.colors).map(tile));
  const menu = openMenu({ anchor, label: 'WordArt', minWidth: 220, items: [{ custom: grid }] });
  grid.querySelector('button')?.focus();
  return menu;
}
