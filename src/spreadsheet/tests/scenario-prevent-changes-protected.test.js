// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { saveScenario, deleteScenario } from '../src/core/scenarios.js';
import { openScenarioManager } from '../src/ui/scenario-manager.js';
import { closeAllModals } from '../src/ui/modal.js';

// A scenario's Prevent changes and Hide boxes did nothing: on a protected sheet the scenario could still be
// edited and deleted, and a hidden one was listed. As in Excel, they now take effect while the sheet is protected.
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  const cells = [{ r: 0, c: 0 }];
  saveScenario(wb, id, { name: 'Kept', cells, values: [5], locked: true });
  saveScenario(wb, id, { name: 'Open', cells, values: [6], locked: false });
  saveScenario(wb, id, { name: 'Secret', cells, values: [7], locked: false, hidden: true });
  return { wb, id, cells };
}

it('refuses to change or delete a scenario with Prevent changes while its sheet is protected', () => {
  const { wb, id, cells } = book();
  wb.setSheetProtected(id, true);
  expect(deleteScenario(wb, id, 'Kept')).toBe(false);
  expect(saveScenario(wb, id, { name: 'Kept', cells, values: [9] }, 'Kept')).toMatch(/protected/);
  expect(wb.sheet(id).scenarios.list.find((s) => s.name === 'Kept').values).toEqual([5]);
  expect(deleteScenario(wb, id, 'Open')).toBe(true);
  wb.setSheetProtected(id, false);
  expect(deleteScenario(wb, id, 'Kept')).toBe(true);
});

it('lists no hidden scenario, and offers no Edit or Delete for a kept one, on a protected sheet', () => {
  const { wb, id } = book();
  wb.setSheetProtected(id, true);
  const { panel } = openScenarioManager({ wb, sheetId: () => id, grid: { focus() {} } });
  const list = panel.querySelector('[aria-label="Scenarios"]');
  expect([...list.options].map((o) => o.value)).toEqual(['Kept', 'Open']);
  const button = (text) => [...panel.querySelectorAll('button')].find((b) => b.textContent.startsWith(text));
  list.value = 'Kept'; list.dispatchEvent(new Event('change'));
  expect([button('Edit').disabled, button('Delete').disabled, button('Show').disabled]).toEqual([true, true, false]);
  list.value = 'Open'; list.dispatchEvent(new Event('change'));
  expect([button('Edit').disabled, button('Delete').disabled]).toEqual([false, false]);
});
