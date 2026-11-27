// The study saved with the part, materials' elastic properties, and the
// results summary export: round trips, old files, refused damage.
import { describe, expect, it } from 'vitest';
import { newDocument, parseDocument, serializeDocument } from '../src/model/document';
import { type StaticStudy, elementSizeFor, feaUnits, newStudy, parseStudy, studyIds } from '../src/model/fea';
import { MATERIALS, elasticOf, normalizeMaterial, validElastic } from '../src/model/materials';
import { colorAt, interpolate } from '../src/fea/results';
import { principal } from '../src/fea/elements';
import { summaryCsv } from '../src/app/fea/report';

const face = (name: string) => ({ name, sig: { type: 'plane', c: [1, 2, 3] as [number, number, number], n: [0, 0, 1] as [number, number, number], area: 12 } });

function study(): StaticStudy {
  const s = newStudy('st3');
  s.fixtures.push({ id: 'fx4', name: 'Fixed-1', type: 'fixed', faces: [face('f1:cap0')] });
  s.fixtures.push({ id: 'fx5', name: 'Hinge-1', type: 'hinge', faces: [{ name: 'f2:h1:1', sig: { type: 'cylinder', c: [0, 0, 0], area: 50 } }], suppressed: true });
  s.loads.push({ id: 'ld6', name: 'Force-1', type: 'force', faces: [face('f1:cap1')], value: 250, dir: { kind: 'edge', edge: { name: 'e1', sig: { type: 'line', m: [0, 0, 0], len: 10 } } }, flip: true });
  s.loads.push({ id: 'ld7', name: 'Pressure-1', type: 'pressure', faces: [face('f1:side:bl2')], value: 2, flip: false });
  s.loads.push({ id: 'ld8', name: 'Gravity-1', type: 'gravity', value: 9806.65, dir: { kind: 'base', axis: 'y' }, flip: true });
  s.mesh.fineness = 0.75;
  return s;
}

describe('static study in the part file', () => {
  it('saves and reads a study unchanged, and new ids never collide with its ids', () => {
    const doc = newDocument();
    doc.study = study();
    const back = parseDocument(serializeDocument(doc));
    expect(back.study).toEqual(doc.study);
    expect(back.nextId).toBeGreaterThan(8);
    expect(studyIds(back.study)).toEqual(['st3', 'fx4', 'fx5', 'ld6', 'ld7', 'ld8']);
  });

  it('opens parts without a study, and with a null one', () => {
    expect(parseDocument(serializeDocument(newDocument())).study).toBeUndefined();
    expect(parseDocument(JSON.stringify({ ...newDocument(), study: null })).study).toBeNull();
  });

  it('refuses a damaged study with a message', () => {
    const bad: [string, (s: Record<string, unknown>) => void][] = [
      ['no fixture list', (s) => { delete s.fixtures; }],
      ['unknown fixture type', (s) => { (s.fixtures as Record<string, unknown>[])[0].type = 'glued'; }],
      ['face without signature', (s) => { (s.fixtures as { faces: unknown[] }[])[0].faces = [{ name: 'x' }]; }],
      ['duplicate ids', (s) => { (s.loads as Record<string, unknown>[])[0].id = 'fx4'; }],
      ['value not a number', (s) => { (s.loads as Record<string, unknown>[])[1].value = '2 MPa'; }],
      ['unknown load type', (s) => { (s.loads as Record<string, unknown>[])[1].type = 'torque'; }],
      ['gravity without a direction', (s) => { delete (s.loads as Record<string, unknown>[])[2].dir; }],
      ['bad direction', (s) => { (s.loads as Record<string, unknown>[])[0].dir = { kind: 'base', axis: 'w' }; }],
      ['fineness out of range', (s) => { s.mesh = { fineness: 3 }; }],
      ['not an object', (s) => { for (const k of Object.keys(s)) delete s[k]; }],
    ];
    for (const [what, damage] of bad) {
      const raw = JSON.parse(JSON.stringify(study())) as Record<string, unknown>;
      damage(raw);
      expect(() => parseStudy(raw), what).toThrow(/invalid study/);
      expect(() => parseDocument(JSON.stringify({ ...newDocument(), study: raw })), what).toThrow(/damaged \(invalid study/);
    }
  });

  it('drops unknown keys and keeps only what a study holds', () => {
    const raw = { ...study(), extra: 1 } as Record<string, unknown>;
    (raw.fixtures as Record<string, unknown>[])[0].colour = 'red';
    const s = parseStudy(raw);
    expect('extra' in s).toBe(false);
    expect('colour' in s.fixtures[0]).toBe(false);
  });

  it('sizes elements from the automatic size, never beyond the walls', () => {
    expect(elementSizeFor(4, 100, 0.5)).toBeCloseTo(4);
    expect(elementSizeFor(4, 100, 1)).toBeCloseTo(2);
    expect(elementSizeFor(4, 100, 0)).toBeCloseTo(8);
    expect(elementSizeFor(4, 6, 0)).toBeCloseTo(6);
  });

  it('shows forces and stresses in the part\'s units', () => {
    expect(feaUnits('MMGS')).toMatchObject({ force: 'N', stress: 'MPa', length: 'mm' });
    expect(feaUnits('IPS')).toMatchObject({ force: 'lbf', stress: 'psi', length: 'in' });
    expect(1 / feaUnits('IPS').stressScale).toBeCloseTo(145.04, 1);
  });
});

describe('materials for analysis', () => {
  it('has elastic properties for every preset but wood', () => {
    for (const m of MATERIALS) expect(!!elasticOf(m), m.name).toBe(!/Oak|Pine/.test(m.name));
    const steel = elasticOf(MATERIALS[0])!;
    expect(steel.E).toBeGreaterThan(190000);
    expect(steel.yield).toBeLessThan(steel.uts);
  });

  it('finds the properties of a preset saved before materials had them', () => {
    expect(elasticOf({ name: 'Aluminum 6061', density: 2700 })?.E).toBe(68900);
    expect(elasticOf({ name: 'Aluminum 6061', density: 2600 })).toBeNull();
    expect(elasticOf({ name: 'Custom', density: 1000 })).toBeNull();
    expect(elasticOf(null)).toBeNull();
  });

  it('keeps a custom material\'s properties only as a complete, valid set', () => {
    const ok = { name: 'Custom', density: 1000, E: 1000, nu: 0.3, yield: 10, uts: 12 };
    expect(normalizeMaterial(ok)).toEqual(ok);
    expect(normalizeMaterial({ ...ok, nu: 0.5 })).toEqual({ name: 'Custom', density: 1000 });
    expect(normalizeMaterial({ name: 'Custom', density: 1000, E: 1000 })).toEqual({ name: 'Custom', density: 1000 });
    expect(validElastic({ E: -1, nu: 0.3, yield: 1, uts: 1 })).toBe(false);
    const doc = parseDocument(JSON.stringify({ ...newDocument(), material: { ...ok, E: 'stiff' } }));
    expect(doc.material).toEqual({ name: 'Custom', density: 1000 });
    expect(parseDocument(JSON.stringify({ ...newDocument(), material: ok })).material).toEqual(ok);
  });
});

describe('result helpers', () => {
  it('finds principal stresses', () => {
    const p = principal(10, 0, 0, 0, 0, 0);
    expect(p[0]).toBeCloseTo(10);
    const q = principal(0, 0, 0, 5, 0, 0);
    expect(q[0]).toBeCloseTo(5);
    expect(q[2]).toBeCloseTo(-5);
    expect(q[1]).toBeCloseTo(0);
  });

  it('interpolates on six-node triangles and maps colours', () => {
    const tris = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const v = [0, 1, 0, 0.5, 0.5, 0];
    expect(interpolate(v, tris, 0, 0.5, 0)).toBeCloseTo(0.5);
    expect(interpolate(v, tris, 0, 1, 0)).toBeCloseTo(1);
    expect(colorAt(0)[2]).toBeGreaterThan(colorAt(0)[0]);
    expect(colorAt(1)[0]).toBeGreaterThan(colorAt(1)[2]);
  });

  it('writes the summary as CSV, quoting what needs it', () => {
    const csv = summaryCsv([{ section: 'Results', name: 'Max von Mises stress', value: '12.5', unit: 'MPa' }, { section: 'Study', name: 'Part', value: 'Bracket, "A"', unit: '' }]);
    expect(csv.split('\n')[0]).toBe('Section,Quantity,Value,Unit');
    expect(csv).toContain('Results,Max von Mises stress,12.5,MPa');
    expect(csv).toContain('Study,Part,"Bracket, ""A""",');
  });
});
