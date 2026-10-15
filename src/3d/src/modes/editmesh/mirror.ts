// Mirror (transform.mirror) for the selected mesh elements in Edit Mode: reflect them across the
// pivot along a global or local axis. Object Mode keeps the object-level operator.
import { Matrix4, Vector3 } from 'three';
import { app, operators, registerOperator, onAppReady } from '../../app/app';
import { withEdit, worldMatrix } from './context';
import { editPoll, flipFace } from './ops-basic';
import { MeshEdit } from './meshedit';

/** Reflect the selected vertices of `m` with a local-space matrix; fully selected faces are flipped to keep their facing. */
export function mirrorSelected(m: MeshEdit, mat: Matrix4) {
  const sel = m.selectedVerts();
  if (!sel.length) return false;
  const p = new Vector3();
  for (const v of sel) {
    p.set(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]).applyMatrix4(mat);
    m.setP(v, [p.x, p.y, p.z]);
  }
  for (const fi of m.selectedFaces()) flipFace(m.faces[fi]);
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return true;
}

onAppReady(() => {
  const base = operators.get('transform.mirror');
  if (!base) return;
  const props = [...(base.props ?? [])];
  if (!props.some((d) => d.id === 'orient_type')) props.push({ id: 'orient_type', label: 'Orientation', type: 'enum', default: 'GLOBAL', items: [['GLOBAL', 'Global'], ['LOCAL', 'Local']] });
  registerOperator({
    ...base,
    props,
    poll: (ctx) => (editPoll(ctx) ? true : base.poll ? base.poll(ctx) : true),
    exec: (ctx, p) => {
      if (!editPoll(ctx)) return base.exec?.(ctx, p);
      const axis = (p.axis as number) ?? 0;
      // pivot: median of the selection in world space
      const pivot = new Vector3();
      let n = 0;
      withEdit((m, ob) => {
        const w = worldMatrix(ob);
        for (const v of m.selectedVerts()) {
          pivot.add(new Vector3(...m.p(v)).applyMatrix4(w));
          n++;
        }
        return false;
      });
      if (!n) return 'CANCELLED';
      pivot.multiplyScalar(1 / n);
      const ok = withEdit((m, ob) => {
        const w = worldMatrix(ob);
        const s = [1, 1, 1];
        s[axis] = -1;
        const scale = new Matrix4().makeScale(s[0], s[1], s[2]);
        let mat: Matrix4;
        if (p.orient_type === 'LOCAL') {
          const pl = pivot.clone().applyMatrix4(w.clone().invert());
          mat = new Matrix4().makeTranslation(pl.x, pl.y, pl.z).multiply(scale).multiply(new Matrix4().makeTranslation(-pl.x, -pl.y, -pl.z));
        } else {
          const world = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(scale).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
          mat = w.clone().invert().multiply(world).multiply(w);
        }
        return mirrorSelected(m, mat);
      });
      return ok ? 'FINISHED' : 'CANCELLED';
    },
  });
});
