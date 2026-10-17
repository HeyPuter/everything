import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { insertBlock, getBlock, listBlocks, duplicateBlocks, setType, pageText } from '../src/data/page.js';
import * as T from '../src/data/table.js';

const pair = (spec) => {
  const a = new Y.Doc();
  const id = insertBlock(a, { type: 'table', table: spec });
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const merge = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };
  return { a, b, id, merge, table: () => getBlock(a, id).table };
};

describe('table blocks', () => {
  it('keeps cells, rows and columns two people change at once', () => {
    const { a, b, id, merge, table } = pair({ rows: [['a', 'b'], ['c', 'd']], header: true });
    const { rowIds, colIds } = table();
    T.setCells(a, id, [{ row: rowIds[0], col: colIds[0], text: 'A' }]);
    T.setCells(b, id, [{ row: rowIds[1], col: colIds[1], text: 'D' }]);
    T.insertRow(a, id, { after: rowIds[0] });
    T.insertCol(b, id);
    merge();
    expect(table().rows).toEqual([['A', 'b', ''], ['', '', ''], ['c', 'D', '']]);
    expect(getBlock(b, id).table.rows).toEqual(table().rows);
  });

  it('lets the later save win inside one cell and drops edits to a deleted row', () => {
    const { a, b, id, merge, table } = pair({ rows: [['x'], ['y']], header: false });
    const { rowIds, colIds } = table();
    T.setCells(a, id, [{ row: rowIds[0], col: colIds[0], text: 'one' }]);
    T.setCells(b, id, [{ row: rowIds[0], col: colIds[0], text: 'two' }]);
    T.deleteRow(a, id, rowIds[1]);
    T.setCells(b, id, [{ row: rowIds[1], col: colIds[0], text: 'gone' }]);
    merge();
    expect(table().rows).toHaveLength(1);
    expect(['one', 'two']).toContain(table().rows[0][0]);
  });

  it('repairs a table emptied by two deletes at once', () => {
    const { a, b, id, merge, table } = pair({ rows: [['x'], ['y']], header: false });
    const { rowIds } = table();
    T.deleteRow(a, id, rowIds[0]);
    T.deleteRow(b, id, rowIds[1]);
    merge();
    expect(table().rows).toEqual([]);
    T.insertRow(a, id);
    expect(table().rows).toEqual([['']]);
  });

  it('reads tables saved as one plain value and converts them on change', () => {
    const doc = new Y.Doc();
    const id = insertBlock(doc, { type: 'paragraph' });
    doc.getMap('blocks').get(id).set('type', 'table');
    doc.getMap('blocks').get(id).set('table', { rows: [['h1', 'h2'], ['1']], header: true });
    const before = getBlock(doc, id).table;
    expect(before).toMatchObject({ rows: [['h1', 'h2'], ['1', '']], header: true, rowIds: ['r0', 'r1'], colIds: ['c0', 'c1'] });
    T.setCells(doc, id, [{ row: 'r1', col: 'c1', text: '2' }]);
    expect(doc.getMap('blocks').get(id).get('table')).toBeInstanceOf(Y.Map);
    expect(getBlock(doc, id).table).toMatchObject({ rows: [['h1', 'h2'], ['1', '2']], rowIds: ['r0', 'r1'] });
  });

  it('copies, retypes and indexes tables', () => {
    const doc = new Y.Doc();
    const id = insertBlock(doc, { type: 'table', table: { rows: [['a', 'b']], header: false } });
    const [copy] = duplicateBlocks(doc, [id]);
    expect(getBlock(doc, copy).table.rows).toEqual([['a', 'b']]);
    expect(getBlock(doc, copy).table.rowIds[0]).not.toBe(getBlock(doc, id).table.rowIds[0]);
    expect(pageText(doc)).toContain('a b');
    const p = insertBlock(doc, { type: 'paragraph' });
    setType(doc, p, 'table', { table: { rows: [['', ''], ['', '']], header: true } });
    expect(getBlock(doc, p).table.rows).toEqual([['', ''], ['', '']]);
    expect(listBlocks(doc)).toHaveLength(3);
  });

  it('keeps every row and column of imported and older tables', () => {
    const big = Array.from({ length: T.MAX_ROWS + 10 }, (_, r) => Array.from({ length: T.MAX_COLS + 5 }, (_, c) => `${r}.${c}`));
    const doc = new Y.Doc();
    const imported = insertBlock(doc, { type: 'table', table: { rows: big, header: true } });
    expect(getBlock(doc, imported).table.rows).toEqual(big);
    const old = insertBlock(doc, { type: 'paragraph' });
    doc.getMap('blocks').get(old).set('type', 'table');
    doc.getMap('blocks').get(old).set('table', { rows: big, header: true });
    T.setCells(doc, old, [{ row: 'r0', col: 'c0', text: 'changed' }]);
    expect(getBlock(doc, old).table.rows).toEqual([['changed', ...big[0].slice(1)], ...big.slice(1)]);
  });

  it('treats a malformed table value as an empty table', () => {
    const doc = new Y.Doc();
    const id = insertBlock(doc, { type: 'table', table: { rows: 'not rows' } });
    expect(getBlock(doc, id).table.rows).toEqual([['']]);
  });

  it('respects the size limits', () => {
    const doc = new Y.Doc();
    const id = insertBlock(doc, { type: 'table', table: { rows: Array.from({ length: T.MAX_ROWS }, () => ['x']) } });
    expect(T.insertRow(doc, id)).toBe(null);
    expect(getBlock(doc, id).table.rows).toHaveLength(T.MAX_ROWS);
  });
});
