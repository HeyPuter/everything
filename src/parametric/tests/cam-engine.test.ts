// The CAM engine on meshes built by hand: drop-cutter heights against exact
// answers, toolpaths that stay clear of the part, simulation and G-code.
import { describe, expect, it } from 'vitest';
import { DropCutter, NO_CONTACT, TriIndex, cutterOf, makeCutter } from '../src/cam/dropcutter';
import { machineFrame, setupAxes, toModel, pointToWork } from '../src/cam/frame';
import { contours, gridOver, simplify } from '../src/cam/grid';
import { placePart, generateFor } from '../src/cam/engine';
import { stepLevels } from '../src/cam/ops';
import { simulate } from '../src/cam/simulate';
import { postProcess, writeArcs } from '../src/cam/post';
import { CYCLE, FEED, PLUNGE, RAPID, type Toolpath, expandMoves, pathStats } from '../src/cam/toolpath';
import { type CamOperation, type CamSetup, type CamTool, newCamDoc, normalizeCam, opDefaults } from '../src/model/cam';
import type { Vec3 } from '../src/math/vec';
import { allocateId, newDocument, parseDocument, serializeDocument } from '../src/model/document';

type Tri = number[];

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Tri {
  const p = (x: number, y: number, z: number) => [x, y, z];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...q(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...q(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)),
    ...q(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...q(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)),
    ...q(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...q(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
  ];
}

const mesh = (...parts: Tri[]) => Float32Array.from(parts.flat());

const tool = (type: CamTool['type'], diameter: number, extra: Partial<CamTool> = {}): CamTool => ({
  id: 'tt', number: 1, name: 'tool', type, diameter, fluteLength: 30, flutes: 2, rpm: 10000, feed: 1000, plunge: 300, coolant: true, ...extra,
});

const setup = (extra: Partial<CamSetup> = {}): CamSetup => ({
  id: 's', name: 'Setup1', axis: '+Z', rotation: 0, origin: 'modelOrigin',
  stock: { mode: 'offset', side: 5, top: 2, bottom: 3, size: [0, 0, 0] }, clearance: 10, retract: 3, workOffset: 54, ops: [], ...extra,
});

const op = <T extends CamOperation['type']>(type: T, t: CamTool, extra: Record<string, unknown> = {}) =>
  ({ id: 'o', name: type, type, tool: t.id, ...opDefaults(type, t.diameter), ...extra }) as Extract<CamOperation, { type: T }>;

/** Every move with its kind, cycles written out. */
function moves(tp: Toolpath) {
  const out: { k: number; x: number; y: number; z: number }[] = [];
  expandMoves(tp, (k, x, y, z) => out.push({ k, x, y, z }));
  return out;
}

/** Distance from a point to an axis-aligned rectangle (0 inside). */
const rectDist = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));

describe('drop-cutter', () => {
  const idx = new TriIndex(Float64Array.from(box(0, 0, 0, 20, 20, 10)));

  it('rests a flat end mill on a box top until its edge leaves the box', () => {
    const dc = new DropCutter(idx, makeCutter('flat', 3, 0, 0));
    expect(dc.drop(10, 10)).toBeCloseTo(10, 9);
    expect(dc.drop(22.9, 10)).toBeCloseTo(10, 9);
    expect(dc.drop(23.1, 10)).toBe(NO_CONTACT);
    // Off the corner diagonally: touches only within the radius of the corner.
    expect(dc.drop(22, 22)).toBeCloseTo(10, 9);
    expect(dc.drop(22.2, 22.2)).toBe(NO_CONTACT);
  });

  it('drops a ball onto the edge of a box at the exact height', () => {
    const dc = new DropCutter(idx, makeCutter('ball', 3, 3, 0));
    // 2 mm beyond the edge: the ball touches the edge; the centre is sqrt(9-4) above it.
    expect(dc.drop(22, 10)).toBeCloseTo(10 + Math.sqrt(5) - 3, 9);
    expect(dc.drop(10, 10)).toBeCloseTo(10, 9);
  });

  it('drops a ball on a sloped plane at the offset surface height', () => {
    const s = 0.5;
    // A large plane z = s * x.
    const tris = Float64Array.from([-100, -100, -50, 100, -100, 50, 100, 100, 50, -100, -100, -50, 100, 100, 50, -100, 100, -50]);
    const dc = new DropCutter(new TriIndex(tris), makeCutter('ball', 4, 4, 0));
    expect(dc.drop(10, 0)).toBeCloseTo(s * 10 + 4 * Math.sqrt(1 + s * s) - 4, 9);
    const flat = new DropCutter(new TriIndex(tris), makeCutter('flat', 4, 0, 0));
    expect(flat.drop(10, 0)).toBeCloseTo(s * 14, 9);
  });

  it('drops a cone onto an edge and a bull nose between flat and ball', () => {
    const cone = new DropCutter(idx, cutterOf({ type: 'chamfer', diameter: 10, tipAngle: 90 }));
    // 45° half angle: 2 mm beyond the edge the tip is 2 mm below it.
    expect(cone.drop(22, 10)).toBeCloseTo(8, 6);
    const bull = new DropCutter(idx, cutterOf({ type: 'bull', diameter: 6, cornerRadius: 1 }));
    // Flat part (radius 2) reaches 1 mm beyond the edge; the corner beyond that.
    expect(bull.drop(21.5, 10)).toBeCloseTo(10, 6);
    expect(bull.drop(22.5, 10)).toBeCloseTo(10 - (1 - Math.sqrt(1 - 0.25)), 5);
  });
});

describe('machine frame', () => {
  it('gives right-handed axes for every tool direction and turn', () => {
    for (const axis of ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const) {
      for (const rot of [0, 90, 180, 270]) {
        const { x, y, z } = setupAxes(axis, rot);
        const c: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
        for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(z[k], 9);
      }
    }
  });

  it('puts the work origin on the stock and maps points back', () => {
    const tris = mesh(box(0, 0, 0, 40, 20, 10));
    // Top view: the tool comes down along -Y of the model (its axis is +Y).
    const f = machineFrame({ axis: '+Y', rotation: 0, origin: 'topFrontLeft', stock: { mode: 'offset', side: 2, top: 1, bottom: 0, size: [0, 0, 0] } }, tris)!;
    expect(f.stock.max[2]).toBeCloseTo(0, 9);
    expect(f.stock.min[0]).toBeCloseTo(0, 9);
    expect(f.stock.min[1]).toBeCloseTo(0, 9);
    expect(f.part.max[2]).toBeCloseTo(-1, 9);
    const p: Vec3 = [5, 7, 3];
    const w = pointToWork(f, p);
    const back = toModel(f, w[0], w[1], w[2]);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(p[k], 9);
  });
});

describe('contours and levels', () => {
  it('traces a disc counter-clockwise with the inside on the left', () => {
    const g = gridOver(-10, -10, 10, 10, 0.25);
    const v = new Float64Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) v[j * g.nx + i] = 5 - Math.hypot(g.x0 + i * g.c, g.y0 + j * g.c);
    const ls = contours(g, v, 0);
    expect(ls).toHaveLength(1);
    expect(ls[0].closed).toBe(true);
    let a = 0;
    const p = ls[0].pts;
    for (let i = 0; i < p.length; i += 2) {
      expect(Math.hypot(p[i], p[i + 1])).toBeCloseTo(5, 1);
      const j = (i + 2) % p.length;
      a += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    expect(a).toBeGreaterThan(0);
    expect(simplify(p, 0.01, 2, true).length).toBeLessThan(p.length);
  });

  it('steps down to the bottom with extra levels', () => {
    expect(stepLevels(10, 0, 3)).toEqual([7, 4, 1, 0]);
    expect(stepLevels(10, 0, 3, [5])).toEqual([7, 5, 4, 1, 0]);
  });
});

// A 100 x 60 x 20 plate with a 40 x 20 pocket 10 deep.
const floorTris = Float32Array.from(box(30, 20, 9, 70, 40, 10).slice(0, 18));
const pocketPlate = mesh(box(0, 0, 0, 100, 60, 10), box(0, 0, 10, 30, 60, 20), box(70, 0, 10, 100, 60, 20), box(30, 0, 10, 70, 20, 20), box(30, 40, 10, 70, 60, 20));

describe('operations', () => {
  it('faces the stock down to the top of the part', () => {
    const t = tool('flat', 12);
    const s = setup();
    const part = placePart(s, pocketPlate)!;
    const tp = generateFor(part, { setup: s, op: op('face', t, { stepdown: 1 }), tool: t });
    const ms = moves(tp).filter((m) => m.k !== RAPID);
    expect(ms.length).toBeGreaterThan(0);
    expect(Math.min(...ms.map((m) => m.z))).toBeCloseTo(20, 9);
    expect(new Set(ms.map((m) => m.z.toFixed(3)))).toEqual(new Set(['21.000', '20.000']));
    // Passes start and end off the stock.
    const xs = ms.map((m) => m.x);
    expect(Math.min(...xs)).toBeLessThan(-5 - 6);
    expect(Math.max(...xs)).toBeGreaterThan(105 + 6);
  });

  it('cuts a contour round a box at the tool radius, with lead arcs outside', () => {
    const t = tool('flat', 6);
    const s = setup();
    const part = placePart(s, mesh(box(0, 0, 0, 40, 30, 10)))!;
    const tp = generateFor(part, { setup: s, op: op('contour', t, { stepdown: 4, lead: 1.5 }), tool: t });
    const ms = moves(tp).filter((m) => m.k !== RAPID && m.z < 10);
    expect(ms.length).toBeGreaterThan(10);
    // Never closer than the tool radius; the wall pass right at it.
    const d = ms.map((m) => rectDist(m.x, m.y, 0, 0, 40, 30));
    expect(Math.min(...d)).toBeGreaterThan(3 - 0.01);
    expect(d.filter((v) => Math.abs(v - 3) < 0.01).length).toBeGreaterThan(8);
    // Down to the breakthrough below the part.
    expect(Math.min(...ms.map((m) => m.z))).toBeCloseTo(-0.5, 6);
    // Climb milling: clockwise round the part (negative signed area of the wall pass).
    const wall = ms.filter((m) => Math.abs(m.z + 0.5) < 1e-6 && Math.abs(rectDist(m.x, m.y, 0, 0, 40, 30) - 3) < 0.01);
    let a = 0;
    for (let i = 0; i + 1 < wall.length; i++) a += wall[i].x * wall[i + 1].y - wall[i + 1].x * wall[i].y;
    expect(a).toBeLessThan(0);
  });

  it('leaves holding tabs in the last passes', () => {
    const t = tool('flat', 6);
    const s = setup({ stock: { mode: 'offset', side: 5, top: 0, bottom: 0, size: [0, 0, 0] } });
    const part = placePart(s, mesh(box(0, 0, 0, 40, 30, 10)))!;
    const tp = generateFor(part, { setup: s, op: op('contour', t, { stepdown: 5, breakthrough: 0, tabs: { count: 4, width: 4, height: 2 } }), tool: t });
    const low = moves(tp).filter((m) => m.k !== RAPID && Math.abs(m.z - 2) < 1e-6);
    expect(low.length).toBeGreaterThan(4);
  });

  it('clears a pocket to its floor without touching the walls', () => {
    const t = tool('flat', 6);
    const s = setup();
    const part = placePart(s, pocketPlate)!;
    for (const pattern of ['offset', 'zigzag'] as const) {
      const tp = generateFor(part, { setup: s, op: op('pocket', t, { stepdown: 4, pattern }), tool: t, floors: [floorTris] });
      const cut = moves(tp).filter((m) => m.k !== RAPID && m.z < 20);
      expect(cut.length).toBeGreaterThan(20);
      for (const m of cut) {
        expect(m.x).toBeGreaterThan(33 - 0.01);
        expect(m.x).toBeLessThan(67 + 0.01);
        expect(m.y).toBeGreaterThan(23 - 0.01);
        expect(m.y).toBeLessThan(37 + 0.01);
      }
      expect(Math.min(...cut.map((m) => m.z))).toBeCloseTo(10, 6);
      const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: tp, tool: t, feed: 1000, plunge: 300 }], rapidFeed: 5000, cell: 0.25 });
      expect(sim.gouges).toBe(0);
      expect(sim.rapidCuts[0]).toBe(0);
      // The pocket is cleared to its floor.
      const g = sim.grid;
      const last = sim.snapshots[sim.snapshots.length - 1].z;
      const at = (x: number, y: number) => last[Math.round((y - g.y0) / g.c) * g.nx + Math.round((x - g.x0) / g.c)];
      expect(at(50, 30)).toBeCloseTo(10, 1);
      expect(at(36, 26)).toBeCloseTo(10, 1);
    }
  }, 60_000);

  it('keeps clearing stepovers to what the tool can cut', () => {
    const t = tool('flat', 6);
    const s = setup();
    const part = placePart(s, pocketPlate)!;
    const leftOver = (tp: Toolpath, x0: number, y0: number, x1: number, y1: number) => {
      const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: tp, tool: t, feed: 1000, plunge: 300 }], rapidFeed: 5000, cell: 0.25 });
      expect(sim.gouges).toBe(0);
      const g = sim.grid;
      const last = sim.snapshots[sim.snapshots.length - 1].z;
      let top = -Infinity;
      for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
        const x = g.x0 + i * g.c, y = g.y0 + j * g.c;
        if (x > x0 && x < x1 && y > y0 && y < y1) top = Math.max(top, last[j * g.nx + i]);
      }
      return top;
    };
    // Wider than the tool: passes 15 mm apart would leave strips of stock standing.
    const face = generateFor(part, { setup: s, op: op('face', t, { stepover: 15, stepdown: 2 }), tool: t });
    expect(face.warnings.some((w) => /stepover is too wide/.test(w))).toBe(true);
    expect(leftOver(face, 2, 2, 28, 58)).toBeCloseTo(20, 6);
    // Offset passes leave posts in their corners well before the tool's diameter.
    const pocket = generateFor(part, { setup: s, op: op('pocket', t, { stepover: 5.9, stepdown: 5 }), tool: t, floors: [floorTris] });
    expect(leftOver(pocket, 31, 21, 69, 39)).toBeCloseTo(10, 6);
    // None or less: finishes (zigzag passes never did).
    for (const pattern of ['offset', 'zigzag'] as const) {
      const rough = generateFor(placePart(s, mesh(box(0, 0, 0, 30, 20, 8)))!, { setup: s, op: op('rough', t, { stepover: 0, pattern }), tool: t });
      expect(rough.moves.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('roughs round the part leaving the allowance, without gouging', () => {
    const t = tool('flat', 6);
    const s = setup();
    const part = placePart(s, mesh(box(0, 0, 0, 30, 20, 8), box(10, 5, 8, 20, 15, 14)))!;
    const tp = generateFor(part, { setup: s, op: op('rough', t, { stepdown: 2, leave: 0.3, floorLeave: 0.2 }), tool: t });
    const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: tp, tool: t, feed: 1000, plunge: 300 }], rapidFeed: 5000, cell: 0.25 });
    expect(sim.gouges).toBe(0);
    expect(sim.rapidCuts[0]).toBe(0);
    expect(sim.removed).toBeGreaterThan(0);
    // The step at z = 8 is left with the floor allowance.
    const g = sim.grid;
    const last = sim.snapshots[sim.snapshots.length - 1].z;
    const at = (x: number, y: number) => last[Math.round((y - g.y0) / g.c) * g.nx + Math.round((x - g.x0) / g.c)];
    expect(at(5, 10)).toBeCloseTo(8.2, 1);
    expect(at(15, 10)).toBeCloseTo(14.2, 1);
  }, 60_000);

  it('finishes with parallel passes and waterlines that stay on the surface', () => {
    const ball = tool('ball', 4);
    const s = setup({ stock: { mode: 'offset', side: 2, top: 0.5, bottom: 0, size: [0, 0, 0] } });
    // A ridge: two sloped planes.
    const ridge = Float32Array.from([0, 0, 0, 20, 0, 10, 20, 30, 10, 0, 0, 0, 20, 30, 10, 0, 30, 0, 20, 0, 10, 40, 0, 0, 40, 30, 0, 20, 0, 10, 40, 30, 0, 20, 30, 10]);
    const part = placePart(s, ridge)!;
    const par = generateFor(part, { setup: s, op: op('parallel', ball, { stepover: 0.5, angle: 0, boundary: 'silhouette' }), tool: ball });
    const dc = new DropCutter(part.index, cutterOf(ball));
    for (const m of moves(par)) if (m.k !== RAPID) expect(m.z).toBeGreaterThan(dc.drop(m.x, m.y) - 0.02);
    const wl = generateFor(part, { setup: s, op: op('waterline', ball, { stepdown: 1 }), tool: ball });
    const w = moves(wl).filter((m) => m.k === FEED);
    expect(w.length).toBeGreaterThan(10);
    for (const m of w) expect(m.z).toBeGreaterThan(dc.drop(m.x, m.y) - 0.02);
  }, 60_000);

  it('drills and bores the holes picked, by their cylinders', () => {
    const drill = tool('drill', 5, { tipAngle: 118 });
    const s = setup();
    const part = placePart(s, mesh(box(0, 0, 0, 40, 40, 10)))!;
    // A through hole's wall as a cylinder of triangles (the plate itself has no hole: the
    // check that its centre is empty is answered by the hole's own triangles only).
    const wall: number[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
      const p = (t: number, z: number) => [20 + 2.5 * Math.cos(t), 20 + 2.5 * Math.sin(t), z];
      wall.push(...p(a, 0), ...p(b, 0), ...p(b, 10), ...p(a, 0), ...p(b, 10), ...p(a, 10));
    }
    const holed = placePart(s, mesh(box(0, 0, 0, 40, 17.5, 10), box(0, 22.5, 0, 40, 40, 10), box(0, 17.5, 0, 17.5, 22.5, 10), box(22.5, 17.5, 0, 40, 22.5, 10)))!;
    const cyl = [{ name: 'F1', p: [20, 20, 0] as Vec3, d: [0, 0, 1] as Vec3, radius: 2.5, tris: Float32Array.from(wall) }];
    const tp = generateFor(holed, { setup: s, op: op('drill', drill, { cycle: 'peck', peck: 2 }), tool: drill, cylinders: cyl });
    const cycle = [...tp.moves].findIndex((v, i) => i % 4 === 0 && v === CYCLE);
    expect(cycle).toBeGreaterThanOrEqual(0);
    expect(tp.moves[cycle + 1]).toBeCloseTo(20, 6);
    expect(tp.cycles[0].z).toBeLessThan(-1);
    expect(tp.cycles[0].r).toBeCloseTo(15, 6);
    // Bore it with a 3 mm end mill.
    const em = tool('flat', 3);
    const big = [{ ...cyl[0], radius: 2.5 }];
    const bore = generateFor(holed, { setup: s, op: op('bore', em, { pitch: 1 }), tool: em, cylinders: big, picked: ['F1'] });
    const helix = moves(bore).filter((m) => m.k === PLUNGE);
    expect(helix.length).toBeGreaterThan(20);
    for (const m of helix) expect(Math.hypot(m.x - 20, m.y - 20)).toBeCloseTo(1, 6);
    void part;
  });

  it('bores a blind hole wider than two tools without leaving a core in it', () => {
    const em = tool('flat', 3);
    const s = setup({ stock: { mode: 'offset', side: 5, top: 0, bottom: 0, size: [0, 0, 0] } });
    // A 12 mm hole 6 deep in a 40 x 40 x 10 plate (its wall a cylinder of triangles).
    const wall: number[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2, b = ((i + 1) / 48) * Math.PI * 2;
      const p = (t: number, z: number) => [20 + 6 * Math.cos(t), 20 + 6 * Math.sin(t), z];
      wall.push(...p(a, 4), ...p(b, 4), ...p(b, 10), ...p(a, 4), ...p(b, 10), ...p(a, 10));
    }
    const part = placePart(s, mesh(box(0, 0, 0, 40, 40, 4), box(0, 0, 4, 40, 14, 10), box(0, 26, 4, 40, 40, 10), box(0, 14, 4, 14, 26, 10), box(26, 14, 4, 40, 26, 10)))!;
    const cyl = [{ name: 'F1', p: [20, 20, 0] as Vec3, d: [0, 0, 1] as Vec3, radius: 6, tris: Float32Array.from(wall) }];
    const tp = generateFor(part, { setup: s, op: op('bore', em, { pitch: 1 }), tool: em, cylinders: cyl, picked: ['F1'] });
    expect(tp.warnings.filter((w) => /cuts into/.test(w))).toEqual([]);
    const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: tp, tool: em, feed: 1000, plunge: 300 }], rapidFeed: 5000, cell: 0.1 });
    expect(sim.gouges).toBe(0);
    expect(sim.rapidCuts[0]).toBe(0);
    // Down to the floor everywhere in the hole: a helix at the wall alone leaves a 6 mm core.
    const g = sim.grid;
    const last = sim.snapshots[sim.snapshots.length - 1].z;
    let top = -Infinity;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      if (Math.hypot(g.x0 + i * g.c - 20, g.y0 + j * g.c - 20) < 5.8) top = Math.max(top, last[j * g.nx + i]);
    }
    expect(top).toBeLessThan(4.05);
  });
});

describe('simulation and G-code', () => {
  it('reports a rapid move into the stock', () => {
    const t = tool('flat', 6);
    const s = setup();
    const part = placePart(s, mesh(box(0, 0, 0, 20, 20, 10)))!;
    const tp: Toolpath = { moves: Float64Array.from([RAPID, -10, 10, 30, RAPID, -10, 10, 11, RAPID, 30, 10, 11]), cycles: [], clearance: 22, warnings: [] };
    const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: tp, tool: t, feed: 1000, plunge: 300 }], rapidFeed: 5000 });
    expect(sim.rapidCuts[0]).toBeGreaterThan(0);
    expect(sim.time).toBeGreaterThan(0);
  });

  it('writes arcs for points on a circle', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 20; i++) { const a = (i / 20) * Math.PI * 0.8; pts.push(10 * Math.cos(a), 10 * Math.sin(a), -i * 0.05); }
    const arcs: unknown[] = [];
    let lines = 0;
    writeArcs(pts, 0.005, () => lines++, (...a) => arcs.push(a));
    expect(arcs).toHaveLength(1);
    expect(lines).toBe(0);
    expect((arcs[0] as [boolean])[0]).toBe(false);
  });

  it('posts G-code with tool changes, arcs and canned cycles, per controller', () => {
    const t = tool('flat', 6);
    const d = tool('drill', 5, { number: 2, name: '5 mm drill' });
    const s = setup();
    const part = placePart(s, pocketPlate)!;
    const pocket = generateFor(part, { setup: s, op: op('pocket', t, { stepdown: 5 }), tool: t, floors: [floorTris] });
    const drill: Toolpath = { moves: Float64Array.from([RAPID, 10, 10, 32, CYCLE, 10, 10, 0, CYCLE, 20, 10, 1]), cycles: [{ cycle: 'peck', r: 23, z: 0, peck: 2, dwell: 0 }, { cycle: 'peck', r: 23, z: 0, peck: 2, dwell: 0 }], clearance: 32, warnings: [] };
    const job = (controller: 'fanuc' | 'grbl' | 'linuxcnc') => ({
      name: 'Plate (test)', units: 'mm' as const,
      post: { ...newCamDoc(() => 'x').post, controller },
      setups: [{ name: 'Setup1', workOffset: 54, ops: [
        { name: 'Pocket1', tool: t, rpm: 9000, feed: 800, plunge: 200, toolpath: pocket },
        { name: 'Drill1', tool: d, rpm: 2000, feed: 200, plunge: 150, toolpath: drill },
      ] }],
    });
    const fanuc = postProcess(job('fanuc'));
    expect(fanuc.startsWith('%\nO1001 (Plate test)')).toBe(true);
    expect(fanuc).toContain('G21');
    expect(fanuc).toContain('T1 M6');
    expect(fanuc).toContain('T2 M6');
    expect(fanuc).toMatch(/G43 Z\S+ H1/);
    expect(fanuc).toMatch(/\nG[23] X/);
    expect(fanuc).toMatch(/G98 G83 X10\. Y10\. Z0\. R23\. Q2\. F150/);
    expect(fanuc).toContain('\nX20. Y10.\n');
    expect(fanuc.trimEnd().endsWith('M30\n%')).toBe(true);
    const grbl = postProcess(job('grbl'));
    expect(grbl).not.toMatch(/M6|G43|G83|^%/m);
    expect(grbl).toContain('M0');
    const linux = postProcess(job('linuxcnc'));
    expect(linux).not.toMatch(/^O\d/m);
    expect(linux).toContain('M2');
    // Inches: values divided by 25.4.
    const inch = postProcess({ ...job('fanuc'), units: 'in' });
    expect(inch).toContain('G20');
    expect(inch).toContain('R0.9055');
    const st = pathStats(pocket, 800, 200, 5000);
    expect(st.time).toBeGreaterThan(0);
    expect(st.zMin).toBeCloseTo(10, 6);
  }, 60_000);

  it('saves CAM data with the part and opens it again, without id clashes', () => {
    const doc = newDocument('Plate');
    doc.cam = newCamDoc((p) => allocateId(doc, p));
    doc.cam.setups.push({ ...setup({ id: allocateId(doc, 's') }), ops: [{ ...op('face', doc.cam.tools[0]), id: allocateId(doc, 'op') }] });
    const back = parseDocument(serializeDocument({ ...doc, nextId: 1 }));
    expect(back.cam).toEqual(doc.cam);
    // A stale counter is moved past the CAM ids.
    const used = new Set([...back.cam!.tools.map((t) => t.id), back.cam!.setups[0].id, back.cam!.setups[0].ops[0].id]);
    for (let i = 0; i < 5; i++) expect(used.has(allocateId(back, 't'))).toBe(false);
  });

  it('reads CAM data back and drops what is damaged', () => {
    const doc = newCamDoc((p) => `${p}9`);
    const raw = JSON.parse(JSON.stringify({ ...doc, tools: [...doc.tools.slice(0, 1), { id: 'bad', type: 'laser' }], setups: [{ id: 's1', name: 'S', axis: '+Q', ops: [{ id: 'o1', name: 'P', type: 'pocket', tool: doc.tools[0].id, faces: 'nope' }, { id: 'o2', name: 'F', type: 'face', tool: doc.tools[0].id }] }] }));
    const n = normalizeCam(raw)!;
    expect(n.tools).toHaveLength(1);
    expect(n.setups[0].axis).toBe('+Y');
    expect(n.setups[0].ops.map((o) => o.id)).toEqual(['o2']);
    expect((n.setups[0].ops[0] as { stepover: number }).stepover).toBeGreaterThan(0);
    expect(normalizeCam('x')).toBeNull();
  });
});
