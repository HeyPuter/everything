// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Doc, publishing, versioning } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { CLOSE_TITLE, createCloseWindow } from '../src/views/window-close.js';
import { closeAllModals } from '../src/ui/modal.js';

/**
 * The Puter desktop window's close button: edits are written first, and a never-saved document (which inside
 * the desktop waits for a first Save to ask where it goes) asks whether to save it before the window goes.
 */

let files, dialogs;
function installPuter() {
  files = new Map();
  dialogs = [];
  globalThis.puter = {
    env: 'app',
    exit: vi.fn(),
    fs: {
      write: vi.fn(async (path, blob) => { files.set(path, blob); return { path, name: path.split('/').pop() }; }),
      stat: vi.fn(async (path) => { if (!files.has(path)) throw Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' }); return { path }; }),
      readdir: async () => [],
    },
    ui: {
      onWindowClose: vi.fn(),
      showSaveFilePicker: vi.fn((blob, suggestedName) => {
        let answer;
        const answered = new Promise((resolve) => { answer = resolve; });
        dialogs.push({
          suggestedName,
          save() { const path = `~/Desktop/${suggestedName}`; files.set(path, blob); answer({ name: suggestedName, path }); },
          cancel() { answer(undefined); },
        });
        const saved = answered.then((item) => item || new Promise(() => {}));
        saved.undefinedOnCancel = answered;
        return saved;
      }),
    },
  };
}

const question = () => [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')].find((d) => d.getAttribute('aria-label') === CLOSE_TITLE) || null;
const press = (label) => [...question().querySelectorAll('button')].find((b) => b.textContent === label).click();

let shown, leaveDialog, closeWindow;
function editorWith(doc) {
  shown = { kind: 'editor', view: { doc, engine: null, unsaveable: false, flush: () => doc.flush().catch(() => false) } };
  leaveDialog = vi.fn(async () => 'stay');
  closeWindow = createCloseWindow({ open: () => shown, leaveDialog, exit: P.exitApp });
  return doc;
}
const newDocument = () => { const doc = Doc.blank(); doc.attach(async () => new Blob(['typed'])); doc.changed(); return editorWith(doc); };

beforeEach(() => {
  versioning.enabled = false;
  publishing.enabled = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  installPuter();
});
afterEach(() => {
  shown?.view.doc?.destroy();
  vi.unstubAllGlobals();
  closeAllModals();
  document.body.replaceChildren();
  delete globalThis.puter;
});

describe('closing the Puter window', () => {
  it('takes over the close button only inside the desktop, where the window can be closed', () => {
    const handler = () => {};
    expect(P.onWindowClose(handler)).toBe(true);
    expect(puter.ui.onWindowClose).toHaveBeenCalledWith(handler);
    delete puter.exit;
    expect(P.onWindowClose(handler)).toBe(false);
    puter.env = 'web';
    puter.exit = vi.fn();
    expect(P.onWindowClose(handler)).toBe(false);
  });

  it('closes at once when nothing is waiting to be saved', async () => {
    editorWith(Doc.blank());
    expect(await closeWindow()).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
    expect(question()).toBeNull();
    expect(dialogs).toHaveLength(0);
  });

  it('closes at once from the documents screen', async () => {
    shown = { kind: 'home', view: {} };
    closeWindow = createCloseWindow({ open: () => shown, leaveDialog: vi.fn(), exit: P.exitApp });
    expect(await closeWindow()).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
  });

  it('writes a saved document\'s pending edits first, without asking', async () => {
    files.set('Documents/Report.docx', new Blob(['old']));
    const doc = editorWith(new Doc({ name: 'Report', path: 'Documents/Report.docx' }));
    const edited = new Blob(['edited']);
    doc.attach(async () => edited);
    doc.changed();
    expect(await closeWindow()).toBe(true);
    expect(files.get('Documents/Report.docx')).toBe(edited);
    expect(question()).toBeNull();
    expect(dialogs).toHaveLength(0);
    expect(puter.exit).toHaveBeenCalledOnce();
  });

  it('asks about a never-saved document, and Cancel keeps the window open', async () => {
    newDocument();
    const closing = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain('“Untitled document” has not been saved yet.');
    expect([...question().querySelectorAll('.row button')].map((b) => b.textContent)).toEqual(['Cancel', 'Close without saving', 'Save…']);
    // The close button pressed again while the question is up asks nothing more.
    closeWindow();
    expect(document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')).toHaveLength(1);
    press('Cancel');
    expect(await closing).toBe(false);
    expect(puter.exit).not.toHaveBeenCalled();
    expect(dialogs).toHaveLength(0);
    expect(shown.view.doc.dirty).toBe(true);
  });

  it('closes without saving when asked to', async () => {
    newDocument();
    const closing = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Close without saving');
    expect(await closing).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
    expect(dialogs).toHaveLength(0);
    expect(files.size).toBe(0);
  });

  it('a Save dialog closed without an answer (Esc) keeps the window open, and the close button asks again', async () => {
    const doc = newDocument();
    const closing = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Save…');
    await vi.waitFor(() => expect(dialogs).toHaveLength(1));
    // Esc in Puter's dialog sends the app no answer; the desktop gives the window the focus back.
    await new Promise((resolve) => setTimeout(resolve, P.DIALOG_FOCUS_MS + 20));
    window.dispatchEvent(new MessageEvent('message', { data: { msg: 'focus' }, source: window }));
    expect(await closing).toBe(false);
    expect(puter.exit).not.toHaveBeenCalled();
    expect(doc.dirty).toBe(true);
    // The close button works again: it asks once more.
    const again = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Close without saving');
    expect(await again).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
  });

  it('Save… opens Puter\'s Save dialog and closes once the document is saved', async () => {
    const doc = newDocument();
    const closing = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Save…');
    await vi.waitFor(() => expect(dialogs).toHaveLength(1));
    expect(dialogs[0].suggestedName).toBe('Untitled document.docx');
    expect(puter.exit).not.toHaveBeenCalled();
    dialogs[0].save();
    expect(await closing).toBe(true);
    expect(doc.path).toBe('~/Desktop/Untitled document.docx');
    expect(files.has('~/Desktop/Untitled document.docx')).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
  });

  it('stays open when the Save dialog opened from Save… is cancelled', async () => {
    const doc = newDocument();
    const closing = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Save…');
    await vi.waitFor(() => expect(dialogs).toHaveLength(1));
    dialogs[0].cancel();
    expect(await closing).toBe(false);
    expect(puter.exit).not.toHaveBeenCalled();
    expect(doc.path).toBeNull();
    expect(doc.dirty).toBe(true);
    expect(leaveDialog).not.toHaveBeenCalled();
    // Closing again asks again.
    const again = closeWindow();
    await vi.waitFor(() => expect(question()).not.toBeNull());
    press('Cancel');
    expect(await again).toBe(false);
  });

  it('asks, as leaving does, when a saved document\'s edits cannot be written', async () => {
    files.set('Documents/Report.docx', new Blob(['old']));
    const doc = editorWith(new Doc({ name: 'Report', path: 'Documents/Report.docx' }));
    doc.attach(async () => new Blob(['edited']));
    doc.changed();
    puter.fs.write.mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await closeWindow()).toBe(false);
    expect(leaveDialog).toHaveBeenCalledWith(doc, { unsaveable: false });
    expect(puter.exit).not.toHaveBeenCalled();
    leaveDialog.mockResolvedValueOnce('leave');
    puter.fs.write.mockRejectedValueOnce(new Error('quota'));
    expect(await closeWindow()).toBe(true);
    expect(puter.exit).toHaveBeenCalledOnce();
  });
});
