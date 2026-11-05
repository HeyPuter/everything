import { describe, expect, it } from 'vitest';
import { DocStore, changeUnits, mapExpressions, newDocument, parseDocument, serializeDocument } from '../src/model/document';
import { defaultName, dependencies, newExtrude } from '../src/model/features';
import type { ExtrudeFeature, Feature, SkDimension, SketchFeature } from '../src/model/types';
import { rect, sketch } from './helpers';

describe('document store', () => {
  it('undoes and redoes changes, and batches drags into one step', () => {
    const st = new DocStore(newDocument());
    st.change('Rename', (d) => { d.name = 'A'; });
    st.change('Rename', (d) => { d.name = 'B'; });
    expect(st.undoDepth).toBe(2);
    st.undo();
    expect(st.doc.name).toBe('A');
    st.redo();
    expect(st.doc.name).toBe('B');
    st.beginBatch('Drag');
    for (let i = 0; i < 5; i++) st.change('x', (d) => { d.decimals = i; });
    st.endBatch();
    expect(st.undoDepth).toBe(3);
    st.undo();
    expect(st.doc.decimals).toBe(2);
    // No-op changes do not create undo steps.
    st.change('Nothing', () => {});
    expect(st.undoDepth).toBe(2);
  });

  it('keeps large blobs out of undo snapshots', () => {
    const st = new DocStore(newDocument());
    st.doc.blobs.b1 = 'x'.repeat(1000);
    st.change('Rename', (d) => { d.name = 'Z'; });
    st.undo();
    expect(st.doc.blobs.b1).toHaveLength(1000);
  });

  it('leaves the data of deleted imports out of the saved file, but keeps it for undo', () => {
    const st = new DocStore(newDocument());
    st.doc.blobs.b1 = 'ISO-10303-21; kept';
    st.doc.blobs.b2 = 'ISO-10303-21; deleted';
    st.change('Import', (d) => {
      d.features.push({ id: 'f1', name: 'Import1', type: 'import', format: 'step', blob: 'b1', fileName: 'a.step' });
      d.features.push({ id: 'f2', name: 'Import2', type: 'import', format: 'step', blob: 'b2', fileName: 'b.step' });
    });
    st.change('Delete', (d) => { d.features = d.features.filter((f) => f.id !== 'f2'); });
    const saved = parseDocument(serializeDocument(st.doc));
    expect(Object.keys(saved.blobs)).toEqual(['b1']);
    expect(serializeDocument(st.doc)).not.toContain('deleted');
    st.undo();
    expect(st.doc.blobs.b2).toBe('ISO-10303-21; deleted');
    expect(Object.keys(parseDocument(serializeDocument(st.doc)).blobs).sort()).toEqual(['b1', 'b2']);
  });

  it('evaluates expressions in feature parameters and sketch dimensions', () => {
    const doc = newDocument('P', 'IPS');
    doc.variables = [{ id: 'v1', name: 'W', expr: '2' }];
    const s = sketch('s1', rect(0, 0, 25.4, 25.4, 'r'));
    s.constraints.push({ id: 'd1', type: 'distance', refs: ['rl0'], value: '=W*2', at: [0, 0], name: 'D1' } as SkDimension);
    const e: ExtrudeFeature = { ...newExtrude('e1', 'E', 's1', false, 10), depth: '=W/2' };
    doc.features = [s, e];
    const st = new DocStore(doc);
    const r = st.resolve();
    expect(r.errors.size).toBe(0);
    expect((r.features[1] as ExtrudeFeature).depth).toBeCloseTo(25.4, 9);
    const solved = r.features[0] as SketchFeature;
    const x = (id: string) => (solved.entities.find((e) => e.id === id) as { x: number }).x;
    expect(x('rp1') - x('rp0')).toBeCloseTo(4 * 25.4, 6);
    // The stored document is untouched.
    expect((st.doc.features[1] as ExtrudeFeature).depth).toBe('=W/2');
  });

  it('reports parameter errors per feature', () => {
    const doc = newDocument();
    doc.features = [sketch('s1', rect(0, 0, 1, 1)), { ...newExtrude('e1', 'E', 's1', false, 10), depth: '=Missing+1' }];
    const r = new DocStore(doc).resolve();
    expect(r.errors.get('e1')).toMatch(/Unknown name/);
  });

  it('round-trips through serialization and validates input', () => {
    const doc = newDocument('Round');
    doc.features = [sketch('s1', rect(0, 0, 1, 1))];
    const back = parseDocument(serializeDocument(doc));
    expect(back.name).toBe('Round');
    expect(back.features).toHaveLength(1);
    expect(() => parseDocument('{}')).toThrow(/not a part/);
    expect(() => parseDocument('nope')).toThrow(/not a valid/);
    expect(() => parseDocument(JSON.stringify({ ...doc, version: 9 }))).toThrow(/newer version/);
    expect(() => parseDocument(JSON.stringify({ ...doc, version: undefined }))).toThrow(/damaged \(unknown version\)/);
    expect(() => parseDocument(JSON.stringify({ ...doc, version: '1' }))).toThrow(/damaged/);
  });

  it('repairs damaged settings and a missing id counter when loading', () => {
    const raw = { format: 'parametric-part', version: 1, units: 'FOO', decimals: 'x', rollback: 'y', features: [sketch('s1', []), sketch('f7', [])] };
    const doc = parseDocument(JSON.stringify(raw));
    expect(doc.units).toBe('MMGS');
    expect(doc.decimals).toBe(2);
    expect(doc.rollback).toBeNull();
    const st = new DocStore(doc);
    expect(st.unitScale).toBe(1);
    expect(st.nextId('f')).toBe('f8');
    expect(parseDocument(JSON.stringify({ ...raw, nextId: 3 })).nextId).toBe(8);
    expect(parseDocument(JSON.stringify({ ...raw, nextId: 40 })).nextId).toBe(40);
    expect(() => parseDocument(JSON.stringify({ ...raw, features: [null] }))).toThrow(/damaged/);
  });

  it('refuses a damaged sketch and repairs damaged values that would break the app later', () => {
    const raw = { format: 'parametric-part', version: 1, features: [sketch('s1', [])] };
    expect(() => parseDocument(JSON.stringify({ ...raw, features: [{ id: 'f1', type: 'sketch', name: 'S' }] }))).toThrow(/damaged \(invalid sketch\)/);
    expect(() => parseDocument(JSON.stringify({ ...raw, features: [{ ...sketch('f1', []), plane: null }] }))).toThrow(/invalid sketch/);
    const doc = parseDocument(JSON.stringify({
      ...raw,
      variables: [null, { name: 5 }, { id: 'v2', name: 'W', expr: 10 }, { name: 'H', expr: '2*W' }],
      features: [...raw.features, { id: 'f3', type: 'plane' }],
      blobs: 5, material: 'steel', color: 7, drawing: { views: 3 },
    }));
    expect(doc.variables.map((v) => [v.id, v.name, v.expr])).toEqual([['v2', 'W', '10'], ['v4', 'H', '2*W']]);
    expect(new DocStore(doc).resolve().variables.get('H')).toBe(20);
    expect(doc.features[1].name).toBe('f3');
    expect(doc.blobs).toEqual({});
    expect(doc.material).toBeNull();
    expect(doc.color).toBe('#b8c4d2');
    expect(doc.drawing).toBeNull();
    expect(doc.nextId).toBe(5);
  });

  it('names features and tracks dependencies', () => {
    const doc = newDocument();
    doc.features = [sketch('s1', []), { ...newExtrude('e1', 'Extrude1', 's1', false, 1) }];
    expect(defaultName(doc, 'extrude')).toBe('Extrude2');
    expect(defaultName(doc, 'extrude', true)).toBe('Cut-Extrude1');
    expect(dependencies(doc.features[1])).toEqual(['s1']);
  });

  it('counts face and edge references as dependencies', () => {
    const face = (name: string) => ({ name, sig: { type: 'plane', c: [0, 0, 0] as [number, number, number], area: 1 } });
    const onFace = sketch('s2', [], { kind: 'face', face: face('e1:cap1') });
    expect(dependencies(onFace)).toEqual(['e1']);
    const fillet: Feature = {
      id: 'f9', name: 'Fillet1', type: 'fillet', faces: [face('e3:cap1@p4.2')], radius: 1,
      edges: [{ name: 'e1:side:l1|e2:cap0#1', sig: { type: 'line', m: [0, 0, 0], len: 1 } }],
    };
    expect(dependencies(fillet).sort()).toEqual(['e1', 'e2', 'e3', 'p4']);
    const shell: Feature = { id: 'sh', name: 'Shell1', type: 'shell', faces: [face('f9:f:e1:side:l1|e2:cap0')], thickness: 1, outward: false };
    expect(dependencies(shell)).toContain('f9');
  });

  it('honours the rollback position', () => {
    const st = new DocStore(newDocument());
    st.change('add', (d) => { d.features = [sketch('a', []), sketch('b', []), sketch('c', [])]; d.rollback = 1; });
    expect(st.builtCount).toBe(1);
    st.change('roll', (d) => { d.rollback = null; });
    expect(st.builtCount).toBe(3);
  });

  it('visits every expression in the document with its kind', () => {
    const doc = newDocument();
    const sk = sketch('s1', rect(0, 0, 10, 10));
    sk.constraints.push({ id: 'd1', type: 'distance', refs: [sk.entities[4].id], value: '=W', at: [0, 0], name: 'D1' } as SkDimension);
    const e = newExtrude('f1', 'Extrude1', 's1', false, 10);
    e.depth = '=W/2';
    doc.variables = [{ id: 'v1', name: 'W', expr: '10' }];
    doc.features = [sk, e];
    const seen: string[] = [];
    mapExpressions(doc, (src, kind) => { seen.push(`${kind}:${src}`); return `${src}!`; });
    expect(seen).toEqual(['variable:10', 'length:=W', 'length:=W/2']);
    expect([doc.variables[0].expr, (sk.constraints[sk.constraints.length - 1] as SkDimension).value, e.depth]).toEqual(['10!', '=W!', '=W/2!']);
  });

  it('converts expressions when the units change, so every value keeps its size', () => {
    const doc = newDocument();
    const sk = sketch('s1', rect(0, 0, 10, 10));
    const dim = (id: string, value: string, type: SkDimension['type'] = 'distance') => ({ id, type, refs: [sk.entities[4].id], value, at: [0, 0], name: id.toUpperCase() } as SkDimension);
    sk.constraints.push(dim('d1', '=Width/2'), dim('d2', '=Width - 2*Gap + 5'), dim('d3', '=Angle', 'angle'), dim('d4', '=Width*Ratio'), dim('d5', '=sqrt(Area)'), dim('d6', '=0.5in + Gap'));
    const e = newExtrude('f1', 'Extrude1', 's1', false, 10);
    e.depth = '=Depth';
    doc.variables = [
      { id: 'v1', name: 'Width', expr: '100' }, { id: 'v2', name: 'Gap', expr: 'Width/20' }, { id: 'v3', name: 'Angle', expr: '30' },
      { id: 'v4', name: 'Ratio', expr: '0.25' }, { id: 'v5', name: 'Depth', expr: '12.7' }, { id: 'v6', name: 'Area', expr: '400' },
      { id: 'v7', name: 'Count', expr: '4' },
    ];
    doc.features = [sk, e];
    const store = new DocStore(doc);
    const lengths = () => [...sk.constraints.filter((c) => c.id.startsWith('d')).map((c) => store.dimensionValue(c as SkDimension)), store.evalParam(e.depth, 'length')];
    const was = lengths();
    expect(changeUnits(doc, 'IPS')).toEqual([]);
    expect(doc.units).toBe('IPS');
    lengths().forEach((v, i) => expect(v).toBeCloseTo(was[i], 9));
    // Lengths convert, plain ratios, angles, counts and links stay.
    expect(doc.variables.map((v) => v.expr)).toEqual(['3.93700787402', 'Width/20', '30', '0.25', '0.5', '0.620001240002', '4']);
    expect(sk.constraints.filter((c) => c.id.startsWith('d')).map((c) => (c as SkDimension).value)).toEqual(['=Width/2', '=Width - 2*Gap + 0.196850393701', '=Angle', '=Width*Ratio', '=sqrt(Area)', '=0.5in + Gap']);
    expect(e.depth).toBe('=Depth');
    changeUnits(doc, 'MMGS');
    expect(doc.variables[0].expr).toBe('100');
  });

  it('keeps a value that cannot be converted as the number it was', () => {
    const doc = newDocument();
    const e = newExtrude('f1', 'Extrude1', 's1', false, 10);
    e.depth = '=W*W';
    doc.variables = [{ id: 'v1', name: 'W', expr: '5' }];
    doc.features = [e];
    expect(changeUnits(doc, 'IPS')).toEqual(['Extrude1 Depth']);
    expect(e.depth).toBeCloseTo(25, 9);
  });
});
