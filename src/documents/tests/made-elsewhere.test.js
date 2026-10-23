// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberMade, forgetMade, madeFiles, withMade, madeLocation } from '../src/lib/made.js';
import { Doc, publishing, versioning } from '../src/lib/doc.js';
import { homeView } from '../src/views/home.js';
import { recentFiles } from '../src/lib/recent.js';
import { listVersions } from '../src/lib/versions.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

/**
 * Inside the Puter desktop a new document, and a copy, are saved where the user puts them in Puter's Save dialog,
 * outside the app folder the home screen lists. The app remembers the files it made that way and lists them too.
 */

const notFound = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });
let files, uids;
const entry = (path) => ({ path, name: path.split('/').pop(), size: files.get(path).size, modified: 5, uid: uids.get(path) });

function installPuter() {
  files = new Map();
  uids = new Map();
  const put = (path, blob) => { files.set(path, blob); if (!uids.has(path)) uids.set(path, `uid-${uids.size + 1}`); };
  const fs = {
    write: vi.fn(async (path, blob) => { put(path, blob); return entry(path); }),
    read: vi.fn(async (path) => { if (!files.has(path)) throw notFound(); return files.get(path); }),
    stat: vi.fn(async (arg) => {
      // By id, wherever the file is now; by path, as the drive spells it: from the root.
      const path = typeof arg === 'object' ? [...uids].find(([, uid]) => uid === arg.uid)?.[0] : arg.replace(/^~\//, '/alice/');
      if (!path || !files.has(path)) throw notFound();
      return entry(path);
    }),
    readdir: vi.fn(async (dir) => {
      const d = dir.replace(/^~\//, '/alice/');
      const inside = [...files.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/'));
      if (!inside.length && !d.endsWith('Documents')) throw notFound();
      return inside.map(entry);
    }),
    rename: vi.fn(async (path, name) => {
      const target = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
      files.set(target, files.get(path)); uids.set(target, uids.get(path)); files.delete(path); uids.delete(path);
      return entry(target);
    }),
    delete: vi.fn(async (path, { recursive = false } = {}) => { files.delete(path); if (recursive) for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) files.delete(k); }),
  };
  const ui = {
    showSaveFilePicker: vi.fn((blob, name) => {
      // The desktop writes the file, and answers with its path from the home folder and no time stamp.
      put(`/alice/Desktop/${name}`, blob);
      const saved = Promise.resolve({ name, path: `~/Desktop/${name}`, uid: uids.get(`/alice/Desktop/${name}`) });
      saved.undefinedOnCancel = saved;
      return saved;
    }),
  };
  vi.stubGlobal('puter', { env: 'app', fs, ui, auth: { isSignedIn: () => true } });
}

beforeEach(() => {
  localStorage.clear();
  versioning.enabled = false;
  publishing.enabled = false;
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  installPuter();
});
afterEach(() => {
  closeAllModals();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('documents made elsewhere on the drive', () => {
  it('a Save that asks where records the file under the spelling the drive lists it by', async () => {
    const doc = Doc.blank({ name: 'Report' });
    doc.attach(async () => new Blob(['typed']));
    doc.changed();
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('/alice/Desktop/Report.docx');
    // The file's time stamp arms the check for another window's writes.
    expect(doc._remoteModified).toBe(5);
    const made = await madeFiles();
    expect(made.map((f) => f.path)).toEqual(['/alice/Desktop/Report.docx']);
    // Open recent lists it, though not while it is the document open.
    expect(recentFiles(withMade([], made), { exclude: doc.path })).toEqual([]);
    expect(recentFiles(withMade([], made)).map((f) => f.name)).toEqual(['Report.docx']);
  });

  it('a document saved elsewhere has a version history, which goes when it is deleted', async () => {
    versioning.enabled = true;
    const doc = Doc.blank({ name: 'Report' });
    doc.attach(async () => new Blob(['typed']));
    doc.changed();
    expect(await doc.save()).toBe(true);
    expect(doc.uid).toBe(uids.get('/alice/Desktop/Report.docx'));
    // The first save leaves a snapshot, as one in the app folder does.
    await vi.waitFor(async () => expect(await listVersions(doc.path, { uid: doc.uid })).toHaveLength(1));
    const v = await doc.saveVersionNow({ label: 'Draft' });
    expect(v).toBeTruthy();
    expect(await listVersions(doc.path, { uid: doc.uid })).toHaveLength(2);
    const { path, uid } = doc;
    await doc.remove();
    expect(await listVersions(path, { uid })).toEqual([]);
    expect([...files.keys()].filter((k) => k.includes('.versions'))).toEqual([]);
  });

  it('follows a file moved or renamed elsewhere by its id, and forgets one deleted or in the trash', async () => {
    files.set('/alice/Desktop/A.docx', new Blob(['a'])); uids.set('/alice/Desktop/A.docx', 'uid-a');
    files.set('/alice/Desktop/B.docx', new Blob(['b'])); uids.set('/alice/Desktop/B.docx', 'uid-b');
    files.set('/alice/Desktop/C.docx', new Blob(['c'])); uids.set('/alice/Desktop/C.docx', 'uid-c');
    for (const p of ['A', 'B', 'C']) rememberMade({ path: `/alice/Desktop/${p}.docx`, uid: `uid-${p.toLowerCase()}` });
    // A is moved into a folder, B to the trash, C deleted.
    files.set('/alice/Work/A2.docx', files.get('/alice/Desktop/A.docx')); uids.set('/alice/Work/A2.docx', 'uid-a');
    files.delete('/alice/Desktop/A.docx'); uids.delete('/alice/Desktop/A.docx');
    files.set('/alice/Trash/B.docx', files.get('/alice/Desktop/B.docx')); uids.set('/alice/Trash/B.docx', 'uid-b');
    files.delete('/alice/Desktop/B.docx'); uids.delete('/alice/Desktop/B.docx');
    files.delete('/alice/Desktop/C.docx');
    expect((await madeFiles()).map((f) => f.path)).toEqual(['/alice/Work/A2.docx']);
    // The record followed A: the next listing reads its new folder.
    puter.fs.stat.mockClear();
    expect((await madeFiles()).map((f) => f.path)).toEqual(['/alice/Work/A2.docx']);
    expect(puter.fs.stat).not.toHaveBeenCalled();
  });

  it('keeps the record of a file whose folder cannot be read just now', async () => {
    rememberMade({ path: '/alice/Desktop/A.docx', uid: 'uid-a' });
    puter.fs.readdir.mockRejectedValueOnce(new Error('offline'));
    const made = await madeFiles();
    expect([...made]).toEqual([]);
    expect(made.unreachable).toEqual(['/alice/Desktop/A.docx']);
    files.set('/alice/Desktop/A.docx', new Blob(['a'])); uids.set('/alice/Desktop/A.docx', 'uid-a');
    expect((await madeFiles()).map((f) => f.path)).toEqual(['/alice/Desktop/A.docx']);
  });

  it('follows a rename and forgets a deletion made here', async () => {
    rememberMade({ path: '/alice/Desktop/A.docx', uid: 'uid-a' });
    forgetMade('/alice/Desktop/A.docx', '/alice/Desktop/Final.docx');
    files.set('/alice/Desktop/Final.docx', new Blob(['a'])); uids.set('/alice/Desktop/Final.docx', 'uid-a');
    expect((await madeFiles()).map((f) => f.path)).toEqual(['/alice/Desktop/Final.docx']);
    forgetMade('/alice/Desktop/Final.docx');
    expect([...await madeFiles()]).toEqual([]);
  });

  it('a file in the app folder is left to the folder listing', () => {
    rememberMade({ path: 'Documents/A.docx' });
    expect(localStorage.length).toBe(0);
    const folder = [{ name: 'A.docx', path: 'Documents/A.docx', uid: 'uid-a' }];
    expect(withMade(folder, [{ name: 'A.docx', path: '/alice/Desktop/A.docx', uid: 'uid-a' }, { name: 'B.docx', path: '/alice/Desktop/B.docx', uid: 'uid-b' }]).map((f) => f.path))
      .toEqual(['Documents/A.docx', '/alice/Desktop/B.docx']);
  });

  it('names the folder a document is in', () => {
    expect(madeLocation('/alice/Desktop/A.docx')).toBe('Desktop');
    expect(madeLocation('~/Work/Q3/A.docx')).toBe('Work/Q3');
    expect(madeLocation('/alice/A.docx')).toBe('Home');
    expect(madeLocation('Documents/A.docx')).toBe('');
  });

  it('the home screen lists them with the app folder, says where they are, and renames them in their own folder', async () => {
    files.set('Documents/Notes.docx', new Blob(['n'])); uids.set('Documents/Notes.docx', 'uid-n');
    files.set('Documents/Plans.docx', new Blob(['p'])); uids.set('Documents/Plans.docx', 'uid-p');
    files.set('/alice/Desktop/Notes.docx', new Blob(['d'])); uids.set('/alice/Desktop/Notes.docx', 'uid-d');
    rememberMade({ path: '/alice/Desktop/Notes.docx', uid: 'uid-d' });
    const view = homeView({ openPath: vi.fn(), newDoc: vi.fn(), newFromTemplate: vi.fn(), importFile: vi.fn() });
    document.body.append(view.el);
    await vi.waitFor(() => expect(view.el.querySelectorAll('.file-row')).toHaveLength(3));
    const desktop = view.el.querySelector('[data-path="/alice/Desktop/Notes.docx"]');
    expect(desktop.querySelector('.file-meta').textContent).toMatch(/^Desktop · /);
    expect(desktop.querySelector('.file-main').title).toBe('Notes.docx in Desktop');
    expect(view.el.querySelector('[data-path="Documents/Notes.docx"] .file-main').title).toBe('');
    // A name taken in another folder is free in this one.
    desktop.querySelector('.file-menu-btn').click();
    [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Rename')).click();
    const input = document.querySelector('.modal-panel input');
    input.value = 'Plans';
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(files.has('/alice/Desktop/Plans.docx')).toBe(true));
    await vi.waitFor(() => expect(view.el.querySelector('[data-path="/alice/Desktop/Plans.docx"]')).not.toBeNull());
    expect((await madeFiles()).map((f) => f.path)).toEqual(['/alice/Desktop/Plans.docx']);
    view.destroy();
  });
});
