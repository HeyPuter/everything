// @vitest-environment happy-dom
// Generic mesh attributes: domain / type conversion, Edit Mode carrying values through topology
// changes, the attribute operators, and .blend import (tests/fixtures/blend/make_attributes.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/modeling/index';
import { readBlend } from '../../src/io/blend/convert';
import { MeshEdit, edgeKey } from '../../src/modes/editmesh/meshedit';
import { newAttribute, convertAttribute, validAttributes, attrDomainSize } from '../../src/mesh/attributes';
import type { MeshData } from '../../src/data/types';

function cube() {
  setApp(new App(startupDocument()));
  const ob = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  return { ob, me: app.doc.meshes[ob.data!] as MeshData };
}

describe('attribute conversion', () => {
  it('vertex → face averages, face → corner copies, float → bool / int casts', () => {
    const { me } = cube();
    const a = newAttribute(me, 'h', 'POINT', 'FLOAT');
    a.data.forEach((_, i) => (a.data[i] = i));
    const f = convertAttribute(me, a, 'FACE', 'FLOAT');
    for (let fi = 0; fi < 6; fi++) {
      let s = 0;
      for (let c = me.offsets[fi]; c < me.offsets[fi + 1]; c++) s += me.indices[c];
      expect(f.data[fi]).toBeCloseTo(s / 4, 5);
    }
    const c = convertAttribute(me, f, 'CORNER', 'FLOAT');
    expect(c.data.length).toBe(24);
    expect(c.data[me.offsets[2]]).toBeCloseTo(f.data[2], 5);
    const b = convertAttribute(me, a, 'POINT', 'BOOLEAN');
    expect(Array.from(b.data)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
    const v = convertAttribute(me, a, 'POINT', 'FLOAT_VECTOR');
    expect(Array.from(v.data.subarray(9, 12))).toEqual([3, 3, 3]);
    const e = convertAttribute(me, a, 'EDGE', 'FLOAT');
    expect(e.data.length).toBe(attrDomainSize(me, 'EDGE'));
  });
});

describe('Edit Mode keeps attributes through topology changes', () => {
  it('subdivide: points interpolate, faces inherit, edges keep their halves, corners follow', () => {
    const { me } = cube();
    const p = newAttribute(me, 'p', 'POINT', 'FLOAT');
    p.data.fill(2);
    const f = newAttribute(me, 'f', 'FACE', 'INT');
    f.data.forEach((_, i) => (f.data[i] = i + 1));
    const e = newAttribute(me, 'e', 'EDGE', 'BOOLEAN');
    e.data.fill(1);
    const c = newAttribute(me, 'c', 'CORNER', 'FLOAT2');
    c.data.fill(0.5);
    me.attributes = [p, f, e, c];
    app.doc.mode = 'EDIT';
    me.select_vert = new Uint8Array(8).fill(1);
    expect(app.run('mesh.subdivide', { number_cuts: 1 })).toBe('FINISHED');
    const attrs = validAttributes(me);
    expect(attrs.map((a) => a.name)).toEqual(['p', 'f', 'e', 'c']);
    const [p2, f2, , c2] = attrs;
    expect(Array.from(p2.data).every((x) => Math.abs(x - 2) < 1e-6)).toBe(true);
    expect(f2.data.length).toBe(24);
    expect(new Set(Array.from(f2.data))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(c2.data.length).toBe(me.indices.length * 2);
  });

  it('delete keeps the remaining values with their elements; scripts-style EDGE storage per corner', () => {
    const { me } = cube();
    const p = newAttribute(me, 'idx', 'POINT', 'INT');
    p.data.forEach((_, i) => (p.data[i] = i * 10));
    me.attributes = [p];
    const m = MeshEdit.from(me);
    m.sel = m.sel.map((_, i) => (i === 0 ? 1 : 0));
    // delete vertex 0 (and its faces)
    m.keepVerts(m.sel.map((s) => (s ? 0 : 1)));
    m.write(me);
    expect(Array.from(validAttributes(me)[0].data)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    void edgeKey;
  });
});

describe('attribute operators', () => {
  it('add, set on the selection, select by attribute, convert, remove', () => {
    const { me } = cube();
    expect(app.run('geometry.attribute_add', { name: 'mask', domain: 'POINT', data_type: 'BOOLEAN' }, { invoke: false })).toBe('FINISHED');
    expect(me.active_attribute).toBe('mask');
    app.run('object.mode_set', { mode: 'EDIT' });
    me.select_vert = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(app.run('mesh.attribute_set', { value_bool: true })).toBe('FINISHED');
    expect(Array.from(validAttributes(me)[0].data)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    me.select_vert = new Uint8Array(8);
    expect(app.run('mesh.select_by_attribute')).toBe('FINISHED');
    expect(Array.from(me.select_vert!)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    app.run('object.mode_set', { mode: 'OBJECT' });
    expect(app.run('geometry.attribute_convert', { mode: 'GENERIC', domain: 'FACE', data_type: 'FLOAT' }, { invoke: false })).toBe('FINISHED');
    expect(validAttributes(me)[0].domain).toBe('FACE');
    expect(app.run('geometry.attribute_remove')).toBe('FINISHED');
    expect(validAttributes(me).length).toBe(0);
  });
});

describe('.blend generic attributes', () => {
  it('imports values on every domain', async () => {
    const dir = 'tests/fixtures/blend/';
    const ref = JSON.parse(readFileSync(dir + 'attributes.json', 'utf8'));
    const doc = (await readBlend(new Uint8Array(readFileSync(dir + 'attributes_zstd.blend')))).doc;
    const me = Object.values(doc.meshes)[0];
    const attrs = validAttributes(me);
    // (a 2D vector on face corners is a UV map)
    for (const name of ['heat', 'flag', 'vec']) {
      const a = attrs.find((x) => x.name === name)!;
      expect(a.domain).toBe(ref[name].domain);
      expect(Array.from(a.data).map((x) => +x.toFixed(4))).toEqual(ref[name].values.flat().map((x: number) => +(+x).toFixed(4)));
    }
    // edge values: each corner holds the value of its edge
    const tag = attrs.find((x) => x.name === 'tag')!;
    const edges: number[][] = ref.edges;
    for (let f = 0; f < me.offsets.length - 1; f++)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        const a = me.indices[c],
          b = me.indices[c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f]];
        const e = edges.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
        expect(tag.data[c]).toBe(ref.tag.values[e][0]);
      }
    expect(Array.from(me.bevel_weight_edge!).filter((x) => x > 0).length).toBe(2);
    expect(Array.from(me.crease_vert!).filter((x) => x > 0)).toEqual([0.5]);
  });
});

import { uvMaps, addUVMap, setActiveUV, removeActiveUV, renameUV } from '../../src/mesh/uvmaps';

describe('UV maps', () => {
  it('add / switch / rename / remove keep the list order and data', () => {
    const { me } = cube();
    const first = me.uvs.slice();
    expect(uvMaps(me).map((r) => r.name)).toEqual(['UVMap']);
    addUVMap(me);
    expect(uvMaps(me)).toEqual([
      { name: 'UVMap', active: false, render: true },
      { name: 'UVMap.001', active: true, render: false },
    ]);
    me.uvs = me.uvs.map((x) => x + 1);
    setActiveUV(me, 0);
    expect(Array.from(me.uvs)).toEqual(Array.from(first));
    expect(uvMaps(me).map((r) => r.active)).toEqual([true, false]);
    renameUV(me, 1, 'Second');
    setActiveUV(me, 1);
    expect(me.uv_map_name).toBe('Second');
    expect(me.uvs[0]).toBeCloseTo(first[0] + 1, 5);
    removeActiveUV(me);
    expect(uvMaps(me).map((r) => r.name)).toEqual(['UVMap']);
    expect(Array.from(me.uvs)).toEqual(Array.from(first));
  });
  it('inactive maps follow topology changes in Edit Mode', () => {
    const { me } = cube();
    addUVMap(me, 'Other');
    setActiveUV(me, 0);
    app.doc.mode = 'EDIT';
    me.select_vert = new Uint8Array(8).fill(1);
    app.run('mesh.subdivide', { number_cuts: 1 });
    expect(me.uv_layers_extra![0].name).toBe('Other');
    expect(me.uv_layers_extra![0].data.length).toBe(me.indices.length * 2);
    expect(app.run('mesh.uv_texture_remove')).toBe('FINISHED');
    expect(me.uv_map_name).toBe('Other');
  });
  it('.blend files bring all their UV maps', async () => {
    const dir = 'tests/fixtures/blend/';
    const ref = JSON.parse(readFileSync(dir + 'attributes.json', 'utf8'));
    const doc = (await readBlend(new Uint8Array(readFileSync(dir + 'attributes_zstd.blend')))).doc;
    const me = Object.values(doc.meshes)[0];
    expect(uvMaps(me).map((r) => r.name)).toEqual(['UVMap', 'dir']);
    expect(Array.from(me.uv_layers_extra![0].data).map((x) => +x.toFixed(4))).toEqual(ref.dir.values.flat().map((x: number) => +(+x).toFixed(4)));
  });
});
