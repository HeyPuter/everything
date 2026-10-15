import { describe, it, expect } from 'vitest';
import { filterRows, sortRows, newRowFilter, toTSV, cellValues, rowPredicate } from '../../src/spreadsheet/filter';
import type { Column } from '../../src/spreadsheet/data';

const pos: Column = { name: 'position', type: 'FLOAT_VECTOR', comps: 3, data: new Float32Array([1, 0, 0, -1, 2, 0, 0.5, 0.5, 3, 2, -2, 1]) };
const id: Column = { name: 'id', type: 'INT', comps: 1, data: new Int32Array([3, 1, 2, 3]) };
const flag: Column = { name: 'flag', type: 'BOOLEAN', comps: 1, data: new Uint8Array([1, 0, 1, 0]) };
const name: Column = { name: 'Name', type: 'STRING', comps: 1, data: ['Cube', 'Cone', 'Plane', 'cube.001'] };
const cols = [pos, id, flag, name];

describe('spreadsheet filters', () => {
  it('filters numbers, vectors, booleans and text', () => {
    const f = (o: Partial<ReturnType<typeof newRowFilter>>) => ({ ...newRowFilter(), ...o });
    expect(Array.from(filterRows(cols, 4, [f({ column: 'id', value: [3] })]))).toEqual([0, 3]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'id', operation: 'GREATER', value: [1] })]))).toEqual([0, 2, 3]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'position', operation: 'GREATER', value: [0, -1, -1] })]))).toEqual([0, 2]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'position', value: [1, 0, 0], threshold: 0.1 })]))).toEqual([0]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'flag', bool: false })]))).toEqual([1, 3]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'Name', text: 'cube*' })]))).toEqual([0, 3]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'Name', text: 'Cone' })]))).toEqual([1]);
    // combined rules, disabled rules and unknown columns
    expect(Array.from(filterRows(cols, 4, [f({ column: 'flag', bool: true }), f({ column: 'id', value: [2] })]))).toEqual([2]);
    expect(Array.from(filterRows(cols, 4, [f({ column: 'id', value: [9], enabled: false }), f({ column: 'nope' })]))).toEqual([0, 1, 2, 3]);
    // starting from a subset keeps its order
    expect(Array.from(filterRows(cols, 4, [f({ column: 'flag', bool: true })], Int32Array.from([2, 1, 0])))).toEqual([2, 0]);
    expect(rowPredicate(name, f({ column: 'Name', text: '' }))).toBeNull();
  });

  it('sorts stably by component, length and text', () => {
    const all = Int32Array.from([0, 1, 2, 3]);
    expect(Array.from(sortRows(all, id, { column: 'id', dir: 1, comp: 0 }))).toEqual([1, 2, 0, 3]);
    expect(Array.from(sortRows(all, id, { column: 'id', dir: -1, comp: 0 }))).toEqual([0, 3, 2, 1]);
    expect(Array.from(sortRows(all, pos, { column: 'position', dir: 1, comp: 1 }))).toEqual([3, 0, 2, 1]);
    expect(Array.from(sortRows(all, pos, { column: 'position', dir: 1, comp: -1 }))).toEqual([0, 1, 3, 2]);
    expect(Array.from(sortRows(all, name, { column: 'Name', dir: 1, comp: 0 }))).toEqual([1, 0, 3, 2]);
  });

  it('formats cells and exports tab-separated text', () => {
    const rot: Column = { name: 'Rotation', type: 'QUATERNION', comps: 3, data: new Float32Array([Math.PI / 2, 0, -0]) };
    expect(cellValues(rot, 0)).toEqual(['90.000°', '0.000°', '0.000°']);
    expect(cellValues(flag, 1)).toEqual(['False']);
    const tsv = toTSV([pos, name], Int32Array.from([2]), { header: true, index: true });
    expect(tsv).toBe('index\tposition.x\tposition.y\tposition.z\tName\n2\t0.500000\t0.500000\t3.000000\tPlane');
  });
});
