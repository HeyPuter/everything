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
const { rememberedRoom, rememberRoom } = await import('../src/collab/room-memory.js');

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
});
