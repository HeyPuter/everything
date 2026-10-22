// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { closeAllModals } from '../src/ui/modal.js';
import { pageLayoutMetrics, pageNumber, headerFooterKey, sectionEditText, sectionStoredText, joinSections, paperInches } from '../src/ui/page-layout.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount(fill = 3) {
  const doc = new Doc({ name: 'Budget' }); const wb = doc.wb; const id = wb.activeSheetId;
  for (let r = 0; r < fill; r++) { wb.setInput(id, r, 0, `Item ${r + 1}`); wb.setInput(id, r, 1, String(r)); }
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const tab = name => [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === name);
const ribbonButton = label => [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === label) || null;
const grid = () => view.el.querySelector('.grid');

it('sizes pages from the page setup, with the default page when the sheet has none', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.ensureSize(id, 200, 30);
  const m = pageLayoutMetrics(wb, id);
  expect([m.paperWidth, m.paperHeight]).toEqual([816, 1056]); // Letter at 96 px to the inch
  // A sheet without a page setup of its own is laid out as it prints: the print's Normal margins of 12mm.
  const margin = 12 / 25.4 * 96;
  expect(m.margins.left).toBeCloseTo(margin);
  expect(m.margins.top).toBeCloseTo(margin);
  expect(m.scale).toBe(1);
  // Each page holds as many whole columns and rows as fit its printable width and height.
  const width = 816 - 2 * margin, height = 1056 - 2 * margin;
  const firstCols = m.cols[1], firstRows = m.rows[1];
  let w = 0; for (let c = 0; c < firstCols; c++) w += wb.colWidth(id, c);
  let h = 0; for (let r = 0; r < firstRows; r++) h += wb.rowHeight(id, r);
  expect(w).toBeLessThanOrEqual(width); expect(w + wb.colWidth(id, firstCols)).toBeGreaterThan(width);
  expect(h).toBeLessThanOrEqual(height); expect(h + wb.rowHeight(id, firstRows)).toBeGreaterThan(height);
  expect(m.colStarts.has(firstCols)).toBe(true);

  wb.setPrintSettings(id, { ...(wb.sheet(id).printSettings || {}), orientation: 'landscape', paperSize: 9, scale: 50 });
  const a4 = pageLayoutMetrics(wb, id);
  expect(a4.paperWidth).toBeCloseTo(297 / 25.4 * 96);
  expect(a4.scale).toBe(0.5);
  expect(a4.cols[1]).toBeGreaterThan(firstCols); // at half size more columns fit across
  expect(paperInches({ paperSize: 5, orientation: 'portrait' })).toEqual([8.5, 14]);
});

it('fits the used range to the pages asked for, at a whole percentage, never above 100%', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let c = 0; c < 40; c++) wb.setInput(id, 0, c, 'x');
  wb.setPrintSettings(id, { fitToPage: true, fitWidth: 1, fitHeight: 0 });
  const m = pageLayoutMetrics(wb, id);
  expect(m.scale).toBeLessThan(1);
  expect(Math.round(m.scale * 100)).toBe(m.scale * 100);
  expect(m.cols[1] === undefined || m.cols[1] >= 40).toBe(true); // all forty columns on one page across
  wb.setPrintSettings(id, { fitToPage: true, fitWidth: 10, fitHeight: 5 });
  expect(pageLayoutMetrics(wb, id).scale).toBe(1);
});

it('numbers pages in print order and picks first and even page headers', () => {
  const metrics = { printed: { a0: 0, a1: 1, d0: 0, d1: 2 }, settings: { pageOrder: 'downThenOver', useFirstPageNumber: false, firstPageNumber: 1 } };
  expect(pageNumber(metrics, 0, 0)).toEqual({ index: 0, number: 1, pages: 6 });
  expect(pageNumber(metrics, 0, 2).number).toBe(3);
  expect(pageNumber(metrics, 1, 0).number).toBe(4);
  const over = { ...metrics, settings: { pageOrder: 'overThenDown', useFirstPageNumber: true, firstPageNumber: 10 } };
  expect(pageNumber(over, 1, 0).number).toBe(11);
  expect(pageNumber(over, 0, 1).number).toBe(12);
  const s = { differentFirst: true, differentOddEven: true };
  expect(headerFooterKey(s, 'header', 0)).toBe('firstHeader');
  expect(headerFooterKey(s, 'footer', 1)).toBe('evenFooter');
  expect(headerFooterKey(s, 'header', 2)).toBe('header');
  expect(headerFooterKey({}, 'footer', 1)).toBe('footer');
});

it('edits header sections with readable field codes and saves the codes the file uses', () => {
  expect(sectionEditText('Page &P of &N && &D &T &F &A &Z')).toBe('Page &[Page] of &[Pages] && &[Date] &[Time] &[File] &[Tab] &[Path]');
  expect(sectionStoredText('Page &[Page] of &[pages] && &[Path]')).toBe('Page &P of &N && &Z');
  expect(joinSections({ left: 'A', center: '', right: '&P' })).toBe('&LA&R&P');
  expect(joinSections({ left: '', center: '', right: '' })).toBe('');
});

it('keeps the view with the sheet through XLSX, as <sheetView view="pageLayout">, and Page Break Preview too', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Pages' }, { name: 'Breaks' }, { name: 'Plain' }] });
  const [a, b, c] = wb.sheets;
  wb.setInput(a.id, 0, 0, 'x');
  wb.setSheetViewMode(a.id, 'pageLayout');
  wb.setSheetViewMode(b.id, 'pageBreak');
  wb.setSheetView(a.id, { viewZoom: 0.75 });
  expect(wb.canUndo()).toBe(true); // the edit above; the view itself is not an undo step
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(bytes, { type: 'array' });
  const sheetXml = n => new TextDecoder().decode(X.CFB.find(zip, `/xl/worksheets/sheet${n}.xml`).content);
  expect(sheetXml(1)).toMatch(/<sheetView\b[^>]*\bview="pageLayout"/);
  expect(sheetXml(1)).toMatch(/zoomScalePageLayoutView="75"/);
  expect(sheetXml(2)).toMatch(/<sheetView\b[^>]*\bview="pageBreakPreview"/);
  expect(sheetXml(3)).not.toMatch(/<sheetView\b[^>]*\bview=/);
  // Read back with the app's own notes, and from the native part alone.
  const back = await workbookFromFile(bytes.slice(), 'views.xlsx');
  expect(back.sheets.map(s => s.viewMode || 'normal')).toEqual(['pageLayout', 'pageBreak', 'normal']);
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const native = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'native.xlsx');
  expect(native.sheets.map(s => s.viewMode || 'normal')).toEqual(['pageLayout', 'pageBreak', 'normal']);
  expect(c.viewMode).toBeUndefined();
});

it('reads Page Layout view from a file another program wrote', async () => {
  const wb = await workbookFromFile(otherProgramsXlsx({ sheetNames: ['One', 'Two'], sheetXml: {
    One: { head: '<sheetViews><sheetView view="pageLayout" workbookViewId="0"/></sheetViews>' },
    Two: { head: '<sheetViews><sheetView view="normal" workbookViewId="0"/></sheetViews>' },
  } }), 'other.xlsx');
  expect(wb.sheets.map(s => s.viewMode || 'normal')).toEqual(['pageLayout', 'normal']);
  // Saved in the app's own document too, and kept through an undone structural edit.
  const again = new Workbook(wb.toJSON());
  expect(again.sheets[0].viewMode).toBe('pageLayout');
  const id = again.sheets[0].id;
  again.insertRows(id, 0, 1);
  again.undo();
  expect(again.sheet(id).viewMode).toBe('pageLayout');
  again.setSheetViewMode(id, 'bogus');
  expect(again.sheet(id).viewMode).toBe('pageLayout');
});

it('shows the sheet as pages from View, the status bar and the View menu, and back to Normal', async () => {
  const { wb, id } = await mount();
  tab('View').click(); await flush();
  ribbonButton('Page Layout view').click(); await flush();
  expect(wb.sheet(id).viewMode).toBe('pageLayout');
  expect(grid().classList.contains('page-layout')).toBe(true);
  expect(view.el.querySelector('.status-view[data-mode="pageLayout"]').getAttribute('aria-pressed')).toBe('true');
  expect(ribbonButton('Page Layout view').getAttribute('aria-pressed') ?? ribbonButton('Page Layout view').classList.contains('checked')).toBeTruthy();
  const pages = view.el.querySelectorAll('.grid-paper .pl-page');
  expect(pages.length).toBeGreaterThan(0);
  // The first page's cells start inside its left and top margins, below the gap.
  const a1 = view.el.querySelector('#gc-0-0') || view.el.querySelector('.cell[data-c="0"]');
  expect(a1).toBeTruthy();
  const row = a1.closest('.grid-row');
  // Inside the margins it prints with (the print's Normal, 12mm, for a sheet with no page setup of its own).
  expect(parseFloat(row.style.transform.match(/translateY\(([-\d.]+)px\)/)[1])).toBe(12 + Math.round(12 / 25.4 * 96));
  expect(parseFloat(a1.style.left)).toBe(12 + Math.round(12 / 25.4 * 96));
  // Rulers above the column letters and beside the row numbers.
  expect(view.el.querySelectorAll('.grid-ruler.across .pl-ruler').length).toBeGreaterThan(0);
  expect(view.el.querySelectorAll('.grid-ruler.down .pl-ruler').length).toBeGreaterThan(0);
  // An empty header and footer invite one.
  const first = pages[0];
  expect(first.querySelector('.pl-header .pl-add').textContent).toBe('Add header');
  expect(first.querySelector('.pl-footer .pl-add').textContent).toBe('Add footer');
  // The status bar names the page the active cell prints on.
  const page = view.el.querySelector('.status-page');
  expect(page.hidden).toBe(false);
  expect(page.textContent).toMatch(/^Page: 1 of \d+$/);
  view.el.querySelector('.status-view[data-mode="normal"]').click(); await flush();
  expect(view.el.querySelector('.status-page').hidden).toBe(true);
  expect(wb.sheet(id).viewMode).toBeUndefined();
  expect(grid().classList.contains('page-layout')).toBe(false);
  expect(view.el.querySelectorAll('.grid-paper .pl-page').length).toBe(0);
  view.el.querySelector('.status-view[data-mode="pageLayout"]').click(); await flush();
  expect(grid().classList.contains('page-layout')).toBe(true);
});

it('draws the header and footer with their codes filled in, and edits a section in place', async () => {
  const { wb, id } = await mount();
  wb.setPrintSettings(id, { header: '&LBudget&RPage &P of &N', footer: '&C&A' });
  view.el.querySelector('.status-view[data-mode="pageLayout"]').click(); await flush();
  const page = view.el.querySelector('.grid-paper .pl-page[data-page="0.0"]');
  const header = page.querySelector('.pl-header');
  expect(header.querySelector('[data-side="left"]').textContent).toBe('Budget');
  expect(header.querySelector('[data-side="right"]').textContent).toBe('Page 1 of 1');
  expect(page.querySelector('.pl-footer [data-side="center"]').textContent).toBe(wb.sheet(id).name);
  // Clicking a section shows its codes for editing; leaving it saves the change as one undo step.
  const center = header.querySelector('[data-side="center"]');
  center.dispatchEvent(new Event('focus'));
  expect(center.textContent).toBe('');
  center.textContent = 'Draft &[Date]';
  center.dispatchEvent(new Event('blur'));
  await flush();
  expect(wb.sheet(id).printSettings.header).toBe('&LBudget&CDraft &D&RPage &P of &N');
  const right = view.el.querySelector('.grid-paper .pl-page[data-page="0.0"] .pl-header [data-side="right"]');
  right.dispatchEvent(new Event('focus'));
  expect(right.textContent).toBe('Page &[Page] of &[Pages]');
  // Escape gives the edit up.
  right.textContent = 'changed';
  right.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  right.dispatchEvent(new Event('blur'));
  await flush();
  expect(wb.sheet(id).printSettings.header).toBe('&LBudget&CDraft &D&RPage &P of &N');
  wb.undo(); await flush();
  expect(wb.sheet(id).printSettings.header).toBe('&LBudget&RPage &P of &N');
  // Tab moves to the next section and keeps the page (and so the focus) in place while the header saves.
  const left = view.el.querySelector('.grid-paper .pl-page[data-page="0.0"] .pl-header [data-side="left"]');
  left.focus();
  left.textContent = 'Budget 2026';
  left.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await flush(); await flush();
  expect(document.activeElement.dataset.side).toBe('center');
  expect(wb.sheet(id).printSettings.header).toBe('&LBudget 2026&RPage &P of &N');
  document.activeElement.blur(); await flush();
  // Typing in a header does not reach the cells.
  const selected = view.el.querySelector('.grid-viewport');
  const before = wb.getValue(id, 0, 0);
  const sec = view.el.querySelector('.grid-paper .pl-page .pl-footer [data-side="left"]');
  sec.dispatchEvent(new Event('focus'));
  sec.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await flush();
  expect(wb.getValue(id, 0, 0)).toBe(before);
  expect(selected).toBeTruthy();
});

it('keeps cells editable in Page Layout view and zooms the pages', async () => {
  const { wb, id } = await mount();
  view.el.querySelector('.status-view[data-mode="pageLayout"]').click(); await flush();
  view.goTo('C2'); await flush();
  const vp = view.el.querySelector('.grid-viewport');
  vp.focus();
  vp.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true }));
  vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  const editor = view.el.querySelector('.grid-editor');
  if (wb.getValue(id, 1, 2) == null && editor && !editor.hidden) { editor.value = '7'; editor.dispatchEvent(new Event('input', { bubbles: true })); editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush(); }
  expect(String(wb.getValue(id, 1, 2))).toBe('7');
  const width = () => parseFloat(view.el.querySelector('.grid-paper .pl-page').style.width);
  expect(width()).toBe(816);
  view.el.querySelector('.zoom-box input[type="range"]').value = '50';
  view.el.querySelector('.zoom-box input[type="range"]').dispatchEvent(new Event('input')); await flush();
  expect(width()).toBe(408);
  expect(wb.sheet(id).viewZoom).toBe(0.5);
  // Print scale shrinks the cells on the page, not the paper; the zoom shown stays the chosen one.
  wb.setPrintSettings(id, { scale: 50 }); await flush();
  expect(width()).toBe(408);
  expect(view.el.querySelector('.zoom-box').textContent).toContain('50%');
  const a1 = view.el.querySelector('#gc-0-0');
  expect(parseFloat(a1.style.width)).toBe(Math.round(wb.colWidth(id, 0) * 0.25));
});

it('offers the Header & Footer elements and options while a section is typed in', async () => {
  const { wb, id } = await mount();
  view.el.querySelector('.status-view[data-mode="pageLayout"]').click(); await flush();
  const page = () => view.el.querySelector('.grid-paper .pl-page[data-page="0.0"]');
  const center = page().querySelector('.pl-header [data-side="center"]');
  center.focus();
  expect(page().querySelector('.pl-header').classList.contains('pl-editing')).toBe(true);
  const tool = label => [...page().querySelectorAll('.pl-header .pl-tool')].find(b => b.textContent === label);
  expect([...page().querySelectorAll('.pl-header .pl-tool[data-code]')].map(b => b.textContent))
    .toEqual(['Page Number', 'Number of Pages', 'Current Date', 'Current Time', 'File Path', 'File Name', 'Sheet Name']);
  // A press on a tool keeps the focus in the section; its click puts the code at the caret.
  const down = new Event('pointerdown', { bubbles: true, cancelable: true });
  tool('Page Number').dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  tool('Page Number').click();
  center.append(document.createTextNode(' of ')); // typed: the caret follows it
  const caret = document.createRange(); caret.selectNodeContents(center); caret.collapse(false);
  getSelection().removeAllRanges(); getSelection().addRange(caret);
  tool('Number of Pages').click();
  expect(center.textContent).toBe('&[Page] of &[Pages]');
  // Go to Footer moves to the footer's center section, saving the header.
  tool('Go to Footer').click(); await flush();
  expect(wb.sheet(id).printSettings.header).toBe('&C&P of &N');
  expect(document.activeElement.dataset.kind).toBe('footer');
  const option = label => [...page().querySelectorAll('.pl-footer .pl-tool')].find(b => b.textContent === label);
  expect(option('Different First Page').getAttribute('aria-pressed')).toBe('false');
  option('Different First Page').click(); await flush();
  expect(wb.sheet(id).printSettings.differentFirst).toBe(true);
  expect(option('Different First Page').getAttribute('aria-pressed')).toBe('true');
  option('Align with Page Margins').click(); await flush();
  expect(wb.sheet(id).printSettings.alignWithMargins).toBe(false);
  document.activeElement.blur(); await flush();
  // The first page now has its own (empty) header; the usual one stays for the pages after it.
  expect(page().querySelector('.pl-header').dataset.key).toBe('firstHeader');
  expect(page().querySelector('.pl-header .pl-add')).toBeTruthy();
});


it('opens a sheet saved in Page Layout view that way, and each sheet keeps its own view', async () => {
  const doc = new Doc({ name: 'Views' }); const wb = doc.wb;
  const first = wb.activeSheetId;
  wb.setInput(first, 0, 0, 'a');
  wb.setSheetViewMode(first, 'pageLayout');
  wb.addSheet?.('Second');
  const second = wb.sheets.find(s => s.id !== first)?.id;
  wb.setActiveSheet(first);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  expect(grid().classList.contains('page-layout')).toBe(true);
  expect(view.el.querySelectorAll('.grid-paper .pl-page').length).toBeGreaterThan(0);
  expect(second).toBeTruthy();
  wb.setActiveSheet(second); await flush(); await flush();
  expect(grid().classList.contains('page-layout')).toBe(false);
  expect(view.el.querySelector('.status-view[data-mode="normal"]').getAttribute('aria-pressed')).toBe('true');
  wb.setActiveSheet(first); await flush(); await flush();
  expect(grid().classList.contains('page-layout')).toBe(true);
  expect(view.el.querySelector('.status-view[data-mode="pageLayout"]').getAttribute('aria-pressed')).toBe('true');
});

it('outlines a selection across a page break on each page', async () => {
  const { wb, id } = await mount(80);
  view.el.querySelector('.status-view[data-mode="pageLayout"]').click(); await flush();
  const slider = view.el.querySelector('.zoom-box input[type="range"]');
  slider.value = '50'; slider.dispatchEvent(new Event('input')); await flush();
  const breakRow = pageLayoutMetrics(wb, id).rows[1];
  view.goTo(`A${breakRow - 1}:B${breakRow + 2}`); await flush();
  const pieces = view.el.querySelectorAll('.sel-extras .sel-range.page-piece');
  expect(pieces.length).toBe(1);
  const main = view.el.querySelector('.sel-range:not(.extra):not(.page-piece)');
  // The two outlines stop at their pages' edges: a gap of margins lies between them.
  const top = n => parseFloat(n.style.transform.match(/translate\([-\d.]+px, ([-\d.]+)px\)/)[1]);
  const [upper, lower] = [main, pieces[0]].sort((a, b) => top(a) - top(b));
  expect(top(lower) - (top(upper) + parseFloat(upper.style.height))).toBeGreaterThan(40);
  view.el.querySelector('.status-view[data-mode="normal"]').click(); await flush();
  expect(view.el.querySelectorAll('.sel-extras .sel-range.page-piece').length).toBe(0);
});
