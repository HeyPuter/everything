// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { openVersionHistory } from '../src/ui/versions.js';
import { closeAllModals } from '../src/ui/modal.js';
import { installMockPuter } from './helpers/mock-puter.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { workbookToXlsx } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';

// A save writes the history's snapshot in the background. Version history opened a moment after (File ▸ Version
// history on a spreadsheet that was just saved, or saved by opening it) listed the history before the snapshot
// landed: it read "No versions yet" and stayed so, and a version saved by hand on the strength of that doubled it.
let doc;
beforeAll(async () => { await workbookToXlsx(new Workbook()); });
beforeEach(() => {
  installMockPuter();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  doc?.destroy();
  doc = null;
  vi.unstubAllGlobals();
  delete globalThis.puter;
  document.body.replaceChildren();
});

const until = async (test) => { for (let i = 0; i < 400 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); return test(); };

it('lists the snapshot of the save just made', async () => {
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.save()).toBe(true);
  const { panel } = openVersionHistory(doc);
  expect(await until(() => !/Loading/.test(panel.querySelector('.version-list').textContent))).toBe(true);
  expect(panel.querySelectorAll('.version-row')).toHaveLength(1);
  expect(panel.textContent).not.toContain('No versions yet');
});
