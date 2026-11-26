// Weldment profile library: generated cross-sections against published
// section areas, closed outlines, placement and the cut list grouping.
import { describe, expect, it } from 'vitest';
import {
  type PSeg, type WeldProfileType, type WeldStandard, PROFILE_LIBRARY, WELD_STANDARDS, WELD_TYPES, findProfile, outlineBox, outlineMax, placeProfile, profileShape,
  profileSizes, sectionProps,
} from '../src/model/weldment-profiles';
import { type WeldMemberInfo, cutListCsv, cutListRows, memberOfFace, newEndCap, newGusset, newStructuralMember, newTrimExtend, newWeldBead, weldmentCutList } from '../src/model/weldments';
import { newDocument, parseDocument, serializeDocument } from '../src/model/document';
import { dependencies } from '../src/model/features';

const area = (standard: string, type: string, size: string) => {
  const p = findProfile(standard, type, size);
  if (!p) throw new Error(`no ${standard} ${type} ${size}`);
  return sectionProps(profileShape(type, p.dims)).area;
};
const IN2 = 25.4 * 25.4;
/** lb/ft of steel from an area in in² (0.2836 lb/in³). */
const lbPerFt = (mm2: number) => (mm2 / IN2) * 12 * 0.2836;

const ends = (s: PSeg): [[number, number], [number, number]] =>
  s.k === 'line' ? [s.a, s.b] : [[s.c[0] + s.r * Math.cos(s.a0), s.c[1] + s.r * Math.sin(s.a0)], [s.c[0] + s.r * Math.cos(s.a1), s.c[1] + s.r * Math.sin(s.a1)]];

describe('profile library', () => {
  it('matches published areas of metric sections (cm²)', () => {
    // EN 10219-2 hollow sections.
    expect(area('iso', 'squareTube', '40x40x3') / 100).toBeCloseTo(4.21, 2);
    expect(area('iso', 'squareTube', '100x100x5') / 100).toBeCloseTo(18.4, 1);
    expect(area('iso', 'rectTube', '60x40x3') / 100).toBeCloseTo(5.41, 2);
    expect(area('iso', 'rectTube', '100x50x4') / 100).toBeCloseTo(10.9, 1);
    expect(area('iso', 'pipe', '48.3x3.2') / 100).toBeCloseTo(4.53, 2);
    expect(area('iso', 'pipe', '114.3x3.6') / 100).toBeCloseTo(12.5, 1);
    // EN 10056-1 equal angles.
    expect(area('iso', 'angle', '50x50x5') / 100).toBeCloseTo(4.8, 1);
    expect(area('iso', 'angle', '60x60x6') / 100).toBeCloseTo(6.91, 2);
    expect(area('iso', 'angle', '100x100x10') / 100).toBeCloseTo(19.2, 1);
    // EN 10279 UPE and EN 10365 IPE / HE A.
    expect(area('iso', 'channel', 'UPE100') / 100).toBeCloseTo(12.5, 1);
    expect(area('iso', 'channel', 'UPE200') / 100).toBeCloseTo(29.0, 1);
    expect(area('iso', 'beam', 'IPE200') / 100).toBeCloseTo(28.5, 1);
    expect(area('iso', 'beam', 'IPE300') / 100).toBeCloseTo(53.8, 1);
    expect(area('iso', 'beam', 'HEA100') / 100).toBeCloseTo(21.2, 1);
    expect(area('iso', 'flatBar', '40x5')).toBeCloseTo(200, 9);
    expect(area('iso', 'roundBar', '20')).toBeCloseTo(Math.PI * 100, 9);
  });

  it('matches published weights and areas of inch sections', () => {
    // AISC: HSS weights per foot (nominal wall).
    expect(lbPerFt(area('ansi', 'squareTube', '2x2x1/8'))).toBeCloseTo(3.05, 1);
    expect(lbPerFt(area('ansi', 'squareTube', '4x4x1/4'))).toBeCloseTo(12.21, 1);
    expect(lbPerFt(area('ansi', 'rectTube', '4x2x1/4'))).toBeCloseTo(8.81, 1);
    // ASME B36.10M standard pipe.
    expect(lbPerFt(area('ansi', 'pipe', '2'))).toBeCloseTo(3.65, 1);
    expect(lbPerFt(area('ansi', 'pipe', '4'))).toBeCloseTo(10.79, 1);
    // AISC W shapes, in².
    expect(area('ansi', 'beam', 'W8x18') / IN2).toBeCloseTo(5.26, 2);
    expect(area('ansi', 'beam', 'W6x9') / IN2).toBeCloseTo(2.68, 2);
    // Channels are modelled without their fillets: within 2 % of the tables.
    expect(area('ansi', 'channel', 'C8x11.5') / IN2 / 3.37).toBeGreaterThan(0.98);
    expect(area('ansi', 'channel', 'C8x11.5') / IN2 / 3.37).toBeLessThan(1);
    expect(area('ansi', 'angle', '2x2x1/4') / IN2).toBeCloseTo(0.9375, 6);
  });

  it('finds no profile for names that are not in the library', () => {
    for (const [standard, type] of [['toString', 'name'], ['constructor', 'name'], ['iso', 'constructor'], ['iso', '__proto__'], ['din', 'pipe']]) {
      expect(findProfile(standard, type, 'x')).toBeNull();
      expect(profileSizes(standard as WeldStandard, type as WeldProfileType)).toEqual([]);
    }
  });

  it('generates closed outlines for every size, with a positive area', () => {
    for (const { value: std } of WELD_STANDARDS) {
      for (const { value: type } of WELD_TYPES) {
        const sizes = PROFILE_LIBRARY[std][type];
        expect(sizes.length).toBeGreaterThan(3);
        for (const size of sizes) {
          const sh = profileShape(type, size.dims);
          const a = sectionProps(sh).area;
          expect(a, `${std} ${type} ${size.id}`).toBeGreaterThan(0);
          for (const loop of [sh.outer, ...sh.holes]) {
            loop.forEach((s, i) => {
              const next = loop[(i + 1) % loop.length];
              const [, b] = ends(s);
              const [a0] = ends(next);
              expect(Math.hypot(b[0] - a0[0], b[1] - a0[1]), `${std} ${type} ${size.id} segment ${i}`).toBeLessThan(1e-9);
            });
          }
          expect(new Set(sizes.map((x) => x.id)).size).toBe(sizes.length);
        }
      }
    }
  });

  it('finds the centroid of an angle', () => {
    // EN 10056-1: L 50 x 50 x 5 has its centroid 1.40 cm from the heel.
    const p = findProfile('iso', 'angle', '50x50x5')!;
    const c = sectionProps(profileShape('angle', p.dims)).centroid;
    expect(c[0] / 10).toBeCloseTo(1.4, 1);
    expect(c[1]).toBeCloseTo(c[0], 9);
  });

  it('places a profile by pierce point, rotation and mirror', () => {
    const p = findProfile('iso', 'rectTube', '60x40x3')!;
    const sh = profileShape('rectTube', p.dims);
    const box = (s: typeof sh) => outlineBox(s.outer);
    const plain = box(placeProfile(sh, { pierce: 'bl', rotation: 0, mirror: false }));
    expect([...plain.min, ...plain.max].map((v) => v + 0)).toEqual([0, 0, 40, 60]);
    const turned = box(placeProfile(sh, { pierce: 'bl', rotation: 90, mirror: false }));
    expect(turned.min[0]).toBeCloseTo(-60, 9);
    expect(turned.max[1]).toBeCloseTo(40, 9);
    const mirrored = placeProfile(sh, { pierce: 'bl', rotation: 0, mirror: true });
    expect(box(mirrored).min[0]).toBeCloseTo(-40, 9);
    // Mirroring keeps the outer loop counter-clockwise (positive area).
    expect(sectionProps(mirrored).area).toBeCloseTo(sectionProps(sh).area, 9);
    // The extreme of an arc is found between its ends.
    expect(outlineMax([{ k: 'arc', c: [0, 0], r: 2, a0: 0, a1: Math.PI }], [0, 1])).toBeCloseTo(2, 12);
    expect(outlineMax([{ k: 'arc', c: [0, 0], r: 2, a0: Math.PI, a1: Math.PI / 2 }], [1, 1])).toBeCloseTo(2, 12);
  });
});

describe('cut list', () => {
  const m = (member: string, length: number, a1: number, a2: number, desc = 'SQ TUBE 40 x 40 x 3'): WeldMemberInfo => ({
    feature: 'f1', member, group: 0, standard: 'iso', profile: 'squareTube', size: '40x40x3', desc, length, angle1: a1, angle2: a2, volume: 420.8 * length, area: 420.8,
  });

  it('groups identical members within tolerance, either way round', () => {
    const list = weldmentCutList({ material: { name: 'Plain Carbon Steel', density: 7800 } }, [
      m('s/a', 500, 0, 45), m('s/b', 500.004, 45, 0), m('s/c', 500, 45, 45), m('s/d', 300, 0, 0), m('s/e', 300, 0, 0, 'PIPE 48.3 x 3.2'),
    ]);
    expect(list.items.map((it) => [it.description, it.quantity, it.length, it.angle1, it.angle2])).toEqual([
      ['PIPE 48.3 x 3.2', 1, 300, 0, 0],
      ['SQ TUBE 40 x 40 x 3', 2, 500, 0, 45],
      ['SQ TUBE 40 x 40 x 3', 1, 500, 45, 45],
      ['SQ TUBE 40 x 40 x 3', 1, 300, 0, 0],
    ]);
    expect(list.items.map((it) => it.item)).toEqual([1, 2, 3, 4]);
    expect(list.count).toBe(5);
    expect(list.items[1].totalMass).toBeCloseTo(420.8 * 1000.004 * 1e-9 * 7800, 9);
    expect(list.material).toBe('Plain Carbon Steel');
  });

  it('keeps curved pieces bent to different radii apart, and gives their radius', () => {
    // A quarter circle of radius 200 and an eighth of radius 400 are both 314.16 long.
    const arc = (member: string, r: number, sweep: number): WeldMemberInfo => ({ ...m(member, r * sweep, 0, 0), curved: true, radius: r });
    const list = weldmentCutList({ material: null }, [arc('s/a', 200, Math.PI / 2), arc('s/b', 400, Math.PI / 4), arc('s/c', 200, Math.PI / 2)]);
    expect(list.items.map((it) => [it.quantity, it.radius])).toEqual([[2, 200], [1, 400]]);
    expect(cutListRows(list, 'MMGS', 1).rows.map((r) => r[2])).toEqual(['SQ TUBE 40 x 40 x 3 (curved, R 200.0)', 'SQ TUBE 40 x 40 x 3 (curved, R 400.0)']);
  });

  it('writes CSV in the part units', () => {
    const list = weldmentCutList({ material: null }, [m('s/a', 254, 0, 0, 'HSS 2 x 2 x 1/8, "A500"')]);
    const csv = cutListCsv(list, 'IPS', 3).split('\r\n');
    expect(csv[0]).toBe('Item,Qty,Description,Length (in),Angle 1 (°),Angle 2 (°),Total length (in),Mass each (lb),Total mass (lb)');
    expect(csv[1].startsWith('1,1,"HSS 2 x 2 x 1/8, ""A500""",10.000,0.00,0.00,10.000,')).toBe(true);
    expect(csv[2].startsWith(',1,Total,,,,10.000,,')).toBe(true);
    // Masses from before a later fillet or shell say so.
    expect(cutListRows({ ...list, massApproximate: true }, 'IPS', 3).header.slice(-2)).toEqual(['Mass each (lb, before later changes)', 'Total mass (lb, before later changes)']);
  });

  it('reads the member of a face name', () => {
    expect(memberOfFace('f7:f3/l2:4')).toEqual({ feature: 'f7', member: 'f3/l2' });
    expect(memberOfFace('f7:f3/l2:4#1')).toEqual({ feature: 'f7', member: 'f3/l2' });
    expect(memberOfFace('f7:cap1')).toBeNull();
    expect(memberOfFace('f7:f3/l2:4|f8:cap0')).toBeNull();
  });
});

describe('weldment features in part files', () => {
  const doc = (features: unknown[]) => JSON.stringify({ ...newDocument('W'), features });
  const sm = { ...newStructuralMember('f2', 'Structural Member1', [[{ sketch: 'f1', entity: 'l1' }]]), rotation: '=Angle' };

  it('opens weldment features and keeps their values', () => {
    const d = parseDocument(doc([{ id: 'f1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [], constraints: [] }, sm,
      newTrimExtend('f3', 'Trim/Extend1'), newEndCap('f4', 'End Cap1', 3), newGusset('f5', 'Gusset1', 50, 5)]));
    expect(d.features.map((f) => f.type)).toEqual(['sketch', 'structuralMember', 'trimExtend', 'endCap', 'gusset']);
    expect((d.features[1] as typeof sm).rotation).toBe('=Angle');
  });

  it('saves and reopens every weldment field', () => {
    const face = (name: string) => ({ name, sig: { type: 'plane', c: [1, 2, 3] as [number, number, number], n: [0, 0, 1] as [number, number, number], area: 12 } });
    const features = [
      { id: 'f1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [], constraints: [] },
      {
        ...newStructuralMember('f2', 'Frame', [[{ sketch: 'f1', entity: 'l1' }], [{ sketch: 'f1', entity: 'l2' }, { sketch: 'f1', entity: 'a3' }]]),
        standard: 'ansi', profile: 'beam', size: 'W6x15', rotation: 30, mirror: true, pierce: 'tl', corner: 'butt2', gap: 1.5, trimGroups: false, gap2: '=G',
      },
      { ...newTrimExtend('f3', 'Trim'), members: [{ feature: 'f2', member: 'f1/l1' }], boundary: 'members', faces: [face('f2:f1/l2:3')], boundaryMembers: [{ feature: 'f2', member: 'f1/l2' }], allowExtension: false, coped: true, gap: 2 },
      { ...newEndCap('f4', 'Cap', 3), faces: [face('f2:f1/l1:0')], offset: 1, inward: true },
      { ...newGusset('f5', 'Gusset', 50, 5), faces: [face('f2:f1/l1:1'), face('f2:f1/l2:2')], shape: 'polygonal', d1: 60, d2: 40, d3: 20, location: 'side2', chamfer: 4 },
      { ...newWeldBead('f6', 'Bead', 4), edges: [{ name: 'f2:f1/l1:1|f2:f1/l2:2', sig: { type: 'line', m: [0, 0, 0] as [number, number, number], len: 40 } }] },
    ];
    const d = parseDocument(serializeDocument({ ...newDocument('W', 'IPS'), features: features as never }));
    expect(d.units).toBe('IPS');
    expect(d.features).toEqual(features);
  });

  it('rejects damaged weldment features', () => {
    expect(() => parseDocument(doc([{ ...sm, groups: [{ segments: [{ sketch: 'f1' }] }] }]))).toThrow(/damaged/);
    expect(() => parseDocument(doc([{ ...sm, groups: 'x' }]))).toThrow(/damaged/);
    expect(() => parseDocument(doc([{ ...sm, corner: 'weld' }]))).toThrow(/damaged/);
    expect(() => parseDocument(doc([{ ...newTrimExtend('f3', 'T'), members: [{ member: 'a/b' }] }]))).toThrow(/damaged/);
    expect(() => parseDocument(doc([{ ...newGusset('f5', 'G', 1, 1), faces: [{}] }]))).toThrow(/damaged/);
  });

  it('lists the sketches and members a weldment feature depends on', () => {
    expect(dependencies(sm)).toEqual(['f1']);
    const t = { ...newTrimExtend('f3', 'T'), members: [{ feature: 'f2', member: 'f1/l1' }], faces: [{ name: 'f9:cap1', sig: { type: 'plane', c: [0, 0, 0] as [number, number, number], area: 1 } }] };
    expect(dependencies(t).sort()).toEqual(['f2', 'f9']);
  });
});
