import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Protect Workbook locks the sheets: none is added, removed, renamed, moved, hidden or recoloured. Undo and Redo went
// round the lock: a sheet added before the workbook was protected was removed by Ctrl+Z. A step that would change the
// sheets is now refused with the protection notice, and stays to be undone once the workbook is unprotected.

function watch(wb) {
  const notices = [];
  wb.addEventListener('change', (e) => { if (e.detail.type === 'protected' && e.detail.structure) notices.push(e.detail); });
  return notices;
}

it('refuses to undo or redo a change to the sheets while the structure is protected', () => {
  const wb = new Workbook();
  const notices = watch(wb);
  const added = wb.addSheet('Plan');
  wb.setStructureProtected(true);
  expect(wb.undo()).toBe(false);
  expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Plan']);
  expect(notices.length).toBe(1);
  expect(wb.canUndo()).toBe(true);
  // Unprotected, the step is there to undo, and once undone it is refused as a redo while protected again.
  wb.setStructureProtected(false);
  expect(wb.undo()).toBe(true);
  expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1']);
  wb.setStructureProtected(true);
  expect(wb.redo()).toBe(false);
  expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1']);
  expect(wb.canRedo()).toBe(true);
  wb.setStructureProtected(false);
  expect(wb.redo()).toBe(true);
  expect(wb.sheet(added.id)?.name).toBe('Plan');
});

it('guards every kind of change to the sheets, also inside a transaction, and lets cell steps through', () => {
  const wb = new Workbook();
  const first = wb.activeSheetId;
  const second = wb.addSheet('Data').id;
  wb.setActiveSheet(first);
  const steps = [
    () => wb.renameSheet(second, 'Renamed'),
    () => wb.moveSheet(second, 0),
    () => wb.setSheetHidden(second, true),
    () => wb.setSheetColor(second, '#ff0000'),
    () => wb.deleteSheet(second),
    () => wb.duplicateSheet(first),
    () => wb.transaction('Several', () => { wb.setInput(first, 0, 0, 'x'); wb.insertRows(first, 0, 1); wb.addSheet('Inner'); }),
  ];
  for (const step of steps) {
    step();
    const before = JSON.stringify(wb.sheets.map((s) => [s.id, s.name, !!s.hidden, s.color || null]));
    wb.setStructureProtected(true);
    expect(wb.undo()).toBe(false);
    expect(JSON.stringify(wb.sheets.map((s) => [s.id, s.name, !!s.hidden, s.color || null]))).toBe(before);
    wb.setStructureProtected(false);
    expect(wb.undo()).toBe(true);
  }
  wb.setStructureProtected(true);
  wb.setInput(first, 2, 2, 'typed');
  expect(wb.undo()).toBe(true);
  expect(wb.getValue(first, 2, 2)).toBe(null);
  wb.insertRows(first, 0, 1);
  expect(wb.undo()).toBe(true);
});

it('refuses an undo of a sheet change in a shared workbook while the structure is protected', async () => {
  const wb = new Workbook({ sheets: [{ name: 'S' }, { name: 'T' }] });
  const rep = new Replica(wb);
  rep.receive([]);
  const notices = watch(wb);
  const t = wb.sheets[1].id;
  wb.deleteSheet(t);
  wb.setStructureProtected(true);
  await Promise.resolve();
  expect(wb.undo()).toBe(false);
  expect(wb.sheets.map((s) => s.name)).toEqual(['S']);
  expect(notices.length).toBe(1);
  expect(wb.canUndo()).toBe(true);
  wb.setStructureProtected(false);
  await Promise.resolve();
  expect(wb.undo()).toBe(true);
  expect(wb.sheets.map((s) => s.name)).toEqual(['S', 'T']);
});
