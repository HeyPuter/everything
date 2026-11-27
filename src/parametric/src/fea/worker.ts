/// <reference lib="webworker" />
// Stress analysis worker: meshes the part and solves studies away from the
// interface. It keeps the last mesh, so a study changed without changing the
// part or the mesh size is solved again without meshing.

import { MeshError, type TetMesh, meshSolid } from './mesher';
import { type StaticInput, StudyError, solveStatic } from './static';
import { SurfaceIndex, type FeaSurfaceData } from './surface';
import { type FeaMeshInfo, type FeaSolution, meshView, solutionOf } from './results';

declare const self: DedicatedWorkerGlobalScope;

export type FeaWorkerRequest =
  | { id: number; type: 'mesh'; surface: FeaSurfaceData; size: number }
  | { id: number; type: 'solve'; input: StaticInput };

export type FeaWorkerResponse =
  | { id: number; type: 'progress'; stage: string; value: number }
  | { id: number; type: 'done'; result: unknown }
  | { id: number; type: 'error'; error: string; user: boolean };

let mesh: TetMesh | null = null;
let viewMap: Int32Array | null = null;

self.onmessage = (ev: MessageEvent<FeaWorkerRequest>) => {
  const msg = ev.data;
  const progress = (stage: string, value: number) => self.postMessage({ id: msg.id, type: 'progress', stage, value } satisfies FeaWorkerResponse);
  try {
    if (msg.type === 'mesh') {
      mesh = null;
      const surf = new SurfaceIndex(msg.surface);
      mesh = meshSolid(surf, { size: msg.size, progress });
      const v = meshView(mesh);
      viewMap = v.map;
      const info: FeaMeshInfo = v.info;
      self.postMessage({ id: msg.id, type: 'done', result: info } satisfies FeaWorkerResponse, [info.nodes.buffer, info.tris.buffer, info.triFace.buffer, info.lines.buffer] as ArrayBuffer[]);
      return;
    }
    if (!mesh || !viewMap) throw new StudyError('Mesh the part first.');
    const res = solveStatic(mesh, msg.input, progress);
    const sol: FeaSolution = solutionOf(mesh, viewMap, res, msg.input);
    self.postMessage({ id: msg.id, type: 'done', result: sol } satisfies FeaWorkerResponse, sol.fields.map((f) => f.buffer) as ArrayBuffer[]);
  } catch (e) {
    const user = e instanceof StudyError || e instanceof MeshError;
    self.postMessage({ id: msg.id, type: 'error', error: (e as Error).message ?? String(e), user } satisfies FeaWorkerResponse);
  }
};
