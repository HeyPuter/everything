import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageStoryVariant, pageStoryLabel } from '../src/engine/page-stories.js';
import { paintStoryChrome } from '../src/engine/canvas-story-chrome.js';

// While a header or footer is edited, its tag names which one it is (§17.10.5 headerReference types, §17.6.19
// titlePg, §17.15.1.35 evenAndOddHeaders): "First Page Header", "Even Page Header", "Odd Page Header", with the
// section when there are several, as the page shows it.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const measure = (text, style) => ({ width: text.length * style.fontSize * 0.5, ascent: 12, descent: 3 });

it('names the variant a page shows, and its section when there are several', () => {
  const definition = { sections: [{ header: {}, footer: {}, firstPageDifferent: true }, { header: {}, footer: {}, firstPageDifferent: false }], stories: {}, evenAndOdd: true };
  expect(pageStoryVariant(definition, 0, 1, true)).toBe('first');
  expect(pageStoryVariant(definition, 0, 2, false)).toBe('even');
  expect(pageStoryVariant(definition, 0, 3, false)).toBe('odd');
  expect(pageStoryVariant(definition, 1, 4, true)).toBe('even');
  expect(pageStoryVariant({ ...definition, evenAndOdd: false }, 1, 4, true)).toBe('default');
  expect(pageStoryLabel('header', { variant: 'first', section: 0 })).toBe('First Page Header');
  expect(pageStoryLabel('footer', { variant: 'even', section: 1 }, 2)).toBe('Even Page Footer -Section 2-');
  expect(pageStoryLabel('header', { variant: 'odd', section: 0 }, 1)).toBe('Odd Page Header');
  expect(pageStoryLabel('footer', { variant: 'default', section: 2 }, 3)).toBe('Footer -Section 3-');
  expect(pageStoryLabel('header')).toBe('Header');
});

it('lays out which header and footer each page shows, also where a story is empty', async () => {
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/empty-page-stories.docx'));
  const text = Array.from({ length: 160 }, (_, i) => paragraph(`Line ${i + 1} of a document long enough to run onto several pages.`));
  const doc = new TextDocument(text, pkg.pageSettings, pkg.numbering, pkg.styles, [], pkg.assets);
  const body = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories);
  expect(body.pageCount).toBeGreaterThanOrEqual(3);
  const stories = layoutPageStories(body, pkg.pageStories, [doc.pageSettings], measure, doc.numbering, { styles: doc.styles });
  expect(stories.pageVariants.slice(0, 3)).toEqual([{ section: 0, variant: 'first' }, { section: 0, variant: 'even' }, { section: 0, variant: 'odd' }]);
  // The positions of each shown story carry the same names.
  for (const item of stories.positions) expect(item.variant).toBe(stories.pageVariants[item.page].variant);
});

it('paints the names on the tags, and plain Header and Footer without them', () => {
  const calls = [];
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 6 }), fillText: text => calls.push(text) }, { get: (target, key) => key in target ? target[key] : () => {}, set: () => true });
  const geometry = { width: 816, height: 1056, left: 96, right: 96, top: 96, bottom: 96 };
  paintStoryChrome(ctx, geometry, { header: 120, footer: 980 }, 'header', { header: 'First Page Header -Section 2-', footer: 'First Page Footer -Section 2-' });
  expect(calls).toEqual(['First Page Header -Section 2-', 'First Page Footer -Section 2-']);
  calls.length = 0;
  paintStoryChrome(ctx, geometry, { header: 120, footer: 980 }, 'footer');
  expect(calls).toEqual(['Header', 'Footer']);
});
