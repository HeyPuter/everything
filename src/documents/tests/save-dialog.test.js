// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Doc, AUTOSAVE_MS, RETRY_MS, publishing, versioning } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { createBackstage } from '../src/views/backstage.js';

/**
 * Inside the Puter desktop a new document is saved where the user chooses, with Puter's Save dialog, and only
 * when the user asks; elsewhere it still goes into the app folder on its own.
 */

const docx = (text) => new Blob([text], { type: P.DOCX_MIME });
const notFound = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });

let files, dialogs, clock;
/** A Puter SDK with a file system in memory and a Save dialog the test answers (dialogs[i].save / .cancel). */
function installPuter({ env = 'app', picker = true, cancelAware = true } = {}) {
  files = new Map();
  dialogs = [];
  clock = 1000;
  const fs = {
    write: vi.fn(async (path, blob, { overwrite = true, dedupeName = false } = {}) => {
      let target = path;
      if (dedupeName) for (let n = 1; files.has(target); n++) target = path.replace(/\.docx$/, ` (${n}).docx`);
      else if (!overwrite && files.has(target)) throw new Error('A file with that name already exists');
      files.set(target, blob);
      return { path: target, name: target.split('/').pop(), modified: ++clock };
    }),
    stat: vi.fn(async (path) => { if (!files.has(path)) throw notFound(); return { path, modified: clock }; }),
    read: vi.fn(async (path) => { if (!files.has(path)) throw notFound(); return files.get(path); }),
    readdir: vi.fn(async () => []),
    rename: vi.fn(async (path, name) => {
      if (!files.has(path)) throw notFound();
      const target = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
      if (files.has(target)) throw new Error('A file with that name already exists');
      files.set(target, files.get(path)); files.delete(path);
      return { path: target, name, modified: ++clock };
    }),
  };
  const ui = {};
  if (picker) {
    ui.showSaveFilePicker = vi.fn((blob, suggestedName) => {
      let answer;
      const answered = new Promise((resolve) => { answer = resolve; });
      const dialog = {
        blob, suggestedName,
        // As the desktop does: write the file, then answer with it, its path relative to the home folder.
        save(name = suggestedName) { const path = `~/Desktop/${name}`; files.set(path, blob); answer({ name, path, uid: `uid-${name}` }); },
        cancel() { answer(undefined); },
      };
      dialogs.push(dialog);
      // The SDK's own promise never settles on a cancel; undefinedOnCancel does.
      const saved = answered.then((item) => item || new Promise(() => {}));
      if (cancelAware) saved.undefinedOnCancel = answered;
      return saved;
    });
  }
  globalThis.puter = { env, fs, ui };
  return globalThis.puter;
}

/** Let the promise chains between the editor, the document and the dialog run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  versioning.enabled = false;
  publishing.enabled = false;
});
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.puter;
});

describe('the first save inside the Puter desktop', () => {
  beforeEach(() => installPuter());

  it('waits for Save: autosaves and retries neither write a file nor open the dialog', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('typed'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + RETRY_MS * 3);
    // The page going to the background, a reconnection or a sign-in ask for an autosave directly.
    expect(await doc.save({ auto: true, now: true })).toBe(false);
    expect(puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
    expect(puter.fs.write).not.toHaveBeenCalled();
    expect(doc.path).toBeNull();
    expect(doc.status).toBe('unsaved');
    doc.destroy();
  });

  it('asks where with the document name, and the document then lives in the chosen file', async () => {
    const doc = Doc.blank({ name: 'Quarterly report' });
    const paths = [];
    doc.addEventListener('path', (e) => paths.push(e.detail));
    const v1 = docx('v1'), v2 = docx('v2');
    doc.attach(async () => v1);
    doc.changed();
    const saving = doc.save();
    await settle();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].suggestedName).toBe('Quarterly report.docx');
    expect(dialogs[0].blob).toBe(v1);
    // The dialog is the user's for as long as they like; the document is not "Saving…" meanwhile.
    expect(doc.status).toBe('unsaved');
    expect(doc.choosingPlace).toBe(true);
    dialogs[0].save('Report.docx');
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Report.docx');
    expect(doc.name).toBe('Report');
    expect(doc.dirty).toBe(false);
    expect(doc.status).toBe('saved');
    expect(doc.choosingPlace).toBe(false);
    expect(paths).toEqual([{ path: '~/Desktop/Report.docx', name: 'Report', copy: false }]);
    // The dialog wrote the file; later edits autosave there with an ordinary write and no dialog.
    expect(puter.fs.write).not.toHaveBeenCalled();
    doc.attach(async () => v2);
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(puter.fs.write).toHaveBeenCalledOnce();
    expect(puter.fs.write.mock.calls[0][0]).toBe('~/Desktop/Report.docx');
    expect(files.get('~/Desktop/Report.docx')).toBe(v2);
    expect(dialogs).toHaveLength(1);
    doc.destroy();
  });

  it('leaves the document unsaved, without an error, when the dialog is cancelled', async () => {
    const doc = Doc.blank();
    const statuses = [];
    doc.addEventListener('status', (e) => statuses.push(e.detail.status));
    const paths = vi.fn();
    doc.addEventListener('path', paths);
    doc.attach(async () => docx('draft'));
    doc.changed();
    const saving = doc.save();
    await settle();
    dialogs[0].cancel();
    expect(await saving).toBe(false);
    expect(doc.path).toBeNull();
    expect(doc.dirty).toBe(true);
    expect(doc.status).toBe('unsaved');
    expect(doc.error).toBeNull();
    expect(statuses).not.toContain('error');
    expect(paths).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    // Nothing comes back on its own: no retry, no second dialog.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(dialogs).toHaveLength(1);
    doc.destroy();
  });

  it('tells a leaving editor that nothing was saved, without an error, when the dialog is cancelled', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('draft'));
    doc.changed();
    const flushing = doc.flush();
    await settle();
    dialogs[0].cancel();
    expect(await flushing).toBe(false);
    expect(doc.path).toBeNull();
    doc.destroy();
  });

  it('asks again only when Save is pressed again after a first save failed', async () => {
    const doc = Doc.blank();
    const exporter = vi.fn(async () => docx('v1'));
    exporter.mockRejectedValueOnce(new Error('Export failed'));
    doc.attach(exporter);
    doc.changed();
    await expect(doc.save()).rejects.toThrow('Export failed');
    expect(doc.status).toBe('error');
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + RETRY_MS * 3);
    expect(dialogs).toHaveLength(0);
    const saving = doc.save();
    await settle();
    expect(dialogs).toHaveLength(1);
    dialogs[0].save();
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Untitled document.docx');
    doc.destroy();
  });

  it('answers a second Save pressed while the dialog is open with that dialog', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    doc.changed();
    const first = doc.save(), second = doc.save();
    await settle();
    expect(dialogs).toHaveLength(1);
    dialogs[0].save();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(doc.path).toBe('~/Desktop/Untitled document.docx');
    doc.destroy();
  });

  it('does not let a dialog that never answers block later saves', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    doc.changed();
    let settled = false;
    const lost = doc.save().then((saved) => { settled = true; return saved; });
    await settle();
    // A key that reaches the window before the desktop has covered it is not the user coming back.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    await settle();
    expect(settled).toBe(false);
    // The desktop failed to write and never answered. The window is uncovered again: the user clicks in it.
    await vi.advanceTimersByTimeAsync(P.DIALOG_COVER_MS);
    window.dispatchEvent(new Event('pointerdown'));
    expect(await lost).toBe(false);
    expect(doc.choosingPlace).toBe(false);
    expect(doc.path).toBeNull();
    // Autosaves are not held up, and the next Save asks again.
    const again = doc.save();
    await settle();
    expect(dialogs).toHaveLength(2);
    dialogs[1].save();
    expect(await again).toBe(true);
    // Answers to the lost dialog that arrive late change nothing.
    dialogs[0].save('Late.docx');
    await settle();
    expect(doc.path).toBe('~/Desktop/Untitled document.docx');
    doc.destroy();
  });

  it('counts a dialog closed without an answer (Esc, its close button) as cancelled once the desktop hands the focus back', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    doc.changed();
    let settled = false;
    const closed = doc.save().then((saved) => { settled = true; return saved; });
    await settle();
    const focus = (source = window) => window.dispatchEvent(new MessageEvent('message', { data: { msg: 'focus' }, source }));
    // A focus the desktop sent before it put the dialog up, and messages from anywhere else, are not the dialog closing.
    focus();
    await vi.advanceTimersByTimeAsync(P.DIALOG_FOCUS_MS);
    window.dispatchEvent(new MessageEvent('message', { data: { msg: 'focus' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { msg: 'click' }, source: window }));
    await settle();
    expect(settled).toBe(false);
    // Esc in Puter's dialog: the desktop closes it without a word to the app, and gives the window the focus back.
    focus();
    expect(await closed).toBe(false);
    expect(doc.choosingPlace).toBe(false);
    expect(doc.path).toBeNull();
    expect(doc.status).toBe('unsaved');
    doc.destroy();
  });

  it('a saved file is not taken for a cancel by the focus that follows it', async () => {
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    doc.changed();
    const saving = doc.save();
    await settle();
    await vi.advanceTimersByTimeAsync(P.DIALOG_FOCUS_MS);
    // The desktop answers with the file, then closes its dialog and gives the window the focus back.
    dialogs[0].save();
    window.dispatchEvent(new MessageEvent('message', { data: { msg: 'focus' }, source: window }));
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Untitled document.docx');
    doc.destroy();
  });

  it('gives a file named without .docx in the dialog the extension, and autosaves to it from then on', async () => {
    const doc = Doc.blank();
    let content = docx('v1');
    doc.attach(async () => content);
    doc.changed();
    const saving = doc.save();
    await settle();
    // The whole name was typed over, extension and all.
    dialogs[0].save('Notes');
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Notes.docx');
    expect(doc.name).toBe('Notes');
    expect(files.has('~/Desktop/Notes')).toBe(false);
    expect(doc.waitsForPlace).toBe(false);
    content = docx('v2');
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(files.get('~/Desktop/Notes.docx')).toBe(content);
    expect(dialogs).toHaveLength(1);
    doc.destroy();
  });

  it('keeps a name without .docx when the name with it is taken, and still autosaves to that file', async () => {
    files.set('~/Desktop/Notes.docx', docx('someone else\'s'));
    const doc = Doc.blank();
    let content = docx('v1');
    doc.attach(async () => content);
    doc.changed();
    const saving = doc.save();
    await settle();
    dialogs[0].save('Notes');
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Notes');
    content = docx('v2');
    doc.changed();
    expect(doc.waitsForPlace).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(files.get('~/Desktop/Notes')).toBe(content);
    expect(files.get('~/Desktop/Notes.docx')).not.toBe(content);
    // Save writes there too, without asking again.
    content = docx('v3');
    doc.changed();
    expect(await doc.save()).toBe(true);
    expect(files.get('~/Desktop/Notes')).toBe(content);
    expect(dialogs).toHaveLength(1);
    doc.destroy();
  });

  it('Save a Copy of a document open read-only copies the file as it is', async () => {
    const original = docx('unsupported content, kept as is');
    files.set('~/Desktop/Odd.docx', original);
    // A read-only preview attaches no exporter: nothing on screen may be written over the file.
    const doc = new Doc({ name: 'Odd', path: '~/Desktop/Odd.docx', blob: original });
    const copying = doc.saveCopy();
    await settle();
    expect(dialogs[0].blob).toBe(original);
    expect(dialogs[0].suggestedName).toBe('Odd copy.docx');
    dialogs[0].save();
    expect(await copying).toBeNull();
    expect(doc.path).toBe('~/Desktop/Odd copy.docx');
    expect(files.get('~/Desktop/Odd copy.docx')).toBe(original);
    expect(doc.status).toBe('saved');
    doc.destroy();
  });

  it('saves a template being edited as a new .docx where the user chooses, and leaves the template as it was', async () => {
    const template = docx('template');
    files.set('Documents/Letter.dotx', template);
    const doc = new Doc({ name: 'Letter', path: 'Documents/Letter.dotx', blob: template });
    const paths = [];
    doc.addEventListener('path', (e) => paths.push(e.detail));
    doc.attach(async () => docx('filled in'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(dialogs).toHaveLength(0);
    expect(puter.fs.write).not.toHaveBeenCalled();
    const saving = doc.save();
    await settle();
    expect(dialogs[0].suggestedName).toBe('Letter.docx');
    dialogs[0].save();
    expect(await saving).toBe(true);
    expect(doc.path).toBe('~/Desktop/Letter.docx');
    expect(paths).toEqual([{ path: '~/Desktop/Letter.docx', name: 'Letter', copy: true }]);
    expect(files.get('Documents/Letter.dotx')).toBe(template);
    doc.destroy();
  });

  it('names a document without looking for that name in the app folder', async () => {
    files.set('Documents/Taken.docx', docx('another document'));
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    expect(await doc.rename('Taken')).toBeNull();
    expect(doc.name).toBe('Taken');
    expect(puter.fs.stat).not.toHaveBeenCalled();
    const saving = doc.save();
    await settle();
    expect(dialogs[0].suggestedName).toBe('Taken.docx');
    dialogs[0].cancel();
    await saving;
    doc.destroy();
  });
});

describe('Save a copy inside the Puter desktop', () => {
  beforeEach(() => installPuter());

  let original, current;
  async function savedDocument() {
    original = docx('original'); current = docx('current');
    files.set('Documents/Report.docx', original);
    const doc = new Doc({ name: 'Report', path: 'Documents/Report.docx', modified: clock });
    doc.attach(async () => current);
    return doc;
  }

  it('asks where for "<name> copy.docx" and goes on in the copy', async () => {
    const doc = await savedDocument();
    const paths = [];
    doc.addEventListener('path', (e) => paths.push(e.detail));
    const copying = doc.saveCopy();
    await settle();
    expect(dialogs[0].suggestedName).toBe('Report copy.docx');
    dialogs[0].save();
    expect(await copying).toBeNull();
    expect(doc.path).toBe('~/Desktop/Report copy.docx');
    expect(doc.name).toBe('Report copy');
    expect(paths).toEqual([{ path: '~/Desktop/Report copy.docx', name: 'Report copy', copy: true }]);
    expect(files.get('~/Desktop/Report copy.docx')).toBe(current);
    expect(files.get('Documents/Report.docx')).toBe(original);
    // Edits now go to the copy.
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(puter.fs.write.mock.calls.map((call) => call[0])).toEqual(['~/Desktop/Report copy.docx']);
    doc.destroy();
  });

  it('changes nothing, and has nothing to say, when the dialog is cancelled', async () => {
    const doc = await savedDocument();
    const copying = doc.saveCopy();
    await settle();
    dialogs[0].cancel();
    expect(await copying).toBe('');
    expect(doc.path).toBe('Documents/Report.docx');
    expect(doc.status).toBe('saved');
    doc.destroy();
  });

  it('keeps autosaving the original while the dialog is open', async () => {
    const doc = await savedDocument();
    const copying = doc.saveCopy();
    await settle();
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(puter.fs.write.mock.calls.map((call) => call[0])).toEqual(['Documents/Report.docx']);
    dialogs[0].cancel();
    expect(await copying).toBe('');
    doc.destroy();
  });
});

describe('without Puter\'s Save dialog', () => {
  it('saves a new document into the app folder on its own on the open web', async () => {
    installPuter({ env: 'web' });
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/Untitled document.docx');
    expect(puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
    doc.destroy();
  });

  it('saves a new document into the app folder in a Puter desktop without the dialog', async () => {
    installPuter({ picker: false });
    expect(P.asksWhereToSave()).toBe(false);
    const doc = Doc.blank();
    doc.attach(async () => docx('v1'));
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('Documents/Untitled document.docx');
    expect(await doc.saveAs('Named copy')).toBeNull();
    expect(doc.path).toBe('Documents/Named copy.docx');
    doc.destroy();
  });
});

describe('saveFileAs', () => {
  it('answers with the file the dialog wrote, or null when it was cancelled', async () => {
    installPuter();
    const saving = P.saveFileAs(docx('x'), 'A.docx');
    await settle();
    dialogs[0].save();
    expect(await saving).toEqual({ path: '~/Desktop/A.docx', name: 'A.docx', uid: 'uid-A.docx', modified: null });
    const cancelled = P.saveFileAs(docx('x'), 'B.docx');
    await settle();
    dialogs[1].cancel();
    expect(await cancelled).toBeNull();
  });

  it('works with an SDK whose dialog promise has no undefinedOnCancel', async () => {
    installPuter({ cancelAware: false });
    const saving = P.saveFileAs(docx('x'), 'A.docx');
    await settle();
    dialogs[0].save();
    expect((await saving).path).toBe('~/Desktop/A.docx');
  });
});

describe('the File view\'s Save As', () => {
  const open = (api) => {
    const backstage = createBackstage({ title: () => 'Report', save: () => {}, ...api });
    document.body.append(backstage.el);
    backstage.open('save');
    return backstage;
  };
  afterEach(() => { document.body.replaceChildren(); });

  it('opens Puter\'s Save dialog for the copy instead of asking for a name', async () => {
    vi.useRealTimers();
    let answer;
    const saveCopyWhere = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const refreshTitle = vi.fn();
    const saveAs = vi.fn();
    const backstage = open({ saveCopyWhere, saveAs, refreshTitle });
    expect(backstage.el.querySelector('[aria-label="New file name"]')).toBeNull();
    const button = [...backstage.el.querySelectorAll('button')].find((b) => b.textContent === 'Save a Copy…');
    button.click(); button.click();
    expect(saveCopyWhere).toHaveBeenCalledOnce();
    const status = backstage.el.querySelector('.bs-section.bs-card [role="status"]');
    answer('');
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(status.textContent).toBe('');
    expect(refreshTitle).not.toHaveBeenCalled();
    button.click();
    answer(null);
    await vi.waitFor(() => expect(status.textContent).toBe('Saved. You are now editing the copy.'));
    expect(refreshTitle).toHaveBeenCalledOnce();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('asks for a name when there is no Save dialog', () => {
    vi.useRealTimers();
    const backstage = open({ saveAs: vi.fn() });
    expect(backstage.el.querySelector('[aria-label="New file name"]').value).toBe('Report');
    expect([...backstage.el.querySelectorAll('button')].some((b) => b.textContent === 'Save a Copy…')).toBe(false);
  });
});
