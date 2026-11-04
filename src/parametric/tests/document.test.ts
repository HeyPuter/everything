import { describe, expect, it } from 'vitest';
import { DocStore, newDocument, parseDocument, serializeDocument } from '../src/model/document';
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
});
