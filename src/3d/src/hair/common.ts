// Shared helpers of the hair modes: the active Curves object, world matrices, screen projection.
import { Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import type { ObjectData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { makeProjector, type Projector } from './brushmath';
import { hairOf } from './data';
import type { HairCurvesData } from './types';

export function activeHair(): { ob: ObjectData; hc: HairCurvesData } | null {
  const ob = app.activeObject;
  const hc = hairOf(app.doc, ob);
  return ob && hc ? { ob, hc } : null;
}

export const inCurvesEdit = () => app.doc.mode === 'EDIT' && !!activeHair();
export const inSculptCurves = () => app.doc.mode === 'SCULPT_CURVES' && !!activeHair();

export const worldOf = (ob: ObjectData) => app.graph.get(ob.id)?.world.clone() ?? new Matrix4();

/** Projector from object space of `world` to the viewport's pixels. */
export function projectorFor(v: View3D, world: Matrix4): Projector {
  const cam = v.camera;
  cam.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(world);
  return makeProjector(m.elements, v.width, v.height);
}

/** Surface object of hair data with its evaluated mesh and the hair → surface space matrix. */
export function surfaceOf(ob: ObjectData, hc: HairCurvesData) {
  const so = hc.surface ? app.doc.objects[hc.surface] : null;
  if (!so || so.type !== 'MESH') return null;
  const ev = app.graph.get(so.id);
  if (!ev?.mesh || !ev.mesh.indices.length) return null;
  const hairWorld = worldOf(ob);
  const toSurface = ev.world.clone().invert().multiply(hairWorld);
  return { ob: so, mesh: ev.mesh, toSurface, fromSurface: toSurface.clone().invert() };
}

export const v3 = (P: ArrayLike<number>, i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
