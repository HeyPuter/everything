// Hooks for curves (Ctrl H): control points follow another object. Hook modifiers on curve objects
// act on the control points (before the curve is turned into geometry); point indices count a
// Bézier point as three (left handle, point, right handle) and a poly / NURBS point as one.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, onAppReady, operators, registerOperator } from '../../app/app';
import { addKeys } from '../../app/keymap';
import type { CurveData, ObjectData, Spline, Vec3 } from '../../data/types';
import type { ModifierBase } from '../../data/types';
import { newObject, uid } from '../../data/defaults';
import { addObjectToScene } from '../../ops/object';
import { newModifier } from '../../eval/modifiers';
import type { Depsgraph } from '../../eval/depsgraph';
import type { MenuItem } from '../../ui/menu';
import { activeCurve, inCurveEdit } from './curve';
import * as K from './curveops';

/** Flattened hook indices of the selected control points (and their handles). */
export function selectedHookIndices(cu: CurveData): number[] {
  const out: number[] = [];
  let base = 0;
  for (const sp of cu.splines) {
    if (sp.type === 'BEZIER')
      sp.bezier_points.forEach((b, i) => {
        if (b.select_left_handle || b.select_control_point) out.push(base + i * 3);
        if (b.select_control_point) out.push(base + i * 3 + 1);
        if (b.select_right_handle || b.select_control_point) out.push(base + i * 3 + 2);
      });
    else sp.points.forEach((p, i) => p.select && out.push(base + i));
    base += sp.type === 'BEZIER' ? sp.bezier_points.length * 3 : sp.points.length;
  }
  return out;
}

/** Splines with the curve's hook modifiers applied to their control points (or null if none act). */
export function hookedSplines(ob: ObjectData, cu: CurveData, graph: Depsgraph): Spline[] | null {
  const hooks = ob.modifiers.filter((m) => m.type === 'HOOK' && m.show_viewport !== false && typeof m.object === 'string' && graph.get(m.object as string));
  if (!hooks.length) return null;
  const own = graph.get(ob.id)?.world ?? new Matrix4();
  const splines = structuredClone(cu.splines);
  for (const mod of hooks) {
    const target = graph.get(mod.object as string)!;
    const inv = new Matrix4().fromArray((mod.matrix_inverse as number[]) ?? new Matrix4().elements);
    const mat = own.clone().invert().multiply(target.world).multiply(inv).multiply(own);
    const strength = typeof mod.strength === 'number' ? mod.strength : 1;
    const falloff = typeof mod.falloff_radius === 'number' ? mod.falloff_radius : 0;
    const center = new Vector3(...((mod.center as number[]) ?? [0, 0, 0]));
    const idx = new Set((mod.vertex_indices as number[]) ?? []);
    const move = (c: ArrayLike<number>): Vec3 => {
      const p = new Vector3(c[0], c[1], c[2]);
      let f = strength;
      if (falloff > 0) f *= Math.max(0, 1 - p.distanceTo(center) / falloff);
      return p.lerp(p.clone().applyMatrix4(mat), f).toArray() as Vec3;
    };
    let base = 0;
    for (const sp of splines) {
      if (sp.type === 'BEZIER')
        sp.bezier_points.forEach((b, i) => {
          if (idx.has(base + i * 3)) b.handle_left = move(b.handle_left);
          if (idx.has(base + i * 3 + 1)) b.co = move(b.co);
          if (idx.has(base + i * 3 + 2)) b.handle_right = move(b.handle_right);
        });
      else
        sp.points.forEach((p, i) => {
          if (!idx.has(base + i)) return;
          const q = move(p.co);
          p.co = [q[0], q[1], q[2], p.co[3]];
        });
      base += sp.type === 'BEZIER' ? sp.bezier_points.length * 3 : sp.points.length;
    }
  }
  return splines;
}

function addHook(target: ObjectData | null) {
  const a = activeCurve()!;
  const idx = selectedHookIndices(a.cu);
  if (!idx.length) {
    app.report('ERROR', 'Select control points to hook');
    return 'CANCELLED' as const;
  }
  // centre of the selected control points
  const c = new Vector3();
  let n = 0;
  for (const sp of a.cu.splines)
    for (let i = 0; i < K.pointCount(sp); i++)
      if (K.isSel(sp, i)) {
        c.add(K.pointCo(sp, i));
        n++;
      }
  c.multiplyScalar(1 / Math.max(1, n));
  const own = app.graph.get(a.ob.id)?.world ?? new Matrix4();
  const wc = c.clone().applyMatrix4(own);
  let hookOb = target;
  let targetWorld: Matrix4;
  if (!hookOb) {
    hookOb = newObject('Empty', 'EMPTY', null);
    const keepActive = app.doc.scene.active_object;
    addObjectToScene(app.doc, hookOb, { location: [wc.x, wc.y, wc.z] });
    app.doc.scene.active_object = keepActive;
    hookOb.select = false;
    a.ob.select = true;
    targetWorld = new Matrix4().makeTranslation(wc.x, wc.y, wc.z);
  } else targetWorld = app.graph.get(hookOb.id)?.world.clone() ?? new Matrix4();
  const md = newModifier('HOOK', uid('md'), a.ob.modifiers) as ModifierBase;
  md.name = `Hook-${hookOb.name}`;
  md.object = hookOb.id;
  md.vertex_indices = idx;
  md.center = [c.x, c.y, c.z];
  md.matrix_inverse = targetWorld.clone().invert().toArray();
  a.ob.modifiers.push(md);
  app.changed('doc', 'geometry');
  return 'FINISHED' as const;
}

/** Hook modifiers of the edited curve. */
const curveHooks = () => (activeCurve()?.ob.modifiers ?? []).filter((m) => m.type === 'HOOK');

registerOperators([
  {
    idname: 'object.hook_add_selob',
    label: 'Hook to Selected Object',
    description: 'Hook the selected control points to the other selected object',
    poll: () => inCurveEdit() && app.selectedObjects().some((o) => o.id !== app.activeObject?.id),
    exec: () => {
      const other = app.selectedObjects().find((o) => o.id !== app.activeObject?.id);
      return other ? addHook(other) : 'CANCELLED';
    },
  },
  {
    idname: 'object.hook_remove',
    label: 'Remove Hook',
    description: 'Remove a hook from the edited curve',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => inCurveEdit() && curveHooks().length > 0,
    exec: (_c, p) => {
      const ob = activeCurve()!.ob;
      const i = ob.modifiers.findIndex((m) => m.type === 'HOOK' && (!p.modifier || m.name === p.modifier));
      if (i < 0) return 'CANCELLED';
      ob.modifiers.splice(i, 1);
    },
  },
  {
    idname: 'object.hook_reset',
    label: 'Reset Hook',
    description: 'Make the hooked points rest where the hook object is now',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => inCurveEdit() && curveHooks().length > 0,
    exec: (_c, p) => {
      for (const m of curveHooks()) {
        if (p.modifier && m.name !== p.modifier) continue;
        const t = typeof m.object === 'string' ? app.graph.get(m.object) : undefined;
        if (t) m.matrix_inverse = t.world.clone().invert().toArray();
      }
    },
  },
  {
    idname: 'object.hook_select',
    label: 'Select Hook',
    description: 'Select the control points of a hook',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => inCurveEdit() && curveHooks().length > 0,
    exec: (_c, p) => {
      const cu = activeCurve()!.cu;
      const idx = new Set(curveHooks().filter((m) => !p.modifier || m.name === p.modifier).flatMap((m) => (m.vertex_indices as number[]) ?? []));
      let base = 0;
      for (const sp of cu.splines) {
        for (let i = 0; i < K.pointCount(sp); i++) if (sp.type === 'BEZIER' ? idx.has(base + i * 3 + 1) : idx.has(base + i)) K.setSel(sp, i, true);
        base += sp.type === 'BEZIER' ? sp.bezier_points.length * 3 : sp.points.length;
      }
    },
  },
]);

export function hookMenu(): MenuItem[] {
  const hooks = curveHooks();
  return [
    { label: 'Hook to New Object', op: 'object.hook_add_newob' },
    { label: 'Hook to Selected Object', op: 'object.hook_add_selob' },
    ...(hooks.length
      ? [
          { separator: true } as MenuItem,
          { label: 'Reset Hook', op: 'object.hook_reset' },
          { label: 'Select Hook', submenu: () => hooks.map((m) => ({ label: m.name, op: 'object.hook_select', props: { modifier: m.name } })) },
          { label: 'Remove Hook', submenu: () => hooks.map((m) => ({ label: m.name, op: 'object.hook_remove', props: { modifier: m.name } })) },
        ]
      : []),
  ];
}

// Hook to New Object: the existing operator handles meshes; curves are handled here
onAppReady(() => {
  const prev = operators.get('object.hook_add_newob');
  if (!prev) return;
  registerOperator({
    ...prev,
    description: 'Hook the selected vertices / control points to a new empty',
    poll: (ctx) => inCurveEdit() || (!!prev.poll && prev.poll(ctx)),
    exec: (ctx, p) => (inCurveEdit() ? addHook(null) : prev.exec ? prev.exec(ctx, p) : 'CANCELLED'),
  });
});

addKeys('Curve', [{ key: 'H', ctrl: true, menu: hookMenu, menuTitle: 'Hooks', when: inCurveEdit }]);

export { addHook };
