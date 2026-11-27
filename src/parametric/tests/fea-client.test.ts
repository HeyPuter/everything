// The stress analysis worker's interface side and the worker itself (run in
// this thread with a stand-in for the worker scope): progress, results,
// errors written for the user or not, Cancel, a worker that dies, the arrays
// that are moved rather than copied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { FeaCancelled, FeaClient, FeaEngineError } from '../src/fea/client';
import type { FeaWorkerRequest, FeaWorkerResponse } from '../src/fea/worker';
import type { FeaSurfaceData } from '../src/fea/surface';
import { extrude, rect, req, sketch } from './helpers';

/** The worker module, loaded with `self` standing for its global scope. */
type Scope = { onmessage: ((ev: MessageEvent<FeaWorkerRequest>) => void) | null; postMessage: (m: FeaWorkerResponse, t?: Transferable[]) => void };
const scope: Scope = { onmessage: null, postMessage: () => {} };
const g = globalThis as unknown as { self?: unknown };
const hadSelf = 'self' in g, oldSelf = g.self;

beforeAll(async () => {
  setOc(await init());
  g.self = scope;
  await import('../src/fea/worker');
});
afterAll(() => { if (hadSelf) g.self = oldSelf; else delete g.self; });

/** A Worker that runs the worker module in this thread (asynchronously, like a real one). */
class LocalWorker {
  onmessage: ((ev: MessageEvent<FeaWorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: { msg: FeaWorkerRequest; transfer: Transferable[] }[] = [];
  replies: { msg: FeaWorkerResponse; transfer: Transferable[] }[] = [];
  postMessage(msg: FeaWorkerRequest, transfer: Transferable[] = []) {
    this.posted.push({ msg, transfer });
    setTimeout(() => {
      if (this.terminated) return;
      scope.postMessage = (m, t = []) => { this.replies.push({ msg: m, transfer: t }); if (!this.terminated) this.onmessage?.({ data: m } as MessageEvent<FeaWorkerResponse>); };
      scope.onmessage!({ data: msg } as MessageEvent<FeaWorkerRequest>);
    }, 0);
  }
  terminate() { this.terminated = true; }
}

/** A Worker that never answers. */
class SilentWorker {
  onmessage: ((ev: MessageEvent<FeaWorkerResponse>) => void) | null = null;
  onerror: ((ev: Partial<ErrorEvent> & { preventDefault?: () => void }) => void) | null = null;
  terminated = false;
  postMessage() {}
  terminate() { this.terminated = true; }
}

async function barSurface(): Promise<{ surface: FeaSurfaceData; faces: { normal?: number[] | null }[] }> {
  const b = new ModelBuilder();
  const res = await b.build(req([sketch('s1', rect(0, 0, 60, 10)), extrude('f1', 's1', 10)], { quality: 1 }));
  const fs = b.feaSurface(0.05);
  return { surface: { positions: fs.positions, indices: fs.indices, triFace: fs.triFace }, faces: res.faces };
}

describe('analysis worker and client', () => {
  it('meshes and solves with progress, moving the large arrays both ways', async () => {
    const workers: LocalWorker[] = [];
    const client = new FeaClient(() => { const w = new LocalWorker(); workers.push(w); return w as unknown as Worker; });
    const { surface, faces } = await barSurface();
    const stages = new Set<string>();
    const info = await client.mesh(surface, 4, (s) => stages.add(s));
    expect(client.meshed).toBe(true);
    expect(info.stats.elements).toBeGreaterThan(0);
    expect(stages.has('Filling')).toBe(true);
    // The surface went to the worker (moved, not copied), and the mesh came back the same way.
    const sent = workers[0].posted[0];
    expect(sent.transfer).toContain(surface.positions.buffer);
    expect(sent.transfer).toContain(surface.indices.buffer);
    expect(workers[0].replies.at(-1)!.transfer).toContain(info.nodes.buffer);
    const fixed = faces.findIndex((f) => f.normal?.[0] === -1), tip = faces.findIndex((f) => f.normal?.[0] === 1);
    const solving: number[] = [];
    const sol = await client.solve({ E: 200000, nu: 0.3, density: 7.85e-9, fixtures: [{ kind: 'fixed', faces: [fixed] }], loads: [{ kind: 'force', faces: [tip], total: 100, dir: [0, -1, 0] }] }, (s, v) => { if (s === 'Solving') solving.push(v); });
    expect(sol.fields).toHaveLength(6);
    expect(sol.summary.maxDisplacement.value).toBeGreaterThan(0);
    expect(workers[0].replies.at(-1)!.transfer).toEqual(sol.fields.map((f) => f.buffer));
    expect(solving.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(workers).toHaveLength(1);
    client.dispose();
    expect(workers[0].terminated).toBe(true);
  }, 120000);

  it('passes on the messages written for the user, and wraps internal failures', async () => {
    const client = new FeaClient(() => new LocalWorker() as unknown as Worker);
    // An empty surface: a mesh error for the user.
    const e2 = await client.mesh({ positions: new Float32Array(0), indices: new Uint32Array(0), triFace: new Int32Array(0) }, 1).catch((e) => e);
    expect(e2.user).toBe(true);
    expect(e2.message).toMatch(/no solid to mesh/);
    expect(client.meshed).toBe(false);
    // Solving without a mesh (the failed one replaced the last): a study error, as it is.
    const e1 = await client.solve({ E: 1, nu: 0.3, density: 0, fixtures: [], loads: [] }).catch((e) => e);
    expect(e1).toBeInstanceOf(FeaEngineError);
    expect(e1.user).toBe(true);
    expect(e1.message).toBe('Mesh the part first.');
    // Damaged input (triangles naming vertices that are not there): an internal failure, said as one.
    const e3 = await client.mesh({ positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0, 5, 9]), triFace: new Int32Array([0]) }, 1).catch((e) => e);
    expect(e3).toBeInstanceOf(FeaEngineError);
    expect(e3.message).toMatch(/^The analysis ran into a problem|no solid/);
    client.dispose();
  }, 60000);

  it('cancels at once: the request rejects, the worker is stopped and the next request starts a new one', async () => {
    const workers: SilentWorker[] = [];
    const client = new FeaClient(() => { const w = new SilentWorker(); workers.push(w); return w as unknown as Worker; });
    const p = client.mesh({ positions: new Float32Array(9), indices: new Uint32Array(3), triFace: new Int32Array(1) }, 1);
    const q = client.solve({ E: 1, nu: 0.3, density: 0, fixtures: [], loads: [] });
    expect(client.busy).toBe(true);
    client.cancel();
    await expect(p).rejects.toBeInstanceOf(FeaCancelled);
    await expect(q).rejects.toBeInstanceOf(FeaCancelled);
    expect(workers[0].terminated).toBe(true);
    expect(client.busy).toBe(false);
    expect(client.meshed).toBe(false);
    // Cancel with nothing running leaves the worker alone.
    const r = client.solve({ E: 1, nu: 0.3, density: 0, fixtures: [], loads: [] });
    expect(workers).toHaveLength(2);
    client.cancel();
    await expect(r).rejects.toBeInstanceOf(FeaCancelled);
    client.cancel();
    expect(workers).toHaveLength(2);
  });

  it('a worker that dies (out of memory) fails its requests with advice instead of hanging', async () => {
    const workers: SilentWorker[] = [];
    const client = new FeaClient(() => { const w = new SilentWorker(); workers.push(w); return w as unknown as Worker; });
    const p = client.solve({ E: 1, nu: 0.3, density: 0, fixtures: [], loads: [] });
    let prevented = false;
    workers[0].onerror!({ message: 'Uncaught RangeError: Array buffer allocation failed', preventDefault: () => { prevented = true; } });
    await expect(p).rejects.toThrow(/Array buffer allocation failed.*coarser mesh/);
    expect(prevented).toBe(true);
    expect(workers[0].terminated).toBe(true);
    expect(client.busy).toBe(false);
  });
});
