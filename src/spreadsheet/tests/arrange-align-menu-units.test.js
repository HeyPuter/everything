import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { alignMenu } from '../src/ui/arrange-ribbon.js';

// A group aligns and distributes as one object, but Align ▸ Align Left and Distribute counted its members:
// one group of three selected offered every alignment and both distributions, each doing nothing.
function menuFor(groups) {
  const wb = new Workbook(), id = wb.activeSheetId, ids = [];
  for (const size of groups) {
    const members = Array.from({ length: size }, (_, i) => wb.addChart(id, { type: 'text', text: `T${ids.length + i}`, anchor: { r: 2 * (ids.length + i), c: i }, w: 80, h: 30 }));
    if (size > 1) wb.groupObjects(id, members);
    ids.push(...members);
  }
  const items = alignMenu({ wb, sheetId: () => id, grid: { selectedCharts: ids }, flags: () => ({}) });
  return label => items.find(i => i.label === label).disabled;
}

it('offers Align for two objects or groups and Distribute for three, counting a group once', () => {
  let disabled = menuFor([3]);
  expect([disabled('Align Left'), disabled('Distribute Horizontally')]).toEqual([true, true]);
  disabled = menuFor([2, 1]);
  expect([disabled('Align Left'), disabled('Distribute Vertically')]).toEqual([false, true]);
  disabled = menuFor([2, 1, 1]);
  expect([disabled('Align Left'), disabled('Distribute Vertically')]).toEqual([false, false]);
});
