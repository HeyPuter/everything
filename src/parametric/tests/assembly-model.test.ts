import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_FORMAT, type AssemblyDocument, PartCache, assemblyBom, bomCsv, instanceName, isAssembly, newAssembly, nextAsmId, parseAnyDocument, parseAssembly,
} from '../src/model/assembly';
import { DocStore, newDocument, parseDocument, serializeDocument, withUsedBlobs } from '../src/model/document';
import { composeModel, placementMatrix, splitName, type PartGeometry } from '../src/assembly/compose';
import { qAxisAngle } from '../src/math/vec';
import type { MeshData } from '../src/kernel/protocol';

function sample(): AssemblyDocument {
  const doc = newAssembly('Hinge');
  const block = newDocument('Block');
  block.material = { name: 'Steel', density: 7800 };
  const pin = newDocument('Pin');
  doc.blobs.a1 = serializeDocument(block);
  doc.blobs.a2 = serializeDocument(pin);
  doc.parts = [
    { id: 'p1', name: 'Block', source: { type: 'local', id: 'part-1' }, version: { modified: 5, size: 10 }, blob: 'a1', color: '#b8c4d2' },
    { id: 'p2', name: 'Pin', source: { type: 'cloud', path: '/u/Parts/Pin.parametric' }, version: null, blob: 'a2', color: '#e0a85a' },
  ];
  doc.components = [
    { id: 'c3', name: 'Block<1>', part: 'p1', placement: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true },
    { id: 'c4', name: 'Pin<1>', part: 'p2', placement: { p: [10, 10, 0], q: qAxisAngle([1, 0, 0], 0.3) }, fixed: false },
    { id: 'c5', name: 'Pin<2>', part: 'p2', placement: { p: [30, 10, 0], q: [0, 0, 0, 1] }, fixed: false, hidden: true },
    { id: 'c6', name: 'Pin<3>', part: 'p2', placement: { p: [50, 10, 0], q: [0, 0, 0, 1] }, fixed: false, suppressed: true },
  ];
  doc.mates = [
    { id: 'm7', name: 'Concentric1', type: 'concentric', a: { comp: 'c3', face: { name: 'E1:side:h', sig: { type: 'cylinder', c: [10, 10, 5], area: 250 } } }, b: { comp: 'c4', face: { name: 'E1:side:k', sig: { type: 'cylinder', c: [0, 0, 15], area: 750 } } }, aligned: true },
    { id: 'm8', name: 'Distance1', type: 'distance', a: { plane: 'front' }, b: { comp: 'c4', edge: { name: 'a|b', sig: { type: 'circle', m: [0, 0, 0], len: 25 } } }, aligned: false, value: '=Gap*2', flip: true },
    { id: 'm9', name: 'Lock1', type: 'lock', a: { comp: 'c3' }, b: { comp: 'c5' }, aligned: true, rel: { p: [30, 10, 0], q: [0, 0, 0, 1] }, suppressed: true },
  ];
  doc.explode = [{ id: 'x10', name: 'Explode Step1', comps: ['c4'], dir: [0, 0, 1], distance: 50 }];
  doc.exploded = true;
  doc.variables = [{ id: 'v11', name: 'Gap', expr: '2' }];
  return doc;
}

describe('assembly documents', () => {
  it('round-trips through the file format and keeps the parts it embeds', () => {
    const doc = sample();
    const text = serializeDocument(doc as never);
    expect(text.startsWith(`{"format":"${ASSEMBLY_FORMAT}"`)).toBe(true);
    const back = parseAssembly(text);
    expect(back).toEqual({ ...doc, nextId: 12 });
    expect(isAssembly(back)).toBe(true);
    expect(parseAnyDocument(text)).toEqual(back);
    // Each embedded copy is a part document of its own.
    expect(parseDocument(back.blobs.a1).material?.name).toBe('Steel');
  });

  it('opens parts exactly as before', () => {
    const part = newDocument('Plate');
    const text = serializeDocument(part);
    expect(parseAnyDocument(text)).toEqual(parseDocument(text));
    expect(() => parseAnyDocument('{}')).toThrow(/not a part/);
  });

  it('keeps used part copies out of undo history and drops unused ones from the file', () => {
    const doc = sample();
    doc.blobs.old = 'stale copy';
    expect(Object.keys(withUsedBlobs(doc as never).blobs).sort()).toEqual(['a1', 'a2']);
    const st = new DocStore(doc as never);
    st.change('Rename', (d) => { d.name = 'Other'; });
    st.undo();
    expect(st.doc.name).toBe('Hinge');
    expect(st.doc.blobs.a1).toBe(doc.blobs.a1);
  });

  it('refuses damaged files with a clear message', () => {
    const doc = sample();
    const bad = (patch: (d: Record<string, unknown>) => void) => {
      const raw = JSON.parse(serializeDocument(doc as never));
      patch(raw);
      return () => parseAssembly(JSON.stringify(raw));
    };
    expect(bad((d) => { d.version = 2; })).toThrow(/newer version/);
    expect(bad((d) => { delete d.components; })).toThrow(/damaged \(no component list\)/);
    expect(bad((d) => { (d.components as { part: string }[])[0].part = 'nope'; })).toThrow(/invalid component/);
    expect(bad((d) => { (d.parts as { blob: string }[])[0].blob = 'missing'; })).toThrow(/invalid part/);
    expect(bad((d) => { (d.mates as { type: string }[])[0].type = 'glue'; })).toThrow(/invalid mate/);
    expect(bad((d) => { (d.mates as { b: unknown }[])[0].b = { comp: 'c99' }; })).toThrow(/invalid mate/);
    expect(bad((d) => { (d.explode as { comps: string[] }[])[0].comps = ['c99']; })).toThrow(/explode step/);
    expect(bad((d) => { (d.components as { placement: unknown }[])[1].placement = { p: [0, 0], q: [0, 0, 0, 1] }; })).toThrow(/invalid component/);
    expect(() => parseAssembly('not json')).toThrow(/not a valid assembly/);
  });

  it('allocates ids past those in use, and instance names per part', () => {
    const doc = sample();
    const back = parseAssembly(JSON.stringify({ ...doc, nextId: 1 }));
    expect(nextAsmId(back, 'c')).toBe('c12');
    expect(instanceName(back, 'Pin')).toBe('Pin<4>');
    expect(instanceName(back, 'Bracket')).toBe('Bracket<1>');
  });

  it('lists the bill of materials: parts in order, quantities without suppressed components, materials', () => {
    const doc = sample();
    const cache = new PartCache(parseDocument);
    const rows = assemblyBom(doc, (id) => cache.get(doc, id).doc);
    expect(rows.map((r) => [r.item, r.name, r.quantity, r.material])).toEqual([[1, 'Block', 1, 'Steel'], [2, 'Pin', 2, '']]);
    expect(bomCsv(rows)).toBe('Item No.,Part Name,Quantity,Material\n1,Block,1,Steel\n2,Pin,2,');
    // Copied as tab-separated text: a comma in a name stays in its cell; a tab or quote is quoted.
    const named = [{ ...rows[0], name: 'Plate, top' }, { ...rows[1], name: 'Pin\t"A"' }];
    expect(bomCsv(named, '\t')).toBe('Item No.\tPart Name\tQuantity\tMaterial\n1\tPlate, top\t1\tSteel\n2\t"Pin\t""A"""\t2\t');
    expect(bomCsv(named)).toBe('Item No.,Part Name,Quantity,Material\n1,"Plate, top",1,Steel\n2,"Pin\t""A""",2,');
    expect(assemblyBom(newAssembly())).toEqual([]);
  });

  it('reports a damaged part copy as an error of that part only', () => {
    const doc = sample();
    doc.blobs.a2 = '{"format":"parametric-part","version":1,"features":[{"id":"x","type":"bogus"}]}';
    const cache = new PartCache(parseDocument);
    expect(cache.get(doc, 'p1').doc).not.toBeNull();
    expect(cache.get(doc, 'p2').error).toMatch(/damaged/);
  });
});

describe('combined model', () => {
  const tri = (): MeshData => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    vertexFace: new Float32Array([0, 0, 0]), edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]), edgeIds: new Float32Array([0, 0]), vertices: new Float32Array([0, 0, 0]),
  });
  const geom = (): PartGeometry => ({
    mesh: tri(), faces: [{ name: 'F', type: 'plane', center: [0.3, 0.3, 0], area: 0.5, normal: [0, 0, 1], feature: 'E1' }],
    edges: [{ name: 'E', type: 'line', a: [0, 0, 0], b: [1, 0, 0], mid: [0.5, 0, 0], length: 1, faces: [0], dir: [1, 0, 0] }], bbox: { min: [0, 0, 0], max: [1, 1, 0] }, cones: {},
  });

  it('places each component and numbers faces and edges after those before it', () => {
    const comp = (id: string) => ({ id, name: id, part: 'p', placement: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: false }) as never;
    const m = composeModel([
      { comp: comp('c1'), placement: { p: [0, 0, 0], q: [0, 0, 0, 1] }, geom: geom(), color: [1, 0, 0] },
      { comp: comp('c2'), placement: { p: [10, 0, 0], q: qAxisAngle([0, 0, 1], Math.PI / 2) }, geom: geom(), color: [0, 1, 0] },
    ]);
    expect(m.faces.map((f) => f.name)).toEqual(['c1#F', 'c2#F']);
    expect(m.faces[1].feature).toBe('c2');
    expect(splitName(m.faces[1].name)).toEqual({ comp: 'c2', name: 'F' });
    expect([...m.mesh!.vertexFace]).toEqual([0, 0, 0, 1, 1, 1]);
    expect([...m.mesh!.indices]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...m.mesh!.edgeIds]).toEqual([0, 0, 1, 1]);
    // (1, 0, 0) turned a quarter about z and moved to x = 10.
    expect(m.mesh!.positions[12]).toBeCloseTo(10, 6);
    expect(m.mesh!.positions[13]).toBeCloseTo(1, 6);
    expect(m.edges[1].dir![1]).toBeCloseTo(1, 6);
    expect([...m.faceColors]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(m.bbox!.max[0]).toBeCloseTo(10, 6);
    expect(placementMatrix({ p: [1, 2, 3], q: [0, 0, 0, 1] })).toEqual([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3]);
  });
});
