// Mirror and snap for the non-mesh edit modes (curve, lattice, armature, metaball): these work on
// whatever the active edit mode's transform provider collects. The object-mode operators are
// wrapped once the app is ready, so they keep working unchanged outside these modes.
import { Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, type OpContext, type OpResult } from '../app/app';
import { transformProviders, type TElement } from '../ops/transform';
import { medianHooks } from '../ops/view3d';

/** Edit modes handled here (mesh and grease pencil edit modes have their own implementations). */
export const genericEditMode = () => {
  const t = app.activeObject?.type;
  return app.doc.mode === 'EDIT' && !!t && t !== 'MESH' && t !== 'GREASEPENCIL';
};

function collect() {
  for (let i = transformProviders.length - 1; i >= 0; i--) {
    const d = transformProviders[i].collect({ proportional: false, connected: false, individual: false });
    if (d) return d;
  }
  return null;
}

/** Apply a world-space matrix per selected element (relative to its initial state). */
export function transformSelection(fn: (e: TElement, center: Vector3) => Matrix4 | null): boolean {
  const d = collect();
  if (!d) return false;
  const sel = d.elements.filter((e) => e.weight >= 1);
  if (!sel.length) return false;
  const center = new Vector3();
  sel.forEach((e) => center.add(e.center));
  center.multiplyScalar(1 / sel.length);
  for (const e of sel) {
    const m = fn(e, center);
    if (m) e.apply(m, { mode: 'TRANSLATION', value: [0, 0, 0] });
  }
  d.onUpdate?.();
  d.finish();
  app.changed('doc', 'geometry');
  return true;
}

const hasSelection = () => genericEditMode() && !!collect()?.elements.length;

/** Active element position (world) of the current edit mode, for Selection to Active. */
export const activeElementHooks: (() => Vector3 | null)[] = [];
const activeElement = () => {
  for (const f of activeElementHooks) {
    const p = f();
    if (p) return p;
  }
  return null;
};

// Cursor to Selected uses the median of the selected elements
medianHooks.push(() => {
  if (!genericEditMode()) return null;
  const sel = collect()?.elements.filter((e) => e.weight >= 1) ?? [];
  if (!sel.length) return null;
  const c = new Vector3();
  sel.forEach((e) => c.add(e.center));
  return c.multiplyScalar(1 / sel.length);
});

function pivot(ctx: OpContext, center: Vector3) {
  return ctx.doc.scene.tool_settings.transform_pivot_point === 'CURSOR' ? new Vector3(...ctx.doc.scene.cursor.location) : center;
}

function wrap(idname: string, exec: (ctx: OpContext, p: Record<string, unknown>) => OpResult, extraPoll: () => boolean = () => true) {
  const prev = operators.get(idname);
  if (!prev) return;
  const prevPoll = (ctx: OpContext) => !prev.poll || prev.poll(ctx);
  registerOperator({
    ...prev,
    poll: (ctx) => (genericEditMode() ? hasSelection() && extraPoll() : prevPoll(ctx)),
    exec: (ctx, p) => (genericEditMode() ? exec(ctx, p) : prev.exec ? prev.exec(ctx, p) : 'CANCELLED'),
    invoke: prev.invoke ? (ctx, p) => (genericEditMode() ? exec(ctx, p) : prev.invoke!(ctx, p)) : undefined,
  });
}

onAppReady(() => {
  wrap('transform.mirror', (ctx, p) => {
    const ok = transformSelection((_e, c) => {
      const o = pivot(ctx, c);
      const s = [1, 1, 1];
      s[(p.axis as number) ?? 0] = -1;
      return new Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new Matrix4().makeScale(s[0], s[1], s[2])).multiply(new Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    });
    return ok ? 'FINISHED' : 'CANCELLED';
  });
  wrap('view3d.snap_selected_to_cursor', (ctx, p) => {
    const cur = new Vector3(...ctx.doc.scene.cursor.location);
    const ok = transformSelection((e, c) => {
      const target = p.use_offset ? cur.clone().add(e.center.clone().sub(c)) : cur;
      return new Matrix4().makeTranslation(target.x - e.center.x, target.y - e.center.y, target.z - e.center.z);
    });
    return ok ? 'FINISHED' : 'CANCELLED';
  });
  wrap('view3d.snap_selected_to_active', () => {
    const target = activeElement();
    if (!target) return 'CANCELLED';
    const ok = transformSelection((e) => new Matrix4().makeTranslation(target.x - e.center.x, target.y - e.center.y, target.z - e.center.z));
    return ok ? 'FINISHED' : 'CANCELLED';
  }, () => !!activeElement());
  // Cursor to Active: the active element in these edit modes
  const cursorPrev = operators.get('view3d.snap_cursor_to_active');
  if (cursorPrev)
    registerOperator({
      ...cursorPrev,
      poll: (ctx) => (genericEditMode() ? !!activeElement() : !cursorPrev.poll || cursorPrev.poll(ctx)),
      exec: (ctx, p) => {
        if (!genericEditMode()) return cursorPrev.exec ? cursorPrev.exec(ctx, p) : 'CANCELLED';
        const t = activeElement();
        if (!t) return 'CANCELLED';
        ctx.doc.scene.cursor.location = [t.x, t.y, t.z];
      },
    });
  wrap('view3d.snap_selected_to_grid', () => {
    const ok = transformSelection((e) => new Matrix4().makeTranslation(Math.round(e.center.x) - e.center.x, Math.round(e.center.y) - e.center.y, Math.round(e.center.z) - e.center.z));
    return ok ? 'FINISHED' : 'CANCELLED';
  });
});
