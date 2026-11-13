import { describe, it, expect, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Prefs } from '../src/prefs.js';
import { serializeDocument, parseDocument, isGzip, FileFormatError, migrate, validateData, readThumbnail, FORMAT_VERSION } from '../src/features/files/format.js';
import { nextUntitled, ensureExtension, suggestFileName, uniqueName, fileKind, baseName, dirName, stripExtension, relativeTime } from '../src/features/files/naming.js';
import { RecentFiles, entryKey } from '../src/features/files/recent.js';
import { RecoveryStore, recoverableEntries } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';
import { parsePresetForm, withOrientation, orientationOf, pushPreset, presetKey, sizeLabel } from '../src/features/files/presets.js';
import { documentSetupPatch } from '../src/features/files/document-setup.js';
import { documentStats } from '../src/features/files/document-info.js';
import { classifyError } from '../src/features/files/errors.js';
import { FileService } from '../src/features/files/service.js';
import { parseField, validField } from '../src/features/files/preferences.js';
import { createFromSettings, newDocumentQuick, peekUntitledName } from '../src/features/files/new-document.js';
import { bootApp } from './helpers.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function sampleDoc() {
  const doc = VDocument.create({ name: 'Logo', width: 200, height: 100 });
  const layer = doc.layers()[0];
  doc.transact('Add', () => {
    doc.insert(createPath(rectangle(10, 10, 50, 40), true), layer.id);
  });
  doc.assets.set('img1', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
  return doc;
}

const enc = new TextEncoder();

describe('native format', () => {
  it('round-trips through gzip', async () => {
    const doc = sampleDoc();
    const bytes = await serializeDocument(doc, { thumbnail: 'data:image/png;base64,THUMB' });
    expect(isGzip(bytes)).toBe(true);
    const r = await parseDocument(bytes);
    expect(r.compressed).toBe(true);
    expect(r.doc.root.name).toBe('Logo');
    expect(r.doc.artboards[0].w).toBe(200);
    expect(r.doc.leaves()).toHaveLength(1);
    expect(r.meta.thumbnail).toBe('data:image/png;base64,THUMB');
    expect(r.doc.dirty).toBe(false);
    expect(await readThumbnail(bytes)).toBe('data:image/png;base64,THUMB');
  });

  it('accepts plain JSON and a Blob', async () => {
    const doc = sampleDoc();
    const bytes = await serializeDocument(doc, { compress: false });
    expect(isGzip(bytes)).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(bytes)).format).toBe('vector-studio');
    const r = await parseDocument(new Blob([bytes]));
    expect(r.compressed).toBe(false);
    expect(r.doc.leaves()).toHaveLength(1);
  });

  it('drops assets nothing references', async () => {
    const doc = sampleDoc();
    const r = await parseDocument(await serializeDocument(doc, { compress: false }));
    expect(r.doc.assets.has('img1')).toBe(false);
  });

  it('reports clear errors', async () => {
    await expect(parseDocument(new Uint8Array())).rejects.toThrow(/empty/);
    await expect(parseDocument('<svg xmlns="http://www.w3.org/2000/svg"/>')).rejects.toMatchObject({ code: 'svg' });
    await expect(parseDocument('not json')).rejects.toThrow(/not a Vector Studio document/);
    await expect(parseDocument(JSON.stringify({ format: 'other', nodes: {} }))).rejects.toMatchObject({ code: 'format' });
    await expect(parseDocument(JSON.stringify({ format: 'vector-studio', version: FORMAT_VERSION + 1, nodes: { root: { type: 'root' } } }))).rejects.toMatchObject({ code: 'newer' });
    await expect(parseDocument(JSON.stringify({ format: 'vector-studio', version: 1, nodes: {} }))).rejects.toMatchObject({ code: 'damaged' });
    await expect(parseDocument(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]))).rejects.toBeInstanceOf(FileFormatError);
  });

  it('migrates unversioned documents and repairs what it can', async () => {
    const data = {
      nodes: {
        root: { id: 'root', type: 'root', name: 'Old', children: ['l1', 'ghost'] },
        l1: { id: 'l1', type: 'layer', name: 'Layer 1', children: ['p1', 'missing'] },
        p1: { type: 'path', anchors: [], closed: false },
      },
    };
    expect(migrate({ version: 0 }).migrated).toBe(true);
    const r = await parseDocument(JSON.stringify(data));
    expect(r.migrated).toBe(true);
    expect(r.version).toBe(0);
    expect(r.repaired).toBe(2);
    expect(r.doc.root.children).toEqual(['l1']);
    expect(r.doc.get('p1').id).toBe('p1');
    expect(r.doc.get('p1').parent).toBe('l1');
    expect(r.doc.artboards).toHaveLength(1);
    expect(r.doc.root.grid).toEqual({ spacing: 72, subdivisions: 8 });
  });

  it('repairs malformed objects so the document can be drawn', async () => {
    const nodes = {
      root: { id: 'root', type: 'root', name: 'Damaged', children: ['l1'], artboards: [{ id: 'a', name: 'A', x: 0, y: 0, w: 100, h: 100 }] },
      l1: { id: 'l1', type: 'layer', name: 'Layer 1', children: ['p1', 'p2', 'p3', 'g1', 't1'] },
      p1: { id: 'p1', type: 'path', closed: true },
      p2: { id: 'p2', type: 'path', anchors: 'abc', closed: true },
      p3: { id: 'p3', type: 'path', anchors: [null, { x: 1, y: 2 }, { x: 'a', y: 2 }, { x: 5, y: 6, ix: 4, iy: 5, ox: 6, oy: 7 }], closed: false },
      g1: { id: 'g1', type: 'group', name: 'G' },
      t1: { id: 't1', type: 'text', text: 42, x: 1, y: 2 },
    };
    const r = await parseDocument(JSON.stringify({ format: 'vector-studio', version: 1, nodes }));
    expect(r.doc.get('p1').anchors).toEqual([]);
    expect(r.doc.get('p2').anchors).toEqual([]);
    expect(r.doc.get('p3').anchors).toEqual([
      { x: 1, y: 2, ix: 1, iy: 2, ox: 1, oy: 2 },
      { x: 5, y: 6, ix: 4, iy: 5, ox: 6, oy: 7 },
    ]);
    expect(r.doc.get('g1').children).toEqual([]);
    expect(r.doc.get('t1')).toMatchObject({ text: '42', transform: [1, 0, 0, 1, 0, 0] });
    expect(r.doc.get('t1').char.fontSize).toBeGreaterThan(0);
    // Well-formed objects are left as they are.
    const doc = sampleDoc();
    const again = await parseDocument(await serializeDocument(doc));
    expect(JSON.stringify(again.doc.toJSON().nodes.root.children)).toBe(JSON.stringify(doc.root.children));
    for (const [id, n] of doc.nodes) if (id !== 'root') expect(again.doc.get(id)).toEqual(n);
  });

  it('adds a layer when a document has none', () => {
    const { data } = validateData({ format: 'vector-studio', version: 1, nodes: { root: { id: 'root', type: 'root', children: [] } } });
    expect(data.nodes.root.children).toHaveLength(1);
    expect(data.nodes[data.nodes.root.children[0]].type).toBe('layer');
  });
});

describe('VDocument.create extensions', () => {
  it('stores bleed per side and keeps number input working', () => {
    expect(VDocument.create({ bleed: 9 }).root.bleed).toEqual({ top: 9, bottom: 9, left: 9, right: 9 });
    expect(VDocument.create({ bleed: { top: 1, left: 2 } }).root.bleed).toEqual({ top: 1, bottom: 0, left: 2, right: 0 });
    const d = VDocument.create({ artboards: 3, columns: 3, width: 100, height: 50, spacing: 10, rasterResolution: 300 });
    expect(d.artboards.map((a) => a.x)).toEqual([0, 110, 220]);
    expect(d.root.rasterResolution).toBe(300);
  });
});

describe('naming', () => {
  it('numbers untitled documents past open ones', () => {
    expect(nextUntitled(0, [])).toEqual({ name: 'Untitled-1', counter: 1 });
    expect(nextUntitled(1, ['Untitled-1', 'Untitled-4', 'Logo'])).toEqual({ name: 'Untitled-5', counter: 5 });
    expect(nextUntitled(7, ['Untitled-2']).name).toBe('Untitled-8');
  });

  it('handles extensions', () => {
    expect(ensureExtension('Logo')).toBe('Logo.vstudio');
    expect(ensureExtension('Logo.VSTUDIO')).toBe('Logo.vstudio');
    expect(ensureExtension('logo.svg')).toBe('logo.vstudio');
    expect(ensureExtension('v1.2')).toBe('v1.2.vstudio');
    expect(ensureExtension('a/b:c?')).toBe('a-b-c-.vstudio');
    expect(ensureExtension('   ')).toBe('Untitled.vstudio');
    expect(suggestFileName('Untitled-3')).toBe('Untitled-3.vstudio');
    expect(stripExtension('x.vstudio')).toBe('x');
  });

  it('makes unique names and parses paths', () => {
    expect(uniqueName('Logo.vstudio', ['logo.vstudio', 'Logo 2.vstudio'])).toBe('Logo 3.vstudio');
    expect(uniqueName('New.vstudio', [])).toBe('New.vstudio');
    expect(baseName('/u/Documents/Logo.vstudio')).toBe('Logo.vstudio');
    expect(dirName('/u/Documents/Logo.vstudio')).toBe('/u/Documents');
    expect(fileKind('a.vstudio')).toBe('native');
    expect(fileKind('a.svg')).toBe('svg');
    expect(fileKind('drop', enc.encode('<?xml version="1.0"?><svg>'))).toBe('svg');
    expect(fileKind('drop', new Uint8Array([0x1f, 0x8b]))).toBe('native');
    expect(fileKind('drop', enc.encode('{"nodes":{}}'))).toBe('native');
    expect(relativeTime(1000, 1000 + 5 * 60 * 1000)).toBe('5 min ago');
  });
});

describe('preferences storage', () => {
  it('moves values saved under earlier key names to the current ones', () => {
    const storage = memStorage();
    storage.setItem('vector-studio:prefs', JSON.stringify({ smartGuides: false, smartGuideColor: 'cyan', prefsSection: 'smart' }));
    const prefs = new Prefs(storage);
    expect(prefs.get('alignmentGuides')).toBe(false);
    expect(prefs.get('alignmentGuideColor')).toBe('cyan');
    expect(prefs.get('prefsSection')).toBe('alignment');
    const saved = JSON.parse(storage.getItem('vector-studio:prefs'));
    expect(saved.alignmentGuides).toBe(false);
    expect('smartGuides' in saved).toBe(false);
  });

  it('keeps what another window saved when this one changes a different preference', () => {
    const storage = memStorage();
    const first = new Prefs(storage);
    const second = new Prefs(storage);
    first.set('theme', 'dark');
    second.set('dockTab', 'layers');
    const saved = JSON.parse(storage.getItem('vector-studio:prefs'));
    expect(saved.theme).toBe('dark');
    expect(saved.dockTab).toBe('layers');
    expect(new Prefs(storage).get('theme')).toBe('dark');
    // The same preference: the latest change wins.
    second.set('theme', 'light');
    expect(new Prefs(storage).get('theme')).toBe('light');
  });

  it('falls back to defaults for damaged stored values', () => {
    const storage = memStorage();
    storage.setItem('vector-studio:prefs', JSON.stringify({ keyboardIncrement: '1O', recentFiles: null, openPanels: 'x', dockOpen: 'yes', theme: 5, undoLevels: null, toolbarColumns: 3, cornerRadius: 4, guideColor: 'red', lastRect: { w: 5, h: 6 } }));
    const prefs = new Prefs(storage);
    expect(prefs.get('keyboardIncrement')).toBe(1);
    expect(prefs.get('recentFiles')).toEqual([]);
    expect(prefs.get('openPanels')).toEqual([]);
    expect(prefs.get('dockOpen')).toBe(true);
    expect(prefs.get('theme')).toBe('system');
    expect(prefs.get('undoLevels')).toBe(200);
    expect(prefs.get('toolbarColumns')).toBe('auto');
    // Valid values, and keys other modules own, are kept.
    expect(prefs.get('cornerRadius')).toBe(4);
    expect(prefs.get('guideColor')).toBe('red');
    expect(prefs.get('lastRect')).toEqual({ w: 5, h: 6 });
    for (const raw of ['null', '[1,2]', '"text"', '{"__proto__":{"polluted":1}}']) {
      storage.setItem('vector-studio:prefs', raw);
      const p = new Prefs(storage);
      expect(p.get('keyboardIncrement')).toBe(1);
      expect(p.values.polluted).toBeUndefined();
    }
  });
});

describe('recent files', () => {
  const make = (opts = {}) => {
    let t = 1000;
    const prefs = new Prefs(memStorage());
    const r = new RecentFiles(prefs, { cache: memoryBackend(), now: () => ++t, ...opts });
    return { prefs, r };
  };

  it('adds to the top, dedupes and caps the list', async () => {
    const { r } = make({ max: 3 });
    await r.add({ kind: 'puter', path: '/u/a.vstudio', name: 'a.vstudio' });
    await r.add({ kind: 'puter', path: '/u/b.vstudio', name: 'b.vstudio' });
    await r.add({ kind: 'puter', path: '/u/a.vstudio', name: 'a.vstudio' });
    expect(r.list().map((e) => e.name)).toEqual(['a.vstudio', 'b.vstudio']);
    await r.add({ kind: 'puter', path: '/u/c.vstudio', name: 'c.vstudio' });
    await r.add({ kind: 'puter', path: '/u/d.vstudio', name: 'd.vstudio' });
    expect(r.list().map((e) => e.name)).toEqual(['d.vstudio', 'c.vstudio', 'a.vstudio']);
  });

  it('keeps thumbnails in the cache, not in prefs', async () => {
    const { prefs, r } = make();
    const e = await r.add({ kind: 'puter', path: '/u/a.vstudio', name: 'a', thumb: 'data:image/png;base64,X' });
    expect(JSON.stringify(prefs.get('recentFiles'))).not.toContain('base64');
    r.thumbs.clear();
    expect(await r.thumb(e)).toBe('data:image/png;base64,X');
    await r.remove(e);
    expect(r.list()).toEqual([]);
    expect(await r.thumb(e)).toBe(null);
  });

  it('drops missing cloud files when validated, keeps them when offline', async () => {
    const { r } = make();
    await r.add({ kind: 'puter', path: '/u/gone.vstudio', name: 'gone' });
    await r.add({ kind: 'puter', path: '/u/here.vstudio', name: 'here' });
    await r.add({ kind: 'puter', path: '/u/offline.vstudio', name: 'offline' });
    const stat = vi.fn(async (p) => {
      if (p.includes('gone')) throw { code: 'subject_does_not_exist', message: 'Item does not exist' };
      if (p.includes('offline')) throw new Error('Failed to fetch');
      return { path: p };
    });
    const removed = await r.validate(stat, { force: true });
    expect(removed.map((e) => e.name)).toEqual(['gone']);
    expect(r.list().map((e) => e.name).sort()).toEqual(['here', 'offline']);
    // Recently checked entries are not stat-ed again.
    stat.mockClear();
    await r.validate(stat);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls[0][0]).toContain('offline');
  });

  it('ignores corrupt stored entries', () => {
    const { prefs, r } = make();
    prefs.set('recentFiles', [null, 5, { kind: 'puter' }, { kind: 'puter', path: '/x', name: 'x' }]);
    expect(r.list()).toHaveLength(1);
    expect(entryKey(r.list()[0])).toBe('puter:/x');
  });
});

describe('recovery bookkeeping', () => {
  it('stores, lists, reads and removes copies', async () => {
    const b = memoryBackend();
    const store = new RecoveryStore([b]);
    await store.put('r1', { name: 'A', data: new Uint8Array([1, 2]), session: 's1', saved: 10 });
    await store.put('r2', { name: 'B', data: new Uint8Array([3]), session: 's1', saved: 20, file: { kind: 'puter', path: '/u/b.vstudio', name: 'b.vstudio' } });
    await store.put('r1', { name: 'A2', data: new Uint8Array([4]), session: 's1', saved: 30 });
    const list = await store.list();
    expect(list.map((e) => e.name)).toEqual(['A2', 'B']);
    expect(list[1].file.path).toBe('/u/b.vstudio');
    const blob = await store.read(list[0]);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([4]);
    await store.remove('r1');
    expect((await store.list()).map((e) => e.id)).toEqual(['r2']);
    expect([...b.files.keys()].some((k) => k.includes('r1'))).toBe(false);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('falls back to the next store and cleans stale copies', async () => {
    const cloud = memoryBackend();
    const local = memoryBackend();
    const store = new RecoveryStore([cloud, local]);
    await store.put('r1', { name: 'v1', data: new Uint8Array([1]), saved: 1 });
    cloud.failNext = 2;
    await store.put('r1', { name: 'v2', data: new Uint8Array([2]), saved: 2 });
    let list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('v2');
    expect(list[0].backend).toBe(local);
    await store.put('r1', { name: 'v3', data: new Uint8Array([3]), saved: 3 });
    list = await store.list();
    expect(list[0].backend).toBe(cloud);
    expect([...local.files.keys()].some((k) => k.startsWith('recovery/r1'))).toBe(false);
  });

  it('keeps a recovery copy that could not be read right now, and drops a damaged one', async () => {
    const b = memoryBackend();
    const store = new RecoveryStore([b]);
    await store.put('ok', { name: 'Fine', data: await serializeDocument(sampleDoc()), session: 'dead', saved: 3 });
    await store.put('net', { name: 'Offline', data: await serializeDocument(sampleDoc()), session: 'dead', saved: 2 });
    await store.put('bad', { name: 'Damaged', data: new Uint8Array([1, 2, 3]), session: 'dead', saved: 1 });
    const readBlob = b.readBlob;
    b.readBlob = async (path) => {
      if (path === 'recovery/net.vstudio' || path.startsWith('recovery/net/')) throw new Error('Failed to fetch');
      return readBlob(path);
    };
    const prefs = new Prefs(memStorage());
    const app = { prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
    const saver = new Autosaver(app, { store, session: 'me' });
    saver.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    try {
      const opened = await saver.offerRecovery();
      expect(opened.map((e) => e.file.name)).toEqual(['Fine [Recovered]']);
    } finally {
      dialogHooks.open = null;
    }
    expect((await store.list()).map((e) => e.id)).toEqual(['ok', 'net']);
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/"Offline" could not be recovered right now/), expect.objectContaining({ error: true }));
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/"Damaged" could not be recovered: the recovery copy is damaged/), expect.objectContaining({ error: true }));
  });

  it('asks before discarding recovery copies, and keeps them for next time unless confirmed', async () => {
    const b = memoryBackend();
    const store = new RecoveryStore([b]);
    for (const [id, name] of [['a', 'Logo'], ['b', 'Flyer'], ['c', 'Card']]) await store.put(id, { name, data: await serializeDocument(sampleDoc()), session: 'dead', saved: 1 });
    const prefs = new Prefs(memStorage());
    const app = { prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
    const saver = new Autosaver(app, { store, session: 'me' });
    saver.liveSessions = async () => new Set();
    const asked = [];
    let answer = 'keep';
    dialogHooks.open = async (opts) => {
      if (opts.title === 'Recover Documents') {
        // Uncheck "Flyer", recover the others.
        opts.body.querySelector('#rec-b').checked = false;
        return 'recover';
      }
      asked.push(opts.body.textContent);
      return answer;
    };
    try {
      expect((await saver.offerRecovery()).map((e) => e.file.name)).toEqual(['Logo [Recovered]', 'Card [Recovered]']);
      expect(asked).toEqual([expect.stringContaining('Discard "Flyer"? Its unsaved changes will be lost.')]);
      // Kept: offered again next time.
      expect((await store.list()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
      // Discard everything, confirmed this time.
      dialogHooks.open = async (opts) => {
        if (opts.title === 'Recover Documents') return 'discard';
        asked.push(opts.body.textContent);
        return 'discard';
      };
      expect(await saver.offerRecovery()).toEqual([]);
      expect(asked[1]).toContain('Discard 3 documents ("Logo", "Flyer", "Card")?');
      expect(await store.list()).toEqual([]);
    } finally {
      dialogHooks.open = null;
    }
  });

  it('does not leave a recovery copy behind when the document is saved while it is being written', async () => {
    const store = new RecoveryStore([memoryBackend()]);
    const prefs = new Prefs(memStorage());
    const doc = sampleDoc();
    const editor = { doc, name: 'Logo', file: null };
    const app = { prefs, editors: [editor] };
    const saver = new Autosaver(app, { store, session: 'me' });
    const flushing = saver.flush();
    // Saved (and its copy discarded) while the copy is still being encoded.
    doc.markSaved();
    await saver.discard(editor);
    await flushing;
    expect(await store.list()).toEqual([]);
  });

  it('keeps the last edits made before the page closes even when the storage write never finishes', async () => {
    const b = memoryBackend();
    // The page closes: writes it starts never land.
    let closing = false;
    const store = new RecoveryStore([{ ...b, writeBlob: (...args) => (closing ? new Promise(() => {}) : b.writeBlob(...args)) }]);
    const prefs = new Prefs(memStorage());
    const doc = sampleDoc();
    const editor = { doc, name: 'Logo', file: null };
    const saver = new Autosaver({ prefs, editors: [editor] }, { store, session: 'closed' });
    // The regular copy and the one kept at close can carry the same time.
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000);
    await saver.flush();
    const id = editor.recoveryId;
    doc.transact('Add', () => doc.insert(createPath(rectangle(100, 10, 20, 20), true), doc.layers()[0].id));
    closing = true;
    saver.flush({ hiding: true });
    const key = `vs-recovery-unwritten:${id}`;
    expect(localStorage.getItem(key)).toContain('"revision":2');
    // Next start: the kept copy is written back, offered, and forgotten.
    const store2 = new RecoveryStore([b]);
    const app = { prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((d, { file }) => ({ doc: d, file })) };
    const next = new Autosaver(app, { store: store2, session: 'me' });
    next.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    try {
      const [opened] = await next.offerRecovery();
      expect(opened.doc.nodes.size).toBe(doc.nodes.size);
    } finally {
      dialogHooks.open = null;
      now.mockRestore();
    }
    expect(localStorage.getItem(key)).toBe(null);
    expect((await store2.list()).map((e) => e.revision)).toEqual([2]);
  });

  it('never lets a kept copy replace a newer stored one, and forgets kept copies once written or discarded', async () => {
    const store = new RecoveryStore([memoryBackend()]);
    const prefs = new Prefs(memStorage());
    const doc = sampleDoc();
    const editor = { doc, name: 'Logo', file: null };
    const editors = [editor];
    const saver = new Autosaver({ prefs, editors }, { store, session: 'old' });
    // Hidden, then the write lands: the kept copy is no longer needed.
    await saver.flush({ hiding: true });
    const key = `vs-recovery-unwritten:${editor.recoveryId}`;
    expect(localStorage.getItem(key)).toBe(null);
    // Kept, then discarded (saved or closed without saving).
    doc.transact('Add', () => doc.insert(createPath(rectangle(100, 10, 20, 20), true), doc.layers()[0].id));
    const busy = saver.flush({ hiding: true });
    expect(localStorage.getItem(key)).not.toBe(null);
    await busy;
    doc.transact('Add', () => doc.insert(createPath(rectangle(130, 10, 20, 20), true), doc.layers()[0].id));
    const flushing = saver.flush({ hiding: true });
    editors.length = 0;
    await saver.discard(editor);
    await flushing;
    expect(localStorage.getItem(key)).toBe(null);
    // A kept copy older than the stored one is dropped, not written back.
    await store.put('r9', { name: 'New', data: await serializeDocument(sampleDoc()), revision: 7, session: 'old', saved: 2000 });
    localStorage.setItem('vs-recovery-unwritten:r9', `${JSON.stringify({ id: 'r9', name: 'Old', file: null, revision: 5, session: 'old', saved: 1000 })}\n{}`);
    // A copy kept by a tab that is still running is left to that tab.
    localStorage.setItem('vs-recovery-unwritten:r8', `${JSON.stringify({ id: 'r8', name: 'Live', file: null, revision: 1, session: 'live', saved: 3000 })}\n{}`);
    const next = new Autosaver({ prefs, editors: [] }, { store, session: 'me' });
    next.liveSessions = async () => new Set(['live']);
    dialogHooks.open = async () => null;
    try {
      await next.offerRecovery();
    } finally {
      dialogHooks.open = null;
    }
    expect((await store.list()).map((e) => `${e.id}:${e.name}`)).toEqual(['r9:New']);
    expect(localStorage.getItem('vs-recovery-unwritten:r9')).toBe(null);
    expect(localStorage.getItem('vs-recovery-unwritten:r8')).not.toBe(null);
    localStorage.removeItem('vs-recovery-unwritten:r8');
  });

  it('skips copies owned by sessions that are still running', () => {
    const entries = [{ id: 'a', session: 'live' }, { id: 'b', session: 'dead' }, { id: 'c' }, { id: 'd', session: 'me' }];
    expect(recoverableEntries(entries, new Set(['live']), 'me').map((e) => e.id)).toEqual(['b', 'c']);
  });
});

describe('new document values', () => {
  it('numbers untitled documents without skipping', () => {
    const app = bootApp();
    const first = createFromSettings(app, { name: peekUntitledName(app), width: 100, height: 100, units: 'pt', artboards: 1, bleed: 0, rasterResolution: 72, previewMode: 'default' });
    expect(first.name).toBe('Untitled-1');
    expect(newDocumentQuick(app).name).toBe('Untitled-2');
    expect(app.newDocument({ name: 'Logo' }).name).toBe('Logo');
    expect(app.newDocument().name).toBe('Untitled-3');
    expect(peekUntitledName(app)).toBe('Untitled-4');
  });

  const base = { name: 'Untitled-1', width: '8.5', height: '11', units: 'in', artboards: '1', bleed: { top: '0', bottom: '0', left: '0', right: '0' } };

  it('parses sizes in the chosen units, with suffixes and arithmetic', () => {
    const r = parsePresetForm(base);
    expect(r.ok).toBe(true);
    expect(r.value.width).toBeCloseTo(612);
    expect(r.value.height).toBeCloseTo(792);
    expect(r.value.colorMode).toBe('RGB');
    const r2 = parsePresetForm({ ...base, width: '210 mm', height: '100*2', units: 'px', bleed: { top: '0.125 in', bottom: '9', left: '', right: '1pt' } });
    expect(r2.value.width).toBeCloseTo(595.28, 1);
    expect(r2.value.height).toBe(200);
    expect(r2.value.bleed).toEqual({ top: 9, bottom: 9, left: 0, right: 1 });
  });

  it('rejects invalid values with the field name', () => {
    expect(parsePresetForm({ ...base, name: '  ' })).toMatchObject({ ok: false, field: 'name' });
    expect(parsePresetForm({ ...base, width: 'abc' })).toMatchObject({ ok: false, field: 'width' });
    expect(parsePresetForm({ ...base, height: '0' })).toMatchObject({ ok: false, field: 'height' });
    expect(parsePresetForm({ ...base, width: '300', units: 'in' })).toMatchObject({ ok: false, field: 'width' });
    expect(parsePresetForm({ ...base, artboards: '1.5' })).toMatchObject({ ok: false, field: 'artboards' });
    expect(parsePresetForm({ ...base, artboards: '1001' })).toMatchObject({ ok: false, field: 'artboards' });
    expect(parsePresetForm({ ...base, bleed: { ...base.bleed, left: '2 in' } })).toMatchObject({ ok: false, field: 'bleed-left' });
    expect(parsePresetForm({ ...base, units: 'furlongs' }).value.units).toBe('pt');
  });

  it('states the limits in the chosen units, rounded so both ends are allowed', () => {
    expect(parsePresetForm({ ...base, width: '0', units: 'pt' }).message).toBe('Width must be between 1 pt and 16383 pt.');
    expect(parsePresetForm({ ...base, width: '9000', units: 'mm' }).message).toBe('Width must be between 0.4 mm and 5779.5 mm.');
    expect(parsePresetForm({ ...base, height: '300', units: 'in' }).message).toBe('Height must be between 0.02 in and 227.54 in.');
    expect(parsePresetForm({ ...base, width: '0', units: 'px' }).message).toBe('Width must be between 1 px and 16383 px.');
    expect(parsePresetForm({ ...base, units: 'cm', bleed: { ...base.bleed, top: '3' } }).message).toBe('Bleed must be between 0 cm and 2.54 cm.');
    // The stated ends are themselves accepted.
    expect(parsePresetForm({ ...base, width: '5779.5', height: '0.4', units: 'mm' }).ok).toBe(true);
    expect(parsePresetForm({ ...base, width: '227.54', height: '0.02', units: 'in' }).ok).toBe(true);
  });

  it('handles orientation and preset lists', () => {
    expect(orientationOf(10, 20)).toBe('portrait');
    expect(orientationOf(20, 10)).toBe('landscape');
    expect(withOrientation({ width: 10, height: 20 }, 'landscape')).toEqual({ width: 20, height: 10 });
    expect(withOrientation({ width: 10, height: 10 }, 'landscape')).toEqual({ width: 10, height: 10 });
    const a = { name: 'A', width: 1, height: 2, units: 'pt' };
    const b = { name: 'B', width: 1, height: 2, units: 'pt' };
    expect(pushPreset(pushPreset([], a), b).map((p) => p.name)).toEqual(['B', 'A']);
    expect(pushPreset([a, b], a).map((p) => p.name)).toEqual(['A', 'B']);
    expect(pushPreset([a, b], { ...a, width: 5 }, 2)).toHaveLength(2);
    expect(presetKey(a)).not.toBe(presetKey(b));
    expect(sizeLabel({ width: 612, height: 792, units: 'in' })).toBe('8.5 x 11 in');
  });
});

describe('document setup and info', () => {
  it('builds a minimal root patch', () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    const root = doc.root;
    expect(documentSetupPatch(root, { units: root.units, bleed: root.bleed, artboard: 0, width: 100, height: 100, showImagesInOutline: false })).toEqual({});
    const p = documentSetupPatch(root, { units: 'mm', bleed: { top: 9, bottom: 9, left: 9, right: 9 }, artboard: 0, width: 200, height: 100, showImagesInOutline: true, transparencyGrid: { size: 16 } });
    expect(p.units).toBe('mm');
    expect(p.bleed.top).toBe(9);
    expect(p.artboards[0].w).toBe(200);
    expect(p.showImagesInOutline).toBe(true);
    expect(p.transparencyGrid.size).toBe(16);
    doc.transact('Document Setup', () => doc.updateRoot(p));
    expect(doc.root.units).toBe('mm');
    doc.undo();
    expect(doc.root.units).toBe('pt');
  });

  it('counts objects and fonts', () => {
    const s = documentStats(sampleDoc());
    expect(s.counts.path).toBe(1);
    expect(s.counts.layer).toBe(1);
    expect(s.anchors).toBe(4);
    expect(s.images).toBe(1);
  });
});

describe('errors and preferences parsing', () => {
  it('classifies storage errors', () => {
    expect(classifyError(new Error('x'), { online: false }).kind).toBe('offline');
    expect(classifyError({ code: 'storage_limit_reached', message: 'Storage capacity limit reached' }).kind).toBe('quota');
    expect(classifyError({ code: 'forbidden', message: 'Permission denied' }).kind).toBe('permission');
    expect(classifyError({ code: 'subject_does_not_exist', message: 'Item does not exist' }).kind).toBe('missing');
    expect(classifyError(new Error('weird')).transient).toBe(true);
  });

  it('parses preference fields', () => {
    expect(parseField({ type: 'length' }, '1 mm', 'pt')).toBeCloseTo(2.835, 2);
    expect(parseField({ type: 'number', integer: true }, '2.6')).toBe(3);
    expect(validField({ type: 'number', min: 1, max: 8 }, 9)).toBe(false);
    expect(validField({ type: 'number', min: 1, max: 8 }, 4)).toBe(true);
    expect(validField({ type: 'select' }, 'x')).toBe(true);
  });
});

/** A small fake app around FileService with an in-memory Puter file system. */
function fakeApp({ cancelPicker = false } = {}) {
  const files = new Map();
  const puter = {
    fs: {
      write: vi.fn(async (path, blob) => {
        files.set(path, new Uint8Array(await blob.arrayBuffer()));
        return { path, name: baseName(path) };
      }),
      read: vi.fn(async (path) => {
        if (!files.has(path)) throw { code: 'subject_does_not_exist', message: 'Item does not exist' };
        return new Blob([files.get(path)]);
      }),
      stat: vi.fn(async (path) => {
        if (!files.has(path)) throw { code: 'subject_does_not_exist' };
        return { path };
      }),
    },
    ui: {
      showSaveFilePicker: vi.fn((blob, name) => {
        const p = (async () => {
          const path = `/u/Desktop/${name}`;
          files.set(path, new Uint8Array(await blob.arrayBuffer()));
          return { path, name };
        })();
        const out = cancelPicker ? new Promise(() => {}) : p;
        out.undefinedOnCancel = cancelPicker ? Promise.resolve(undefined) : p;
        return out;
      }),
    },
  };
  const prefs = new Prefs(memStorage());
  prefs.set('filesSaveDialog', 'puter');
  const handlers = {};
  const app = {
    env: 'app',
    user: { username: 'u' },
    puter,
    prefs,
    editors: [],
    editor: null,
    notify: vi.fn(),
    renderTabs: vi.fn(),
    emit: (n, v) => handlers[n]?.(v),
    dialogs: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true) },
    addDocument(doc, { file = null } = {}) {
      const ed = { doc, file, view: {}, get name() {
        return this.file?.name || doc.root.name;
      } };
      this.editors.push(ed);
      this.editor = ed;
      return ed;
    },
    activate(ed) {
      this.editor = ed;
    },
  };
  return { app, files, puter };
}

describe('FileService', () => {
  it('saves a new document through the Puter picker, then saves in place', async () => {
    const { app, files, puter } = fakeApp();
    const recent = new RecentFiles(app.prefs, { cache: memoryBackend() });
    const discard = vi.fn();
    const svc = new FileService(app, { recent, recovery: { discard }, handles: { find: async () => null, put: async () => true } });
    const ed = app.addDocument(sampleDoc());
    expect(ed.doc.dirty).toBe(true);
    expect(await svc.save(ed)).toBe(true);
    expect(puter.ui.showSaveFilePicker).toHaveBeenCalledWith(expect.any(Blob), 'Logo.vstudio');
    expect(ed.file).toEqual({ kind: 'puter', path: '/u/Desktop/Logo.vstudio', name: 'Logo.vstudio' });
    expect(ed.doc.dirty).toBe(false);
    expect(discard).toHaveBeenCalledWith(ed);
    expect(recent.list()[0].path).toBe('/u/Desktop/Logo.vstudio');

    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Changed' }));
    expect(await svc.save(ed)).toBe(true);
    expect(puter.fs.write).toHaveBeenCalledWith('/u/Desktop/Logo.vstudio', expect.any(Blob), expect.objectContaining({ overwrite: true }));
    const reopened = await parseDocument(files.get('/u/Desktop/Logo.vstudio'));
    expect(reopened.doc.root.name).toBe('Changed');
  });

  it('saves again after an in-flight save when the document changed meanwhile', async () => {
    const { app, files, puter } = fakeApp();
    const svc = new FileService(app, { recent: null });
    const ed = app.addDocument(sampleDoc(), { file: { kind: 'puter', path: '/u/Logo.vstudio', name: 'Logo.vstudio' } });
    const write = puter.fs.write.getMockImplementation();
    let release;
    puter.fs.write.mockImplementationOnce((...a) => new Promise((r) => (release = () => r(write(...a)))));
    const first = svc.save(ed);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // An edit while the first write is still in flight, then Save again (or Close > Save).
    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Edited during save' }));
    const second = svc.save(ed);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(ed.doc.dirty).toBe(false);
    expect(puter.fs.write).toHaveBeenCalledTimes(2);
    expect((await parseDocument(files.get('/u/Logo.vstudio'))).doc.root.name).toBe('Edited during save');
  });

  it('keeps the Save As location when an earlier save lands after it', async () => {
    const { app, files, puter } = fakeApp();
    const svc = new FileService(app, { recent: null });
    const ed = app.addDocument(sampleDoc(), { file: { kind: 'puter', path: '/u/Logo.vstudio', name: 'Logo.vstudio' } });
    const write = puter.fs.write.getMockImplementation();
    let release;
    puter.fs.write.mockImplementationOnce((...a) => new Promise((r) => (release = () => r(write(...a)))));
    const first = svc.save(ed);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Edited' }));
    // Save As while the slow save is still writing: the new file is written first.
    expect(await svc.saveAs(ed)).toBe(true);
    expect(ed.file.path).toBe('/u/Desktop/Logo.vstudio');
    release();
    expect(await first).toBe(true);
    // The tab stays on the file chosen last, and is saved.
    expect(ed.file.path).toBe('/u/Desktop/Logo.vstudio');
    expect(ed.doc.dirty).toBe(false);
    expect((await parseDocument(files.get('/u/Desktop/Logo.vstudio'))).doc.root.name).toBe('Edited');
  });

  it('clears the file name message in the Save As dialog once the name is edited', async () => {
    const { app } = fakeApp();
    app.prefs.set('filesSaveDialog', 'app');
    const svc = new FileService(app, { recent: null });
    const ed = app.addDocument(sampleDoc());
    const done = svc.saveAs(ed);
    let input = null;
    for (let i = 0; i < 50 && !(input = document.querySelector('dialog[open] #files-save-name')); i++) await new Promise((r) => setTimeout(r, 10));
    const dlg = input.closest('dialog');
    input.value = '  ';
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    const error = dlg.querySelector('.form-error');
    await vi.waitFor(() => expect(error.textContent).toBe('Enter a file name.'));
    input.value = 'Logo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(error.textContent).toBe('');
    dlg.querySelector('.dialog-close').click();
    expect(await done).toBe(false);
  });

  it('returns false when the save picker is cancelled', async () => {
    const { app } = fakeApp({ cancelPicker: true });
    const svc = new FileService(app, { recent: null });
    const ed = app.addDocument(sampleDoc());
    expect(await svc.save(ed)).toBe(false);
    expect(ed.doc.dirty).toBe(true);
  });

  it('opens cloud files once and reports missing ones', async () => {
    const { app, files } = fakeApp();
    const recent = new RecentFiles(app.prefs, { cache: memoryBackend() });
    const svc = new FileService(app, { recent });
    files.set('/u/a.vstudio', await serializeDocument(sampleDoc()));
    const ed = await svc.openPath('/u/a.vstudio');
    expect(ed.file).toEqual({ kind: 'puter', path: '/u/a.vstudio', name: 'a.vstudio' });
    expect(await svc.openPath('/u/a.vstudio')).toBe(ed);
    expect(app.editors).toHaveLength(1);
    await recent.add({ kind: 'puter', path: '/u/gone.vstudio', name: 'gone.vstudio' });
    // The home screen listing it is redrawn without it.
    app.home = { hidden: false };
    app.renderHome = vi.fn();
    expect(await svc.openPath('/u/gone.vstudio')).toBe(null);
    expect(app.dialogs.alert).toHaveBeenCalled();
    expect(recent.list().some((e) => e.name === 'gone.vstudio')).toBe(false);
    expect(app.renderHome).toHaveBeenCalledWith(app.home);
  });

  it('explains when SVG import is unavailable and uses it when present', async () => {
    const { app } = fakeApp();
    const svc = new FileService(app, { recent: null });
    const svg = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await svc.openBytes(svg, { name: 'logo.svg' })).toBe(null);
    expect(app.dialogs.alert.mock.calls[0][0].title).toMatch(/SVG/);
    app.importers = { svg: vi.fn(async (text, { name }) => VDocument.create({ name })) };
    const ed = await svc.openBytes(svg, { name: 'logo.svg' });
    expect(app.importers.svg).toHaveBeenCalledWith(expect.stringContaining('<svg'), { name: 'logo' });
    expect(ed.file).toMatchObject({ kind: 'import', format: 'svg', name: 'logo.svg' });
  });

  it('opens gzip-compressed .svgz files', async () => {
    const { app } = fakeApp();
    const svc = new FileService(app, { recent: null });
    app.importers = { svg: vi.fn(async (text, { name }) => VDocument.create({ name })) };
    const { gzip } = await import('../src/features/files/format.js');
    const bytes = await gzip(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'));
    const ed = await svc.openBytes(bytes, { name: 'logo.svgz' });
    expect(app.importers.svg).toHaveBeenCalledWith(expect.stringContaining('<rect'), { name: 'logo' });
    expect(ed.file).toMatchObject({ kind: 'import', format: 'svg' });
  });

  it('switches to an SVG already opened from the cloud instead of importing it again', async () => {
    const { app, files } = fakeApp();
    const svc = new FileService(app, { recent: null });
    app.importers = { svg: vi.fn(async (text, { name }) => VDocument.create({ name })) };
    files.set('/u/icon.svg', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>']));
    const ed = await svc.openPath('/u/icon.svg');
    expect(ed.file).toMatchObject({ kind: 'import', path: '/u/icon.svg' });
    expect(await svc.openPath('/u/icon.svg')).toBe(ed);
    expect(app.importers.svg).toHaveBeenCalledTimes(1);
  });
});

describe('Puter desktop hooks', () => {
  it('opens launch items, mirrors the title and asks before closing', async () => {
    const { installPuterHooks } = await import('../src/features/files/index.js');
    const handlers = {};
    const puter = {
      exit: vi.fn(),
      ui: {
        onLaunchedWithItems: (f) => (handlers.launch = f),
        onItemsOpened: (f) => (handlers.opened = f),
        onWindowClose: (f) => (handlers.close = f),
        setWindowTitle: vi.fn(),
      },
    };
    const clean = { doc: { dirty: false } };
    const dirty = { doc: { dirty: true } };
    const app = { env: 'app', puter, editors: [clean, dirty], activate: vi.fn(), closeDocument: vi.fn(async () => false) };
    const service = { openPath: vi.fn(async () => null) };
    document.title = 'Logo.vstudio - Vector Studio';
    installPuterHooks(app, service);
    expect(puter.ui.setWindowTitle).toHaveBeenCalledWith('Logo.vstudio - Vector Studio');
    await handlers.launch([{ path: '/u/a.vstudio', name: 'a.vstudio' }, { path: '/u/dir', is_dir: true }]);
    expect(service.openPath).toHaveBeenCalledTimes(1);
    expect(service.openPath).toHaveBeenCalledWith('/u/a.vstudio', { name: 'a.vstudio' });
    // Cancel in the save prompt keeps the window open.
    await handlers.close();
    expect(app.closeDocument).toHaveBeenCalledWith(dirty);
    expect(puter.exit).not.toHaveBeenCalled();
    app.closeDocument.mockResolvedValue(true);
    await handlers.close();
    expect(puter.exit).toHaveBeenCalled();
  });
});

describe('bleed guides', () => {
  it('outsets the artboard by the document bleed on each side', async () => {
    const { bleedRect } = await import('../src/render/canvas-view.js');
    const a = { x: 10, y: 20, w: 100, h: 50 };
    expect(bleedRect(a, 0)).toBe(null);
    expect(bleedRect(a, undefined)).toBe(null);
    expect(bleedRect(a, 9)).toEqual({ x: 1, y: 11, w: 118, h: 68 });
    expect(bleedRect(a, { top: 1, bottom: 2, left: 3, right: 4 })).toEqual({ x: 7, y: 19, w: 107, h: 53 });
  });
});

describe('home screen Your files', () => {
  it('labels the section with a real heading id and the home heading style', async () => {
    const { installHomeFiles } = await import('../src/features/files/home-files.js');
    const { installHome } = await import('../src/ui/home.js');
    const app = bootApp();
    installHome(app);
    const files = { cloud: false, recent: { list: () => [], thumb: async () => null }, service: { openLocal() {} } };
    installHomeFiles(app, files);
    app.showHome();
    const section = document.querySelector('section.files-home');
    const title = document.getElementById(section.getAttribute('aria-labelledby'));
    expect(title?.textContent).toBe('Your files');
    expect(title.classList.contains('home-h2')).toBe(true);
  });
});

describe('File menu', () => {
  it('offers Open from This Computer next to Open, for signed-in users whose Open shows the cloud', async () => {
    const { MENUS } = await import('../src/ui/menus.js');
    const file = MENUS.find((m) => m.label === 'File').submenu;
    expect(file.indexOf('file.openLocal')).toBe(file.indexOf('file.open') + 1);
  });
});
