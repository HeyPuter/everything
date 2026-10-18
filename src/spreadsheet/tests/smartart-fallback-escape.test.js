// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createGrid } from '../src/ui/grid.js';
import { fallbackPicture } from '../src/ui/smartart.js';

// A SmartArt diagram's stored picture (the one another program drew) was written into the page with
// its address unescaped, so a workbook whose stored address held a quote could add attributes of its
// own to the picture, an onerror script among them, run as soon as the sheet was shown. A stored address
// must now be plain base64 (the diagram is drawn from its outline otherwise), and is escaped when drawn.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const hostile = 'data:image/svg+xml;base64,AAAA" onerror="window.__pwned=1" data-x="<b>';

it('draws a diagram whose stored picture address is not plain base64 from its outline', async () => {
  const wb = new Workbook({ sheets: [{ name: 'S', charts: [{ type: 'smartart', id: 'sa', layout: 'basicProcess', items: [{ text: 'A', level: 0 }],
    anchor: { r: 1, c: 1 }, w: 300, h: 200, fallback: { src: hostile } }] }] });
  const id = wb.sheets[0].id;
  expect(wb.sheet(id).charts[0].fallback).toBeUndefined();
  const grid = createGrid({ wb, sheetId: id });
  document.body.append(grid.el);
  await new Promise(r => setTimeout(r, 10));
  const box = grid.el.querySelector('.smartart-box');
  expect(box.querySelector('[onerror]')).toBeNull();
  expect(box.querySelector('img')).toBeNull();
  expect(box.querySelector('svg')).not.toBeNull();
  grid.destroy();
});

it('escapes the address when drawing the picture', () => {
  const markup = fallbackPicture({ src: hostile });
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  expect(holder.querySelectorAll('img')).toHaveLength(1);
  expect([...holder.querySelector('img').attributes].map(a => a.name).sort()).toEqual(['alt', 'class', 'draggable', 'src', 'style']);
});
