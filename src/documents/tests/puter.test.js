import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as P from '../src/lib/puter.js';

describe('names', () => {
  it('sanitizes file names', () => {
    expect(P.sanitizeName('  Report/2026\\Q1 ')).toBe('Report 2026 Q1');
    expect(P.sanitizeName('x'.repeat(300))).toHaveLength(200);
    // Invisible format characters would spoof or duplicate a name; joiners inside words (Persian, Indic) stay.
    expect(P.sanitizeName('\u202Eexe.docx')).toBe('exe.docx');
    expect(P.sanitizeName('a\u200bb \ufeffc\u2066d\u2069')).toBe('ab cd');
    expect(P.sanitizeName('می\u200cخواهم')).toBe('می\u200cخواهم');
    // Dots alone name no file; a name that merely starts with one is kept.
    for (const dots of ['.', '..', ' ... ', '\u202e..']) expect(P.sanitizeName(dots)).toBe('');
    expect(P.sanitizeName('.hidden')).toBe('.hidden');
    // A space at the cut is trimmed too, so no file name ends in a space.
    expect(P.sanitizeName(`${'x'.repeat(199)} y`)).toBe('x'.repeat(199));
    // Nor does a cut leave half an emoji behind: that would break the document's URL.
    const emoji = P.sanitizeName(`${'x'.repeat(199)}😀`);
    expect(emoji).toBe('x'.repeat(199));
    expect(P.sanitizeName('😀'.repeat(120)).isWellFormed()).toBe(true);
    expect(() => encodeURIComponent(P.sanitizeName('😀'.repeat(120)))).not.toThrow();
    expect(P.ensureDocx('Report')).toBe('Report.docx');
    expect(P.ensureDocx('Report.DOCX')).toBe('Report.DOCX');
    expect(P.displayName('Documents/a/b.docx')).toBe('b.docx');
    expect(P.stripExtension('Report.final.docx')).toBe('Report.final');
    expect(P.stripExtension('no extension')).toBe('no extension');
  });

  it('recognizes not-found errors in their several shapes', () => {
    expect(P.isNotFound({ code: 'subject_does_not_exist' })).toBe(true);
    expect(P.isNotFound(new Error('File not found'))).toBe(true);
    expect(P.isNotFound({ error: { message: 'The path does not exist' } })).toBe(true);
    expect(P.isNotFound(new Error('permission denied'))).toBe(false);
  });
});

describe('files', () => {
  let entries;
  let writes;
  beforeEach(() => {
    writes = [];
    entries = [
      { name: 'b.docx', path: 'Documents/b.docx', size: 10, modified: 100, is_dir: false },
      { name: 'notes.txt', path: 'Documents/notes.txt', size: 1, modified: 500, is_dir: false },
      { name: 'sub', path: 'Documents/sub', is_dir: true },
      { name: 'a.docx', path: 'Documents/a.docx', size: 20, modified: 300, is_dir: false },
      { name: 'old.dotx', path: 'Documents/old.dotx', size: 5, modified: 200, is_dir: false },
    ];
    globalThis.puter = {
      env: 'app',
      fs: {
        async readdir(p) { if (p !== 'Documents') throw Object.assign(new Error('x does not exist'), { code: 'subject_does_not_exist' }); return entries; },
        async stat(p) { const e = entries.find((x) => x.path === p); if (!e) throw new Error('does not exist'); return e; },
        async mkdir() { return {}; },
        async write(path, data, opts) { writes.push({ path, size: data.size, opts }); return { path, name: path.split('/').pop() }; },
      },
      ui: { showOpenFilePicker() {} },
    };
  });
  afterEach(() => { delete globalThis.puter; });

  it('lists only document files, newest first', async () => {
    const files = await P.listFiles();
    expect(files.map((f) => f.name)).toEqual(['a.docx', 'old.dotx', 'b.docx']);
    expect(files[0].path).toBe('Documents/a.docx');
  });

  it('treats a missing folder as empty', async () => {
    globalThis.puter.fs.readdir = async () => { throw Object.assign(new Error('nope'), { code: 'subject_does_not_exist' }); };
    expect(await P.listFiles()).toEqual([]);
  });

  it('finds a free name', async () => {
    expect(await P.uniqueName('b.docx')).toBe('b 2.docx');
    expect(await P.uniqueName('c')).toBe('c.docx');
    expect(await P.uniqueName('')).toBe('Untitled document.docx');
  });

  it('keeps a template\'s or macro-enabled document\'s own extension when finding a free name', async () => {
    expect(await P.uniqueName('old.dotx')).toBe('old 2.dotx');
    expect(await P.uniqueName('Macros.DOCM')).toBe('Macros.docm');
    expect(await P.uniqueName('Notes.txt')).toBe('Notes.docx');
  });

  it('finds a free name among many copies without a cloud request per collision', async () => {
    entries = Array.from({ length: 1000 }, (_, i) => {
      const name = `Report${i ? ` ${i + 1}` : ''}.docx`;
      return { name, path: `Documents/${name}` };
    });
    const stat = vi.spyOn(puter.fs, 'stat');
    const list = vi.spyOn(puter.fs, 'readdir');
    expect(await P.uniqueName('Report.docx')).toBe('Report 1001.docx');
    expect(stat.mock.calls.length + list.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('keeps gaps available and accounts for directories with document-like names', async () => {
    entries.push({ name: 'b 2.docx', path: 'Documents/b 2.docx', is_dir: true });
    entries.push({ name: 'b 4.docx', path: 'Documents/b 4.docx' });
    expect(await P.uniqueName('b.docx')).toBe('b 3.docx');
  });

  it('keeps naming usable if the folder cannot be listed', async () => {
    puter.fs.readdir = async () => { throw new Error('Cannot list folder'); };
    expect(await P.uniqueName('b.docx')).toBe('b 2.docx');
  });

  it('writes into the app folder with overwrite on, and dedupes when asked', async () => {
    await P.writeFile('Documents/x.docx', new Blob(['a']));
    await P.writeFile('Documents/x.docx', new Blob(['ab']), { dedupe: true });
    await P.writeFile('Documents/x.docx', new Blob(['ab']), { overwrite: false });
    expect(writes[0].opts).toEqual({ overwrite: true, dedupeName: false, createMissingParents: true });
    expect(writes[1].opts).toEqual({ overwrite: false, dedupeName: true, createMissingParents: true });
    expect(writes[2].opts).toEqual({ overwrite: false, dedupeName: false, createMissingParents: true });
  });

  it('keeps an app-relative directory when a new file returns an absolute path', async () => {
    globalThis.puter.fs.write = async () => ({ name: 'x (1).docx', path: '/user/app/Documents/x (1).docx' });
    expect(await P.createFile('Documents/x.docx', new Blob(['new']))).toBe('Documents/x (1).docx');
  });

  it('retains a deduplicated file’s timestamp without another cloud request', async () => {
    const write = vi.fn(async () => ({ name: 'x (1).docx', path: '/user/app/Documents/x (1).docx', modified: 123 }));
    globalThis.puter.fs.write = write;
    const stat = vi.spyOn(globalThis.puter.fs, 'stat');
    expect(await P.createFileWithMetadata('Documents/x.docx', new Blob(['new'])))
      .toEqual({ path: 'Documents/x (1).docx', modified: 123 });
    expect(write).toHaveBeenCalledOnce();
    expect(stat).not.toHaveBeenCalled();
  });

  it('reports the environment and picker availability', () => {
    expect(P.env()).toBe('app');
    expect(P.isApp()).toBe(true);
    expect(P.canPickFiles()).toBe(true);
    expect(P.canSaveFiles()).toBe(false);
  });

  it('defaults to the web environment without an SDK', () => {
    delete globalThis.puter;
    expect(P.hasSDK()).toBe(false);
    expect(P.env()).toBe('web');
    expect(P.isApp()).toBe(false);
  });
});

describe('pickers', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.puter = {
      env: 'app',
      fs: { async read() { return new Blob(['png-bytes']); } },
      ui: { async showOpenFilePicker(opts) { calls.push(opts); return { path: 'Pictures/cat.PNG', name: 'cat.PNG' }; } },
    };
  });
  afterEach(() => { delete globalThis.puter; });

  it('knows image and document MIME types by extension', () => {
    expect(P.mimeFor('a.PNG')).toBe('image/png');
    expect(P.mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(P.mimeFor('a.docx')).toBe(P.DOCX_MIME);
    expect(P.mimeFor('a.xyz')).toBe('');
    expect(P.mimeFor('')).toBe('');
  });

  it('asks the Open dialog for documents by default and for whatever accept says', async () => {
    const f = await P.pickFile();
    expect(f).toMatchObject({ path: 'Pictures/cat.PNG', name: 'cat.PNG' });
    expect(calls[0]).toEqual({ multiple: false, accept: P.DOCUMENT_EXTENSIONS });
    await P.pickFile({ accept: ['.txt'] });
    expect(calls[1].accept).toEqual(['.txt']);
  });

  it('reads a picked image into a named, typed File', async () => {
    const file = await P.pickImage();
    expect(calls[0].accept).toEqual(P.IMAGE_EXTENSIONS);
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('cat.PNG');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('png-bytes');
  });

  it('returns null when the dialog is cancelled or unavailable', async () => {
    globalThis.puter.ui.showOpenFilePicker = async () => { throw new Error('cancelled'); };
    expect(await P.pickImage()).toBeNull();
    delete globalThis.puter.ui.showOpenFilePicker;
    expect(await P.pickFile()).toBeNull();
  });
});
