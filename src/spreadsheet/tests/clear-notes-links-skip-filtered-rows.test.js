// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Clear All over a filtered list cleared the contents of the rows on show only, as Excel does, but took the notes,
// comments and links of the rows the filter hides as well: a hidden row kept its value and lost its note. Clear
// Comments and Notes and Clear Hyperlinks did the same. The rows a filter hides now keep theirs.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Filtered' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) { wb.setInput(id, r, 0, `item ${r}`); wb.setNote(id, r, 0, `note ${r}`); }
  wb.setLink(id, 2, 1, 'https://example.com', 'site');
  wb.setLink(id, 3, 1, 'https://example.org', 'other');
  wb.sheet(id).filterHidden.add(2);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A1:B4');
  return { wb, id, view };
}

it('leaves the notes of the rows a filter hides with Clear All and Clear Notes', async () => {
  for (const cmd of ['clearAll', 'clearNotes']) {
    const { wb, id, view } = await mount();
    await view.run(cmd);
    expect(wb.getNote(id, 1, 0)).toBeFalsy();
    expect(wb.getNote(id, 2, 0)).toBe('note 2');
    if (cmd === 'clearAll') expect(wb.getValue(id, 2, 0)).toBe('item 2');
    view.destroy();
    document.body.replaceChildren();
  }
});

it('leaves the links of the rows a filter hides with Clear Hyperlinks', async () => {
  const { wb, id, view } = await mount();
  await view.run('clearLinks');
  expect(wb.linkAt(id, 3, 1)).toBeFalsy();
  expect(wb.linkAt(id, 2, 1)).toBeTruthy();
  view.destroy();
});
