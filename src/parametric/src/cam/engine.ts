// What the CAM worker (and the tests) run: the part placed in a setup's
// machine frame, an operation's toolpath, and the simulation of a setup.

import type { Vec3 } from '../math/vec';
import type { CamOperation, CamSetup, CamTool } from '../model/cam';
import { TriIndex } from './dropcutter';
import { type MachineFrame, dirToWork, machineFrame, pointToWork, toWork } from './frame';
import { type CamPart, type Cylinder, generate } from './ops';
import { type SimResult, simulate } from './simulate';
import type { Toolpath } from './toolpath';

/** A cylindrical face of the part in model coordinates (a hole candidate). */
export interface ModelCylinder {
  name: string;
  p: Vec3;
  d: Vec3;
  radius: number;
  tris: Float32Array;
}

export function placePart(setup: Pick<CamSetup, 'axis' | 'rotation' | 'origin' | 'stock'>, tris: Float32Array): CamPart | null {
  const frame = machineFrame(setup, tris);
  if (!frame) return null;
  const work = toWork(tris, frame);
  return { frame, tris: work, index: new TriIndex(work) };
}

export function workCylinders(frame: MachineFrame, cyl: ModelCylinder[], picked: Set<string>): Cylinder[] {
  return cyl.map((c) => ({ name: c.name, p: pointToWork(frame, c.p), d: dirToWork(frame, c.d), radius: c.radius, tris: toWork(c.tris, frame), picked: picked.has(c.name) }));
}

export interface GenerateJob {
  setup: CamSetup;
  op: CamOperation;
  tool: CamTool;
  /** Pocket floors (model coordinates). */
  floors?: Float32Array[];
  cylinders?: ModelCylinder[];
  /** Names of the cylinders picked in the operation. */
  picked?: string[];
}

export function generateFor(part: CamPart, job: GenerateJob, progress?: (f: number) => void, cancelled?: () => boolean): Toolpath {
  return generate({
    part,
    setup: job.setup,
    op: job.op,
    tool: job.tool,
    floors: job.floors?.map((t) => toWork(t, part.frame)),
    cylinders: job.cylinders ? workCylinders(part.frame, job.cylinders, new Set(job.picked ?? [])) : undefined,
    progress,
    cancelled,
  });
}

export interface SimulateJob {
  steps: { toolpath: Toolpath; tool: CamTool; feed: number; plunge: number }[];
  rapidFeed: number;
}

export function simulateFor(part: CamPart, job: SimulateJob, progress?: (f: number) => void, cancelled?: () => boolean): SimResult {
  return simulate({ stock: part.frame.stock, part: part.index, steps: job.steps, rapidFeed: job.rapidFeed, progress, cancelled });
}
