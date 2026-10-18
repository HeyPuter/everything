import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as P from '../src/lib/puter.js';

describe('names', () => {
  it('sanitizes file names', () => {
    expect(P.sanitizeName('  Budget/2026\\Q1 ')).toBe('Budget 2026 Q1');
    expect(P.sanitizeName('ab')).toBe('ab');
    expect(P.sanitizeName('x'.repeat(300))).toHaveLength(200);
    expect(P.ensureXlsx('Budget')).toBe('Budget.xlsx');
    expect(P.ensureXlsx('Budget.XLSX')).toBe('Budget.XLSX');
    expect(P.displayName('Spreadsheets/a/b.xlsx')).toBe('b.xlsx');
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
  beforeEach(() => {
    entries = [
      { name: 'b.xlsx', path: 'Spreadsheets/b.xlsx', size: 10, modified: 100, is_dir: false },
      { name: 'notes.txt', path: 'Spreadsheets/notes.txt', size: 1, modified: 500, is_dir: false },
      { name: 'sub', path: 'Spreadsheets/sub', is_dir: true },
      { name: 'a.csv', path: 'Spreadsheets/a.csv', size: 20, modified: 300, is_dir: false },
    ];
    globalThis.puter = {
      env: 'app',
      fs: {
        async readdir(p) { if (p !== 'Spreadsheets') throw Object.assign(new Error('x does not exist'), { code: 'subject_does_not_exist' }); return entries; },
        async stat(p) { const e = entries.find((x) => x.path === p); if (!e) throw new Error('does not exist'); return e; },
      },
      ui: { showOpenFilePicker() {} },
    };
  });
  afterEach(() => { delete globalThis.puter; });

  it('lists only spreadsheet files, newest first', async () => {
    const files = await P.listFiles();
    expect(files.map((f) => f.name)).toEqual(['a.csv', 'b.xlsx']);
    expect(files[0].path).toBe('Spreadsheets/a.csv');
  });

  it('treats a missing folder as empty', async () => {
    globalThis.puter.fs.readdir = async () => { throw Object.assign(new Error('nope'), { code: 'subject_does_not_exist' }); };
    expect(await P.listFiles()).toEqual([]);
  });

  it('finds a free name', async () => {
    expect(await P.uniqueName('b.xlsx')).toBe('b 2.xlsx');
    expect(await P.uniqueName('c')).toBe('c.xlsx');
  });

  it('reports the environment and picker availability', () => {
    expect(P.env()).toBe('app');
    expect(P.isApp()).toBe(true);
    expect(P.canPickFiles()).toBe(true);
    expect(P.canSaveFiles()).toBe(false);
  });
});

it('cuts a long name on characters so it never ends on half of an emoji', async () => {
  const { sanitizeName } = await import('../src/lib/puter.js');
  const name = sanitizeName(`${'a'.repeat(199)}😀`);
  expect([...name]).toHaveLength(200);
  expect(name.endsWith('😀')).toBe(true);
  expect(() => encodeURIComponent(name)).not.toThrow();
  expect(sanitizeName(`${'b'.repeat(200)}   `)).toBe('b'.repeat(200));
  expect([...sanitizeName(`${'c'.repeat(199)} d`)]).toHaveLength(199); // the cut leaves no trailing space
});

it('resolves known workbook paths for synchronous copy without guessing an app folder', () => {
  expect(P.resolvedAbsolutePath('/drive/reports/Book.xlsx')).toBe('/drive/reports/Book.xlsx');
  expect(P.resolvedAbsolutePath(null)).toBeNull();
  expect(P.resolvedAbsolutePath('~/Book.xlsx')).toBeNull();
  const previous = globalThis.puter;
  try {
    globalThis.puter = {};
    expect(P.resolvedAbsolutePath('Spreadsheets/Book.xlsx')).toBeNull();
    P.canonicalPath('Spreadsheets/Original.xlsx',{path:'/drive/Spreadsheets/Original.xlsx'});
    expect(P.resolvedAbsolutePath('Spreadsheets/Book.xlsx')).toBe('/drive/Spreadsheets/Book.xlsx');
  } finally { globalThis.puter = previous; }
});

describe('the desktop window', () => {
  afterEach(() => { delete globalThis.puter; });

  it('takes over the close button only where the window can then be closed', () => {
    const handler = () => {};
    const onWindowClose = vi.fn();
    globalThis.puter = { env: 'app', ui: { onWindowClose }, exit: vi.fn() };
    expect(P.onWindowClose(handler)).toBe(true);
    expect(onWindowClose).toHaveBeenCalledWith(handler);
    P.exitApp();
    expect(globalThis.puter.exit).toHaveBeenCalled();
    // Without puter.exit the window would never close; outside the desktop there is no window.
    for (const sdk of [{ env: 'app', ui: { onWindowClose } }, { env: 'web', ui: { onWindowClose }, exit() {} }]) {
      onWindowClose.mockClear();
      globalThis.puter = sdk;
      expect(P.onWindowClose(handler)).toBe(false);
      expect(onWindowClose).not.toHaveBeenCalled();
    }
  });

  it('tells a folder from a file in every shape the drive describes one', () => {
    expect(P.isDirItem({ is_dir: true })).toBe(true);
    expect(P.isDirItem({ isDirectory: true })).toBe(true);
    expect(P.isDirItem({ fsentry_is_dir: true })).toBe(true);
    expect(P.isDirItem({ name: 'a.xlsx', path: '/nj/a.xlsx' })).toBe(false);
    expect(P.isDirItem(null)).toBe(false);
  });
});

describe('the Open picker', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  // The Open dialog offered only six kinds of file, though the app opens Numbers, .xlsb, flat .ods,
  // text files and Excel templates as well (dropping one opened it): it now offers every kind it opens.
  it('offers every kind of file the app opens by default and accepts other file types when requested', async () => {
    const item = { path: '/drive/Pictures/Company logo.png', size: 512 };
    const showOpenFilePicker = vi.fn().mockResolvedValue(item);
    vi.stubGlobal('puter', { ui: { showOpenFilePicker } });
    expect(await P.pickFile()).toEqual({ path: item.path, name: 'Company logo.png', item });
    expect(showOpenFilePicker).toHaveBeenLastCalledWith({ multiple: false, accept: ['.xlsx', '.xlsm', '.xls', '.xltx', '.xltm', '.csv', '.tsv', '.txt', '.ods', '.numbers', '.xlsb', '.fods'] });
    showOpenFilePicker.mockResolvedValue([item]);
    expect(await P.pickFile({ accept: ['.png', '.svg'] })).toEqual({ path: item.path, name: 'Company logo.png', item });
    expect(showOpenFilePicker).toHaveBeenLastCalledWith({ multiple: false, accept: ['.png', '.svg'] });
  });
  it('leaves a dismissed or unavailable picker as cancellation', async () => {
    const showOpenFilePicker = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('puter', { ui: { showOpenFilePicker } });
    expect(await P.pickFile({ accept: ['.png'] })).toBeNull();
    showOpenFilePicker.mockRejectedValue(new Error('cancelled'));
    expect(await P.pickFile({ accept: ['.png'] })).toBeNull();
    vi.stubGlobal('puter', null);
    expect(await P.pickFile({ accept: ['.png'] })).toBeNull();
  });
});
