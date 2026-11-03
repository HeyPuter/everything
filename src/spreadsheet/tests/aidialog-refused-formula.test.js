// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openAiDialog } from '../src/ui/aidialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';
import * as P from '../src/lib/puter.js';
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); vi.spyOn(P, 'canAI').mockReturnValue(true); document.body.innerHTML = '<div id="app"></div>'; toast.mockClear(); });
afterEach(() => { closeAllModals(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// A written formula Excel refuses as typed (=ROUND(A1), a function given the wrong number of arguments) went
// into the cell as the text of the formula, and the dialog closed saying "Formula written into A1": the user
// found "=ROUND(A1)" in the cell and nothing that calculated. The dialog now says what is wrong and stays open.
const insert = async (wb, id, reply) => {
  vi.spyOn(P, 'aiChat').mockResolvedValue(reply);
  const { panel } = openAiDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } }, { mode: 'write' });
  panel.querySelector('textarea').value = 'round it';
  panel.querySelector('form').requestSubmit();
  await new Promise((res) => setTimeout(res, 0));
  [...panel.querySelectorAll('button')].find((b) => /Insert into/.test(b.textContent) && !b.hidden).click();
  return panel;
};

it('says why a formula Excel refuses cannot be inserted, and writes nothing', async () => {
  const wb = new Workbook(); const id = wb.activeSheetId;
  const panel = await insert(wb, id, '=ROUND(B1)');
  expect(wb.getCell(id, 0, 0)).toBeFalsy();
  expect(toast).not.toHaveBeenCalled();
  expect(panel.isConnected).toBe(true);
  expect(panel.querySelector('[role="alert"]').textContent).toBe('ROUND needs 2 arguments. Ask again for another formula.');
});

it('still inserts one Excel takes', async () => {
  const wb = new Workbook(); const id = wb.activeSheetId;
  await insert(wb, id, '=ROUND(B1,0)');
  expect(wb.getCell(id, 0, 0).f).toBe('ROUND(B1,0)');
  expect(toast.mock.calls.map((c) => c[0])).toEqual(['Formula written into A1']);
});
