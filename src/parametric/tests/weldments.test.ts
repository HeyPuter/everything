// Weldments on the real OpenCascade kernel: structural members, corner
// treatments, trimming, end caps, gussets and the cut list.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { type Sh, isValid, setOc } from '../src/kernel/occ';
import type { Feature, SegmentRef, SkEntity, StructuralMemberFeature } from '../src/model/types';
import { findProfile, profileShape, sectionProps } from '../src/model/weldment-profiles';
import { newEndCap, newGusset, newStructuralMember, newTrimExtend, weldmentCutList } from '../src/model/weldments';
import { extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const volume = (b: ModelBuilder) => b.massProperties()!.volume;
const body = (b: ModelBuilder) => (b as unknown as { current: { body: Sh } }).current.body;
const area = (type: string, size: string, standard = 'iso') => sectionProps(profileShape(type, findProfile(standard, type, size)!.dims)).area;

/** A rectangle's four lines as segments ("r" prefixed ids: rl0 bottom, rl1 right, rl2 top, rl3 left). */
const rectSegs = (sk: string): SegmentRef[] => [0, 1, 2, 3].map((i) => ({ sketch: sk, entity: `rl${i}` }));

function member(id: string, groups: SegmentRef[][], extra: Partial<StructuralMemberFeature> = {}): StructuralMemberFeature {
  return { ...newStructuralMember(id, id, groups), ...extra };
}

function line(id: string, a: [number, number], b: [number, number]): SkEntity[] {
  return [{ id: `${id}a`, t: 'point', x: a[0], y: a[1] }, { id: `${id}b`, t: 'point', x: b[0], y: b[1] }, { id, t: 'line', a: `${id}a`, b: `${id}b` }];
}

async function build(features: Feature[]) {
  const b = new ModelBuilder();
  const res = await b.build(req(features));
  return { b, res };
}

describe('structural members', () => {
  it('builds a mitered rectangular frame of square tube', async () => {
    const { b, res } = await build([sketch('S1', rect(0, 0, 200, 100, 'r')), member('M1', [rectSegs('S1')])]);
    expect(res.status.every((s) => s.ok && !s.warning)).toBe(true);
    const A = area('squareTube', '40x40x3');
    // EN 10219-2: 40 x 40 x 3 has 4.21 cm².
    expect(A).toBeCloseTo(420.8, 0);
    // A miter plane passes through the corner point, so each member holds the
    // profile area times its centreline length.
    expect(volume(b)).toBeCloseTo(A * 600, 0);
    expect(isValid(body(b))).toBe(true);
    const ms = res.weldments!;
    expect(ms).toHaveLength(4);
    const lengths = ms.map((m) => m.length).sort((x, y) => x - y);
    // Long point to long point: the centreline plus half the tube each end.
    expect(lengths[0]).toBeCloseTo(140, 6);
    expect(lengths[1]).toBeCloseTo(140, 6);
    expect(lengths[2]).toBeCloseTo(240, 6);
    expect(lengths[3]).toBeCloseTo(240, 6);
    for (const m of ms) {
      expect(m.angle1).toBeCloseTo(45, 6);
      expect(m.angle2).toBeCloseTo(45, 6);
      expect(m.volume).toBeCloseTo(A * (m.length - 40), 0);
      expect(m.desc).toBe('SQ TUBE 40 x 40 x 3');
    }
    // Faces are named after the member they belong to.
    expect(res.faces.some((f) => f.name.startsWith('M1:S1/rl0:'))).toBe(true);
  });

  it('leaves a gap between mitered ends', async () => {
    const { b, res } = await build([sketch('S1', rect(0, 0, 200, 200, 'r')), member('M1', [rectSegs('S1')], { gap: 2 })]);
    expect(res.status.every((s) => s.ok)).toBe(true);
    const A = area('squareTube', '40x40x3');
    // Each end is set back 1 mm along the miter normal: sqrt(2) mm along the member.
    expect(volume(b)).toBeCloseTo(A * (800 - 8 * Math.SQRT2), 0);
    for (const m of res.weldments!) expect(m.length).toBeCloseTo(240 - 2 * Math.SQRT2, 6);
  });

  it('butts members at corners (end butt 1 and 2)', async () => {
    for (const corner of ['butt1', 'butt2'] as const) {
      const { b, res } = await build([sketch('S1', rect(0, 0, 200, 200, 'r')), member('M1', [rectSegs('S1')], { corner })]);
      expect(res.status.every((s) => s.ok)).toBe(true);
      const A = area('squareTube', '40x40x3');
      // Each member runs through one corner and is trimmed at the other: all four are 200 long, square cut.
      for (const m of res.weldments!) {
        expect(m.length).toBeCloseTo(200, 6);
        expect(m.angle1).toBe(0);
        expect(m.angle2).toBe(0);
      }
      expect(volume(b)).toBeCloseTo(A * 800, 0);
      expect(isValid(body(b))).toBe(true);
    }
  });

  it('trims later groups to earlier ones, and extends the earlier member over a joint', async () => {
    // A T: a horizontal rail, and a post from below ending on the rail's centreline.
    const ents = [...line('h', [-100, 0], [100, 0]), ...line('v', [0, -150], [0, 0])];
    const { b, res } = await build([sketch('S1', ents), member('M1', [[{ sketch: 'S1', entity: 'h' }], [{ sketch: 'S1', entity: 'v' }]])]);
    expect(res.status.every((s) => s.ok)).toBe(true);
    const A = area('squareTube', '40x40x3');
    const post = res.weldments!.find((m) => m.member === 'S1/v')!;
    expect(post.length).toBeCloseTo(130, 6);
    expect(volume(b)).toBeCloseTo(A * (200 + 130), 0);
    // An L of two groups: the first member is extended to cover the second.
    const l = [...line('h', [0, 0], [100, 0]), ...line('v', [0, -100], [0, 0])];
    const r2 = await build([sketch('S1', l), member('M1', [[{ sketch: 'S1', entity: 'h' }], [{ sketch: 'S1', entity: 'v' }]])]);
    const ws = r2.res.weldments!;
    expect(ws.find((m) => m.member === 'S1/h')!.length).toBeCloseTo(120, 6);
    expect(ws.find((m) => m.member === 'S1/v')!.length).toBeCloseTo(80, 6);
    expect(volume(r2.b)).toBeCloseTo(A * 200, 0);
  });

  it('joins members of different sketches (a table frame with legs)', async () => {
    // Top frame on the Top plane (y = 0), a leg on the Front plane down from a corner.
    const top = sketch('S1', rect(0, 0, 400, 300, 'r'), { kind: 'base', plane: 'top' });
    const legs = sketch('S2', line('leg', [0, -500], [0, 0]));
    const { b, res } = await build([top, legs, member('M1', [rectSegs('S1'), [{ sketch: 'S2', entity: 'leg' }]])]);
    expect(res.status.every((s) => s.ok)).toBe(true);
    const leg = res.weldments!.find((m) => m.member === 'S2/leg')!;
    // The leg stops at the underside of the frame.
    expect(leg.length).toBeCloseTo(480, 6);
    expect(isValid(body(b))).toBe(true);
  });

  it('places and turns the profile by its pierce point', async () => {
    // An angle along x with its heel on the line: all material on one side.
    const ents = line('h', [0, 0], [100, 0]);
    const { res } = await build([sketch('S1', ents), member('M1', [[{ sketch: 'S1', entity: 'h' }]], { profile: 'angle', size: '50x50x5', pierce: 'bl' })]);
    expect(res.status[1].ok).toBe(true);
    const bb = res.bbox!;
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(100, 6);
    // Profile x runs along U = sketch normal × direction = +y, profile y along the sketch normal (+z).
    expect(bb.min[1]).toBeCloseTo(0, 4);
    expect(bb.max[1]).toBeCloseTo(50, 4);
    expect(bb.min[2]).toBeCloseTo(0, 4);
    expect(bb.max[2]).toBeCloseTo(50, 4);
    const turned = await build([sketch('S1', ents), member('M1', [[{ sketch: 'S1', entity: 'h' }]], { profile: 'angle', size: '50x50x5', pierce: 'bl', rotation: 90 })]);
    expect(turned.res.bbox!.min[1]).toBeCloseTo(-50, 4);
    const mirrored = await build([sketch('S1', ents), member('M1', [[{ sketch: 'S1', entity: 'h' }]], { profile: 'angle', size: '50x50x5', pierce: 'bl', mirror: true })]);
    expect(mirrored.res.bbox!.min[1]).toBeCloseTo(-50, 4);
  });

  it('sweeps members along arcs, and follows sketch edits', async () => {
    const arc: SkEntity[] = [
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 100, y: 0 }, { id: 'b', t: 'point', x: -100, y: 0 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' },
    ];
    const f = member('M1', [[{ sketch: 'S1', entity: 'arc' }]], { profile: 'pipe', size: '48.3x3.2' });
    const { b, res } = await build([sketch('S1', arc), f]);
    expect(res.status[1].ok).toBe(true);
    const A = area('pipe', '48.3x3.2');
    expect(A).toBeCloseTo(453.4, 0);
    expect(volume(b)).toBeCloseTo(A * Math.PI * 100, 0);
    expect(res.weldments![0].length).toBeCloseTo(Math.PI * 100, 4);
    expect(res.weldments![0].curved).toBe(true);
    // Moving a sketch point moves the member.
    const moved = structuredClone(arc);
    (moved[1] as { x: number }).x = 150; (moved[2] as { x: number }).x = -150;
    const r2 = await b.build(req([sketch('S1', moved), f]));
    expect(r2.weldments![0].length).toBeCloseTo(Math.PI * 150, 4);
  });

  it('reports clear errors', async () => {
    const r1 = await build([sketch('S1', rect(0, 0, 100, 100, 'r')), member('M1', [])]);
    expect(r1.res.status[1]).toMatchObject({ ok: false, error: expect.stringMatching(/Select sketch lines or arcs/) });
    const r2 = await build([sketch('S1', rect(0, 0, 100, 100, 'r')), member('M1', [rectSegs('S1')], { size: 'nope' })]);
    expect(r2.res.status[1].error).toMatch(/profile/);
    const r3 = await build([sketch('S1', [...rect(0, 0, 100, 100, 'r'), ...line('d', [0, 0], [100, 100])]), member('M1', [[...rectSegs('S1'), { sketch: 'S1', entity: 'd' }]])]);
    expect(r3.res.status[1].error).toMatch(/Three or more members/);
    const r4 = await build([sketch('S1', rect(0, 0, 100, 100, 'r')), member('M1', [[{ sketch: 'S1', entity: 'gone' }]])]);
    expect(r4.res.status[1].error).toMatch(/no longer in/);
    const r5 = await build([member('M1', [[{ sketch: 'S9', entity: 'x' }]])]);
    expect(r5.res.status[0].error).toMatch(/layout sketch/);
    const arc: SkEntity[] = [
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 10, y: 0 }, { id: 'b', t: 'point', x: -10, y: 0 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' },
    ];
    const r6 = await build([sketch('S1', arc), member('M1', [[{ sketch: 'S1', entity: 'arc' }]], { size: '40x40x3' })]);
    expect(r6.res.status[1].error).toMatch(/does not fit inside the arc/);
  });
});

describe('trim/extend', () => {
  // A plate on the Top plane, 10 thick (y 0..10), and a post on the Front plane.
  const plate = () => [sketch('P', rect(-100, -100, 100, 100), { kind: 'base', plane: 'top' }), extrude('E1', 'P', 10)];

  it('trims a member to a planar face', async () => {
    const post = sketch('S1', line('v', [0, -50], [0, 100]));
    const pre = await build([...plate(), post, member('M1', [[{ sketch: 'S1', entity: 'v' }]])]);
    const top = pre.res.faces.find((f) => f.name === 'E1:cap1')!;
    const t = { ...newTrimExtend('T1', 'T1'), members: [{ feature: 'M1', member: 'S1/v' }], faces: [{ name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } }] };
    const { b, res } = await build([...plate(), post, member('M1', [[{ sketch: 'S1', entity: 'v' }]]), t]);
    expect(res.status.every((s) => s.ok && !s.warning)).toBe(true);
    const A = area('squareTube', '40x40x3');
    expect(res.weldments![0].length).toBeCloseTo(90, 6);
    // The plate is left whole, and the post stands on it.
    expect(volume(b)).toBeCloseTo(200 * 200 * 10 + A * 90, 0);
    expect(isValid(body(b))).toBe(true);
  });

  it('extends a member to a face only when allowed', async () => {
    const post = sketch('S1', line('v', [0, 30], [0, 100]));
    const pre = await build([...plate(), post, member('M1', [[{ sketch: 'S1', entity: 'v' }]])]);
    const top = pre.res.faces.find((f) => f.name === 'E1:cap1')!;
    const face = { name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } };
    const t = { ...newTrimExtend('T1', 'T1'), members: [{ feature: 'M1', member: 'S1/v' }], faces: [face] };
    const { b, res } = await build([...plate(), post, member('M1', [[{ sketch: 'S1', entity: 'v' }]]), t]);
    expect(res.status[4].ok).toBe(true);
    expect(res.weldments![0].length).toBeCloseTo(90, 6);
    expect(volume(b)).toBeCloseTo(200 * 200 * 10 + area('squareTube', '40x40x3') * 90, 0);
    const r2 = await build([...plate(), post, member('M1', [[{ sketch: 'S1', entity: 'v' }]]), { ...t, allowExtension: false }]);
    expect(r2.res.status[4].warning).toMatch(/Allow extension/);
    expect(r2.res.weldments![0].length).toBeCloseTo(70, 6);
  });

  it('trims a member to another member, planar or coped', async () => {
    // Two groups would trim by themselves: here two features, trimmed after.
    const ents = [...line('h', [-100, 0], [100, 0]), ...line('v', [0, -150], [0, 20])];
    const s1 = sketch('S1', ents);
    const m1 = member('M1', [[{ sketch: 'S1', entity: 'h' }]], { profile: 'pipe', size: '88.9x3.2' });
    const m2 = member('M2', [[{ sketch: 'S1', entity: 'v' }]], { profile: 'pipe', size: '48.3x3.2' });
    const t = { ...newTrimExtend('T1', 'T1'), boundary: 'members' as const, members: [{ feature: 'M2', member: 'S1/v' }], boundaryMembers: [{ feature: 'M1', member: 'S1/h' }] };
    const planar = await build([s1, m1, m2, t]);
    expect(planar.res.status.every((s) => s.ok)).toBe(true);
    const post = planar.res.weldments!.find((m) => m.member === 'S1/v')!;
    expect(post.length).toBeCloseTo(150 - 88.9 / 2, 6);
    const coped = await build([s1, m1, m2, { ...t, coped: true }]);
    expect(coped.res.status.every((s) => s.ok)).toBe(true);
    const cp = coped.res.weldments!.find((m) => m.member === 'S1/v')!;
    // Fish-mouth: the long points reach to where the post's sides meet the rail's surface.
    const R = 88.9 / 2, r = 48.3 / 2;
    expect(cp.length).toBeCloseTo(150 - Math.sqrt(R * R - r * r), 1);
    expect(isValid(body(coped.b))).toBe(true);
    // The coped post fills the saddle: more material than the planar cut.
    expect(volume(coped.b)).toBeGreaterThan(volume(planar.b));
  });
});

describe('end caps and gussets', () => {
  it('caps a square-cut tube end, outward and inward', async () => {
    const s1 = sketch('S1', line('v', [0, 0], [0, 100]));
    const m1 = member('M1', [[{ sketch: 'S1', entity: 'v' }]]);
    const pre = await build([s1, m1]);
    const end = pre.res.faces.find((f) => f.type === 'plane' && f.center[1] > 99.9)!;
    const ref = { name: end.name, sig: { type: end.type, c: end.center, n: end.normal, area: end.area } };
    const A = area('squareTube', '40x40x3');
    const out = await build([s1, m1, { ...newEndCap('C1', 'C1', 5), faces: [ref], offset: 2 }]);
    expect(out.res.status.every((s) => s.ok)).toBe(true);
    // A 36 x 36 cap with corner radius 4 (6 - 2), 5 thick.
    const capArea = 36 * 36 - (4 - Math.PI) * 16;
    expect(volume(out.b)).toBeCloseTo(A * 100 + capArea * 5, 0);
    const inward = await build([s1, m1, { ...newEndCap('C1', 'C1', 5), faces: [ref], inward: true }]);
    expect(inward.res.status.every((s) => s.ok)).toBe(true);
    // Inside the 34 x 34 opening with its 3 mm corner radius.
    const plug = 34 * 34 - (4 - Math.PI) * 9;
    expect(volume(inward.b)).toBeCloseTo(A * 100 + plug * 5, 0);
    // Not on a mitered end (a gap leaves the miter faces outside).
    const frame = await build([sketch('S2', rect(0, 0, 100, 100, 'r')), member('M2', [rectSegs('S2')], { gap: 2 })]);
    const miter = frame.res.faces.find((f) => f.type === 'plane' && f.normal && Math.abs(Math.abs(f.normal[0]) - Math.SQRT1_2) < 1e-6)!;
    const bad = await build([sketch('S2', rect(0, 0, 100, 100, 'r')), member('M2', [rectSegs('S2')], { gap: 2 }), { ...newEndCap('C1', 'C1', 5), faces: [{ name: miter.name, sig: { type: 'plane', c: miter.center, n: miter.normal, area: miter.area } }] }]);
    expect(bad.res.status[2].error).toMatch(/square-cut/);
  });

  it('adds a triangular gusset between two member faces', async () => {
    // An L of two groups: rail along x at y = 0, post along y at x = 0, both 40 x 40.
    const l = [...line('h', [0, 0], [300, 0]), ...line('v', [0, 0], [0, 300])];
    const s1 = sketch('S1', l);
    const m1 = member('M1', [[{ sketch: 'S1', entity: 'h' }], [{ sketch: 'S1', entity: 'v' }]]);
    const pre = await build([s1, m1]);
    const sig = (f: typeof pre.res.faces[number]) => ({ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } });
    const railTop = pre.res.faces.find((f) => f.type === 'plane' && f.normal![1] > 0.99 && Math.abs(f.center[1] - 20) < 1e-6)!;
    const postSide = pre.res.faces.find((f) => f.type === 'plane' && f.normal![0] > 0.99 && Math.abs(f.center[0] - 20) < 1e-6)!;
    const v0 = volume(pre.b);
    const g = { ...newGusset('G1', 'G1', 60, 5), faces: [sig(railTop), sig(postSide)] };
    const { b, res } = await build([s1, m1, g]);
    expect(res.status.every((s) => s.ok)).toBe(true);
    expect(volume(b) - v0).toBeCloseTo(60 * 60 / 2 * 5, 0);
    const ch = await build([s1, m1, { ...g, chamfer: 10 }]);
    expect(volume(ch.b) - v0).toBeCloseTo((60 * 60 / 2 - 50) * 5, 0);
    const poly = await build([s1, m1, { ...g, shape: 'polygonal' as const, d3: 20 }]);
    // Pentagon (0,0) (60,0) (60,20) (20,60) (0,60).
    expect(volume(poly.b) - v0).toBeCloseTo((60 * 60 - 40 * 40 / 2) * 5, 0);
  });
});

describe('cut list', () => {
  it('groups identical members', async () => {
    const { res } = await build([sketch('S1', rect(0, 0, 200, 100, 'r')), member('M1', [rectSegs('S1')])]);
    const list = weldmentCutList({ material: { name: 'Plain Carbon Steel', density: 7800 } }, res.weldments);
    expect(list.items).toHaveLength(2);
    expect(list.count).toBe(4);
    expect(list.items[0]).toMatchObject({ item: 1, quantity: 2, description: 'SQ TUBE 40 x 40 x 3' });
    expect(list.items[0].length).toBeCloseTo(240, 6);
    expect(list.items[1].length).toBeCloseTo(140, 6);
    const A = area('squareTube', '40x40x3');
    expect(list.totalMass).toBeCloseTo(A * 600 * 1e-9 * 7800, 6);
    expect(list.totalLength).toBeCloseTo(760, 6);
  });
});
