/// <reference lib="webworker" />
// Geometry worker: owns the OpenCascade instance and the regeneration cache,
// so modeling never blocks the UI thread.

import init from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { solidWorksToStep } from '../formats/sldprt';
import { ModelBuilder, errorText } from './build';
import { setOc } from './occ';
import type { BuildResult, MeshData, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<void> | null = null;
const builder = new ModelBuilder();

function load(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const oc = await init({ locateFile: () => wasmUrl } as never);
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
  const reply = (r: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(r, transfer);
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
        const res: BuildResult = await builder.build(msg.req);
        // Mesh buffers are cached by the builder; send copies so the cache stays valid.
        const copy = (m: MeshData | null): MeshData | null =>
          m && {
            positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), vertexFace: m.vertexFace.slice(),
            edgePositions: m.edgePositions.slice(), edgeIds: m.edgeIds.slice(), vertices: m.vertices.slice(),
          };
        const out: BuildResult = { ...res, mesh: copy(res.mesh) };
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
      case 'checkImport': {
        const probe = new ModelBuilder();
        const res = await probe.build({
          features: [{ id: 'i', name: 'i', type: 'import', format: 'step', blob: 'b', fileName: '' }],
          upTo: 1, blobs: { b: msg.text }, quality: 0,
        });
        const st = res.status[0];
        reply({ id: msg.id, ok: true, result: st.ok ? null : st.error });
        return;
      }
      case 'convertSolidWorks':
        reply({ id: msg.id, ok: true, result: await solidWorksToStep(msg.data, msg.name) });
        return;
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: errorText(e) });
  }
};
