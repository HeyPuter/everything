// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { draftKey, loadDraft } from '../src/lib/drafts.js';
import { closeAllModals } from '../src/ui/modal.js';
import { installMockPuter } from './helpers/mock-puter.js';

// jsdom's Blob has no arrayBuffer(); reading a file back needs one.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this); });
  };
}

let view;
let mock;
// SheetJS is loaded on first use with a real dynamic import; warm it up so no test waits on it.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
  mock = installMockPuter();
});
afterEach(() => {
  closeAllModals();
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.puter;
  document.body.replaceChildren();
});

const PATH = 'Spreadsheets/Budget.xlsx';
const cellA1 = (wb) => wb.getValue(wb.activeSheetId, 0, 0);
const dialogs = () => [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')];
const buttons = (dialog) => [...dialog.querySelectorAll('button')].map((b) => b.textContent).filter(Boolean);
const press = (label) => [...dialogs().at(-1).querySelectorAll('button')].find((b) => b.textContent === label).click();

/**
 * A file opened here and edited, with the drive holding it as `state` when the edits are saved:
 * 'changed' (written elsewhere since, larger), 'missing' (gone), or 'unchecked' (the look-up failed at open).
 */
async function editedFile(state) {
  const bytes = await Doc.blank().toXlsxBlob();
  mock.fs.set(PATH, { blob: bytes, size: bytes.size, modified: 1 });
  const doc = new Doc({ name: 'Budget', path: PATH });
  doc.remoteModified = state === 'unchecked' ? 0 : 1000;
  doc.remoteSize = bytes.size;
  if (state === 'changed') { const theirs = new Blob([bytes, 'more']); mock.fs.set(PATH, { blob: theirs, size: theirs.size, modified: 5000 }); }
  if (state === 'unchecked') mock.fs.set(PATH, { blob: bytes, size: bytes.size, modified: 5000 });
  if (state === 'missing') mock.fs.delete(PATH);
  const onDrive = mock.fs.get(PATH)?.blob;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine');
  return { doc, onDrive };
}

// A conflict found by the save on the way out raised the conflict dialog, whose only answers were
// to overwrite the other version or to discard this one; the navigation was refused, and every
// attempt to leave asked the same again, though the local draft already made leaving safe.
it('lets the user leave with the edits kept on this device when the save on the way out finds the file changed elsewhere', async () => {
  const { doc, onDrive } = await editedFile('changed');
  const leaving = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  const [dialog] = dialogs();
  expect(dialog.querySelector('.modal-title').textContent).toBe('This file changed elsewhere');
  expect(dialog.textContent).toContain('Leave, and they stay on this device');
  expect(buttons(dialog)).toEqual(['Keep editing', 'Leave', 'Overwrite with mine']);
  press('Leave');
  expect(await leaving).toBe(true);
  expect(dialogs()).toHaveLength(0);
  expect(mock.fs.get(PATH).blob).toBe(onDrive); // theirs stands
  expect(loadDraft(draftKey(PATH))?.workbook.sheets[0].cells['0,0'].v).toBe('mine'); // the edits are kept for the next open
  view.destroy();
  view = null;
  expect(loadDraft(draftKey(PATH))).not.toBeNull();
  expect(doc.status).toBe('conflict');
});

it('keeps editing when asked to, and overwrites when asked to, from the same dialog', async () => {
  const { doc } = await editedFile('changed');
  const first = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  press('Keep editing');
  expect(await first).toBe(false);
  expect(cellA1(doc.wb)).toBe('mine');
  const second = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  press('Overwrite with mine');
  expect(await second).toBe(true);
  expect(doc.status).toBe('saved');
  const reopened = await Doc.fromPath(PATH);
  try { expect(cellA1(reopened.wb)).toBe('mine'); } finally { reopened.destroy(); }
});

// "Overwrite with mine" starts a flush of its own. The flush that started it cleared the marker that
// sends a conflict to this dialog, so a write that failed again put the question in the modal conflict
// dialog — no Leave, no Keep editing — while the navigation had already been refused, leaving
// "Reload theirs", which discards the edits, as the only way forward.
it('asks again in the leave dialog when the overwrite fails, not in the dialog that cannot leave', async () => {
  const { doc } = await editedFile('changed');
  const leaving = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  const [first] = dialogs();
  // The file's write fails; what it holds is kept in Version history first all the same (see the test below for that failing).
  const write = puter.fs.write;
  puter.fs.write = async (p, ...rest) => { if (p === PATH) throw new Error('Network request failed'); return write(p, ...rest); };
  press('Overwrite with mine');
  await vi.waitFor(() => { expect(dialogs()).toHaveLength(1); expect(dialogs()[0]).not.toBe(first); });
  expect(dialogs()[0].querySelector('.modal-title').textContent).toBe('This file changed elsewhere');
  expect(buttons(dialogs()[0])).toEqual(['Keep editing', 'Leave', 'Overwrite with mine']);
  press('Leave');
  expect(await leaving).toBe(true);
  expect(doc.status).toBe('conflict');
  expect(loadDraft(draftKey(PATH))?.workbook.sheets[0].cells['0,0'].v).toBe('mine');
});

// The leave dialog says theirs is kept in Version history; when it could not be, the overwrite went ahead regardless.
it('does not overwrite theirs on the way out when it could not be kept, unless the user says so', async () => {
  const { doc } = await editedFile('changed');
  const theirs = mock.fs.get(PATH).blob;
  const leaving = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  const write = puter.fs.write;
  puter.fs.write = async (p, ...rest) => { if (p !== PATH) throw new Error('Storage is full'); return write(p, ...rest); };
  press('Overwrite with mine');
  await vi.waitFor(() => expect(dialogs()[0]?.querySelector('.modal-title').textContent).toBe('Their version could not be kept'));
  expect(dialogs()[0].textContent).toContain('(Storage is full)');
  press('Cancel');
  expect(await leaving).toBe(false);
  expect(mock.fs.get(PATH).blob).toBe(theirs);
  expect(doc.status).toBe('conflict');
});

it('offers the same way out for a file that is gone, and for one that could not be checked', async () => {
  await editedFile('missing');
  let leaving = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  expect(dialogs()[0].querySelector('.modal-title').textContent).toBe('This file was moved or deleted');
  expect(dialogs()[0].textContent).toContain('Unsaved spreadsheets');
  expect(buttons(dialogs()[0])).toEqual(['Keep editing', 'Leave', 'Keep it here']);
  press('Leave');
  expect(await leaving).toBe(true);
  view.destroy();
  view = null;
  await editedFile('unchecked');
  leaving = view.flush();
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  expect(dialogs()[0].querySelector('.modal-title').textContent).toBe('This file could not be checked');
  expect(buttons(dialogs()[0])).toEqual(['Keep editing', 'Leave', 'Save anyway']);
  press('Save anyway');
  expect(await leaving).toBe(true);
  const reopened = await Doc.fromPath(PATH);
  try { expect(cellA1(reopened.wb)).toBe('mine'); } finally { reopened.destroy(); }
});

it('still puts the conflict dialog when the save is not on the way out', async () => {
  await editedFile('changed');
  const flushed = view.flush({ leaving: false });
  await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
  expect(buttons(dialogs()[0])).toEqual(expect.arrayContaining(['Overwrite with mine', 'Reload theirs']));
  expect(buttons(dialogs()[0])).not.toContain('Leave');
  expect(await flushed).toBe(false);
});
