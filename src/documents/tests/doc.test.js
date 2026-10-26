import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  const fs = new Map();
  const writeFile = vi.fn(async (path, blob, { overwrite = true } = {}) => {
    if (!overwrite && fs.has(path)) throw new Error('Already exists');
    fs.set(path, blob); return { path };
  });
  return {
    ...real,
    __fs: fs,
    fileExists: async (p) => fs.has(p),
    uniqueName: async (base) => {
      const stem = real.stripExtension(base) || 'Untitled document';
      let name = `${stem}.docx`;
      let n = 2;
      while (fs.has(`Documents/${name}`)) name = `${stem} ${n++}.docx`;
      return name;
    },
    writeFile,
    createFile: async (path, blob) => (await writeFile(path, blob, { dedupe: true })).path,
    createFileWithMetadata: async (path, blob) => writeFile(path, blob, { dedupe: true }),
    deleteFile: vi.fn(async (path) => { fs.delete(path); }),
    renameFile: vi.fn(async (path, newName) => {
      const dir = path.slice(0, path.lastIndexOf('/'));
      fs.set(`${dir}/${newName}`, fs.get(path));
      fs.delete(path);
    }),
    readFile: vi.fn(async (path) => { if (!fs.has(path)) throw Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' }); return fs.get(path); }),
  };
});

import { publishing, Doc, AUTOSAVE_MS, MAX_AUTOSAVE_MS, RETRY_MS, UNTITLED, needsUnloadWarning, versioning } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { hwp, paragraph } from './helpers/hwp-fixtures.js';
import { isStarred, toggleStar } from '../src/lib/starred.js';

const blob = (s) => new Blob([s], { type: P.DOCX_MIME });

describe('Doc', () => {
  let statuses;
  const track = (doc) => { statuses = []; doc.addEventListener('status', (e) => statuses.push(e.detail.status)); return doc; };

  beforeEach(() => {
    vi.useFakeTimers();
    versioning.enabled = false;
    publishing.enabled = false;
    P.__fs.clear();
    P.writeFile.mockClear();
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('tells the view when saving passes to another tab of a shared document, and back', () => {
    // A guest's status reads "Shared · saved by the owner" only while the owner saves; once sharing ends it is their own copy.
    const doc = track(new Doc({ name: 'Plan' }));
    doc.setSaving(false);
    expect(statuses).toEqual(['saved']);
    doc.setSaving(true);
    expect(statuses).toEqual(['saved', 'saved']);
    expect(doc.writes).toBe(true);
    doc.setSaving(true);
    expect(statuses).toHaveLength(2);
  });

  it('starts blank, clean, and untitled', () => {
    const doc = Doc.blank();
    expect(doc.name).toBe(UNTITLED);
    expect(doc.path).toBeNull();
    expect(doc.dirty).toBe(false);
    expect(doc.fileName).toBe('Untitled document.docx');
    expect(doc.status).toBe('saved');
  });

  it('imports a Hanword device file as a dirty DOCX copy, then autosaves it', async () => {
    const file = new File([hwp({ sections: [paragraph('한글 문서')] })], '한글.HWP');
    const doc = await Doc.fromImportFile(file);
    expect(doc.path).toBeNull();
    expect(doc.name).toBe('한글');
    expect(doc.dirty).toBe(true);
    expect(doc.blob.type).toBe(P.DOCX_MIME);
    expect(doc.importInfo).toMatchObject({ format: 'HWP', sourceName: '한글.HWP' });
    const converted = doc.blob;
    doc.attach(async () => converted);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/한글.docx');
    expect(P.__fs.get(doc.path)).toBe(converted);
    doc.destroy();
  });

  it('opens a Puter HWP as a fresh copy without overwriting or renaming the source', async () => {
    const original = new Blob([hwp()]);
    P.__fs.set('Elsewhere/원본.hwp', original);
    P.__fs.set('Documents/원본.docx', blob('existing'));
    const doc = await Doc.fromPath('Elsewhere/원본.hwp');
    expect(doc.path).toBeNull();
    const converted = doc.blob; doc.attach(async () => converted);
    await doc.save();
    expect(doc.path).toBe('Documents/원본 2.docx');
    expect(P.__fs.get('Elsewhere/원본.hwp')).toBe(original);
    expect(await P.__fs.get('Documents/원본.docx').text()).toBe('existing');
    expect(P.writeFile).toHaveBeenCalledWith('Documents/원본 2.docx', converted, { dedupe: true });
    doc.destroy();
  });

  it('rejects a broken Hanword import before creating or writing a document', async () => {
    await expect(Doc.fromImportFile(new File(['bad'], 'broken.hwp'))).rejects.toThrow(/not a valid/);
    expect(P.writeFile).not.toHaveBeenCalled();
  });

  it('converts a Hanword template before editing and preserves the template on save', async () => {
    const path = 'Documents/Templates/양식.HWP';
    const original = new Blob([hwp()]);
    P.__fs.set(path, original);
    const doc = await Doc.fromTemplateFile(path);
    expect(doc.blob.type).toBe(P.DOCX_MIME);
    expect(doc.importInfo).toMatchObject({ format: 'HWP', sourceName: '양식.HWP' });
    expect(doc.path).toBeNull();
    expect(doc.dirty).toBe(true);
    doc.attach(async () => doc.blob);
    await doc.save();
    expect(doc.path).toBe('Documents/양식.docx');
    expect(P.__fs.get(path)).toBe(original);
    doc.destroy();
  });

  it('autosaves the first edit into the app folder and follows with the path', async () => {
    const doc = track(Doc.blank());
    const paths = [];
    doc.addEventListener('path', (e) => paths.push(e.detail.path));
    doc.attach(async () => blob('v1'));
    doc.changed();
    expect(doc.status).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
    expect(doc.path).toBe('Documents/Untitled document.docx');
    expect(paths).toEqual(['Documents/Untitled document.docx']);
    expect(doc.dirty).toBe(false);
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
    expect(doc.size).toBe(2);
  });

  it('picks a free name when the default is taken', async () => {
    P.__fs.set('Documents/Untitled document.docx', blob('x'));
    const doc = Doc.blank();
    doc.attach(async () => blob('v1'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/Untitled document 2.docx');
    expect(doc.name).toBe('Untitled document 2');
  });

  it('keeps the original identity until a first save succeeds and retries a clean document', async () => {
    const doc = Doc.blank();
    const paths = vi.fn();
    doc.addEventListener('path', paths);
    doc.attach(async () => blob('blank document'));
    P.writeFile.mockRejectedValueOnce(new Error('quota'));

    await expect(doc.save()).rejects.toThrow('quota');
    expect(doc.path).toBeNull();
    expect(paths).not.toHaveBeenCalled();
    expect(await doc.save()).toBe(true);
    expect(await P.__fs.get(doc.path).text()).toBe('blank document');
    expect(doc.status).toBe('saved');
    expect(paths).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it('keeps a template source path when exporting its first DOCX copy fails', async () => {
    const doc = new Doc({ name: 'Old', path: 'Desktop/Old.dotx', blob: blob('template') });
    const paths = vi.fn();
    doc.addEventListener('path', paths);
    doc.attach(vi.fn().mockRejectedValueOnce(new Error('export failed')).mockResolvedValue(blob('copy')));
    doc.changed();

    await expect(doc.save()).rejects.toThrow('export failed');
    expect(doc.path).toBe('Desktop/Old.dotx');
    expect(paths).not.toHaveBeenCalled();
    expect(await doc.save()).toBe(true);
    expect(await P.__fs.get('Documents/Old.docx').text()).toBe('copy');
    expect(doc.path).toBe('Documents/Old.docx');
    doc.destroy();
  });

  it('debounces bursts of edits into one write', async () => {
    const doc = Doc.blank();
    doc.attach(async () => blob('v'));
    for (let i = 0; i < 5; i++) { doc.changed(); await vi.advanceTimersByTimeAsync(300); }
    expect(P.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
  });

  it('keeps the document dirty when an edit lands mid-save, then saves again', async () => {
    const doc = Doc.blank();
    let resolveExport;
    doc.attach(() => new Promise((r) => { resolveExport = r; }));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.status).toBe('saving');
    doc.changed(); // typed while exporting
    resolveExport(blob('a'));
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.dirty).toBe(true);
    expect(doc.status).toBe('unsaved');
    doc.attach(async () => blob('b'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
    expect(doc.dirty).toBe(false);
  });

  it('writes edits made during a save right after it when the page goes to the background', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx' });
    P.__fs.set(doc.path, blob('original'));
    let release;
    P.writeFile.mockImplementationOnce(async (path, b) => { await new Promise((r) => { release = r; }); P.__fs.set(path, b); return { path }; });
    doc.attach(async () => blob(`version ${doc.version}`));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.status).toBe('saving');
    doc.changed(); // typed while the write is in flight
    const hidden = doc.save({ auto: true, now: true });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await hidden).toBe(true);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
    expect(await P.__fs.get(doc.path).text()).toBe('version 2');
    expect(doc.dirty).toBe(false);
    // No second write was left planned for those edits.
    await vi.advanceTimersByTimeAsync(MAX_AUTOSAVE_MS);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
    doc.destroy();
  });

  it('serializes multiple save requests waiting for an earlier save', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx' });
    const exports = [];
    doc.attach(() => new Promise((resolve) => exports.push(resolve)));
    doc.changed();
    const first = doc.save();
    doc.changed();
    const second = doc.save();
    const third = doc.save();
    exports[0](blob('earlier'));
    await vi.advanceTimersByTimeAsync(0);
    // Only one export of the newer edits may be in flight at a time.
    expect(exports).toHaveLength(2);
    exports[1](blob('latest'));
    await Promise.all([first, second, third]);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
    expect(await P.__fs.get(doc.path).text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('retries after a failed autosave and surfaces the error', async () => {
    const doc = track(Doc.blank());
    P.writeFile.mockRejectedValueOnce(new Error('boom'));
    doc.attach(async () => blob('v'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.status).toBe('error');
    expect(doc.error).toBe('boom');
    await vi.advanceTimersByTimeAsync(RETRY_MS + 5);
    expect(doc.status).toBe('saved');
    expect(P.writeFile).toHaveBeenCalledTimes(2);
  });

  it('with AutoSave off, writes only on Save: no background, reconnect or post-copy autosave', async () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    doc.attach(async () => blob('edited'));
    doc.setAutosave(false);
    doc.changed();
    // What the app does when the page is hidden, the connection returns, or the user signs in.
    expect(await doc.save({ auto: true })).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_MS + AUTOSAVE_MS);
    expect(P.writeFile).not.toHaveBeenCalled();
    expect(doc.dirty).toBe(true);
    // Edits made while a copy is saved wait for Save too.
    let release;
    const exporter = vi.fn().mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue(blob('later'));
    doc.attach(exporter);
    const copying = doc.saveAs('B');
    await vi.advanceTimersByTimeAsync(0);
    doc.changed();
    release(blob('copy'));
    expect(await copying).toBeNull();
    await vi.advanceTimersByTimeAsync(RETRY_MS + AUTOSAVE_MS);
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('copy');
    expect(doc.dirty).toBe(true);
    expect(await doc.save()).toBe(true);
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('later');
    expect(await P.__fs.get('Documents/A.docx').text()).toBe('original');
    doc.destroy();
  });

  it('holds an autosave while the editor is composing text, without a failed status', async () => {
    const doc = track(Doc.blank());
    let composing = true;
    doc.attach(async () => { if (composing) throw new Error('Finish composing text before saving.'); return blob('v'); }, { busy: () => composing });
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4);
    expect(P.writeFile).not.toHaveBeenCalled();
    expect(statuses).toEqual(['unsaved']);
    composing = false;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('reports offline instead of error when the browser is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const doc = Doc.blank();
    P.writeFile.mockRejectedValueOnce(new Error('network'));
    doc.attach(async () => blob('v'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.status).toBe('offline');
  });

  it.each(['export', 'write'])('retries newer edits when autosave waits on a failed manual %s', async (stage) => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let reject;
    const pending = new Promise((_, fail) => { reject = fail; });
    let content = 'first edit';
    const exporter = vi.fn(async () => blob(content));
    if (stage === 'export') exporter.mockReturnValueOnce(pending);
    else P.writeFile.mockReturnValueOnce(pending);
    doc.attach(exporter, { ready: Promise.resolve() });
    doc.changed();
    const failure = expect(doc.save()).rejects.toThrow('Temporary failure');
    await vi.advanceTimersByTimeAsync(0);
    content = 'latest edits';
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    reject(new Error('Temporary failure'));
    await failure;
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.status).toBe('error');
    expect(doc.dirty).toBe(true);
    expect(await P.__fs.get(doc.path).text()).toBe('original');
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(exporter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await P.__fs.get(doc.path).text()).toBe('latest edits');
    expect(doc.dirty).toBe(false);
    expect(doc.status).toBe('saved');
    doc.destroy();
  });

  it('does not retry failed initialization when autosave waits on a manual save', async () => {
    const doc = Doc.blank();
    let reject;
    const ready = new Promise((_, fail) => { reject = fail; });
    const exporter = vi.fn(async () => blob('incomplete'));
    doc.attach(exporter, { ready });
    doc.changed();
    const failure = expect(doc.save()).rejects.toThrow('Initialization failed');
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    reject(new Error('Initialization failed'));
    await failure;
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(exporter).not.toHaveBeenCalled();
    expect(P.writeFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.status).toBe('error');
    expect(doc.dirty).toBe(true);
    doc.destroy();
  });

  it('throws from an explicit save so the UI can show it, without scheduling a retry', async () => {
    const doc = Doc.blank();
    P.writeFile.mockRejectedValueOnce(new Error('quota'));
    doc.attach(async () => blob('v'));
    doc.changed();
    await expect(doc.save()).rejects.toThrow('quota');
    await vi.advanceTimersByTimeAsync(RETRY_MS + 5);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not save without an exporter, but saves the pending import once one attaches', async () => {
    const file = blob('imported');
    const doc = Doc.fromBrowserFile(new File([file], 'Memo.docx'));
    expect(doc.name).toBe('Memo');
    expect(doc.dirty).toBe(true);
    expect(await doc.save()).toBe(false);
    doc.attach(async () => blob('exported'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/Memo.docx');
    expect(doc.dirty).toBe(false);
  });

  it('flushes edits made during a slow save before allowing the editor to close', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx' });
    let release;
    const exported = new Promise((resolve) => { release = resolve; });
    const exporter = vi.fn().mockReturnValueOnce(exported).mockResolvedValue(blob('latest'));
    doc.attach(exporter);
    doc.changed();
    const saving = doc.flush();
    doc.changed();
    release(blob('earlier'));
    await expect(saving).resolves.toBe(true);
    expect(await P.__fs.get(doc.path).text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('refuses to flush an import until its exporter is ready', async () => {
    const doc = new Doc({ dirty: true, blob: blob('import') });
    await expect(doc.flush()).rejects.toThrow('still opening');
    expect(doc.dirty).toBe(true);
    expect(P.writeFile).not.toHaveBeenCalled();
  });

  it.each([false, true])('saves a named blank document when renamed (engine ready: %s)', async (ready) => {
    const doc = Doc.blank();
    const content = blob('blank document');
    if (ready) doc.attach(async () => content);
    expect(await doc.rename('Project notes')).toBeNull();
    expect(doc.dirty).toBe(true);
    expect(needsUnloadWarning(doc)).toBe(true);
    expect(doc.status).toBe('unsaved');
    if (!ready) doc.attach(async () => content);
    await doc.flush();
    expect(doc.path).toBe('Documents/Project notes.docx');
    expect(P.__fs.get(doc.path)).toBe(content);
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('does not save an untouched blank document when its name is unchanged', async () => {
    const doc = Doc.blank();
    doc.attach(async () => blob('blank document'));
    expect(await doc.rename(UNTITLED)).toBeNull();
    expect(doc.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(P.writeFile).not.toHaveBeenCalled();
    doc.destroy();
  });

  it('renames the file on disk and refuses collisions', async () => {
    P.__fs.set('Documents/Taken.docx', blob('t'));
    const doc = new Doc({ name: 'Report', path: 'Documents/Report.docx', blob: blob('r') });
    P.__fs.set('Documents/Report.docx', doc.blob);
    expect(await doc.rename('Taken')).toBe('A file with that name already exists');
    expect(await doc.rename('')).toBe('Enter a name');
    for (const dots of ['.', '..', '...docx']) expect(await doc.rename(dots)).toBe('Enter a name');
    expect(await doc.rename('Report')).toBeNull();
    expect(await doc.rename('Final/Report.docx')).toBeNull();
    expect(doc.path).toBe('Documents/Final Report.docx');
    expect(doc.name).toBe('Final Report');
    expect(P.renameFile).toHaveBeenCalledWith('Documents/Report.docx', 'Final Report.docx');
  });

  it('refuses to name an unsaved document after a file that exists', async () => {
    P.__fs.set('Documents/Taken.docx', blob('t'));
    const fresh = Doc.blank();
    expect(await fresh.rename('Taken')).toBe('A file with that name already exists');
    expect(fresh.name).toBe(UNTITLED);
    expect(await fresh.rename('Free')).toBeNull();
    expect(fresh.name).toBe('Free');
  });

  it('renames a file without an extension without inventing one from its folder', async () => {
    const bare = new Doc({ name: 'README', path: '/u/my.folder/README', blob: blob('r') });
    P.__fs.set('/u/my.folder/README', bare.blob);
    expect(await bare.rename('Renamed')).toBeNull();
    expect(bare.path).toBe('/u/my.folder/Renamed');
    expect(P.renameFile).toHaveBeenCalledWith('/u/my.folder/README', 'Renamed');
  });

  it('flushes a clean template file by waiting for the lock, not by saving a copy', async () => {
    const doc = new Doc({ name: 'T', path: 'Desktop/T.dotx', blob: blob('t') });
    P.__fs.set('Desktop/T.dotx', doc.blob);
    doc.attach(async () => blob('export'));
    let release;
    doc._saving = new Promise((resolve) => { release = resolve; }).finally(() => { doc._saving = null; });
    const flushing = doc.flush();
    release();
    expect(await flushing).toBe(true);
    expect(doc.path).toBe('Desktop/T.dotx');
    expect([...P.__fs.keys()].some((k) => k.endsWith('.docx'))).toBe(false);
  });

  it('saves nothing for a clean template file instead of making a copy of it', async () => {
    const doc = new Doc({ name: 'T', path: 'Desktop/T.dotx', blob: blob('t') });
    P.__fs.set('Desktop/T.dotx', doc.blob);
    const exporter = vi.fn(async () => blob('export'));
    doc.attach(exporter);
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('Desktop/T.dotx');
    expect(exporter).not.toHaveBeenCalled();
    expect([...P.__fs.keys()].some((k) => k.endsWith('.docx'))).toBe(false);
    // An edit is what turns it into a document of its own.
    doc.changed();
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('Documents/T.docx');
  });

  it('keeps a clean document saved when a restore fails before anything is written', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('a') });
    P.__fs.set('Documents/A.docx', doc.blob);
    doc.attach(async () => blob('a'));
    await expect(doc.restoreVersion('Documents/.versions/A/missing.docx')).rejects.toThrow();
    expect(doc.status).toBe('saved');
    expect(doc.dirty).toBe(false);
  });

  it('refuses a text import too large to convert on the main thread', async () => {
    const huge = new File(['x'], 'log.txt');
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });
    await expect(Doc.fromImportFile(huge)).rejects.toThrow('too large to import as text');
    const fine = await Doc.fromImportFile(new File(['hello'], 'note.txt'));
    expect(fine.pendingImport).toEqual({ value: 'hello', type: 'text' });
  });

  it('clears the "Not saved" pill of a clean document after a failed copy once it is saved again', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('a') });
    doc.attach(async () => blob('a2'));
    P.writeFile.mockRejectedValueOnce(new Error('quota'));
    expect(await doc.saveAs('B')).toBe('quota');
    expect(doc.status).toBe('error');
    // The original is intact and unchanged: a retry has nothing to write, and says so on the pill.
    expect(await doc.save()).toBe(true);
    expect(doc.status).toBe('saved');
  });

  it('saves a copy and switches to it', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('a') });
    doc.attach(async () => blob('a2'));
    expect(await doc.saveAs('B')).toBeNull();
    expect(doc.path).toBe('Documents/B.docx');
    expect(doc.name).toBe('B');
    expect(P.__fs.has('Documents/B.docx')).toBe(true);
    expect(await doc.saveAs('B')).toBe('A file with that name already exists');
  });

  it('waits for an active save before exporting a copy', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let release;
    const writing = new Promise((resolve) => { release = resolve; });
    P.writeFile.mockImplementationOnce(async (path, content) => { await writing; P.__fs.set(path, content); });
    const exporter = vi.fn().mockResolvedValueOnce(blob('earlier')).mockResolvedValue(blob('latest'));
    doc.attach(exporter);
    doc.changed();
    const saving = doc.save();
    await vi.advanceTimersByTimeAsync(0);
    doc.changed();
    const copying = doc.saveAs('B');
    await vi.advanceTimersByTimeAsync(0);
    const exportsDuringWrite = exporter.mock.calls.length;
    release();
    await saving;
    expect(await copying).toBeNull();
    expect(exportsDuringWrite).toBe(1);
    expect(await P.__fs.get('Documents/A.docx').text()).toBe('earlier');
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('saves edits to the copy when autosave fires during a slow copy export', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let release;
    const exporting = new Promise((resolve) => { release = resolve; });
    const exporter = vi.fn().mockReturnValueOnce(exporting).mockResolvedValue(blob('latest'));
    doc.attach(exporter);
    const copying = doc.saveAs('B');
    await vi.advanceTimersByTimeAsync(0);
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const exportsDuringCopy = exporter.mock.calls.length;
    release(blob('copy'));
    await copying;
    await doc.flush();
    expect(exportsDuringCopy).toBe(1);
    expect(await P.__fs.get('Documents/A.docx').text()).toBe('original');
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('keeps a clean document open until saving its copy finishes', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    let release;
    doc.attach(() => new Promise((resolve) => { release = resolve; }));
    const copying = doc.saveAs('B');
    await vi.advanceTimersByTimeAsync(0);
    let left = false;
    const leaving = doc.flush().then(() => { left = true; });
    await vi.advanceTimersByTimeAsync(0);
    const leftDuringCopy = left;
    release(blob('copy'));
    await Promise.all([copying, leaving]);
    expect(leftDuringCopy).toBe(false);
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('copy');
    doc.destroy();
  });

  it('waits for a pending write before renaming its file', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let release;
    const writing = new Promise((resolve) => { release = resolve; });
    P.writeFile.mockImplementationOnce(async (path, content) => { await writing; P.__fs.set(path, content); });
    doc.attach(async () => blob('latest'));
    doc.changed();
    const saving = doc.save();
    await vi.advanceTimersByTimeAsync(0);
    const renaming = doc.rename('B');
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([saving, renaming]);
    expect(P.__fs.has('Documents/A.docx')).toBe(false);
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('latest');
    expect(doc.path).toBe('Documents/B.docx');
    doc.destroy();
  });

  it('keeps the star of a document renamed from the editor', async () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    doc.attach(async () => blob('latest'));
    toggleStar('Documents/A.docx');
    expect(await doc.rename('B')).toBeNull();
    expect(isStarred('Documents/B.docx')).toBe(true);
    expect(isStarred('Documents/A.docx')).toBe(false);
    doc.destroy();
  });

  it('holds autosave until a slow rename has finished', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let release;
    const moving = new Promise((resolve) => { release = resolve; });
    P.renameFile.mockImplementationOnce(async (path, name) => {
      await moving;
      P.__fs.set(`Documents/${name}`, P.__fs.get(path));
      P.__fs.delete(path);
    });
    doc.attach(async () => blob('latest'));
    const renaming = doc.rename('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(needsUnloadWarning(doc)).toBe(true);
    doc.changed();
    const saving = doc.save();
    await vi.advanceTimersByTimeAsync(0);
    const writesDuringRename = P.writeFile.mock.calls.length;
    release();
    await Promise.all([renaming, saving]);
    expect(writesDuringRename).toBe(0);
    expect(P.__fs.has('Documents/A.docx')).toBe(false);
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('latest');
    doc.destroy();
  });

  it('allows Save a copy to recover after an active save fails', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let reject;
    P.writeFile.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    doc.attach(async () => blob('latest'));
    doc.changed();
    const saving = doc.save();
    const failure = expect(saving).rejects.toThrow('Original is read only');
    const copying = doc.saveAs('B');
    reject(new Error('Original is read only'));
    await failure;
    expect(await copying).toBeNull();
    expect(await P.__fs.get('Documents/A.docx').text()).toBe('original');
    expect(await P.__fs.get('Documents/B.docx').text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('resumes autosave of pending edits on the original if saving a copy fails', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    doc.attach(async () => blob('latest'));
    doc.changed();
    P.writeFile.mockRejectedValueOnce(new Error('Copy failed'));
    expect(await doc.saveAs('B')).toBe('Copy failed');
    expect(doc.path).toBe('Documents/A.docx');
    expect(doc.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(await P.__fs.get('Documents/A.docx').text()).toBe('latest');
    expect(P.__fs.has('Documents/B.docx')).toBe(false);
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('saves a non-docx source as a fresh .docx next to the others, as a copy of it', async () => {
    const doc = new Doc({ name: 'Old', path: 'Desktop/Old.dotx', blob: blob('o') });
    const paths = vi.fn();
    doc.addEventListener('path', paths);
    doc.attach(async () => blob('new'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/Old.docx');
    // The template keeps its star, goal and reading position; the copy gets them too.
    expect(paths.mock.calls[0][0].detail).toEqual({ path: 'Documents/Old.docx', name: 'Old', copy: true, savedAs: false });
  });

  it('renames the copy a template becomes, not the template file, while edits are pending', async () => {
    const doc = new Doc({ name: 'T', path: 'Desktop/T.dotx', blob: blob('t') });
    P.__fs.set('Desktop/T.dotx', doc.blob);
    doc.attach(async () => blob('edited'));
    doc.changed();
    const renames = P.renameFile.mock.calls.length;
    expect(await doc.rename('My letter')).toBeNull();
    expect(P.renameFile.mock.calls.length).toBe(renames);
    expect(doc.name).toBe('My letter');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.path).toBe('Documents/My letter.docx');
    expect(P.__fs.has('Desktop/T.dotx')).toBe(true);
  });

  it('lets the opened bytes go once the engine has them, keeping their size for the details', async () => {
    const doc = new Doc({ name: 'Big', path: 'Documents/Big.docx', blob: blob('x'.repeat(4096)) });
    expect(doc.size).toBe(4096);
    doc.attach(async () => blob('y'.repeat(10)));
    expect(doc.blob).toBeNull();
    expect(doc.size).toBe(4096);
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(doc.blob).toBeNull();
    expect(doc.size).toBe(10);
    // A document without an engine still hands out the bytes it was opened with.
    const plain = new Doc({ name: 'P', path: 'Documents/P.docx', blob: blob('abc') });
    expect(await plain.toBlob()).toBe(plain.blob);
  });

  it('names a first save no copy of anything', async () => {
    const doc = Doc.blank();
    const paths = vi.fn();
    doc.addEventListener('path', paths);
    doc.attach(async () => blob('new'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 5);
    expect(paths.mock.calls[0][0].detail.copy).toBe(false);
  });

  it('opens from a path', async () => {
    P.__fs.set('Documents/Plan.docx', blob('plan'));
    const doc = await Doc.fromPath('Documents/Plan.docx');
    expect(doc.name).toBe('Plan');
    expect(doc.blob.size).toBe(4);
    expect(doc.dirty).toBe(false);
    await expect(Doc.fromPath('Documents/Missing.docx')).rejects.toThrow();
  });

  it('waits for a save before deleting and prevents queued autosaves from recreating the file', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    let release;
    const writing = new Promise((resolve) => { release = resolve; });
    P.writeFile.mockImplementationOnce(async (path, content) => { await writing; P.__fs.set(path, content); });
    doc.attach(async () => blob('latest')); doc.changed();
    const saving = doc.save();
    const deleting = doc.remove();
    const queued = doc.save({ auto: true });
    release(); await Promise.all([saving, deleting, queued]);
    doc.changed();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(P.__fs.has('Documents/A.docx')).toBe(false);
    expect(doc.path).toBeNull();
    expect(doc.dirty).toBe(false);
    expect(await doc.flush()).toBe(true);
    doc.destroy();
  });

  it('resumes autosaving pending edits when deletion fails', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    P.__fs.set(doc.path, doc.blob);
    doc.attach(async () => blob('latest')); doc.changed();
    P.deleteFile.mockRejectedValueOnce(new Error('Delete failed'));
    await expect(doc.remove()).rejects.toThrow('Delete failed');
    expect(doc.path).toBe('Documents/A.docx');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(await P.__fs.get(doc.path).text()).toBe('latest');
    expect(doc.dirty).toBe(false);
    doc.destroy();
  });

  it('stops autosaving and retrying once the editor has closed', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('original') });
    let fail;
    const exporter = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    doc.attach(exporter); doc.changed();
    const saving = doc.save({ auto: true });
    // The user leaves and discards the pending edit while the write is in flight.
    doc.destroy();
    fail(new Error('engine gone'));
    expect(await saving).toBe(false);
    doc.changed();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(doc._timer).toBeNull();
  });

  it('exports the last known bytes when no engine is attached', async () => {
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('a') });
    expect((await doc.toBlob()).size).toBe(1);
    await expect(Doc.blank().toBlob()).rejects.toThrow();
  });

  it('warns before unload only while edits are pending or a save is in flight', async () => {
    expect(needsUnloadWarning(null)).toBe(false);
    const doc = new Doc({ name: 'A', path: 'Documents/A.docx', blob: blob('a') });
    expect(needsUnloadWarning(doc)).toBe(false);
    doc.changed();
    expect(needsUnloadWarning(doc)).toBe(true);
    doc.attach(async () => blob('b'));
    const saving = doc.save();
    expect(doc.status).toBe('saving');
    expect(needsUnloadWarning(doc)).toBe(true);
    await saving;
    expect(needsUnloadWarning(doc)).toBe(false);
  });

  it('counts a template the editor has not laid out yet as nothing to lose, until it is renamed or laid out', async () => {
    const doc = Doc.blank({ template: 'letter', name: 'Letter' });
    expect(doc.dirty).toBe(true);
    expect(doc.untouchedTemplate).toBe(true);
    expect(needsUnloadWarning(doc)).toBe(false);
    expect(await doc.rename('Letter to Sam')).toBeNull();
    expect(doc.untouchedTemplate).toBe(false);
    expect(needsUnloadWarning(doc)).toBe(true);
    const laidOut = Doc.blank({ template: 'letter', name: 'Letter' });
    laidOut.attach(async () => blob('letter'));
    expect(laidOut.untouchedTemplate).toBe(false);
    expect(needsUnloadWarning(laidOut)).toBe(true);
    // Imports and a template file of the user's own carry bytes: they are not untouched templates.
    expect(new Doc({ dirty: true, blob: blob('import') }).untouchedTemplate).toBe(false);
    expect(Doc.fromTextImport('Notes', { value: 'x', type: 'text' }).untouchedTemplate).toBe(false);
    doc.destroy(); laidOut.destroy();
  });
});

describe('Doc versioning', () => {
  it('snapshots after the first save and again on demand, and follows a rename', async () => {
    vi.useRealTimers();
    versioning.enabled = true;
    P.__fs.clear();
    // The mocked writeFile lands in P.__fs; the real folder helpers reach the SDK, so point it at the same map.
    const files = P.__fs;
    const notFound = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });
    globalThis.puter = {
      fs: {
        async mkdir() {},
        async readdir(p) { const rows = [...files.entries()].filter(([k]) => k.startsWith(`${p}/`)); if (!rows.length) throw notFound(); return rows.map(([k, v]) => ({ name: k.split('/').pop(), path: k, size: v.size })); },
        async delete(p) { files.delete(p); },
        async stat(p) { if ([...files.keys()].some((k) => k === p || k.startsWith(`${p}/`))) return { path: p }; throw notFound(); },
      },
    };
    P.renameFile.mockImplementation(async (path, newName) => {
      const t = `${path.split('/').slice(0, -1).join('/')}/${newName}`;
      if (files.has(path)) { files.set(t, files.get(path)); files.delete(path); return; }
      for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) { files.set(`${t}${k.slice(path.length)}`, files.get(k)); files.delete(k); }
    });
    try {
      const doc = new Doc({ name: 'Notes', path: 'Documents/Notes.docx', blob: blob('n') });
      files.set('Documents/Notes.docx', doc.blob);
      doc.attach(async () => blob('edit 1'));
      doc.changed();
      await doc.save();
      await doc._snapshotting;
      const versionKeys = () => [...files.keys()].filter((k) => k.startsWith('Documents/.versions/'));
      expect(versionKeys()).toHaveLength(1);
      expect(versionKeys()[0].startsWith('Documents/.versions/Notes/')).toBe(true);
      expect(typeof doc.lastVersionAt).toBe('number');
      // A second save right away is too soon for another snapshot.
      doc.changed();
      await doc.save();
      await doc._snapshotting;
      expect(versionKeys()).toHaveLength(1);
      // On demand always snapshots.
      const v = await doc.saveVersionNow();
      expect(v.path.startsWith('Documents/.versions/Notes/')).toBe(true);
      expect(versionKeys()).toHaveLength(2);
      // The history follows a rename.
      expect(await doc.rename('Journal')).toBeNull();
      expect(versionKeys()).toHaveLength(2);
      expect(versionKeys().every((k) => k.startsWith('Documents/.versions/Journal/'))).toBe(true);
    } finally {
      delete globalThis.puter;
      versioning.enabled = false;
      vi.useFakeTimers();
    }
  });
});

describe('published pages follow the file', () => {
  it('moves the publication record on rename and takes the page down on delete', async () => {
    const publish = await import('../src/lib/publish.js');
    const move = vi.spyOn(publish, 'movePublication').mockResolvedValue(null);
    const down = vi.spyOn(publish, 'unpublishAt').mockResolvedValue(true);
    publishing.enabled = true;
    try {
      const P = await import('../src/lib/puter.js');
      P.__fs.set('Documents/Draft.docx', new Blob(['x']));
      const doc = new Doc({ name: 'Draft', path: 'Documents/Draft.docx', blob: new Blob(['x']) });
      expect(await doc.rename('Final')).toBeNull();
      expect(move).toHaveBeenCalledWith('Documents/Draft.docx', 'Documents/Final.docx');
      await doc.remove();
      expect(down).toHaveBeenCalledWith('Documents/Final.docx');
    } finally { publishing.enabled = false; move.mockRestore(); down.mockRestore(); }
  });
});

describe('a closed document', () => {
  it('neither becomes dirty nor writes its file once the editor has closed', async () => {
    P.writeFile.mockClear();
    const doc = new Doc({ name: 'Alpha', path: 'Documents/Alpha.docx' });
    const exporter = vi.fn(async () => blob('partial'));
    doc.attach(exporter);
    doc.destroy();
    // The engine can still report an edit from under an error card; it must not reach the file.
    doc.changed();
    expect(doc.dirty).toBe(false);
    expect(await doc.save({ auto: true })).toBe(false);
    expect(await doc.save()).toBe(false);
    expect(exporter).not.toHaveBeenCalled();
    expect(P.writeFile).not.toHaveBeenCalled();
  });
});

describe('offline', () => {
  it('exports and tries the write once, then waits for the connection instead of retrying every few seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: false });
    P.writeFile.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    try {
      const doc = new Doc({ name: 'Alpha', path: 'Documents/Alpha.docx' });
      const exporter = vi.fn(async () => blob('offline edit'));
      doc.attach(exporter);
      doc.changed();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + RETRY_MS * 5);
      expect(exporter).toHaveBeenCalledOnce();
      expect(doc.status).toBe('offline');
      expect(doc.dirty).toBe(true);
      // Back online, the app asks for the save; it goes through.
      vi.stubGlobal('navigator', { onLine: true });
      expect(await doc.save({ auto: true })).toBe(true);
      expect(doc.dirty).toBe(false);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});

describe('files that vanished under the document', () => {
  const gone = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear(); vi.stubGlobal('navigator', { onLine: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('treats deleting a file another window already removed as done, so the next edit cannot recreate it', async () => {
    const doc = new Doc({ name: 'Gone', path: 'Documents/Gone.docx', blob: blob('x') });
    doc.attach(async () => blob('y'));
    P.deleteFile.mockRejectedValueOnce(gone());
    await doc.remove();
    expect(doc.path).toBeNull();
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(P.writeFile).not.toHaveBeenCalled();
  });

  it('says that a file being renamed no longer exists when Puter cannot find it', async () => {
    const doc = new Doc({ name: 'Old', path: 'Documents/Old.docx', blob: blob('x') });
    P.renameFile.mockRejectedValueOnce(gone());
    expect(await doc.rename('New')).toBe('That file no longer exists');
    expect(doc.path).toBe('Documents/Old.docx');
  });
});

describe('a save in flight when the document closes', () => {
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear(); vi.stubGlobal('navigator', { onLine: true }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('does not turn a closed document\'s pill to "Not saved" when the export then fails', async () => {
    let reject;
    const doc = new Doc({ name: 'Import', pendingImport: { value: 'x', type: 'text' } });
    doc.attach(() => new Promise((_, r) => { reject = r; }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(doc.status).toBe('saving');
    // The layout failed: the editor closes the document and discards what it showed.
    doc.destroy(); doc.discardEdits();
    expect(doc.status).toBe('saved');
    reject(new Error('Too many links for one piece'));
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.status).toBe('saved');
    expect(doc.error).toBeNull();
  });
});

describe('renaming a file that lives at the root', () => {
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the file at the root instead of inventing a folder from its name', async () => {
    const doc = new Doc({ name: 'A', path: 'A.docx', blob: blob('x') });
    expect(await doc.rename('B')).toBeNull();
    expect(doc.path).toBe('B.docx');
    expect(P.renameFile).toHaveBeenLastCalledWith('A.docx', 'B.docx');
  });
});

describe('Save while another operation holds the file', () => {
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear(); vi.stubGlobal('navigator', { onLine: true }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('reports the save\'s own outcome, not the failure of the delete it waited for', async () => {
    const doc = new Doc({ name: 'Report', path: 'Documents/Report.docx', blob: blob('x') });
    P.__fs.set('Documents/Report.docx', doc.blob);
    doc.attach(async () => blob('y'));
    P.deleteFile.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('Permission denied for delete')), 100)));
    const removing = doc.remove().catch((e) => e.message);
    doc.changed();
    const saving = doc.save();
    await vi.advanceTimersByTimeAsync(200);
    expect(await removing).toBe('Permission denied for delete');
    expect(await saving).toBe(true);
    expect(doc.status).toBe('saved');
    expect(P.writeFile).toHaveBeenCalledWith('Documents/Report.docx', expect.anything());
  });
});

describe('autosave pacing', () => {
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear(); vi.stubGlobal('navigator', { onLine: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits longer between autosaves of a document whose save takes long, up to half a minute', async () => {
    const doc = new Doc({ name: 'Big', path: 'Documents/Big.docx', blob: blob('x') });
    doc.attach(() => new Promise((resolve) => setTimeout(() => resolve(blob('big')), 4000)));
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 4000);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
    // The save took four seconds: the next autosave waits twelve, not one and a half.
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 4000 + 10);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12000);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
    expect(doc.autosaveDelay).toBe(12000);
    // A quick save brings the pause back down.
    doc.attach(async () => blob('small'));
    doc.changed();
    await vi.advanceTimersByTimeAsync(12000 + 10);
    expect(P.writeFile).toHaveBeenCalledTimes(3);
    expect(doc.autosaveDelay).toBe(AUTOSAVE_MS);
    // Save now is never held back.
    doc.attach(() => new Promise((resolve) => setTimeout(() => resolve(blob('big')), 20000)));
    doc.changed();
    const saving = doc.save();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await saving).toBe(true);
    expect(doc.autosaveDelay).toBe(MAX_AUTOSAVE_MS);
  });
});

describe('autosave pacing after an import', () => {
  beforeEach(() => { vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear(); vi.stubGlobal('navigator', { onLine: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('does not count the wait for the layout of an imported document as save time', async () => {
    const doc = new Doc({ name: 'Imported', path: 'Documents/Imported.docx', blob: blob('x') });
    doc.changed();
    let laidOut;
    doc.attach(async () => blob('laid out'), { ready: new Promise((resolve) => { laidOut = resolve; }) });
    // The first autosave waits ten seconds for the layout before it can export.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10000);
    expect(P.writeFile).not.toHaveBeenCalled();
    laidOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
    // The export itself was instant: the next edit is saved after the usual pause, not half a minute.
    expect(doc.autosaveDelay).toBe(AUTOSAVE_MS);
  });
});

describe('a file open in two windows', () => {
  beforeEach(() => {
    vi.useFakeTimers(); versioning.enabled = false; publishing.enabled = false; P.__fs.clear(); P.writeFile.mockClear();
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const opened = (modified = 100) => {
    P.__fs.set('Documents/Report.docx', blob('a'));
    const doc = new Doc({ name: 'Report', path: 'Documents/Report.docx', blob: blob('a'), modified });
    doc.attach(async () => blob('b'));
    return doc;
  };

  it('does not write over a file another window changed, and does not keep trying on its own', async () => {
    const doc = opened();
    vi.spyOn(P, 'statFile').mockResolvedValue({ path: 'Documents/Report.docx', modified: 200 });
    doc.changed();
    await expect(doc.save()).rejects.toThrow('This document was changed in another window. Use Save a copy to keep your changes, or reopen it to see theirs');
    expect(P.writeFile).not.toHaveBeenCalled();
    expect(doc.status).toBe('error');
    expect(doc.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(P.writeFile).not.toHaveBeenCalled();
    // A copy keeps the edits, and the document follows the copy's own time stamp from then on.
    P.writeFile.mockImplementationOnce(async (path, content) => { P.__fs.set(path, content); return { path, modified: 300 }; });
    expect(await doc.saveAs('Report copy')).toBeNull();
    expect(doc.path).toBe('Documents/Report copy.docx');
    P.statFile.mockResolvedValue({ path: doc.path, modified: 300 });
    doc.changed();
    P.writeFile.mockImplementationOnce(async (path, content) => { P.__fs.set(path, content); return { path, modified: 301 }; });
    expect(await doc.save()).toBe(true);
    expect(doc.status).toBe('saved');
  });

  it('does not bring back a file that was moved or deleted in another window', async () => {
    const doc = opened();
    vi.spyOn(P, 'statFile').mockResolvedValue(null);
    doc.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10);
    expect(P.writeFile).not.toHaveBeenCalled();
    expect(doc.status).toBe('error');
    expect(doc.error).toBe('This file was moved or deleted in another window. Use Save a copy to keep your changes');
    expect(doc.dirty).toBe(true);
  });

  it('writes when the file is as it left it, and learns the time stamp of each write', async () => {
    const doc = opened();
    const stat = vi.spyOn(P, 'statFile').mockResolvedValue({ path: 'Documents/Report.docx', modified: 100 });
    P.writeFile.mockImplementation(async (path, content) => { P.__fs.set(path, content); return { path, modified: 150 }; });
    doc.changed();
    expect(await doc.save()).toBe(true);
    expect(P.writeFile).toHaveBeenCalledTimes(1);
    // The stamp the write returned is the one to expect next time.
    stat.mockResolvedValue({ path: 'Documents/Report.docx', modified: 150 });
    doc.changed();
    expect(await doc.save()).toBe(true);
    stat.mockResolvedValue({ path: 'Documents/Report.docx', modified: 151 });
    doc.changed();
    await expect(doc.save()).rejects.toThrow('changed in another window');
    expect(P.writeFile).toHaveBeenCalledTimes(2);
  });

  it('saves as before when the time stamp is unknown or the check itself fails', async () => {
    const unknown = opened(null);
    vi.spyOn(P, 'statFile').mockResolvedValue({ path: 'Documents/Report.docx', modified: 999 });
    unknown.changed();
    expect(await unknown.save()).toBe(true);
    const known = opened(100);
    P.statFile.mockRejectedValue(new Error('network'));
    known.changed();
    expect(await known.save()).toBe(true);
    expect(P.writeFile).toHaveBeenCalledTimes(2);
  });

  it('learns the time stamp from its first write when the document was opened without one', async () => {
    // Opening reads the file's bytes and nothing more; the first write's answer arms the check.
    const doc = opened(null);
    const stat = vi.spyOn(P, 'statFile').mockResolvedValue({ path: 'Documents/Report.docx', modified: 42 });
    P.writeFile.mockImplementationOnce(async (path, content) => { P.__fs.set(path, content); return { path, modified: 42 }; });
    doc.changed();
    expect(await doc.save()).toBe(true);
    stat.mockResolvedValue({ path: 'Documents/Report.docx', modified: 43 });
    doc.changed();
    await expect(doc.save()).rejects.toThrow('changed in another window');
    expect(P.writeFile).toHaveBeenCalledTimes(1);
  });
});
