// Shift T in Object Mode: interactively aim the selected objects (lights, cameras…) so their
// -Z axis points at the surface (or view plane point) under the mouse.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import type { ObjectData } from '../data/types';
import { activeView3D } from '../editors/view3d/view3d';
import { applyMatrixToObject, toMatrix4 } from '../eval/transform';
import { surfaceHit } from '../ops/view3d';

type Snap = Pick<ObjectData, 'rotation_euler' | 'rotation_quaternion' | 'rotation_axis_angle'>;

/** World matrix that keeps position and scale of `world` but looks along -Z at `target`. */
export function aimMatrix(world: Matrix4, target: Vector3): Matrix4 | null {
  const pos = new Vector3(),
    q = new Quaternion(),
    scale = new Vector3();
  world.decompose(pos, q, scale);
  const dir = target.clone().sub(pos);
  if (dir.lengthSq() < 1e-12) return null;
  dir.normalize();
  const up = Math.abs(dir.z) > 0.999 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const rot = new Matrix4().lookAt(pos, target, up);
  return new Matrix4().compose(pos, new Quaternion().setFromRotationMatrix(rot), scale);
}

registerOperators([
  {
    idname: 'object.transform_axis_target',
    label: 'Interactive Light Track to Cursor',
    description: 'Point the selected objects at the surface under the mouse (click to confirm)',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!activeView3D() && app.selectedObjects().length > 0,
    invoke: () => {
      const v = activeView3D()!;
      const obs = app.selectedObjects();
      const saved = new Map<ObjectData, Snap>(obs.map((o) => [o, { rotation_euler: [...o.rotation_euler] as Snap['rotation_euler'], rotation_quaternion: [...o.rotation_quaternion] as Snap['rotation_quaternion'], rotation_axis_angle: [...o.rotation_axis_angle] as Snap['rotation_axis_angle'] }]));
      const worlds = new Map(obs.map((o) => [o, app.graph.get(o.id)!.world.clone()]));
      const parents = new Map(obs.map((o) => [o, o.parent ? app.graph.get(o.parent)!.world.clone().multiply(toMatrix4(o.matrix_parent_inverse)).invert() : new Matrix4()]));
      const act = app.activeObject && worlds.get(app.activeObject) ? app.activeObject : obs[0];
      const depth = new Vector3().setFromMatrixPosition(worlds.get(act)!);
      const restore = () => {
        for (const [o, s] of saved) Object.assign(o, { rotation_euler: [...s.rotation_euler], rotation_quaternion: [...s.rotation_quaternion], rotation_axis_angle: [...s.rotation_axis_angle] });
      };
      const aim = (cx: number, cy: number) => {
        const r = v.el.getBoundingClientRect();
        const x = cx - r.left,
          y = cy - r.top;
        const target = surfaceHit(v, x, y) ?? v.unproject(x, y, depth);
        for (const o of obs) {
          const m = aimMatrix(worlds.get(o)!, target);
          if (m) applyMatrixToObject(o, parents.get(o)!.clone().multiply(m));
        }
        app.changed('doc');
      };
      aim(app.pointer.x, app.pointer.y);
      app.startModal({
        label: 'Track to Cursor',
        header: () => 'Aim at the surface under the mouse: click or Enter to confirm, Esc to cancel',
        onPointerMove: (e) => aim(e.clientX, e.clientY),
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Enter' || e.key === ' ' ? 'FINISHED' : e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {
          restore();
          app.changed('doc');
        },
      });
      return 'RUNNING_MODAL';
    },
  },
]);
