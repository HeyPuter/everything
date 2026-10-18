// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { openMenu, closeMenu } from '../src/ui/menu.js';
import { el } from '../src/ui/dom.js';
import { stylesheet, declared, rulesFor } from './helpers/css.js';

afterEach(() => { closeMenu(); document.body.replaceChildren(); });

const key = (name) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

// Home ▸ Cell Styles on a phone: the six Themed Cell Styles to a row needed about 600px, so the menu scrolled
// sideways and the last columns were out of view; Page Layout ▸ Themes (four 80px tiles) and Effects ran a
// little past a phone's edge too. The themed styles now go three to a row on a narrow window, and the tiles
// of the other two give some of their width.
it('fits the theme galleries of a menu to a phone', () => {
  const themes = stylesheet('themes.css');
  expect(declared(themes, '.theme-gallery', false)['grid-template-columns']).toBe('repeat(4, minmax(0, 80px))');
  const narrow = rulesFor(themes, '.themed-cell-styles', 'max-width: 680px');
  expect(narrow).toHaveLength(1);
  expect(declared(themes, '.themed-cell-styles', 'max-width: 680px')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
  expect(declared(stylesheet('equation.css'), '.effects-gallery', false)['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
});

// Down and Up in a gallery moved by the column count the code named (`data-cols`), not the columns drawn: with
// the themed styles three to a row, Down from the first went to the seventh, two rows down and one along.
// The same was so of the chart and SmartArt Standard Colors, named ten wide and drawn six to a row.
it('moves Down and Up by the columns the stylesheet draws', () => {
  const cells = Array.from({ length: 9 }, (_, i) => el('button.cell', { type: 'button', tabindex: -1, role: 'menuitem' }, `Cell ${i + 1}`));
  const grid = el('div', { role: 'group', 'data-cols': 6, style: { display: 'grid', gridTemplateColumns: '90px 90px 90px' } }, ...cells);
  openMenu({ x: 10, y: 10, items: [{ custom: grid }] });
  cells[0].focus();
  key('ArrowDown');
  expect(document.activeElement).toBe(cells[3]);
  key('ArrowDown');
  expect(document.activeElement).toBe(cells[6]);
  key('ArrowUp');
  expect(document.activeElement).toBe(cells[3]);
});

it('goes by data-cols where nothing is drawn as a grid', () => {
  const cells = Array.from({ length: 9 }, (_, i) => el('button.cell', { type: 'button', tabindex: -1, role: 'menuitem' }, `Cell ${i + 1}`));
  const grid = el('div', { role: 'group', 'data-cols': 4 }, ...cells);
  openMenu({ x: 10, y: 10, items: [{ custom: grid }] });
  cells[1].focus();
  key('ArrowDown');
  expect(document.activeElement).toBe(cells[5]);
});
