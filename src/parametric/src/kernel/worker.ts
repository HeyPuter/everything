/// <reference lib="webworker" />
// Geometry worker: owns the OpenCascade instance and the regeneration cache,
// so modeling never blocks the UI thread.

import init from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { solidWorksToStep } from '../formats/sldprt';
import { ModelBuilder, checkStep, errorText, isFatal } from './build';
import { AssemblyBuilder, asmTransfers } from './assembly';
import { setOc } from './occ';
import type { BuildResult, MeshData, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<void> | null = null;
/** The WebAssembly memory of the OpenCascade module, to report its size. */
let memory: { buffer: ArrayBuffer } | undefined;
const builder = new ModelBuilder();
/** The parts and components of an open assembly (active while one is open). */
const assembly = new AssemblyBuilder();
/** Imported file data of the open part, by blob id. */
const blobs: Record<string, string> = {};
/** The builder's cached mesh last sent to the main thread. */
let sentMesh: MeshData | null = null;
/** Set when the WebAssembly module aborts: its memory can no longer be trusted. */
let aborted = false;
const KERNEL_FAILED = 'The geometry kernel failed';

function load(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const oc = await init({ locateFile: () => wasmUrl, onAbort: () => { aborted = true; } } as never);
      setOc(oc);
      memory = (oc as { wasmMemory?: { buffer: ArrayBuffer } }).wasmMemory;
    })();
  }
  return ready;
}

function meshTransfers(m: MeshData | null, out: Transferable[]) {
  if (!m) return;
  for (const a of [m.positions, m.normals, m.indices, m.vertexFace, m.edgePositions, m.edgeIds, m.vertices]) out.push(a.buffer);
}

// One request at a time, in the order sent. Requests that arrive while the
// WebAssembly module loads all wait for it; run side by side, a request sent
// after a build (measure, an assembly's mass) ran in the middle of it, between
// two of its features, and found the part or the assembly's parts not built yet.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(ev)).catch(() => undefined);
};

async function handle(ev: MessageEvent<WorkerRequest>) {
  const msg = ev.data;
  // A result computed after the module aborted cannot be trusted either.
  const reply = (r: WorkerResponse, transfer: Transferable[] = []) =>
    aborted ? self.postMessage({ id: r.id, ok: false, error: KERNEL_FAILED, fatal: true }) : self.postMessage(r, transfer);
  try {
    await load();
    switch (msg.type) {
      case 'init':
        reply({ id: msg.id, ok: true, result: true });
        return;
      case 'reset':
        builder.reset();
        assembly.reset();
        reply({ id: msg.id, ok: true, result: true });
        return;
      case 'build': {
        // A part is open: drawings, measure and export work on it again.
        assembly.active = false;
        // File data arrives once; later requests only list the ids in use.
        const keep = new Set(msg.blobs);
        for (const k of Object.keys(blobs)) if (!keep.has(k)) delete blobs[k];
        Object.assign(blobs, msg.req.blobs);
        const res: BuildResult = await builder.build({ ...msg.req, blobs });
        // Mesh buffers are cached by the builder; send copies so the cache stays valid.
        const copy = (m: MeshData | null): MeshData | null =>
          m && {
            positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), vertexFace: m.vertexFace.slice(),
            edgePositions: m.edgePositions.slice(), edgeIds: m.edgeIds.slice(), vertices: m.vertices.slice(),
          };
        // The main thread keeps the last mesh it was sent: an unchanged one
        // (a cached rebuild, a rename, a preview over the same body) is not
        // copied, sent or uploaded to the GPU again.
        const same = !!res.mesh && res.mesh === sentMesh;
        sentMesh = res.mesh;
        const out: BuildResult = same ? { ...res, mesh: null, meshUnchanged: true } : { ...res, mesh: copy(res.mesh) };
        if (memory) out.heap = memory.buffer.byteLength;
        const transfer: Transferable[] = [];
        meshTransfers(out.mesh, transfer);
        meshTransfers(out.preview, transfer);
        reply({ id: msg.id, ok: true, result: out }, transfer);
        return;
      }
      case 'project':
        reply({ id: msg.id, ok: true, result: assembly.active ? assembly.project(msg.views) : builder.project(msg.views) });
        return;
      case 'mass':
        reply({ id: msg.id, ok: true, result: assembly.active ? assembly.massProperties() : builder.massProperties() });
        return;
      case 'weldVolumes':
        reply({ id: msg.id, ok: true, result: builder.weldVolumes() });
        return;
      case 'flatPattern': {
        const res = builder.flatPattern(msg.quality);
        const transfer: Transferable[] = [];
        meshTransfers(res.mesh, transfer);
        reply({ id: msg.id, ok: true, result: res }, transfer);
        return;
      }
      case 'measure':
        reply({ id: msg.id, ok: true, result: assembly.active ? assembly.measure(msg.a, msg.b) : builder.measure(msg.a, msg.b) });
        return;
      case 'export': {
        if (assembly.active && msg.format !== 'brep') {
          const data = msg.format === 'step' ? await assembly.exportStep() : assembly.exportStl(msg.quality);
          reply({ id: msg.id, ok: true, result: data }, [data.buffer as ArrayBuffer]);
          return;
        }
        if (msg.format === 'brep') { reply({ id: msg.id, ok: true, result: builder.exportBrep() }); return; }
        const data = msg.format === 'step' ? builder.exportStep(msg.name) : builder.exportStl(msg.quality);
        reply({ id: msg.id, ok: true, result: data }, [data.buffer as ArrayBuffer]);
        return;
      }
      case 'asm': {
        const r = msg.req;
        const result = r.op === 'build' ? await assembly.build(r.parts)
          : r.op === 'scene' ? (assembly.setScene(r.items), true)
          : r.op === 'drop' ? (assembly.drop(r.keep), true)
          : r.op === 'project' ? assembly.projectItems(r.items, r.views)
          : r.op === 'interference' ? assembly.interference({ groups: r.groups, mesh: r.mesh })
          : assembly.mass(r.densities);
        // The heap lets the main thread replace a worker that grew too big, as after part builds.
        reply({ id: msg.id, ok: true, result, heap: memory?.buffer.byteLength }, r.op === 'build' || r.op === 'interference' ? asmTransfers(result) : []);
        return;
      }
      case 'feaSurface': {
        if (assembly.active) throw new Error('Stress analysis works on parts.');
        const res = builder.feaSurface(msg.tolerance);
        reply({ id: msg.id, ok: true, result: res }, [res.positions.buffer, res.indices.buffer, res.triFace.buffer] as ArrayBuffer[]);
        return;
      }
      case 'checkImport':
        reply({ id: msg.id, ok: true, result: await checkStep(msg.text) });
        return;
      case 'convertSolidWorks':
        reply({ id: msg.id, ok: true, result: await solidWorksToStep(msg.data, msg.name) });
        return;
      case 'debugFail':
        if (!import.meta.env.DEV) throw new Error('Not available');
        if (msg.mode === 'hang') for (;;) { /* never answers */ }
        if (msg.mode === 'crash') { setTimeout(() => { throw new Error('Simulated crash'); }); return; }
        aborted = true;
        throw new WebAssembly.RuntimeError('Aborted(simulated)');
    }
  } catch (e) {
    // After an abort or a WebAssembly trap the module is unusable (and other
    // code may have swallowed the error): ask for a new worker.
    if (isFatal(e)) aborted = true;
    reply({ id: msg.id, ok: false, error: errorText(e) });
  }
}
