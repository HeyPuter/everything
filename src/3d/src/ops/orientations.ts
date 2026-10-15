// Transform orientations: the built-in ones (Global, Local, Normal, Gimbal, View, Cursor, Parent)
// and custom orientations saved on the scene, plus the operators that create, select and delete them.
import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { uiState } from '../app/prefs';
import type { SceneData } from '../data/types';
import { activeView3D } from '../editors/view3d/view3d';
import { gizmoCenterHook } from '../editors/view3d/gizmo';
import { BUILTIN_ORIENTATIONS } from './orientation_list';

export interface CustomOrientation {
  name: string;
  /** 3×3 rotation, column-major (columns are the X, Y and Z axes) */
  matrix: number[];
}

type SceneExt = SceneData & { transform_orientations?: CustomOrientation[] };

export { BUILTIN_ORIENTATIONS };

export function customOrientations(): CustomOrientation[] {
  return (app.doc.scene as SceneExt).transform_orientations ?? [];
}

/** The orientation chosen in the header ('GLOBAL', …, or a custom orientation's name). */
export function currentOrientation(): string {
  const o = uiState.orientation as string;
  if (BUILTIN_ORIENTATIONS.some((b) => b[0] === o)) return o;
  return customOrientations().some((c) => c.name === o) ? o : 'GLOBAL';
}

export function setOrientation(o: string) {
  uiState.orientation = o as typeof uiState.orientation;
  app.changed('ui');
}

export function orientationLabel(o: string): string {
  return BUILTIN_ORIENTATIONS.find((b) => b[0] === o)?.[1] ?? o;
}

function rotationOf(m: Matrix4): Matrix3 {
  const q = new Quaternion();
  m.decompose(new Vector3(), q, new Vector3());
  return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
}

/** Rotation of the active object (or identity). */
function activeRotation(): Matrix3 {
  const ob = app.activeObject;
  const ev = ob ? app.graph.get(ob.id) : undefined;
  return ev ? rotationOf(ev.world) : new Matrix3();
}

/** Selection normal frame in edit modes (from the gizmo hook), else the object rotation. */
function normalRotation(): Matrix3 {
  if (app.doc.mode !== 'OBJECT') {
    const c = gizmoCenterHook?.();
    if (c?.basis) return orthonormal(c.basis);
  }
  return activeRotation();
}

function orthonormal(b: Matrix3): Matrix3 {
  const e = b.elements;
  const x = new Vector3(e[0], e[1], e[2]).normalize();
  const y = new Vector3(e[3], e[4], e[5]);
  const z = new Vector3().crossVectors(x, y).normalize();
  y.crossVectors(z, x).normalize();
  return new Matrix3().set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}

/** Gimbal axes of the active object: the Euler rotation axes as they are applied. */
function gimbalRotation(): Matrix3 {
  const ob = app.activeObject;
  if (!ob || ob.rotation_mode === 'QUATERNION' || ob.rotation_mode === 'AXIS_ANGLE') return activeRotation();
  const parent = ob.parent ? app.graph.get(ob.parent) : undefined;
  const pr = parent ? rotationOf(parent.world) : new Matrix3();
  // for XYZ order X is applied first: its axis is rotated by Y and Z, Y's axis by Z only, Z is fixed
  const order = (ob.rotation_mode ?? 'XYZ') as string;
  const r = ob.rotation_euler;
  const rotFor = (axis: string) => new Matrix4().makeRotationAxis(new Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0), r['XYZ'.indexOf(axis)]);
  const axes: Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const a = order[i];
    const v = new Vector3(a === 'X' ? 1 : 0, a === 'Y' ? 1 : 0, a === 'Z' ? 1 : 0);
    for (let j = i + 1; j < 3; j++) v.applyMatrix4(rotFor(order[j]));
    axes['XYZ'.indexOf(a)] = v.applyMatrix3(pr).normalize();
  }
  return new Matrix3().set(axes[0].x, axes[1].x, axes[2].x, axes[0].y, axes[1].y, axes[2].y, axes[0].z, axes[1].z, axes[2].z);
}

/** World-space basis (columns = axes) of an orientation. */
export function orientationBasis(type: string = currentOrientation()): Matrix3 {
  // object orientations come from the evaluated scene
  if (app.hasPending && type !== 'GLOBAL' && type !== 'VIEW') app.flush();
  switch (type) {
    case 'GLOBAL':
      return new Matrix3();
    case 'LOCAL':
      return activeRotation();
    case 'NORMAL':
      return normalRotation();
    case 'GIMBAL':
      return gimbalRotation();
    case 'VIEW': {
      const v = activeView3D();
      return v ? new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(v.camera.quaternion)) : new Matrix3();
    }
    case 'CURSOR': {
      const c = app.doc.scene.cursor.rotation_euler;
      return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(c[0], c[1], c[2], 'ZYX')));
    }
    case 'PARENT': {
      const ob = app.activeObject;
      const p = ob?.parent ? app.graph.get(ob.parent) : undefined;
      return p ? rotationOf(p.world) : new Matrix3();
    }
  }
  const custom = customOrientations().find((c) => c.name === type);
  return custom ? new Matrix3().fromArray(custom.matrix) : new Matrix3();
}

function uniqueOrientationName(base: string, list: CustomOrientation[]) {
  let name = base;
  for (let i = 1; list.some((c) => c.name === name); i++) name = `${base}.${String(i).padStart(3, '0')}`;
  return name;
}

registerOperators([
  {
    idname: 'transform.create_orientation',
    label: 'Create Orientation',
    description: 'Save the orientation of the active element (or the view) as a custom transform orientation',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'use_view', label: 'Use View', type: 'bool', default: false },
      { id: 'use', label: 'Use After Creation', type: 'bool', default: true },
      { id: 'overwrite', label: 'Overwrite Previous', type: 'bool', default: false },
    ],
    poll: () => !!activeView3D(),
    exec: (ctx, p) => {
      if (app.hasPending) app.flush();
      const sc = ctx.doc.scene as SceneExt;
      const list = [...(sc.transform_orientations ?? [])];
      const useView = !!p.use_view;
      const basis = useView ? orientationBasis('VIEW') : app.doc.mode === 'OBJECT' ? activeRotation() : normalRotation();
      if (!useView && app.doc.mode === 'OBJECT' && !app.activeObject) {
        app.report('ERROR', 'No active object to take the orientation from');
        return 'CANCELLED';
      }
      const base = (p.name as string) || (useView ? 'View' : app.doc.mode === 'OBJECT' ? app.activeObject!.name : app.doc.mode === 'EDIT' ? 'Face' : 'Orientation');
      const existing = list.findIndex((c) => c.name === base);
      const entry: CustomOrientation = { name: p.overwrite && existing >= 0 ? base : uniqueOrientationName(base, list), matrix: basis.toArray() };
      if (p.overwrite && existing >= 0) list[existing] = entry;
      else list.push(entry);
      sc.transform_orientations = list;
      if (p.use) setOrientation(entry.name);
    },
  },
  {
    idname: 'transform.delete_orientation',
    label: 'Delete Orientation',
    description: 'Delete the selected custom transform orientation',
    poll: () => customOrientations().some((c) => c.name === currentOrientation()),
    exec: (ctx) => {
      const sc = ctx.doc.scene as SceneExt;
      const cur = currentOrientation();
      sc.transform_orientations = (sc.transform_orientations ?? []).filter((c) => c.name !== cur);
      setOrientation('GLOBAL');
    },
  },
  {
    idname: 'transform.select_orientation',
    label: 'Select Orientation',
    description: 'Choose the transform orientation used for constraints and gizmos',
    props: [{ id: 'orientation', label: 'Orientation', type: 'enum', default: 'GLOBAL', items: BUILTIN_ORIENTATIONS.map(([id, label]) => [id, label]) }],
    exec: (_ctx, p) => {
      const o = String(p.orientation);
      if (!BUILTIN_ORIENTATIONS.some((b) => b[0] === o) && !customOrientations().some((c) => c.name === o)) return 'CANCELLED';
      setOrientation(o);
    },
    undo: false,
  },
]);
