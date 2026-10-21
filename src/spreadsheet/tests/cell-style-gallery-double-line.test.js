// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openCellStylesGallery } from '../src/ui/cellstyles-ui.js';
import { closeMenu } from '../src/ui/menu.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} })); Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

// The Cell Styles gallery underlined the Total sample with a single 2px line, though the style draws a double
// one: a double line needs 3px to show as two. Samples now draw their lower edge in the style's own line.
it('shows the Total style\'s double bottom line in its sample', () => {
  const wb = new Workbook();
  openCellStylesGallery({ wb, run: vi.fn(), grid: { focus() {} } }, { x: 0, y: 0 });
  const sample = (label) => [...document.querySelectorAll('.cell-style-sample')].find((node) => node.textContent === label);
  expect(sample('Total').style.borderBottom).toMatch(/^3px double /);
  expect(sample('Heading').style.borderBottom).toMatch(/^2px solid /);
});
