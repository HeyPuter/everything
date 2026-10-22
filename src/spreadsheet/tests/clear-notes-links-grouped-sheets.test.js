// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// With Jan and Feb grouped, Clear Comments and Notes, Clear Hyperlinks and Clear All took off the active sheet's notes
// and links alone: Feb's note stayed under its cleared cell, and a link Feb had where Jan had none stayed too. Each
// grouped sheet now loses its own, as Clear takes each sheet's contents, in one undo step.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Months' });
  const wb = doc.wb;
  const jan = wb.activeSheetId;
  const feb = wb.addSheet().id;
  for (const id of [jan, feb]) { wb.setInput(id, 1, 0, 'total'); wb.setNote(id, 1, 0, `note ${id}`); }
  wb.setInput(feb, 2, 1, 'site');
  wb.setLink(feb, 2, 1, 'https://example.com', 'site');
  wb.setNote(feb, 2, 1, 'only on Feb');
  wb.setActiveSheet(jan);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A2:B3');
  wb.groupSheets([jan, feb]);
  return { wb, jan, feb, view };
}

it('clears the notes of every grouped sheet, in one undo step', async () => {
  const { wb, jan, feb, view } = await mount();
  await view.run('clearNotes');
  expect(wb.getNote(jan, 1, 0)).toBeFalsy();
  expect(wb.getNote(feb, 1, 0)).toBeFalsy();
  expect(wb.getNote(feb, 2, 1)).toBeFalsy();
  wb.undo();
  expect(wb.getNote(feb, 1, 0)).toBeTruthy();
  expect(wb.getNote(jan, 1, 0)).toBeTruthy();
  view.destroy();
});

it('clears the links of every grouped sheet, keeping each one\'s text', async () => {
  const { wb, feb, view } = await mount();
  await view.run('clearLinks');
  expect(wb.linkAt(feb, 2, 1)).toBeFalsy();
  expect(wb.getValue(feb, 2, 1)).toBe('site');
  view.destroy();
});

it('takes the notes of every grouped sheet with Clear All', async () => {
  const { wb, jan, feb, view } = await mount();
  await view.run('clearAll');
  expect(wb.getValue(feb, 1, 0)).toBe(null);
  expect(wb.getNote(feb, 1, 0)).toBeFalsy();
  expect(wb.getNote(jan, 1, 0)).toBeFalsy();
  view.destroy();
});

it('takes every grouped sheet\'s conditional formatting off with Clear Formats and Clear All', async () => {
  for (const cmd of ['clearFormat', 'clearAll']) {
    const { wb, jan, feb, view } = await mount();
    wb.ungroupSheets();
    for (const id of [jan, feb]) wb.addRule(id, { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'cellIs', op: 'gt', value: '0', style: { bg: '#ff0000' } });
    expect(wb.sheet(feb).rules.length).toBe(1);
    wb.groupSheets([jan, feb]);
    view.goTo('Sheet1!A1:A5');
    await view.run(cmd);
    expect(wb.sheet(jan).rules.length).toBe(0);
    expect(wb.sheet(feb).rules.length).toBe(0);
    wb.undo();
    expect(wb.sheet(feb).rules.length).toBe(1);
    view.destroy();
    document.body.replaceChildren();
  }
});
