// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  // A desktop window: the phone query does not match.
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  vi.spyOn(P, 'hasAI').mockReturnValue(true);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy();
  view = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function mount() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb: doc.wb, id: doc.wb.activeSheetId };
}

it('opens beside the sheet by default and toggles from Ctrl+J', async () => {
  await mount();
  const panel = view.el.querySelector('.ai-panel');
  expect(panel.hidden).toBe(false);
  view.el.querySelector('.grid-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }));
  expect(panel.hidden).toBe(true);
  view.el.querySelector('.grid-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }));
  expect(panel.hidden).toBe(false);
});

it('attaches a file dropped on the assistant, open or collapsed, and leaves other drops to the sheet', async () => {
  await mount();
  const panel = view.el.querySelector('.ai-panel');
  const rail = view.el.querySelector('.ai-rail');
  const box = { left: 900, right: 1280, top: 48, bottom: 800, width: 380, height: 752 };
  panel.getBoundingClientRect = () => box;
  rail.getBoundingClientRect = () => ({ left: 1240, right: 1280, top: 48, bottom: 800, width: 40, height: 752 });
  const receipt = new File(['a,b'], 'receipt.csv');
  expect(view.dragOver(1000, 300)).toBe(true);
  expect(panel.classList.contains('ai-drop')).toBe(true);
  expect(view.dragOver(100, 300)).toBe(false);
  expect(panel.classList.contains('ai-drop')).toBe(false);
  await view.acceptDrop(receipt, { files: [receipt], x: 1000, y: 300 });
  expect([...panel.querySelectorAll('.ai-tray-item')].map((n) => n.textContent)).toEqual(['receipt.csv']);
  // The message the file goes with is written next.
  await vi.advanceTimersByTimeAsync(1);
  expect(document.activeElement).toBe(panel.querySelector('.ai-input'));
  panel.querySelector('[aria-label="Collapse the assistant"]').click();
  const notes = new File(['x'], 'notes.txt');
  await view.acceptDrop(notes, { files: [notes], x: 1250, y: 300 });
  expect(panel.hidden).toBe(false);
  expect(panel.querySelectorAll('.ai-tray-item')).toHaveLength(2);
  // Over the sheet, a file is the sheet's, which says it cannot open this one.
  toast.mockClear();
  const song = new File(['x'], 'song.mp3');
  await view.acceptDrop(song, { files: [song], x: 100, y: 300 });
  expect(panel.querySelectorAll('.ai-tray-item')).toHaveLength(2);
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Cannot open song.mp3/), expect.anything());
});

it('collapses to a strip beside the sheet that expands it again', async () => {
  await mount();
  const panel = view.el.querySelector('.ai-panel');
  const rail = view.el.querySelector('.ai-rail');
  // Beside the ribbon, under the title row that holds the menus.
  expect(panel.parentElement.querySelector('.editor-main .ribbon')).not.toBeNull();
  expect(view.el.querySelector('.editor-header .menubar')).not.toBeNull();
  expect(rail.hidden).toBe(true);
  panel.querySelector('[aria-label="Collapse the assistant"]').click();
  expect(panel.hidden).toBe(true);
  expect(rail.hidden).toBe(false);
  rail.click();
  expect(panel.hidden).toBe(false);
  expect(rail.hidden).toBe(true);
  expect(view.el.querySelector('.ai-toggle')).toBeNull();
});

it('leaves a cell being typed in alone, and makes its change once the entry is done', async () => {
  const { wb, id } = await mount();
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
    if (n++ === 0) yield { type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C3', values: [['from AI']] } };
    else yield { type: 'text', text: 'Done.' };
  })());
  const input = view.el.querySelector('.ai-input');
  input.value = 'Write in C3';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // The user starts typing into A1 before the assistant's change comes in.
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', bubbles: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = 'Hel';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(wb.getCell(id, 0, 0)).toBeFalsy(); // not committed for the user
  expect(wb.getCell(id, 2, 2)).toBeFalsy(); // the change waits
  expect(view.el.querySelector('.ai-step-note').textContent).toMatch(/finish the cell/);
  editor.value = 'Hello';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(wb.getValue(id, 0, 0)).toBe('Hello');
  expect(wb.getValue(id, 2, 2)).toBe('from AI');
});

it('selects on another sheet only once the entry being typed is done', async () => {
  const { wb, id } = await mount();
  const other = wb.addSheet('Other').id;
  wb.setActiveSheet(id);
  await vi.advanceTimersByTimeAsync(1);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
    if (n++ === 0) { await gate; yield { type: 'tool', id: 's', name: 'select_range', input: { range: 'Other!D10' } }; } else yield { type: 'text', text: 'There.' };
  })());
  const input = view.el.querySelector('.ai-input');
  input.value = 'Show me Other!D10';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', bubbles: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = 'Hel';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  release();
  await vi.advanceTimersByTimeAsync(50);
  // Not committed for the user, nor taken to another sheet mid-word.
  expect(wb.getCell(id, 0, 0)).toBeFalsy();
  expect(wb.activeSheetId).toBe(id);
  expect(document.activeElement).toBe(editor);
  expect(view.el.querySelector('.ai-step-note').textContent).toMatch(/finish the cell/);
  editor.value = 'Hello';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(wb.getValue(id, 0, 0)).toBe('Hello');
  expect(wb.activeSheetId).toBe(other);
});

it('takes F6 into the assistant to its message box', async () => {
  await mount();
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  // From the grid the next regions are the sheet tabs and the status bar, then the assistant.
  for (let i = 0; i < 6 && !view.el.querySelector('.ai-panel').contains(document.activeElement); i++) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
  }
  expect(document.activeElement.classList.contains('ai-input')).toBe(true);
});

it('says nothing of a hidden sheet it changed, where the reply cannot show the change', async () => {
  const { wb } = await mount();
  const hidden = wb.addSheet('Lists');
  wb.setActiveSheet(wb.sheets[0].id);
  wb.sheet(hidden.id).hidden = true;
  await vi.advanceTimersByTimeAsync(1);
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
    if (n++ === 0) yield { type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'Lists!A1', values: [['Red']] } };
    else yield { type: 'text', text: 'Added Red to Lists.' };
  })());
  const input = view.el.querySelector('.ai-input');
  input.value = 'Add Red to the list';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(100);
  expect(wb.getValue(hidden.id, 0, 0)).toBe('Red');
  expect(toast.mock.calls.map(([message]) => message).join('\n')).not.toMatch(/is hidden/);
});

it('does not tell the user to unhide a sheet the assistant tried to select on', async () => {
  const { wb } = await mount();
  const hidden = wb.addSheet('Lists');
  wb.setActiveSheet(wb.sheets[0].id);
  wb.sheet(hidden.id).hidden = true;
  await vi.advanceTimersByTimeAsync(1);
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
    if (n++ === 0) yield { type: 'tool', id: 's', name: 'select_range', input: { range: 'Lists!A1' } };
    else yield { type: 'text', text: 'Lists is hidden.' };
  })());
  const input = view.el.querySelector('.ai-input');
  input.value = 'Show me the list';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(100);
  expect(toast.mock.calls.map(([message]) => message).join('\n')).not.toMatch(/is hidden/);
  expect(view.el.querySelector('.ai-step-error .ai-step-note').textContent).toMatch(/Lists is hidden/);
  expect(wb.activeSheetId).toBe(wb.sheets[0].id);
});

it('does not claim to undo a reply while a cell is being typed in', async () => {
  const { wb, id } = await mount();
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() {
    if (n++ === 0) yield { type: 'tool', id: 'w', name: 'write_cells', input: { start_cell: 'C3', values: [['from AI']] } };
    else yield { type: 'text', text: 'Done.' };
  })());
  const input = view.el.querySelector('.ai-input');
  input.value = 'Write in C3';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(wb.getValue(id, 2, 2)).toBe('from AI');
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', bubbles: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = 'Hi';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  view.el.querySelector('.ai-undo').click();
  await vi.advanceTimersByTimeAsync(50);
  expect(wb.getValue(id, 2, 2)).toBe('from AI');
  expect(view.el.querySelector('.ai-foot-summary').textContent).toBe('1 change made');
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Finish the cell/), expect.anything());
  // Once the entry is done, the reply's Undo takes back its change (and only its change).
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await vi.advanceTimersByTimeAsync(10);
  view.el.querySelector('.ai-undo').click();
  await vi.advanceTimersByTimeAsync(10);
  expect(wb.getCell(id, 2, 2)).toBeFalsy();
  expect(view.el.querySelector('.ai-foot-summary').textContent).toBe('1 change undone');
});

it('shows on its collapsed strip a reply under way, and says when it ends', async () => {
  await mount();
  let release;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() { await new Promise((r) => { release = r; }); yield { type: 'text', text: 'Done.' }; })());
  const rail = view.el.querySelector('.ai-rail');
  const input = view.el.querySelector('.ai-input');
  input.value = 'Summarize';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('[aria-label="Collapse the assistant"]').click();
  expect(view.el.querySelector('.ai-panel').hidden).toBe(true);
  expect(rail.hidden).toBe(false);
  expect(rail.classList.contains('busy')).toBe(true);
  expect(rail.title).toMatch(/working/);
  toast.mockClear();
  release();
  await vi.advanceTimersByTimeAsync(50);
  expect(rail.classList.contains('busy')).toBe(false);
  expect(toast).toHaveBeenCalledWith('The assistant has answered', expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }));
  toast.mock.calls.at(-1)[1].action.onClick();
  expect(view.el.querySelector('.ai-panel').hidden).toBe(false);
});

it('says nothing more of a reply that ends with the panel open', async () => {
  await mount();
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (async function* s() { yield { type: 'text', text: 'Done.' }; })());
  toast.mockClear();
  const input = view.el.querySelector('.ai-input');
  input.value = 'Summarize';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(view.el.querySelector('.ai-assistant').textContent).toContain('Done.');
  expect(toast).not.toHaveBeenCalledWith('The assistant has answered', expect.anything());
});
