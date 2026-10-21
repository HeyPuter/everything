// Surface operators: the six NURBS surface primitives, and the curve.* editing operators in Surface
// Edit Mode (selection, rows, delete, extrude, subdivide, duplicate, cyclic, direction, spin, weights,
// hide / reveal, separate). Operators that also exist for curves keep their ids and gain a surface
// branch; the others are surface-only.
import { Euler, Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, registerOperators, type OpContext, type OpResult, type PropDef, type Operator } from '../app/app';
import type { CurveData, Spline, SplinePoint, Vec3 } from '../data/types';
import { newCurve, newObject } from '../data/defaults';
import { addObjectToScene, uniqueName } from '../ops/object';
import { startTransform } from '../ops/transform';
import { activeView3D } from '../editors/view3d/view3d';
import { surfacePrimitive, gridSize, type SurfacePrimitive } from './nurbs';
import * as G from './grid';
import { activeSurface, inSurfaceEdit, deselectAll, surfaceState, world, pickSurfacePoint } from './edit';

// ---------------------------------------------------------------------------
// primitives

const transformProps: PropDef[] = [
  { id: 'enter_editmode', label: 'Enter Edit Mode', type: 'bool', default: false },
  { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
  { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
  { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
];

const PRIMS: [SurfacePrimitive, string, string, string][] = [
  ['CURVE', 'curve', 'Add Surface Curve', 'SurfCurve'],
  ['CIRCLE', 'circle', 'Add Surface Circle', 'SurfCircle'],
  ['SURFACE', 'surface', 'Add Surface Patch', 'SurfPatch'],
  ['CYLINDER', 'cylinder', 'Add Surface Cylinder', 'SurfCylinder'],
  ['SPHERE', 'sphere', 'Add Surface Sphere', 'SurfSphere'],
  ['TORUS', 'torus', 'Add Surface Torus', 'SurfTorus'],
];

/** A primitive's spline scaled by the radius. */
export function primitiveSpline(kind: SurfacePrimitive, radius: number): Spline {
  const sp = surfacePrimitive(kind);
  for (const p of sp.points) p.co = [p.co[0] * radius, p.co[1] * radius, p.co[2] * radius, p.co[3]];
  return sp;
}

/** New surface curve data with one spline. */
export function newSurfaceData(name: string, sp: Spline): CurveData {
  const cu = newCurve(name);
  cu.dimensions = '3D';
  cu.resolution_u = 4;
  cu.resolution_v = 4;
  cu.render_resolution_u = 0;
  cu.render_resolution_v = 0;
  cu.surface = true;
  cu.splines = [sp];
  return cu;
}

registerOperators(
  PRIMS.map(([kind, id, label, name]) => ({
    idname: `surface.primitive_nurbs_surface_${id}_add`,
    label,
    description: `Construct a NURBS ${label.replace('Add Surface ', '').toLowerCase()}`,
    props: [{ id: 'radius', label: 'Radius', type: 'float' as const, default: 1, min: 0, subtype: 'distance' as const }, ...transformProps],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' || inSurfaceEdit(),
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const sp = primitiveSpline(kind, p.radius as number);
      const loc = (p.location as number[] | null) ?? [...ctx.doc.scene.cursor.location];
      if (inSurfaceEdit()) {
        // added into the edited surface, at the cursor
        const { ob, cu } = activeSurface()!;
        const rot = p.rotation ? new Matrix4().makeRotationFromEuler(new Euler(...(p.rotation as [number, number, number]))) : new Matrix4();
        const xf = world(ob).clone().invert().multiply(new Matrix4().makeTranslation(loc[0], loc[1], loc[2])).multiply(rot);
        for (const q of sp.points) {
          const t = new Vector3(q.co[0], q.co[1], q.co[2]).applyMatrix4(xf);
          q.co = [t.x, t.y, t.z, q.co[3]];
          q.select = true;
        }
        deselectAll(cu);
        cu.splines.push(sp);
        app.changed('doc', 'geometry');
        return 'FINISHED' as OpResult;
      }
      const cu = newSurfaceData(uniqueName(ctx.doc, name, 'curves'), sp);
      ctx.doc.curves[cu.id] = cu;
      const ob = newObject(name, 'SURFACE', cu.id);
      const props: Record<string, unknown> = { ...p, location: loc };
      if (p.rotation === null) delete props.rotation;
      addObjectToScene(ctx.doc, ob, props);
      if (p.enter_editmode) app.run('object.mode_set', { mode: 'EDIT' });
      return 'FINISHED' as OpResult;
    },
  })),
);

// ---------------------------------------------------------------------------
// editing

const surf = () => activeSurface()!;
const changed = () => app.changed('doc', 'geometry');
const anySelected = () => surf().cu.splines.some((sp) => sp.points.some((p) => p.select && !p.hide));
const selPoll = () => inSurfaceEdit() && anySelected();

interface SurfaceImpl {
  props?: PropDef[];
  poll?: (ctx: OpContext) => boolean;
  exec: (ctx: OpContext, p: Record<string, unknown>) => OpResult | void;
  invoke?: (ctx: OpContext, p: Record<string, unknown>) => OpResult | void;
  /** used when no curve operator with this id exists */
  label?: string;
  description?: string;
}

const impls: Record<string, SurfaceImpl> = {};
/** Give operator `id` a branch for Surface Edit Mode (or register it when it doesn't exist yet). */
function surfaceOp(id: string, impl: SurfaceImpl) {
  impls[id] = impl;
}

onAppReady(() => {
  for (const [id, impl] of Object.entries(impls)) {
    const base = operators.get(id);
    const props = [...(base?.props ?? [])];
    for (const d of impl.props ?? []) if (!props.some((x) => x.id === d.id)) props.push(d);
    const surfPoll = (ctx: OpContext) => inSurfaceEdit() && (impl.poll ? impl.poll(ctx) : true);
    const op: Operator = {
      ...(base ?? { idname: id, label: impl.label ?? id, description: impl.description }),
      props,
      poll: (ctx) => (inSurfaceEdit() ? surfPoll(ctx) : base ? (base.poll ? base.poll(ctx) : true) : false),
      exec: (ctx, p) => (inSurfaceEdit() ? impl.exec(ctx, p) : base?.exec ? base.exec(ctx, p) : 'CANCELLED'),
    };
    if (impl.invoke || base?.invoke) op.invoke = (ctx, p) => (inSurfaceEdit() ? (impl.invoke ?? impl.exec)(ctx, p) : base?.invoke ? base.invoke(ctx, p) : base?.exec ? base.exec(ctx, p) : 'CANCELLED');
    registerOperator(op);
  }
});

surfaceOp('curve.select_all', {
  exec: (_c, p) => {
    const pts = surf().cu.splines.flatMap((sp) => sp.points.filter((q) => !q.hide));
    const action = p.action === 'TOGGLE' ? (pts.some((q) => q.select) ? 'DESELECT' : 'SELECT') : p.action;
    for (const q of pts) q.select = action === 'SELECT' ? true : action === 'DESELECT' ? false : !q.select;
  },
});

surfaceOp('curve.select_row', {
  label: 'Select Control Point Row',
  description: 'Select the row of control points through the active point; using it again on the same point switches between the U and V directions',
  poll: () => !!surfaceState.active,
  exec: () => {
    const a = surfaceState.active!;
    const sp = surf().cu.splines[a.s];
    if (!sp) return 'CANCELLED';
    surfaceState.rowDir = surfaceState.rowDir === 'U' ? 'V' : 'U';
    // a 1-row spline only has its U row
    if (gridSize(sp).v === 1) surfaceState.rowDir = 'U';
    G.selectRow(sp, a.i, surfaceState.rowDir, true);
  },
});

surfaceOp('curve.select_more', { exec: () => surf().cu.splines.forEach((sp) => G.growSelection(sp, true)) });
surfaceOp('curve.select_less', { exec: () => surf().cu.splines.forEach((sp) => G.growSelection(sp, false)) });
surfaceOp('curve.select_linked', {
  exec: () => {
    for (const sp of surf().cu.splines) if (sp.points.some((q) => q.select && !q.hide)) for (const q of sp.points) if (!q.hide) q.select = true;
  },
});
surfaceOp('curve.select_linked_pick', {
  invoke: (ctx, p) => {
    const v = activeView3D();
    if (!v || !ctx.event) return 'CANCELLED';
    const r = v.el.getBoundingClientRect();
    const hit = pickSurfacePoint(v, ctx.event.x - r.left, ctx.event.y - r.top, 40);
    if (!hit) return 'CANCELLED';
    for (const q of surf().cu.splines[hit.s].points) if (!q.hide) q.select = !p.deselect;
  },
  exec: (_c, p) => {
    const s = p.spline as number;
    const sp = surf().cu.splines[s];
    if (!sp) return 'CANCELLED';
    for (const q of sp.points) if (!q.hide) q.select = !p.deselect;
  },
});
surfaceOp('curve.select_random', {
  exec: (_c, p) => {
    let s = ((p.seed as number) * 7919 + 1) % 2147483647 || 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (const sp of surf().cu.splines) for (const q of sp.points) if (!q.hide && rnd() < (p.ratio as number)) q.select = p.action !== 'DESELECT';
  },
});

surfaceOp('curve.hide', {
  exec: (_c, p) => {
    let n = 0;
    for (const sp of surf().cu.splines)
      for (const q of sp.points)
        if (!q.hide && (p.unselected ? !q.select : q.select)) {
          q.hide = true;
          q.select = false;
          n++;
        }
    if (!n) return 'CANCELLED';
  },
});
surfaceOp('curve.reveal', {
  exec: (_c, p) => {
    for (const sp of surf().cu.splines) {
      sp.hide = false;
      for (const q of sp.points)
        if (q.hide) {
          q.hide = false;
          q.select = p.select !== false;
        }
    }
  },
});

surfaceOp('curve.delete', {
  poll: selPoll,
  exec: () => {
    const { cu } = surf();
    let any = false;
    cu.splines = cu.splines.filter((sp) => {
      const r = G.deleteRows(sp);
      if (r === false) {
        any = true;
        return false;
      }
      if (r) any = true;
      return true;
    });
    if (!any) {
      app.report('WARNING', 'Select whole rows or columns of control points to delete them');
      return 'CANCELLED';
    }
    surfaceState.active = null;
    changed();
  },
});

surfaceOp('curve.extrude_move', {
  poll: selPoll,
  invoke: (ctx) => {
    if (!extrude()) return 'CANCELLED';
    app.pushUndo('Extrude');
    app.flush();
    return startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude' }) ? 'RUNNING_MODAL' : 'FINISHED';
  },
  exec: () => (extrude() ? 'FINISHED' : 'CANCELLED'),
});
surfaceOp('curve.extrude', {
  label: 'Extrude',
  description: 'Extrude the selected boundary row of control points (the copies become the selection)',
  props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATION', items: [['TRANSLATION', 'Translation']] }],
  poll: selPoll,
  exec: () => (extrude() ? 'FINISHED' : 'CANCELLED'),
});
function extrude(): boolean {
  let ok = false;
  for (const sp of surf().cu.splines) if (G.extrudeEdge(sp)) ok = true;
  if (!ok) app.report('WARNING', 'Select a whole boundary row of control points to extrude');
  else changed();
  return ok;
}

surfaceOp('curve.subdivide', {
  poll: selPoll,
  exec: (_c, p) => {
    let ok = false;
    for (const sp of surf().cu.splines) if (gridSize(sp).v === 1 ? G.subdivideRow(sp, p.number_cuts as number) : G.subdivideGrid(sp, p.number_cuts as number)) ok = true;
    if (!ok) return 'CANCELLED';
    changed();
  },
});

surfaceOp('curve.duplicate_move', {
  poll: selPoll,
  invoke: (ctx) => {
    if (!duplicate()) return 'CANCELLED';
    app.pushUndo('Duplicate');
    app.flush();
    return startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate' }) ? 'RUNNING_MODAL' : 'FINISHED';
  },
  exec: () => (duplicate() ? 'FINISHED' : 'CANCELLED'),
});
function duplicate(): boolean {
  const { cu } = surf();
  const copies = cu.splines.map(G.duplicateRect).filter((x): x is Spline => !!x);
  if (!copies.length) {
    app.report('WARNING', 'Select a rectangle of control points to duplicate');
    return false;
  }
  deselectAll(cu);
  cu.splines.push(...copies);
  changed();
  return true;
}

surfaceOp('curve.cyclic_toggle', {
  props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'CYCLIC_U', items: [['CYCLIC_U', 'Cyclic U'], ['CYCLIC_V', 'Cyclic V']] }],
  poll: selPoll,
  exec: (_c, p) => {
    for (const sp of surf().cu.splines) {
      if (!sp.points.some((q) => q.select && !q.hide)) continue;
      if (p.direction === 'CYCLIC_V' && gridSize(sp).v > 1) sp.use_cyclic_v = !sp.use_cyclic_v;
      else if (p.direction !== 'CYCLIC_V') sp.use_cyclic_u = !sp.use_cyclic_u;
    }
    changed();
  },
});

surfaceOp('curve.switch_direction', {
  poll: selPoll,
  exec: () => {
    for (const sp of surf().cu.splines) if (sp.points.some((q) => q.select && !q.hide)) G.switchDirection(sp);
    changed();
  },
});

surfaceOp('curve.spline_weight_set', {
  poll: selPoll,
  exec: (_c, p) => {
    for (const sp of surf().cu.splines) for (const q of sp.points) if (q.select && !q.hide) q.co = [q.co[0], q.co[1], q.co[2], p.weight as number];
    changed();
  },
});

surfaceOp('curve.separate', {
  poll: selPoll,
  exec: (ctx) => {
    const { ob, cu } = surf();
    const moving = cu.splines.filter((sp) => sp.points.every((q) => q.select || q.hide) && sp.points.some((q) => q.select));
    if (!moving.length) {
      app.report('ERROR', 'Select whole surfaces (L) to separate them');
      return 'CANCELLED';
    }
    if (moving.length === cu.splines.length) {
      app.report('ERROR', 'Cannot separate the whole surface');
      return 'CANCELLED';
    }
    cu.splines = cu.splines.filter((sp) => !moving.includes(sp));
    for (const sp of moving) for (const q of sp.points) q.select = false;
    const nc = newSurfaceData(uniqueName(ctx.doc, cu.name, 'curves'), moving[0]);
    nc.splines = moving;
    nc.materials = [...cu.materials];
    nc.resolution_u = cu.resolution_u;
    nc.resolution_v = cu.resolution_v;
    ctx.doc.curves[nc.id] = nc;
    const no = newObject(uniqueName(ctx.doc, ob.name), 'SURFACE', nc.id);
    no.location = [...ob.location] as Vec3;
    no.rotation_euler = [...ob.rotation_euler] as Vec3;
    no.rotation_quaternion = [...ob.rotation_quaternion] as typeof no.rotation_quaternion;
    no.rotation_mode = ob.rotation_mode;
    no.scale = [...ob.scale] as Vec3;
    no.parent = ob.parent;
    no.matrix_parent_inverse = [...ob.matrix_parent_inverse];
    ctx.doc.objects[no.id] = no;
    ctx.doc.object_order.push(no.id);
    for (const c of Object.values(ctx.doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(no.id);
    surfaceState.active = null;
    changed();
  },
});

surfaceOp('curve.spin', {
  label: 'Spin',
  description: 'Revolve the selected row of control points (or a whole one-row surface) around the 3D cursor and the view axis into a closed surface',
  props: [
    { id: 'center', label: 'Center', type: 'vec3', default: null, subtype: 'distance' },
    { id: 'axis', label: 'Axis', type: 'vec3', default: null, subtype: 'xyz' },
  ],
  poll: selPoll,
  exec: (ctx, p) => {
    const { ob, cu } = surf();
    const v = activeView3D();
    const center = (p.center as number[] | null) ?? [...ctx.doc.scene.cursor.location];
    const axis = (p.axis as number[] | null) ?? (v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion).toArray() : [0, 0, 1]);
    p.center = center;
    p.axis = axis;
    const inv = world(ob).clone().invert();
    const c = new Vector3(...(center as [number, number, number])).applyMatrix4(inv);
    const ax = new Vector3(...(axis as [number, number, number])).transformDirection(inv);
    let done = false;
    for (const sp of cu.splines) {
      const { u, v: nv } = gridSize(sp);
      // the profile: a fully selected U row (a one-row spline is its own row)
      const { rowsV } = G.fullRows(sp);
      if (!rowsV.length) continue;
      const row = G.rowIndices(sp, 'U', rowsV[0]).map((i) => sp.points[i]);
      const rows = G.spinRow(row, [c.x, c.y, c.z], [ax.x, ax.y, ax.z]);
      if (nv !== 1) continue;
      sp.points = rows.flat();
      sp.point_count_u = u;
      sp.point_count_v = 8;
      sp.use_cyclic_v = true;
      sp.order_v = 3;
      sp.use_endpoint_v = true;
      sp.use_bezier_v = true;
      sp.resolution_v = sp.resolution_v || cu.resolution_v || 4;
      done = true;
    }
    if (!done) {
      app.report('WARNING', 'Spin works on surfaces that are a single row of control points, all selected');
      return 'CANCELLED';
    }
    changed();
  },
});

surfaceOp('curve.select_similar', {
  poll: selPoll,
  exec: (_c, p) => {
    const { cu } = surf();
    const pts = cu.splines.flatMap((sp) => sp.points.map((q) => ({ q, sp })));
    const value = (x: { q: SplinePoint; sp: Spline }) => (p.type === 'RADIUS' ? x.q.radius : p.type === 'WEIGHT' ? x.q.co[3] : p.type === 'TYPE' ? (x.sp.order_u ?? 0) * 1000 + (x.sp.order_v ?? 0) : 0);
    const ref = pts.filter((x) => x.q.select && !x.q.hide).map(value);
    if (!ref.length) return 'CANCELLED';
    const th = p.threshold as number;
    for (const x of pts) {
      if (x.q.hide) continue;
      const v = value(x);
      const hit = ref.some((r) => (p.compare === 'GREATER' ? v >= r - th : p.compare === 'LESS' ? v <= r + th : Math.abs(v - r) <= th));
      if (hit) x.q.select = true;
    }
  },
});

surfaceOp('curve.select_nth', {
  poll: selPoll,
  exec: (_c, p) => {
    // checker pattern over the grid: runs of `nth` selected, `skip` deselected, counted along U + V
    const skip = Math.max(1, p.skip as number),
      nth = Math.max(1, p.nth as number),
      off = (p.offset as number) | 0;
    for (const sp of surf().cu.splines)
      sp.points.forEach((q, i) => {
        if (!q.select || q.hide) return;
        const [u, v] = G.guv(sp, i);
        const k = (((u + v + off) % (skip + nth)) + skip + nth) % (skip + nth);
        if (k >= nth) q.select = false;
      });
  },
});

