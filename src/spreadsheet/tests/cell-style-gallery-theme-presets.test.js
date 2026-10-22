// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { applyGalleryTheme, themedPreset } from '../src/core/workbook-theme.js';
import { cellStyle } from '../src/core/cellstyles.js';
import { fontColorCss } from '../src/core/font-color.js';
import { openCellStylesGallery } from '../src/ui/cellstyles-ui.js';
import { closeMenu } from '../src/ui/menu.js';

// Under a theme other than the default, Title, Heading, Subheading and Total apply in the theme's colours
// (Text 2 ink, Accent 1 rules) and Title in its heading face, but the gallery drew their samples in the
// default theme's navy and blue: under Ember the Heading sample was blue while the cells it made were brown.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const samples = (wb) => {
  closeMenu();
  openCellStylesGallery({ wb, run() {}, grid: null }, { x: 10, y: 10 });
  return Object.fromEntries([...document.querySelectorAll('.cell-style-item:not(.themed-cell-style) .cell-style-sample')].map((s) => [s.textContent, s.style]));
};

it('draws the heading presets as the workbook theme applies them', () => {
  const wb = new Workbook();
  expect(samples(wb).Heading.color).toBe(rgb('#1f3b73'));
  applyGalleryTheme(wb, 'Ember');
  const heading = themedPreset(cellStyle('heading'), wb);
  const ink = fontColorCss(heading.patch.color);
  expect(ink).not.toBe('#1f3b73');
  const shown = samples(wb);
  expect(shown.Heading.color).toBe(rgb(ink));
  expect(shown.Subheading.color).toBe(rgb(ink));
  expect(shown.Heading.borderBottom).toContain(rgb(heading.borders[0].color));
  expect(shown.Total.borderBottom).toContain(rgb(themedPreset(cellStyle('total'), wb).borders[1].color));
  expect(shown.Title.color).toBe(rgb(ink));
  expect(shown.Title.fontFamily).not.toBe('');
  // Presets the theme leaves alone keep their own colours.
  expect(shown.Good.background).toBe(rgb('#d8f3dc'));
});
