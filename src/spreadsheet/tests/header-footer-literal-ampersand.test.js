// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sectionEditText, sectionStoredText } from '../src/ui/page-layout.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { expandPrintText, printSheet } from '../src/ui/print.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// In a header or footer & starts a code, &D the date among them; an ampersand of the text is kept doubled (&&). Typed
// as it reads, "R&D" in Page Layout's header sections or the Print dialog was kept as R and the date code: the
// section reopened as R&[Date] and printed the date. What is typed is now kept with its ampersands doubled, fields
// typed as &[Date] and the like stay codes, and a file's && is edited as the one ampersand it is.
vi.mock('../src/ui/print.js', async (original) => ({ ...await original(), printSheet: vi.fn(async () => true) }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); printSheet.mockClear(); });

it('keeps an ampersand typed in a header section as text', () => {
  const stored = sectionStoredText('R&D, AT&T & Q&A &[Page]');
  expect(stored).toBe('R&&D, AT&&T && Q&&A &P');
  expect(expandPrintText(stored, { page: 3, tab: 'Sheet1' })).toBe('R&D, AT&T & Q&A 3');
  expect(sectionEditText(stored)).toBe('R&D, AT&T & Q&A &[Page]');
  // A section is one part: &L typed in it is text, not the start of another part.
  expect(sectionStoredText('P&L')).toBe('P&&L');
});

it("edits a file's doubled ampersand as one and keeps its formatting codes", () => {
  const raw = '&"Arial,Bold"&12R&&D &P&B';
  const edit = sectionEditText(raw);
  expect(edit).toBe('&"Arial,Bold"&12R&D &[Page]&B');
  expect(sectionStoredText(edit, raw)).toBe(raw);
  // The same letters typed anew are text: a code is kept only where the section had it.
  expect(sectionStoredText('R&B', '')).toBe('R&&B');
});

it('keeps an ampersand typed in the Print dialog as text, and its &L, &C and &R as parts', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'x');
  wb.setPrintSettings(id, { ...wb.sheet(id).printSettings, footer: '&LS&&P 500&RPage &P' });
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} }, doc: { name: 'Budget' } });
  const header = document.querySelector('[aria-label="Header text"]');
  const footer = document.querySelector('[aria-label="Footer text"]');
  expect(footer.value).toBe('&LS&P 500&RPage &[Page]');
  header.value = '&LR&D&R&[Date]';
  header.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.print-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(printSheet).toHaveBeenCalled());
  const opts = printSheet.mock.calls[0][3];
  expect(opts.header).toBe('&LR&&D&R&D');
  expect(opts.footer).toBe('&LS&&P 500&RPage &P');
  expect(wb.sheet(id).printSettings.header).toBe('&LR&&D&R&D');
});
