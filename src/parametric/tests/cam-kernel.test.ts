// CAM on parts built by the real OpenCascade kernel: every kind of operation
// on the example parts, simulated together, without gouges or rapid moves
// through the stock, and the holes found and drilled.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { bracketExample, flangeExample } from '../src/app/examples';
import { type ModelCylinder, generateFor, placePart, stlTriangles } from '../src/cam/engine';
import { simulate } from '../src/cam/simulate';
import { CYCLE } from '../src/cam/toolpath';
import { postProcess } from '../src/cam/post';
import { type CamOperation, type CamSetup, type CamTool, newCamDoc, opDefaults } from '../src/model/cam';
import type { PartDocument } from '../src/model/types';
import { req } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

async function build(doc: PartDocument) {
  const b = new ModelBuilder();
  const res = await b.build(req(doc.features, { quality: 1 }));
  expect(res.status.every((s) => s.ok)).toBe(true);
  const tris = stlTriangles(b.exportStl(2));
  // The hole candidates, as the interface collects them from the shown mesh.
  const m = res.mesh!;
  const cylinders: ModelCylinder[] = res.faces.flatMap((f, i) => {
    if (f.type !== 'cylinder' || !f.axis || !f.radius) return [];
    const t: number[] = [];
    for (let k = 0; k < m.indices.length; k += 3) {
      if (Math.round(m.vertexFace[m.indices[k]]) !== i) continue;
      for (let q = 0; q < 3; q++) { const v = m.indices[k + q] * 3; t.push(m.positions[v], m.positions[v + 1], m.positions[v + 2]); }
    }
    return [{ name: f.name, p: f.axis.p, d: f.axis.d, radius: f.radius, tris: Float32Array.from(t) }];
  });
  return { tris, cylinders, faces: res.faces };
}

const setup = (extra: Partial<CamSetup> = {}): CamSetup => ({
  id: 's', name: 'Setup1', axis: '+Y', rotation: 0, origin: 'topCenter',
  stock: { mode: 'offset', side: 2, top: 1, bottom: 2, size: [0, 0, 0] }, clearance: 10, retract: 3, workOffset: 54, ops: [], ...extra,
});

const opOf = (type: CamOperation['type'], tool: CamTool, extra: Record<string, unknown> = {}) =>
  ({ id: type, name: type, type, tool: tool.id, ...opDefaults(type, tool.diameter), ...extra }) as CamOperation;

describe('CAM on kernel parts', () => {
  it('machines the flange: face, rough, finish, drill and contour without gouges', async () => {
    const { tris, cylinders } = await build(flangeExample());
    const s = setup();
    const part = placePart(s, tris)!;
    const cam = newCamDoc((p) => `${p}x`);
    const em12 = cam.tools[0], em6 = cam.tools[1], ball6 = cam.tools[3];
    const drill7: CamTool = { ...cam.tools[6], diameter: 7, name: '7 mm drill' };
    const steps = [];
    for (const [type, tool, extra] of [
      ['face', em12, {}], ['rough', em6, {}], ['waterline', ball6, { stepdown: 1 }], ['parallel', ball6, { stepover: 1 }],
      ['drill', drill7, {}], ['contour', em6, {}],
    ] as const) {
      const tp = generateFor(part, { setup: s, op: opOf(type, tool, extra), tool, cylinders });
      expect(tp.warnings.filter((w) => /cuts into/.test(w)), type).toEqual([]);
      expect(tp.moves.length, type).toBeGreaterThan(0);
      steps.push({ toolpath: tp, tool, feed: tool.feed, plunge: tool.plunge });
    }
    // The six bolt holes, drilled through.
    const drill = steps[4].toolpath;
    expect(drill.cycles).toHaveLength(6);
    expect([...drill.moves].filter((v, i) => i % 4 === 0 && v === CYCLE)).toHaveLength(6);
    for (const c of drill.cycles) expect(c.z).toBeLessThan(part.frame.part.min[2]);
    const sim = simulate({ stock: part.frame.stock, part: part.index, steps, rapidFeed: 5000 });
    expect(sim.gouges).toBe(0);
    expect(sim.rapidCuts).toEqual([0, 0, 0, 0, 0, 0]);
    expect(sim.removed).toBeGreaterThan(0);
    // G-code for the whole program.
    const code = postProcess({
      name: 'Pipe Flange', units: 'mm', post: cam.post,
      setups: [{ name: 'Setup1', workOffset: 54, ops: steps.map((st, i) => ({ name: `Op${i + 1}`, tool: st.tool, rpm: st.tool.rpm, feed: st.feed, plunge: st.plunge, toolpath: st.toolpath })) }],
    });
    expect(code).toContain('G83');
    expect(code).toMatch(/\nG[23] /);
    expect(code.split('\n').length).toBeGreaterThan(1000);
  }, 240_000);

  it('machines the bracket from the top, then its other side in a second setup', async () => {
    const { tris, cylinders } = await build(bracketExample());
    const cam = newCamDoc((p) => `${p}x`);
    const em6 = cam.tools[1];
    for (const s of [setup(), setup({ axis: '-Y', origin: 'topFrontLeft' }), setup({ axis: '+Z', rotation: 90 })]) {
      const part = placePart(s, tris)!;
      const steps = [];
      for (const type of ['rough', 'contour'] as const) {
        const tp = generateFor(part, { setup: s, op: opOf(type, em6), tool: em6, cylinders });
        expect(tp.warnings.filter((w) => /cuts into/.test(w)), `${s.axis} ${type}`).toEqual([]);
        steps.push({ toolpath: tp, tool: em6, feed: em6.feed, plunge: em6.plunge });
      }
      const sim = simulate({ stock: part.frame.stock, part: part.index, steps, rapidFeed: 5000 });
      expect(sim.gouges, s.axis).toBe(0);
      expect(sim.rapidCuts, s.axis).toEqual([0, 0]);
    }
  }, 240_000);

  it('pockets a picked floor and bores the counterbores of the bracket', async () => {
    const { tris, cylinders, faces } = await build(bracketExample());
    const s = setup({ origin: 'topFrontLeft' });
    const part = placePart(s, tris)!;
    const cam = newCamDoc((p) => `${p}x`);
    const em3 = cam.tools[2];
    // The counterbores (11 mm) are larger than a 3 mm end mill; the 6 mm holes too.
    const cb = faces.filter((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 5.5) < 1e-6).map((f) => f.name);
    expect(cb.length).toBeGreaterThanOrEqual(2);
    const bore = generateFor(part, { setup: s, op: opOf('bore', em3, { holes: cb.map((name) => ({ face: { name, sig: { type: 'cylinder', c: [0, 0, 0], area: 0 } } })) }), tool: em3, cylinders, picked: cb });
    expect(bore.warnings.filter((w) => /cuts into/.test(w))).toEqual([]);
    const sim = simulate({ stock: part.frame.stock, part: part.index, steps: [{ toolpath: bore, tool: em3, feed: em3.feed, plunge: em3.plunge }], rapidFeed: 5000 });
    expect(sim.gouges).toBe(0);
    expect(sim.removed).toBeGreaterThan(2 * Math.PI * 5.5 * 5.5 * 3 * 0.8);
  }, 240_000);
});
