// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);

async function insertWordArt() {
  const doc = new Doc({ name: 'Art' }); const wb = doc.wb; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === 'Insert').click(); await flush();
  [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === 'WordArt').click(); await flush();
  document.querySelector('.menu .wordart-tile[aria-label="Accent with outline"]').click(); await flush();
  const box = () => wb.sheet(id).charts.find(c => c.type === 'text');
  return { box, sample: { ...box() } };
}
async function type(text) {
  const dialog = document.querySelector('[role="dialog"]');
  dialog.querySelector('textarea').value = text;
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
}

// WordArt is one line of large text: what is typed over the sample must not wrap and run out of its box.
it('widens a WordArt box to the text typed over its sample', async () => {
  const { box, sample } = await insertWordArt();
  await type('Quarterly sales results 2026');
  expect(box().text).toBe('Quarterly sales results 2026');
  // 28 characters at 40 px, about half an em each, on the one line the sample's 14 took.
  expect(box().w).toBeGreaterThan(sample.w * 1.8);
  expect(box().h).toBe(sample.h);
  expect(box().anchor).toEqual(sample.anchor);
});

it('gives a WordArt box a line of height for each line typed', async () => {
  const { box, sample } = await insertWordArt();
  await type('Q3\nResults');
  expect(box().h).toBeGreaterThan(sample.h * 1.5);
  expect(box().w).toBeLessThan(sample.w);
});
