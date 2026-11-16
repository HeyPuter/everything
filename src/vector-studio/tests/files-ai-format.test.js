// Documents are saved as PDF-compatible .ai files: PDF pages any reader shows, around the
// editable document. Files saved before (.vstudio) still open, and save as a new .ai file;
// a .ai file from another program asks before it is replaced.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Prefs } from '../src/prefs.js';
import { serializeDocument, parseDocument, readThumbnail, FileFormatError } from '../src/features/files/format.js';
import { isPDF, embeddedDocument, fileIdentifier, plainContainer } from '../src/features/files/container.js';
import { NATIVE_EXT, baseName, fileKind, nextUntitled, suggestFileName } from '../src/features/files/naming.js';
import { FileService } from '../src/features/files/service.js';
import { writePDF } from '../src/features/io/pdf.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function sampleDoc(name = 'Logo') {
  const doc = VDocument.create({ name, width: 200, height: 100 });
  doc.transact('Add', () => doc.insert({ ...createPath(rectangle(10, 10, 50, 40), true), fill: { type: 'solid', color: '#ff0000' } }, doc.layers()[0].id));
  return doc;
}

/** The .ai file a save writes when the pages are drawn (the app's exporter does this through writePDF). */
async function aiFile(doc, opts = {}) {
  const data = await serializeDocument(doc, { thumbnail: 'data:image/png;base64,THUMB', ...opts });
  return (await writePDF(doc, doc.artboards, { title: doc.name, layers: true, document: data })).bytes;
}

describe('.ai container', () => {
  it('is a PDF whose pages show the artwork and that carries the document', async () => {
    const doc = sampleDoc();
    const bytes = await aiFile(doc);
    expect(isPDF(bytes)).toBe(true);
    expect(latin1(bytes.subarray(0, 5))).toBe('%PDF-');
    // Any PDF reader sees the artwork: the page imports as the rectangle.
    const pages = await pdfToDocument(bytes, { families: [] });
    expect(pages.artboards[0]).toMatchObject({ w: 200, h: 100 });
    expect(pages.leaves().some((n) => n.type === 'path' && n.fill?.color?.toLowerCase() === '#ff0000')).toBe(true);
    // Opening it here reads the document itself.
    const r = await parseDocument(bytes);
    expect(r.container).toBe(true);
    expect(r.doc.root.name).toBe('Logo');
    expect(r.doc.leaves()).toEqual(doc.leaves());
    expect(r.meta.thumbnail).toBe('data:image/png;base64,THUMB');
    expect(await readThumbnail(bytes)).toBe('data:image/png;base64,THUMB');
  });

  it('names its data in the catalog and ties it to the file identifier', async () => {
    const bytes = await aiFile(sampleDoc());
    const text = latin1(bytes);
    expect(text).toMatch(/\/PieceInfo << \/VectorStudio << \/LastModified \(D:\d{14}Z\) \/Private \d+ 0 R >> >>/);
    const id = fileIdentifier(bytes);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(text).toContain(`/Type /VectorStudioDocument /Version 1 /DocID <${id}>`);
  });

  it('does not use a document another program has written over', async () => {
    const bytes = await aiFile(sampleDoc());
    const text = latin1(bytes);
    // An incremental update: a later trailer gives the file a new identifier.
    const first = fileIdentifier(bytes);
    const xref = /startxref\n(\d+)\n%%EOF\n$/.exec(text)[1];
    const update = `xref\n0 0\ntrailer\n<< /Size 1 /Prev ${xref} /Root 1 0 R /ID [<${first}> <${'ab'.repeat(16)}>] >>\nstartxref\n${bytes.length}\n%%EOF\n`;
    const updated = bytesOf(text + update);
    expect(fileIdentifier(updated)).toBe('ab'.repeat(16));
    expect(embeddedDocument(updated)).toBeNull();
    await expect(parseDocument(updated)).rejects.toMatchObject({ code: 'foreign' });
    // A plain PDF has no document either.
    const plain = (await writePDF(sampleDoc(), [{ x: 0, y: 0, w: 200, h: 100 }])).bytes;
    expect(embeddedDocument(plain)).toBeNull();
    await expect(parseDocument(plain)).rejects.toBeInstanceOf(FileFormatError);
    expect(await readThumbnail(plain)).toBeNull();
  });

  it('rejects a data stream that was cut short or filtered', async () => {
    const bytes = await aiFile(sampleDoc());
    expect(embeddedDocument(bytes.subarray(0, bytes.length - 400))).toBeNull();
    const filtered = bytesOf(latin1(bytes).replace('/Type /VectorStudioDocument /Version 1', '/Type /VectorStudioDocument /Filter /FlateDecode'));
    expect(embeddedDocument(filtered)).toBeNull();
  });

  it('still holds the whole document when the pages cannot be drawn', async () => {
    const doc = sampleDoc();
    const bytes = plainContainer(doc.artboards, await serializeDocument(doc));
    expect(isPDF(bytes)).toBe(true);
    expect((await parseDocument(bytes)).doc.leaves()).toEqual(doc.leaves());
    // A valid one-page PDF of the artboard's size, saying where the artwork is.
    const pages = await pdfToDocument(bytes, { families: [] });
    expect(pages.artboards).toHaveLength(1);
    expect(pages.artboards[0]).toMatchObject({ w: 200, h: 100 });
    expect(latin1(bytes)).toContain('saved without a preview');
  });

  it('names documents .ai', () => {
    expect(NATIVE_EXT).toBe('.ai');
    expect(suggestFileName('Poster.vstudio')).toBe('Poster.ai');
    expect(suggestFileName('logo.svg')).toBe('logo.ai');
    expect(nextUntitled(0, ['Untitled-4.ai', 'Untitled-2.vstudio']).name).toBe('Untitled-5');
    // A .ai file is known by its contents, not its name; document data on its own is still recognized.
    expect(fileKind('a.ai')).toBe('unknown');
    expect(fileKind('a.vstudio')).toBe('native');
  });
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** A small fake app around FileService with an in-memory Puter file system. */
function fakeApp() {
  const files = new Map();
  const store = async (path, blob) => files.set(path, new Uint8Array(await blob.arrayBuffer()));
  const puter = {
    fs: {
      write: vi.fn(async (path, blob) => {
        await store(path, blob);
        return { path, name: baseName(path) };
      }),
      read: vi.fn(async (path) => new Blob([files.get(path)])),
      stat: vi.fn(async (path) => {
        if (!files.has(path)) throw { code: 'subject_does_not_exist' };
        return { path };
      }),
    },
    ui: {
      showSaveFilePicker: vi.fn((blob, name) => {
        const p = store(`/u/Desktop/${name}`, blob).then(() => ({ path: `/u/Desktop/${name}`, name }));
        p.undefinedOnCancel = p;
        return p;
      }),
    },
  };
  const prefs = new Prefs(memStorage());
  prefs.set('filesSaveDialog', 'puter');
  const app = {
    env: 'app',
    user: { username: 'u' },
    puter,
    prefs,
    editors: [],
    editor: null,
    notify: vi.fn(),
    renderTabs: vi.fn(),
    emit: () => {},
    dialogs: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true) },
    // The app's exporter draws the pages with the PDF writer.
    exporters: { documentFile: vi.fn(async (doc, data) => (await writePDF(doc, doc.artboards, { title: doc.name, layers: true, document: data })).bytes) },
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
  return { app, files, puter, svc: new FileService(app, { recent: null }) };
}

describe('FileService with .ai files', () => {
  afterEach(() => {
    dialogHooks.open = null;
  });

  it('saves a new document as a .ai file that opens again as the same document', async () => {
    const { app, files, puter, svc } = fakeApp();
    const ed = app.addDocument(sampleDoc());
    const saved = vi.fn();
    ed.doc.on('saved', saved);
    expect(await svc.save(ed)).toBe(true);
    expect(puter.ui.showSaveFilePicker).toHaveBeenCalledWith(expect.any(Blob), 'Logo.ai');
    expect(puter.ui.showSaveFilePicker.mock.calls[0][0].type).toBe('application/vnd.adobe.illustrator');
    expect(ed.file).toEqual({ kind: 'puter', path: '/u/Desktop/Logo.ai', name: 'Logo.ai' });
    const bytes = files.get('/u/Desktop/Logo.ai');
    expect(isPDF(bytes)).toBe(true);
    expect((await pdfToDocument(bytes, { families: [] })).leaves().length).toBeGreaterThan(0);
    // Version History keeps the document data, not a second copy of the pages.
    expect(isPDF(saved.mock.calls[0][0].bytes)).toBe(false);
    expect((await parseDocument(saved.mock.calls[0][0].bytes)).doc.root.name).toBe('Logo');

    app.editors.length = 0;
    const again = await svc.openPath('/u/Desktop/Logo.ai');
    expect(again.file).toEqual({ kind: 'puter', path: '/u/Desktop/Logo.ai', name: 'Logo.ai' });
    expect(again.doc.leaves()).toEqual(ed.doc.leaves());
    expect(again.doc.fileId).toBe(ed.doc.fileId);
    // It saves back in place, without asking.
    again.doc.transact('Rename', () => again.doc.updateRoot({ name: 'Changed' }));
    expect(await svc.save(again)).toBe(true);
    expect(puter.fs.write).toHaveBeenCalledWith('/u/Desktop/Logo.ai', expect.any(Blob), expect.objectContaining({ overwrite: true }));
    expect((await parseDocument(files.get('/u/Desktop/Logo.ai'))).doc.root.name).toBe('Changed');
  });

  it('writes the pages and the document from the same moment', async () => {
    const { app, files, svc } = fakeApp();
    const ed = app.addDocument(sampleDoc(), { file: { kind: 'puter', path: '/u/Logo.ai', name: 'Logo.ai' } });
    const draw = app.exporters.documentFile.getMockImplementation();
    let pagesAtWrite = null;
    app.exporters.documentFile.mockImplementationOnce(async (doc, data) => {
      // An edit lands while the pages are still being drawn.
      await Promise.resolve();
      ed.doc.transact('Add', () => ed.doc.insert(createPath(rectangle(100, 10, 20, 20), true), ed.doc.layers()[0].id));
      pagesAtWrite = doc.leaves().length;
      return draw(doc, data);
    });
    expect(await svc.save(ed)).toBe(true);
    expect(pagesAtWrite).toBe(1);
    expect((await parseDocument(files.get('/u/Logo.ai'))).doc.leaves()).toHaveLength(1);
    // The edit is not in the file: the document is still unsaved.
    expect(ed.doc.dirty).toBe(true);
  });

  it('saves the document even when its pages cannot be drawn, and says so', async () => {
    const { app, files, svc } = fakeApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.exporters.documentFile.mockRejectedValueOnce(new Error('no canvas'));
    const ed = app.addDocument(sampleDoc(), { file: { kind: 'puter', path: '/u/Logo.ai', name: 'Logo.ai' } });
    expect(await svc.save(ed)).toBe(true);
    warn.mockRestore();
    expect((await parseDocument(files.get('/u/Logo.ai'))).doc.leaves()).toHaveLength(1);
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('without a preview'), expect.anything());
    expect(ed.doc.dirty).toBe(false);
  });

  it('opens a .vstudio file and saves it as a new .ai file, leaving the original alone', async () => {
    const { app, files, puter, svc } = fakeApp();
    const old = await serializeDocument(sampleDoc('Poster'));
    files.set('/u/Poster.vstudio', old);
    const ed = await svc.openPath('/u/Poster.vstudio');
    expect(ed.doc.root.name).toBe('Poster');
    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Poster 2' }));
    expect(await svc.save(ed)).toBe(true);
    // Save went through Save As with a .ai name; nothing was written into the old file.
    expect(puter.fs.write).not.toHaveBeenCalled();
    expect(puter.ui.showSaveFilePicker).toHaveBeenCalledWith(expect.any(Blob), 'Poster.ai');
    expect(files.get('/u/Poster.vstudio')).toBe(old);
    expect(ed.file.path).toBe('/u/Desktop/Poster.ai');
    expect(isPDF(files.get('/u/Desktop/Poster.ai'))).toBe(true);
    // From then on it saves in place.
    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Poster 3' }));
    expect(await svc.save(ed)).toBe(true);
    expect(puter.fs.write).toHaveBeenCalledWith('/u/Desktop/Poster.ai', expect.any(Blob), expect.anything());
  });

  describe('a .ai file from another program', () => {
    const foreign = bytesOf('%PDF-1.5\n% made elsewhere\n');
    function setup() {
      const ctx = fakeApp();
      ctx.files.set('/u/Art.ai', foreign);
      ctx.app.importers = {
        detect: (name, head) => (isPDF(head) || /\.(ai|pdf)$/.test(name) ? 'pdf' : null),
        open: vi.fn(async () => sampleDoc('Art')),
      };
      return ctx;
    }

    it('opens from its pages and asks once before Save replaces it', async () => {
      const { app, files, puter, svc } = setup();
      const ed = await svc.openPath('/u/Art.ai');
      expect(app.importers.open).toHaveBeenCalledWith(foreign, { name: 'Art.ai', format: 'pdf' });
      expect(ed.file).toEqual({ kind: 'puter', path: '/u/Art.ai', name: 'Art.ai', foreign: true });
      ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Edited' }));

      const asked = [];
      dialogHooks.open = async (opts) => {
        asked.push(opts.body.textContent);
        return null;
      };
      expect(await svc.save(ed)).toBe(false);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('"Art.ai" was made in another program');
      expect(files.get('/u/Art.ai')).toBe(foreign);
      expect(ed.doc.dirty).toBe(true);

      dialogHooks.open = async (opts) => {
        asked.push(opts.body.textContent);
        return 'replace';
      };
      expect(await svc.save(ed)).toBe(true);
      expect(asked).toHaveLength(2);
      expect(puter.fs.write).toHaveBeenCalledWith('/u/Art.ai', expect.any(Blob), expect.anything());
      expect((await parseDocument(files.get('/u/Art.ai'))).doc.root.name).toBe('Edited');
      expect(ed.file).toEqual({ kind: 'puter', path: '/u/Art.ai', name: 'Art.ai' });
      // It is this app's file now: no more questions.
      ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Edited again' }));
      expect(await svc.save(ed)).toBe(true);
      expect(asked).toHaveLength(2);
    });

    it('keeps the original when Save As is chosen instead', async () => {
      const { app, files, puter, svc } = setup();
      const ed = await svc.openPath('/u/Art.ai');
      dialogHooks.open = async () => 'saveAs';
      expect(await svc.save(ed)).toBe(true);
      expect(puter.fs.write).not.toHaveBeenCalled();
      expect(files.get('/u/Art.ai')).toBe(foreign);
      expect(ed.file.path).toBe('/u/Desktop/Art.ai');
      expect(app.editors).toHaveLength(1);
    });

    it('reverts to its pages', async () => {
      const { app, svc } = setup();
      const ed = await svc.openPath('/u/Art.ai');
      ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Edited' }));
      expect(svc.canRevert(ed)).toBe(true);
      svc.replaceDocument = vi.fn(async (old, doc, file) => app.addDocument(doc, { file }));
      const back = await svc.revert(ed);
      expect(app.importers.open).toHaveBeenCalledTimes(2);
      expect(back.doc.root.name).toBe('Art');
      expect(back.file.foreign).toBe(true);
    });

    it('imports a PDF as before: Save writes a new .ai file', async () => {
      const { files, puter, svc } = setup();
      files.set('/u/Sheet.pdf', foreign);
      const ed = await svc.openPath('/u/Sheet.pdf');
      expect(ed.file).toEqual({ kind: 'import', format: 'pdf', name: 'Sheet.pdf', path: '/u/Sheet.pdf' });
      expect(await svc.save(ed)).toBe(true);
      expect(puter.ui.showSaveFilePicker).toHaveBeenCalledWith(expect.any(Blob), 'Sheet.ai');
      expect(files.get('/u/Sheet.pdf')).toBe(foreign);
    });
  });
});
