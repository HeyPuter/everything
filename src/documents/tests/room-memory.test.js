import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  const fs = new Map();
  const writeFile = async (path, blob) => { fs.set(path, blob); return { path, modified: 1 }; };
  return {
    ...real,
    __fs: fs,
    fileExists: async (p) => fs.has(p),
    statFile: async (p) => (fs.has(p) ? { modified: 1 } : null),
    uniqueName: async (base) => `${real.stripExtension(base) || 'Untitled document'}.docx`,
    writeFile,
    createFileWithMetadata: writeFile,
    deleteFile: async (path) => { fs.delete(path); },
    renameFile: async (path, newName) => { const dir = path.slice(0, path.lastIndexOf('/')); fs.set(`${dir}/${newName}`, fs.get(path)); fs.delete(path); return { modified: 2 }; },
  };
});

const { Doc, versioning, publishing } = await import('../src/lib/doc.js');
const P = await import('../src/lib/puter.js');
const { rememberedRoom, rememberRoom, moveRoom, forgetRoom } = await import('../src/collab/room-memory.js');
const { rememberDocumentRoot } = await import('../src/lib/document-paths.js');
const { hash } = await import('../src/collab/protocol.js');

const ROOM = { server: 'https://documents-abc.puter.work', room: 'room1' };

describe('the room a shared file rejoins', () => {
  beforeEach(() => {
    versioning.enabled = false; publishing.enabled = false;
    P.__fs.clear();
    const kv = new Map();
    vi.stubGlobal('puter', { kv: { get: async k => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); return true; }, del: async k => kv.delete(k) } });
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows the file when it is renamed', async () => {
    P.__fs.set('Documents/Plan.docx', new Blob(['x']));
    const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx' });
    await rememberRoom(doc.path, ROOM);
    expect(await doc.rename('Plan v2')).toBeNull();
    expect(await rememberedRoom('Documents/Plan v2.docx')).toEqual(ROOM);
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
  });

  it('is not joined by a file renamed to the name of a shared one deleted elsewhere', async () => {
    // Shared, then deleted in the Puter desktop: the app never heard of it, and the memory stayed.
    await rememberRoom('Documents/Plan.docx', ROOM);
    P.__fs.set('Documents/Notes.docx', new Blob(['x']));
    const doc = new Doc({ name: 'Notes', path: 'Documents/Notes.docx' });
    expect(await doc.rename('Plan')).toBeNull();
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
  });

  it('is not joined by a file the document list renames to that name', async () => {
    await rememberRoom('Documents/Plan.docx', ROOM);
    await moveRoom('Documents/Notes.docx', 'Documents/Plan.docx');
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
  });

  it('is forgotten when the file is deleted, and never joined by a new file at its path', async () => {
    P.__fs.set('Documents/Plan.docx', new Blob(['x']));
    const shared = new Doc({ name: 'Plan', path: 'Documents/Plan.docx' });
    await rememberRoom(shared.path, ROOM);
    await shared.remove();
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
    // A room remembered by another window for a file that no longer exists does not pass to a new file there.
    await rememberRoom('Documents/Plan.docx', ROOM);
    const fresh = Doc.blank(); fresh.name = 'Plan';
    fresh.attach(async () => new Blob(['new']));
    fresh.changed();
    expect(await fresh.save()).toBe(true);
    expect(fresh.path).toBe('Documents/Plan.docx');
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
  });

  it('is the same room whether the file is spelled from the app folder or, as the document list does, from the root', async () => {
    const root = '/ada/AppData/app-1/Documents';
    rememberDocumentRoot(root, globalThis.puter);
    // Shared after its first save (spelled from the app folder), reopened from the list (spelled from the root).
    await rememberRoom('Documents/Plan.docx', ROOM);
    expect(await rememberedRoom(`${root}/Plan.docx`)).toEqual(ROOM);
    // Renamed in the list: the room follows.
    await moveRoom(`${root}/Plan.docx`, `${root}/Plan v2.docx`);
    expect(await rememberedRoom('Documents/Plan v2.docx')).toEqual(ROOM);
    expect(await rememberedRoom('Documents/Plan.docx')).toBeNull();
    // Deleted in the list: forgotten, however it is spelled.
    await forgetRoom(`${root}/Plan v2.docx`);
    expect(await rememberedRoom('Documents/Plan v2.docx')).toBeNull();
  });

  it('still finds a room remembered under the path spelled from the root', async () => {
    const root = '/ada/AppData/app-1/Documents';
    rememberDocumentRoot(root, globalThis.puter);
    await globalThis.puter.kv.set(`documents-collab-room:${await hash(`${root}/Plan.docx`)}`, ROOM);
    expect(await rememberedRoom('Documents/Plan.docx')).toEqual(ROOM);
    await forgetRoom('Documents/Plan.docx');
    expect(await rememberedRoom(`${root}/Plan.docx`)).toBeNull();
  });
});
