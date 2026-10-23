// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openCellStylesGallery } from '../src/ui/cellstyles-ui.js';
import { closeMenu } from '../src/ui/menu.js';

// The gallery's samples are held to 16px text so its tiles stay one height. Title, Heading and Subheading came to be
// 24, 20 and 17⅓px (Excel's 18, 15 and 13 points, 060957e20), all past that cap, so the three samples were drawn at
// the same 16px and the gallery no longer showed which is the larger heading.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('draws Title larger than Heading, and Heading larger than Subheading and Normal', () => {
  openCellStylesGallery({ wb: new Workbook(), run() {}, grid: null }, { x: 10, y: 10 });
  const size = Object.fromEntries([...document.querySelectorAll('.cell-style-item:not(.themed-cell-style) .cell-style-sample')]
    .map((s) => [s.textContent, parseFloat(s.style.fontSize)]));
  expect(size.Title).toBeGreaterThan(size.Heading);
  expect(size.Heading).toBeGreaterThan(size.Subheading);
  expect(size.Subheading).toBeGreaterThan(size.Normal);
  expect(size.Title).toBeLessThanOrEqual(16);
});
