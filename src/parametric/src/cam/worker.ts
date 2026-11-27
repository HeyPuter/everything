/// <reference lib="webworker" />
// CAM worker: generates toolpaths and simulates setups away from the
// interface. It keeps the part's mesh and its placement in each setup.

import { type GenerateJob, type SimulateJob, generateFor, placePart, simulateFor } from './engine';
import { CamError } from './ops';
import type { CamPart } from './ops';
import type { CamSetup } from '../model/cam';
import type { SimResult } from './simulate';
import type { Toolpath } from './toolpath';

declare const self: DedicatedWorkerGlobalScope;

export type CamWorkerRequest =
  | { id: number; type: 'mesh'; key: string; tris: Float32Array }
  | { id: number; type: 'generate'; job: GenerateJob }
  | { id: number; type: 'simulate'; setup: CamSetup; job: SimulateJob };

export type CamWorkerResponse =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'done'; result: unknown }
  | { id: number; type: 'error'; error: string; user: boolean };

let tris: Float32Array | null = null;
const parts = new Map<string, CamPart | null>();

const placementKey = (s: CamSetup) => JSON.stringify([s.axis, s.rotation, s.origin, s.stock]);

function partFor(setup: CamSetup): CamPart {
  if (!tris) throw new CamError('The part has no geometry to machine.');
  const key = placementKey(setup);
  if (!parts.has(key)) {
    if (parts.size > 8) parts.clear();
    parts.set(key, placePart(setup, tris));
  }
  const p = parts.get(key);
  if (!p) throw new CamError('The part has no geometry to machine.');
  return p;
}

self.onmessage = (ev: MessageEvent<CamWorkerRequest>) => {
  const msg = ev.data;
  const progress = (value: number) => self.postMessage({ id: msg.id, type: 'progress', value } satisfies CamWorkerResponse);
  try {
    if (msg.type === 'mesh') {
      tris = msg.tris;
      parts.clear();
      self.postMessage({ id: msg.id, type: 'done', result: null } satisfies CamWorkerResponse);
      return;
    }
    if (msg.type === 'generate') {
      const tp: Toolpath = generateFor(partFor(msg.job.setup), msg.job, progress);
      self.postMessage({ id: msg.id, type: 'done', result: tp } satisfies CamWorkerResponse, [tp.moves.buffer]);
      return;
    }
    const res: SimResult = simulateFor(partFor(msg.setup), msg.job, progress);
    const transfer: Transferable[] = [res.partTop.buffer, res.timeline.buffer, ...res.snapshots.map((s) => s.z.buffer)];
    self.postMessage({ id: msg.id, type: 'done', result: res } satisfies CamWorkerResponse, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, type: 'error', error: (e as Error).message ?? String(e), user: e instanceof CamError } satisfies CamWorkerResponse);
  }
};
