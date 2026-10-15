// Interactive mirror (Ctrl M in Object Mode): press X, Y or Z to pick the axis (again for the
// local axis), confirm with Enter or a click, cancel with Esc or right click.
import { app, type OpResult } from '../app/app';
import type { ObjectData } from '../data/types';

type Snapshot = Pick<ObjectData, 'location' | 'rotation_euler' | 'rotation_quaternion' | 'rotation_axis_angle' | 'scale'>;

function snapshot(ob: ObjectData): Snapshot {
  return {
    location: [...ob.location] as Snapshot['location'],
    rotation_euler: [...ob.rotation_euler] as Snapshot['rotation_euler'],
    rotation_quaternion: [...ob.rotation_quaternion] as Snapshot['rotation_quaternion'],
    rotation_axis_angle: [...ob.rotation_axis_angle] as Snapshot['rotation_axis_angle'],
    scale: [...ob.scale] as Snapshot['scale'],
  };
}

export function startInteractiveMirror(apply: (axis: number, orient: string) => void): OpResult {
  const obs = app.selectedObjects();
  if (!obs.length) return 'CANCELLED';
  const saved = new Map(obs.map((o) => [o, snapshot(o)]));
  let axis = -1;
  let orient: 'GLOBAL' | 'LOCAL' = 'GLOBAL';
  const restore = () => {
    for (const [o, s] of saved) Object.assign(o, snapshot(s as ObjectData));
    app.graph.evaluate(app.doc, false);
  };
  const preview = () => {
    restore();
    if (axis >= 0) apply(axis, orient);
    app.changed('doc');
  };
  const props = () => ({ axis: Math.max(0, axis), orient_type: orient, interactive: false });
  app.startModal({
    label: 'Mirror',
    header: () => (axis < 0 ? 'Mirror: press X, Y or Z' : `Mirror along ${orient === 'LOCAL' ? 'local' : 'global'} ${'XYZ'[axis]}`),
    status: () => [
      ['X Y Z', 'Axis (twice: local)'],
      ['Enter', 'Confirm'],
      ['Esc', 'Cancel'],
    ],
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toUpperCase();
      const i = 'XYZ'.indexOf(k);
      if (i >= 0 && k.length === 1) {
        if (axis === i) orient = orient === 'GLOBAL' ? 'LOCAL' : 'GLOBAL';
        else {
          axis = i;
          orient = 'GLOBAL';
        }
        preview();
        return true;
      }
      if (e.key === 'Enter' || e.key === ' ') return axis >= 0 ? 'FINISHED' : 'CANCELLED';
      if (e.key === 'Escape') return 'CANCELLED';
      return true;
    },
    onPointerDown: (e) => (e.button === 0 && axis >= 0 ? 'FINISHED' : 'CANCELLED'),
    cancel: () => {
      restore();
      app.changed('doc');
    },
    get redoOp() {
      return { idname: 'transform.mirror', props: props() };
    },
  });
  return 'RUNNING_MODAL';
}
