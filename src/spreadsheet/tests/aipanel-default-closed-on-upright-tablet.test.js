// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { loadAiSettings } from '../src/ui/aipanel.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

/** matchMedia answering max-width queries as a window `width` px wide would. */
const windowOf = (width) => (query) => {
  const max = /max-width:\s*(\d+)px/.exec(query);
  return { matches: max ? width <= Number(max[1]) : false };
};

// The assistant opens beside the sheet unless it was closed, and waited to be asked for only on a phone. On an
// upright 768px tablet it opened at 380px over half the window, leaving the sheet a phone's width (about 390px)
// on a first visit. It now waits there too, opening by itself only where the sheet keeps at least 640px beside it.
it('waits to be asked for where it would leave the sheet narrower than 640px', () => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', windowOf(375));
  expect(loadAiSettings().open).toBe(false);
  vi.stubGlobal('matchMedia', windowOf(768));
  expect(loadAiSettings().open).toBe(false);
  vi.stubGlobal('matchMedia', windowOf(1019));
  expect(loadAiSettings().open).toBe(false);
  vi.stubGlobal('matchMedia', windowOf(1024));
  expect(loadAiSettings().open).toBe(true);
  vi.stubGlobal('matchMedia', windowOf(1440));
  expect(loadAiSettings().open).toBe(true);
});

it('still follows the person\'s own choice at any width', () => {
  localStorage.setItem('spreadsheet:ai', JSON.stringify({ openNarrow: true }));
  vi.stubGlobal('matchMedia', windowOf(768));
  expect(loadAiSettings().open).toBe(true);
  localStorage.setItem('spreadsheet:ai', JSON.stringify({ open: false }));
  vi.stubGlobal('matchMedia', windowOf(1440));
  expect(loadAiSettings().open).toBe(false);
});
