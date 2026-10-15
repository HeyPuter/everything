import { describe, it, expect } from 'vitest';
import { sortEntries, filterEntries, walkIndex, uniqueEntryName, category, formatSize, type Entry } from '../../src/editors/filebrowser_logic';

const list: Entry[] = [
  { name: 'b.png', kind: 'file', size: 10, mtime: 3 },
  { name: 'A.p3d', kind: 'file', size: 300, mtime: 1 },
  { name: 'z', kind: 'dir' },
  { name: '.hidden', kind: 'file' },
  { name: 'c.obj', kind: 'file', size: 50, mtime: 2 },
  { name: 'notes.txt', kind: 'file', size: 5, mtime: 9 },
  { name: 'a10.png', kind: 'file' },
  { name: 'a9.png', kind: 'file' },
];
const names = (l: Entry[]) => l.map((e) => e.name);

describe('file browser sorting and filtering', () => {
  it('sorts folders first, then by name with natural numbers', () => {
    expect(names(sortEntries(list, 'ALPHA'))).toEqual(['z', '.hidden', 'A.p3d', 'a9.png', 'a10.png', 'b.png', 'c.obj', 'notes.txt']);
  });
  it('sorts by extension, date and size, optionally reversed', () => {
    expect(names(sortEntries(list.filter((e) => e.size), 'SIZE'))).toEqual(['A.p3d', 'c.obj', 'b.png', 'notes.txt']);
    expect(names(sortEntries(list.filter((e) => e.mtime), 'TIME'))).toEqual(['notes.txt', 'b.png', 'c.obj', 'A.p3d']);
    expect(names(sortEntries(list.filter((e) => e.mtime), 'TIME', true))).toEqual(['A.p3d', 'c.obj', 'b.png', 'notes.txt']);
    expect(names(sortEntries(list.filter((e) => e.size), 'EXTENSION'))).toEqual(['c.obj', 'A.p3d', 'b.png', 'notes.txt']);
  });
  it('filters hidden files, text, wildcards and categories', () => {
    const o = { text: '', showHidden: false, categories: null, modelExts: ['.obj'] };
    expect(names(filterEntries(list, o))).not.toContain('.hidden');
    expect(names(filterEntries(list, { ...o, showHidden: true }))).toContain('.hidden');
    expect(names(filterEntries(list, { ...o, text: '*.png' }))).toEqual(['b.png', 'a10.png', 'a9.png']);
    expect(names(filterEntries(list, { ...o, categories: new Set(['model', 'project'] as const) }))).toEqual(['A.p3d', 'z', 'c.obj']);
    expect(category('scene.glb', ['.glb'])).toBe('model');
    expect(category('x.blend', [])).toBe('project');
  });
});

describe('keyboard walking', () => {
  it('moves in a row-filled grid', () => {
    expect(walkIndex(0, 10, 'RIGHT', 4)).toBe(1);
    expect(walkIndex(1, 10, 'DOWN', 4)).toBe(5);
    expect(walkIndex(8, 10, 'DOWN', 4)).toBe(8);
    expect(walkIndex(-1, 10, 'UP', 4)).toBe(9);
    expect(walkIndex(5, 10, 'UP', 4)).toBe(1);
  });
  it('moves in column-filled lists', () => {
    expect(walkIndex(0, 10, 'DOWN', 1, 'column', 3)).toBe(1);
    expect(walkIndex(1, 10, 'RIGHT', 1, 'column', 3)).toBe(4);
    expect(walkIndex(4, 10, 'LEFT', 1, 'column', 3)).toBe(1);
  });
  it('makes unique names and readable sizes', () => {
    expect(uniqueEntryName('New Folder', ['new folder', 'New Folder 2'])).toBe('New Folder 3');
    expect(uniqueEntryName('New Folder', [])).toBe('New Folder');
    expect(formatSize(2048)).toBe('2.0 KiB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
