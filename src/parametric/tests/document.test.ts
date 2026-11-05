import { describe, expect, it } from 'vitest';
import { DocStore, changeFeatureUnits, changeUnits, mapExpressions, newDocument, parseDocument, serializeDocument } from '../src/model/document';
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

  it('excludes a transient preview from history without changing the visible document', () => {
    const st = new DocStore(newDocument('Original'));
    st.doc.blobs.large = 'kept outside history';
    const stop = st.filterHistory((doc) => {
      expect('blobs' in doc).toBe(false);
      doc.decimals = 2;
    });
    st.doc.decimals = 5;
    st.change('Rename', (doc) => { doc.name = 'Renamed'; });
    expect(st.doc.decimals).toBe(5);
    expect(st.doc.name).toBe('Renamed');
    st.undo();
    expect(st.doc).toMatchObject({ name: 'Original', decimals: 2 });
    st.redo();
    expect(st.doc).toMatchObject({ name: 'Renamed', decimals: 2 });
    expect(st.doc.blobs.large).toBe('kept outside history');
    stop();
    st.change('Accept preview', (doc) => { doc.decimals = 5; });
    st.undo();
    expect(st.doc.decimals).toBe(2);
    st.redo();
    expect(st.doc.decimals).toBe(5);
  });

  it('excludes previews from batch history and restore points', () => {
    const st = new DocStore(newDocument('Original'));
    const stop = st.filterHistory((doc) => { doc.decimals = 2; });
    st.doc.decimals = 5;
    const restore = st.restorePoint('Session');
    st.beginBatch('Rename');
    st.change('First rename', (doc) => { doc.name = 'First'; });
    st.change('Second rename', (doc) => { doc.name = 'Second'; });
    st.endBatch();
    expect(st.doc.decimals).toBe(5);
    st.undo();
    expect(st.doc).toMatchObject({ name: 'Original', decimals: 2 });
    st.redo();
    expect(st.doc).toMatchObject({ name: 'Second', decimals: 2 });
    restore();
    expect(st.doc).toMatchObject({ name: 'Original', decimals: 2 });
    st.redo();
    expect(st.doc).toMatchObject({ name: 'Second', decimals: 2 });
    stop();
  });

  it('clears preview history filters when a different document is loaded', () => {
    const st = new DocStore(newDocument('Old'));
    const stop = st.filterHistory((doc) => { doc.name = 'Old'; });
    st.load(newDocument('New'));
    st.change('Rename', (doc) => { doc.name = 'New renamed'; });
    st.undo();
    expect(st.doc.name).toBe('New');
    st.redo();
    expect(st.doc.name).toBe('New renamed');
    stop();
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
      blobs: 5, material: 'steel', color: 7, drawing: null,
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

  it('converts a pending feature against the converted document variables', () => {
    const doc = newDocument();
    doc.variables = [{ id: 'v1', name: 'Width', expr: '100' }];
    const saved = newExtrude('f1', 'Extrude1', 's1', false, 10);
    saved.depth = '=Width';
    doc.features = [saved];
    const pending = structuredClone(saved);
    pending.depth = '=Width/2 + 10';
    const before = structuredClone(doc.variables);
    changeUnits(doc, 'IPS');
    expect(changeFeatureUnits(pending, 'MMGS', 'IPS', before, doc.variables)).toEqual([]);
    expect(typeof pending.depth).toBe('string');
    expect(pending.depth).toContain('Width');
    expect(new DocStore(doc).evalParam(pending.depth, 'length')).toBeCloseTo(60, 8);
    expect(saved.depth).toBe('=Width');
  });

  it.each(['rename', 'delete'])('reconciles a pending expression when units and a variable %s change together', (action) => {
    const doc = newDocument();
    doc.variables = [{ id: 'v1', name: 'Width', expr: '100' }];
    const before = structuredClone(doc.variables);
    const saved = newExtrude('f1', 'Extrude1', 's1', false, 100);
    const pending = structuredClone(saved);
    pending.depth = '=Width/2 + 10';
    if (action === 'rename') {
      doc.variables[0].name = 'Span';
      saved.depth = '=Span';
    } else doc.variables = [];
    doc.features = [saved];
    changeUnits(doc, 'IPS');
    expect(changeFeatureUnits(pending, 'MMGS', 'IPS', before, doc.variables)).toEqual([]);
    expect(typeof pending.depth).toBe('string');
    expect(pending.depth).not.toContain('Width');
    if (action === 'rename') expect(pending.depth).toContain('Span');
    expect(new DocStore(doc).evalParam(pending.depth, 'length')).toBeCloseTo(60, 8);
  });

  it('preserves a pending value without changing the converted part variables', () => {
    const doc = newDocument();
    doc.variables = [{ id: 'v1', name: 'Count', expr: '4' }];
    const pending = newExtrude('f1', 'Extrude1', 's1', false, 10);
    pending.depth = '=Count*2';
    const before = structuredClone(doc.variables);
    changeUnits(doc, 'IPS');
    expect(changeFeatureUnits(pending, 'MMGS', 'IPS', before, doc.variables)).toEqual(['Extrude1 Depth']);
    expect(pending.depth).toBe(8);
    expect(doc.variables).toEqual(before);
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

describe('restorable editing sessions', () => {
  it('restores the document and prior history after more edits than the undo limit', () => {
    const st = new DocStore();
    st.change('Rename', (d) => { d.name = 'Before'; });
    const restore = st.restorePoint('Sketch changes');
    for (let i = 0; i < 125; i++) st.change('Edit', (d) => { d.name = `Edit ${i}`; });
    restore();
    expect(st.doc.name).toBe('Before');
    expect(st.undoLabel).toBe('Rename');
    expect(st.redoLabel).toBe('Sketch changes');
    st.redo();
    expect(st.doc.name).toBe('Edit 124');
    st.undo();
    expect(st.doc.name).toBe('Before');
    st.undo();
    expect(st.doc.name).toBe('Part1');
  });

  it('restores an editing session even after undo crosses its starting point', () => {
    const st = new DocStore();
    st.change('Rename', (d) => { d.name = 'Before'; });
    const restore = st.restorePoint('Sketch changes');
    st.undo();
    restore();
    expect(st.doc.name).toBe('Before');
    expect(st.undoLabel).toBe('Rename');
    st.undo();
    expect(st.doc.name).toBe('Part1');
  });
});

describe('damaged sketch files', () => {
  const valid = () => sketch('s1', rect(0, 0, 10, 10, 'r'));
  it.each([
    { entities: [null] },
    { entities: [{ id: 'p1', t: 'point', x: '10', y: 0 }] },
    { entities: [{ id: 'l1', t: 'line', a: 'missing', b: 'O' }] },
    { entities: [{ id: 'sp1', t: 'spline', pts: [] }] },
    { constraints: [null] },
    { constraints: [{ id: 'c1', type: 'horizontal', refs: null }] },
    { constraints: [{ id: 'c1', type: 'horizontal', refs: ['missing'] }] },
    { constraints: [{ id: 'd1', type: 'distance', refs: ['rl0'], value: 10 }] },
    { constraints: [{ id: 'd1', type: 'radius', refs: ['rp0'], value: 10, at: [0, 0], name: 'D1' }] },
    { plane: { kind: 'base', plane: 'missing' } },
    { plane: { kind: 'face', face: null } },
    { frame: { o: [0, 0, 0] } },
  ])('rejects invalid sketch data before it can replace the open document: %j', (bad) => {
    const doc = { ...newDocument(), features: [{ ...valid(), ...bad }] };
    expect(() => parseDocument(JSON.stringify(doc))).toThrow(/damaged.*sketch/);
  });

  it('rejects duplicate sketch entity and constraint ids', () => {
    const sk = valid();
    sk.entities.push({ id: 'rp0', t: 'point', x: 20, y: 20 });
    expect(() => parseDocument(JSON.stringify({ ...newDocument(), features: [sk] }))).toThrow(/damaged.*sketch/);
    sk.entities.pop();
    sk.constraints = [{ id: 'c1', type: 'horizontal', refs: ['rl0'] }, { id: 'c1', type: 'vertical', refs: ['rl1'] }];
    expect(() => parseDocument(JSON.stringify({ ...newDocument(), features: [sk] }))).toThrow(/damaged.*sketch/);
  });
});


it('round-trips all curve and dimension types, including origin references and expression errors', () => {
  const sk = sketch('s1', [
    ...rect(0, 0, 10, 10, 'r'),
    { id: 'circle', t: 'circle', c: 'O', r: 4 },
    { id: 'arc', t: 'arc', c: 'O', a: 'rp1', b: 'rp3' },
    { id: 'spline', t: 'spline', pts: ['rp0', 'rp1', 'rp2'], construction: true },
  ]);
  sk.constraints = [
    { id: 'rel', type: 'coincident', refs: ['O', 'rp0'] },
    ...(['distance', 'hdistance', 'vdistance', 'angle', 'radius', 'diameter'] as const).map((type, i) => ({
      id: `d${i}`, type, refs: [type === 'radius' || type === 'diameter' ? 'circle' : 'rl0'],
      value: '=Missing', at: [0, 0] as [number, number], name: `D${i}`, driven: i === 1,
    })),
  ];
  const doc = { ...newDocument(), features: [sk], nextId: 2 };
  expect(parseDocument(serializeDocument(doc))).toEqual(doc);
});

describe('loading during a change batch', () => {
  it.each(['endBatch', 'cancelBatch'] as const)('does not bring an old part back when a delayed %s arrives', (finish) => {
    const st = new DocStore(newDocument('Old part'));
    st.beginBatch('Drag');
    st.change('Drag', (d) => { d.color = '#ff0000'; });
    st.load(newDocument('New part'));
    st[finish]();
    expect(st.doc.name).toBe('New part');
    expect(st.canUndo).toBe(false);
    expect(st.canRedo).toBe(false);
    expect(st.dirty).toBe(false);
  });

  it('makes edits in the newly loaded part independently undoable', () => {
    const st = new DocStore(newDocument('Old part'));
    st.beginBatch('Drag');
    st.load(newDocument('New part'));
    st.change('Rename', (d) => { d.name = 'Changed new part'; });
    expect(st.undoLabel).toBe('Rename');
    st.undo();
    expect(st.doc.name).toBe('New part');
  });
});

describe('drawing file validation', () => {
  const view = { id: 'v1', kind: 'front', x: 70, y: 80, hidden: true, dims: true };
  const drawing = { sheet: 'A4', landscape: true, scale: 1, views: [view], title: '', drawnBy: '', notes: '' };

  it.each([
    { views: [null] }, { views: {} }, { sheet: 'A0' }, { sheet: 'constructor' },
    { landscape: 'yes' }, { scale: 0 }, { scale: -1 }, { scale: '1' }, { scale: 1e400 },
    { views: [{ ...view, kind: 'constructor' }] }, { views: [{ ...view, x: null }] },
    { views: [{ ...view, y: '20' }] }, { views: [{ ...view, hidden: 'yes' }] },
    { views: [{ ...view, dims: null }] }, { views: [{ ...view, id: '' }] },
    { views: [view, view] }, { title: {} }, { drawnBy: 5 }, { notes: [] },
  ])('rejects damaged drawing data %j before opening', (broken) => {
    expect(() => parseDocument(JSON.stringify({ ...newDocument(), drawing: { ...drawing, ...broken } }))).toThrow(/damaged.*drawing/);
  });

  it('preserves all supported sheets and view directions, including custom scales and off-sheet positions', () => {
    for (const sheet of ['A4', 'A3', 'A2', 'A1', 'Letter', 'Tabloid']) {
      const views = ['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric'].map((kind, i) => ({ ...view, id: `v${i}`, kind, x: -20, y: 900, hidden: false, dims: false }));
      const raw = { ...newDocument(), drawing: { ...drawing, sheet, landscape: false, scale: 0.037, views, title: 'Bracket', drawnBy: 'Designer', notes: 'First issue' } };
      expect(parseDocument(JSON.stringify(raw))).toEqual(raw);
    }
    expect(parseDocument(JSON.stringify({ ...newDocument(), drawing: { ...drawing, views: [] } })).drawing?.views).toEqual([]);
  });
});


describe('identifier counter limits', () => {
  it.each([Number.MAX_SAFE_INTEGER, 1e100])('loads counter %s without producing duplicate identifiers', (nextId) => {
    const raw = { ...newDocument(), nextId, features: [sketch('s1', [])] };
    const store = new DocStore(parseDocument(JSON.stringify(raw)));
    const ids = Array.from({ length: 4 }, () => store.nextId('f'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Number.isSafeInteger(store.doc.nextId)).toBe(true);
  });

  it('loads arbitrarily large existing identifier suffixes without poisoning allocation', () => {
    const raw = { ...newDocument(), features: [sketch('f9007199254740992', []), sketch('s' + '9'.repeat(400), [])] };
    const store = new DocStore(parseDocument(JSON.stringify(raw)));
    const ids = Array.from({ length: 4 }, () => store.nextId('f'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => store.doc.features.some((f) => f.id === id))).toBe(false);
    expect(Number.isSafeInteger(store.doc.nextId)).toBe(true);
  });

  it('keeps allocating distinct IDs when a running counter reaches its limit', () => {
    const doc = newDocument();
    doc.nextId = Number.MAX_SAFE_INTEGER;
    doc.features.push(sketch('f1', []));
    const store = new DocStore(doc);
    const ids = Array.from({ length: 4 }, () => store.nextId('f'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('f1');
    expect(Number.isSafeInteger(store.doc.nextId)).toBe(true);
  });
});


it('repairs missing variable identifiers when the numeric counter is exhausted', () => {
  const doc = parseDocument(JSON.stringify({ ...newDocument(), nextId: Number.MAX_SAFE_INTEGER,
    variables: [{ name: 'Width', expr: '20' }, { name: 'Height', expr: '10' }, { name: 'Depth', expr: '5' }],
  }));
  expect(new Set(doc.variables.map((v) => v.id)).size).toBe(3);
  expect(doc.variables.every((v) => !!v.id)).toBe(true);
  expect(Number.isSafeInteger(doc.nextId)).toBe(true);
});

it('repairs repeated variable identifiers without changing equations or values', () => {
  const variables = [{ id: 'v1', name: 'Width', expr: '20' }, { id: 'v1', name: 'Height', expr: 'Width/2' }, { id: 'v2', name: 'Depth', expr: '5' }];
  const doc = parseDocument(JSON.stringify({ ...newDocument(), variables }));
  expect(new Set(doc.variables.map((v) => v.id)).size).toBe(3);
  expect(doc.variables.map(({ name, expr }) => ({ name, expr }))).toEqual(variables.map(({ name, expr }) => ({ name, expr })));
  expect(new DocStore(doc).resolve().variables.get('Height')).toBe(10);
});


it('discards nonpositive imported material densities while preserving positive fractions', () => {
  for (const density of [-1000, 0, 0.5, 2700]) {
    const material = { name: 'Custom', density };
    const doc = parseDocument(JSON.stringify({ ...newDocument(), material }));
    expect(doc.material).toEqual(density > 0 ? material : null);
  }
});
