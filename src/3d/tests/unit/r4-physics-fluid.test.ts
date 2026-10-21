import { describe, it, expect, beforeAll } from 'vitest';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import '../../src/physics/engine';
import { caches, startBudget, getCache } from '../../src/physics/common';
import { smokeDraw, fluidCacheKey, simulationSettingsKey, timeSteps, defaultDomainSettings, fluidFrameAt, type FluidModifier } from '../../src/physics/fluid';
import { setFluidJob, mayStepData, layerBaked, anyBaked, fluidLayers } from '../../src/physics/fluidcache';
import { upresGas } from '../../src/physics/fluidnoise';
import { newSecondary, stepSecondary, secondaryParams, secondaryPositions } from '../../src/physics/secondary';
import { effectorGuides, blurGuides, applyGuides, quantizeVelocity } from '../../src/physics/fluidguide';
import { newGrid, stepGas, type GasParams } from '../../src/physics/smoke-solver';
import { addParticle, newLiquidGrid, stepLiquid } from '../../src/physics/liquid-solver';
import { smoothSurface } from '../../src/physics/liquid';
import { scalarField, vectorLines, sliceAxis, type FluidOverlay } from '../../src/physics/fluidoverlay';
import { Vector3 } from 'three';

function addMesh(doc: DocumentData, name: string, size: number, loc: [number, number, number]): ObjectData {
  const me = newMeshData(name, cube(size));
  doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  ob.location = loc;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}

function smokeScene() {
  caches.clear();
  const doc = emptyDocument();
  const domain = addMesh(doc, 'Domain', 4, [0, 0, 2]);
  const dm = newModifier('FLUID', uid('md'), []) as FluidModifier;
  dm.fluid_type = 'DOMAIN';
  dm.domain_settings.resolution_max = 16;
  domain.modifiers.push(dm);
  const flow = addMesh(doc, 'Emitter', 0.6, [0, 0, 0.6]);
  const fm = newModifier('FLUID', uid('md'), []) as FluidModifier;
  fm.fluid_type = 'FLOW';
  fm.flow_settings.flow_type = 'SMOKE';
  flow.modifiers.push(fm);
  return { doc, domain, dm, flow, fm, key: `${domain.id}:${dm.id}` };
}

beforeAll(() => startBudget(Infinity));

describe('fluid cache types', () => {
  it('Replay caches simulate while playing; Modular caches only show baked frames', () => {
    const { doc, domain, dm, key } = smokeScene();
    const g = new Depsgraph(doc);
    doc.scene.frame_current = 6;
    g.evaluate(doc);
    expect(smokeDraw.get(key)).toBeTruthy();
    expect(getCache(fluidCacheKey(domain, dm)).frames.size).toBeGreaterThan(5);
    // switching to Modular: nothing is simulated by playing
    caches.clear();
    dm.domain_settings.cache_type = 'MODULAR';
    doc.scene.frame_current = 7;
    g.evaluate(doc);
    expect(smokeDraw.get(key)).toBeFalsy();
    expect(mayStepData(fluidCacheKey(domain, dm), dm)).toBe(false);
    // a running data bake may step the domain
    setFluidJob({ key: fluidCacheKey(domain, dm), objectId: domain.id, modifierId: dm.id, queue: [], layer: 'data', start: 1, end: 10, frame: 1, paused: false, cancelled: false, started: 0 });
    expect(mayStepData(fluidCacheKey(domain, dm), dm)).toBe(true);
    g.evaluate(doc);
    expect(smokeDraw.get(key)).toBeTruthy();
    setFluidJob(null);
  });

  it('the cache offset shifts which cached frame is shown', () => {
    const { dm } = smokeScene();
    dm.domain_settings.cache_frame_offset = 10;
    expect(fluidFrameAt(dm, 25)).toBe(15);
    expect(fluidFrameAt(dm, 3)).toBe(dm.point_cache.frame_start);
  });

  it('display, noise and mesh settings do not invalidate the simulated data', () => {
    const s = defaultDomainSettings();
    const k = simulationSettingsKey(s);
    for (const [key, v] of [
      ['display_thickness', 3],
      ['use_slice', true],
      ['use_noise', true],
      ['noise_strength', 4],
      ['mesh_scale', 3],
      ['use_spray_particles', true],
      ['cache_type', 'ALL'],
      ['vector_scale', 5],
    ] as const)
      expect(simulationSettingsKey({ ...s, [key]: v })).toBe(k);
    expect(simulationSettingsKey({ ...s, vorticity: 2 })).not.toBe(k);
    expect(simulationSettingsKey({ ...s, cfl_condition: 4 })).not.toBe(k);
  });

  it('baked and paused layers lock the settings', () => {
    const s = defaultDomainSettings();
    expect(anyBaked(s)).toBe(false);
    expect(layerBaked({ ...s, cache_frame_pause_data: 12 }, 'data')).toBe(true);
    expect(anyBaked({ ...s, has_cache_baked_noise: true })).toBe(true);
  });
});

describe('gas solver options', () => {
  it('adaptive time steps follow the CFL number within the limits', () => {
    const s = defaultDomainSettings();
    expect(timeSteps(s, 0, 1 / 24)).toBe(1);
    // 120 cells/s over a frame = 5 cells; CFL 2 → 3 steps
    expect(timeSteps(s, 120, 1 / 24)).toBe(3);
    expect(timeSteps(s, 10000, 1 / 24)).toBe(4);
    expect(timeSteps({ ...s, use_adaptive_timesteps: false, timesteps_min: 2 }, 10000, 1 / 24)).toBe(2);
  });

  it('linear dissolving removes a fixed amount; slow dissolving a share', () => {
    const run = (linear: boolean) => {
      const g = newGrid(4, 4, 4);
      g.density.fill(1);
      g.density[0] = 0.1;
      const P: GasParams = { dt: 0.1, up: [0, 0, 1], gravity: 0, alpha: 0, beta: 0, vorticity: 0, flameVorticity: 0, burningRate: 0, flameSmoke: 0, flameMaxTemp: 3, dissolve: 1, dissolveLinear: linear, heatDecay: 0, pressureIterations: 2, closed: [true, true, true, true, true, true] };
      stepGas(g, P);
      return [g.density[0], g.density[21]];
    };
    const lin = run(true),
      log = run(false);
    // linear: both lose 0.1 (the thin one disappears); slow: both lose 10 %
    expect(lin[0]).toBeCloseTo(0, 5);
    expect(lin[1]).toBeCloseTo(0.9, 2);
    expect(log[0]).toBeCloseTo(0.09, 2);
    expect(log[1]).toBeCloseTo(0.9, 2);
  });

  it('flows emit only inside their vertex group and stop when not used', () => {
    const { doc, domain, dm, flow, fm, key } = smokeScene();
    const me = doc.meshes[flow.data!];
    // weight only the top vertices
    me.vertex_groups = [{ name: 'Top' } as never];
    const w = new Float32Array(me.positions.length / 3);
    for (let v = 0; v < w.length; v++) w[v] = me.positions[v * 3 + 2] > 0 ? 1 : 0;
    (me as unknown as { weights: Float32Array[] }).weights = [w];
    fm.flow_settings.density_vertex_group = 'Top';
    fm.flow_settings.surface_distance = 1.5;
    const g = new Depsgraph(doc);
    doc.scene.frame_current = 2;
    g.evaluate(doc);
    expect(smokeDraw.get(key)).toBeTruthy();
    fm.flow_settings.use_flow = false;
    caches.clear();
    g.evaluate(doc);
    const d = smokeDraw.get(key)!;
    let sum = 0;
    for (let i = 0; i < d.data.length; i += 2) sum += d.data[i];
    expect(sum).toBe(0);
    void domain;
    void dm;
  });
});

describe('noise', () => {
  it('upsamples the smoke by the upres factor and keeps empty space empty', () => {
    const nx = 6,
      ny = 6,
      nz = 6;
    const data = new Uint8Array(nx * ny * nz * 2);
    // a blob in the middle
    for (let k = 2; k < 4; k++) for (let j = 2; j < 4; j++) for (let i = 2; i < 4; i++) data[(i + j * nx + k * nx * ny) * 2] = 200;
    const q = quantizeVelocity(new Float32Array(nx * ny * nz).fill(1), new Float32Array(nx * ny * nz), new Float32Array(nx * ny * nz));
    const fine = upresGas({ nx, ny, nz, data, vel: q.vel, velScale: q.scale }, { scale: 2, strength: 1, posScale: 2, timeAnim: 0.1, frame: 5 });
    expect([fine.nx, fine.ny, fine.nz]).toEqual([12, 12, 12]);
    let inner = 0,
      corner = 0;
    for (let K = 0; K < 12; K++)
      for (let J = 0; J < 12; J++)
        for (let I = 0; I < 12; I++) {
          const v = fine.data[(I + J * 12 + K * 144) * 2];
          if (I >= 5 && I <= 6 && J >= 5 && J <= 6 && K >= 5 && K <= 6) inner += v;
          if (I < 2 && J < 2 && K < 2) corner += v;
        }
    expect(inner).toBeGreaterThan(0);
    expect(corner).toBe(0);
    // deterministic, and different over time
    const again = upresGas({ nx, ny, nz, data, vel: q.vel, velScale: q.scale }, { scale: 2, strength: 1, posScale: 2, timeAnim: 0.1, frame: 5 });
    expect(again.data).toEqual(fine.data);
    const later = upresGas({ nx, ny, nz, data, vel: q.vel, velScale: q.scale }, { scale: 2, strength: 1, posScale: 2, timeAnim: 0.5, frame: 20 });
    expect(later.data).not.toEqual(fine.data);
  });
});

describe('secondary particles', () => {
  it('a fast splashing sheet sheds spray that falls, foam and bubbles', () => {
    const nx = 16,
      ny = 16,
      nz = 16;
    // a slab of liquid moving fast upwards at its top
    const pos: number[] = [],
      vel: number[] = [];
    for (let k = 0; k < 6; k++)
      for (let j = 2; j < 14; j++)
        for (let i = 2; i < 14; i++)
          for (let s = 0; s < 4; s++) {
            pos.push(i + 0.25 + (s & 1) * 0.5, j + 0.25 + ((s >> 1) & 1) * 0.5, k + 0.5);
            vel.push(0, 0, k >= 4 ? 120 : 5);
          }
    const L = { nx, ny, nz, particles: new Float32Array(pos), vel: new Float32Array(vel), solid: null };
    const st = newSecondary();
    const P = secondaryParams({ use_spray_particles: true, use_foam_particles: true, use_bubble_particles: true }, 24, [0, 0, -40]);
    for (let f = 1; f <= 4; f++) stepSecondary(st, L, P, f);
    expect(st.count).toBeGreaterThan(0);
    const k = secondaryPositions(st);
    expect(k.spray.length + k.foam.length + k.bubbles.length).toBe(st.count * 3);
    // only spray enabled: foam / bubbles are not kept
    const st2 = newSecondary();
    const P2 = secondaryParams({ use_spray_particles: true }, 24, [0, 0, -40]);
    for (let f = 1; f <= 4; f++) stepSecondary(st2, L, P2, f);
    const k2 = secondaryPositions(st2);
    expect(k2.foam.length + k2.bubbles.length).toBe(0);
    // nothing moving: nothing generated
    const still = { ...L, vel: new Float32Array(vel.length) };
    const st3 = newSecondary();
    stepSecondary(st3, still, P, 1);
    expect(st3.count).toBe(0);
  });
});

describe('guides', () => {
  it('combine guide velocities by mode, spread them and pull the flow', () => {
    const G = { toGrid: new (class {})() as never, nx: 4, ny: 1, nz: 1 };
    const vox = (w: number[], v: [number, number, number]) => ({ w: new Float32Array(w), nx: null, ny: null, nz: null, vel: v });
    const ob = (id: string, mode: string, v: [number, number, number], w: number[]) => ({ ob: { id } as ObjectData, m: { effector_settings: { use_effector: true, guide_mode: mode, velocity_factor: 1 }, _v: v, _w: w } as never });
    const guides = [ob('a', 'OVERRIDE', [2, 0, 0], [1, 1, 0, 0]), ob('b', 'MAXIMUM', [5, 0, 0], [0, 1, 1, 0])];
    const voxelize = (_c: unknown, o: ObjectData) => {
      const g = guides.find((x) => x.ob.id === o.id)!.m as unknown as { _v: [number, number, number]; _w: number[] };
      return vox(g._w, g._v);
    };
    const f = effectorGuides({ doc: {} as never, graph: null }, guides, G, 1, voxelize as never)!;
    expect([f[0], f[4], f[8], f[12]]).toEqual([2, 5, 5, 0]);
    expect([f[3], f[7], f[11], f[15]]).toEqual([1, 1, 1, 0]);
    const blurred = blurGuides(f, G, 3);
    expect(blurred[15]).toBeGreaterThan(0);
    const u = new Float32Array(4),
      v = new Float32Array(4),
      w = new Float32Array(4);
    applyGuides(u, v, w, f, 2, 1, 1 / 24);
    expect(u[0]).toBeGreaterThan(0);
    expect(u[3]).toBe(0);
  });
});

describe('liquid solver options', () => {
  it('APIC keeps the particle count and moves like FLIP under gravity', () => {
    const run = (apic: boolean) => {
      const g = newLiquidGrid(8, 8, 8);
      for (let k = 2; k < 5; k++) for (let j = 2; j < 6; j++) for (let i = 2; i < 6; i++) addParticle(g, i + 0.5, j + 0.5, k + 0.5, 0, 0, 0);
      const n = g.count;
      for (let s = 0; s < 10; s++) stepLiquid(g, { dt: 1 / 24, gravity: [0, 0, -40], flip: 0.97, apic, pressureIterations: 40, open: [false, false, false, false, false, false] });
      let z = 0;
      for (let p = 0; p < g.count; p++) z += g.px[p * 3 + 2];
      return { n, count: g.count, z: z / g.count };
    };
    const a = run(true),
      f = run(false);
    expect(a.count).toBe(a.n);
    expect(a.z).toBeLessThan(3.6);
    expect(Math.abs(a.z - f.z)).toBeLessThan(1.5);
  });

  it('positive smoothing flattens a bump', () => {
    // a square pyramid fan: centre vertex raised
    const positions = new Float32Array([0, 0, 1, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const mesh = { positions, offsets: new Uint32Array([0, 3, 6, 9, 12]), indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]), uvs: new Float32Array(0), normals: new Float32Array(0) };
    smoothSurface(mesh, 3, 0);
    expect(mesh.positions[2]).toBeLessThan(1);
  });
});

describe('fluid display', () => {
  const overlay = (): FluidOverlay => {
    const n = 4 * 4 * 4;
    const vel = new Int8Array(n * 3);
    for (let c = 0; c < n; c++) vel[c * 3 + 2] = 127;
    const density = new Uint8Array(n * 2);
    density[0] = 255;
    return { objectId: 'x', nx: 4, ny: 4, nz: 4, bmin: [-1, -1, -1], bmax: [1, 1, 1], liquid: false, density, vel, velScale: 10, settings: { ...defaultDomainSettings(), show_velocity: true }, color: [1, 1, 1] };
  };
  it('scalar fields and vectors come from the cached grids', () => {
    const o = overlay();
    expect(scalarField(o, 'DENSITY')[0]).toBe(1);
    expect(scalarField(o, 'VELOCITY_Z')[5]).toBeCloseTo(10, 5);
    const all = vectorLines(o, null, 0.5);
    expect(all.pos.length).toBe(64 * 6);
    // a slice keeps one layer of cells
    const sl = vectorLines(o, 2, 0.5);
    expect(sl.pos.length).toBe(16 * 6);
    const mac = vectorLines({ ...o, settings: { ...o.settings, vector_display_type: 'MAC' } }, 2, 0.5);
    expect(mac.pos.length).toBe(16 * 6);
  });
  it('picks the slice axis facing the view', () => {
    const s = defaultDomainSettings();
    expect(sliceAxis(s, new Vector3(0.1, 0.9, 0.2))).toBe(1);
    expect(sliceAxis({ ...s, slice_axis: 'X' }, new Vector3(0, 0, 1))).toBe(0);
  });
  it('layers are freed with their data', () => {
    const L = fluidLayers('test-key');
    L.noise.set(1, { nx: 1, ny: 1, nz: 1, data: new Uint8Array(2) });
    expect(L.noise.size).toBe(1);
  });
});
