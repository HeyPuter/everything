/// <reference lib="webworker" />
// Geometry worker: owns the OpenCascade instance and the regeneration cache,
// so modeling never blocks the UI thread.

import init from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { solidWorksToStep } from '../formats/sldprt';
import { ModelBuilder, checkStep, errorText, isFatal } from './build';
import { setOc } from './occ';
import type { BuildResult, MeshData, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<void> | null = null;
const builder = new ModelBuilder();
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
    })();
  }
  return ready;
}

function meshTransfers(m: MeshData | null, out: Transferable[]) {
  if (!m) return;
  for (const a of [m.positions, m.normals, m.indices, m.vertexFace, m.edgePositions, m.edgeIds, m.vertices]) out.push(a.buffer);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
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
        reply({ id: msg.id, ok: true, result: true });
        return;
      case 'build': {
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
        const transfer: Transferable[] = [];
        meshTransfers(out.mesh, transfer);
        meshTransfers(out.preview, transfer);
        reply({ id: msg.id, ok: true, result: out }, transfer);
        return;
      }
      case 'project':
        reply({ id: msg.id, ok: true, result: builder.project(msg.views) });
        return;
      case 'mass':
        reply({ id: msg.id, ok: true, result: builder.massProperties() });
        return;
      case 'measure':
        reply({ id: msg.id, ok: true, result: builder.measure(msg.a, msg.b) });
        return;
      case 'export': {
        if (msg.format === 'brep') { reply({ id: msg.id, ok: true, result: builder.exportBrep() }); return; }
        const data = msg.format === 'step' ? builder.exportStep() : builder.exportStl(msg.quality);
        reply({ id: msg.id, ok: true, result: data }, [data.buffer as ArrayBuffer]);
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
};
