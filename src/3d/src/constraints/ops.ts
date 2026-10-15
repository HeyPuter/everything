// Operators on single constraints of the active object or active pose bone (Properties editor
// panel menus, hover shortcuts) and on constraint-specific settings.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type Operator, type PropDef } from '../app/app';
import type { Constraint, ObjectData } from '../data/types';
import { uid } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { availableConstraintTypes, constraintHasTarget, constraintTypes, newConstraint, uniqueConstraintName } from '../eval/constraints';
import { boneBaseMatrix, solveConstraint, solveObjectConstraints, makeTargetWorld, type SpaceInfo } from '../eval/constraint_solve';
import { applyMatrixToObject, poseBoneMatrix, setRotationFromQuaternion } from '../eval/transform';
import { ensureAction, ensureFCurve } from '../anim/keyframes';
import { insertKeyframe } from '../anim/fcurve';
import { openMenu } from '../ui/menu';
import type { ArmatureTarget } from '../eval/constraints_more';

export interface ConstraintRef {
  ob: ObjectData;
  list: Constraint[];
  /** pose bone name for bone constraints */
  bone?: string;
}

/** Constraint list of the active object (OBJECT) or of its active pose bone (BONE). */
export function constraintOwner(owner: unknown = 'OBJECT'): ConstraintRef | null {
  const ob = app.activeObject;
  if (!ob) return null;
  if (owner === 'BONE') {
    const arm = ob.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined;
    const bone = arm?.active_bone ?? undefined;
    const pb = bone ? ob.pose?.[bone] : undefined;
    return pb && bone ? { ob, list: pb.constraints, bone } : null;
  }
  return { ob, list: ob.constraints };
}

function find(p: Record<string, unknown>) {
  const ref = constraintOwner(p.owner);
  if (!ref) return null;
  const i = ref.list.findIndex((c) => c.name === p.constraint);
  return i < 0 ? null : { ...ref, c: ref.list[i], i };
}

const OWNER_PROP = { id: 'owner', label: 'Owner', type: 'enum' as const, default: 'OBJECT', items: [['OBJECT', 'Object'], ['BONE', 'Bone']] as [string, string][] };
const NAME_PROP = { id: 'constraint', label: 'Constraint', type: 'string' as const, default: '' };
const REPORT_PROP = { id: 'report', label: 'Report', type: 'bool' as const, default: false, hidden: true };
const pollFound = () => !!app.activeObject;

/** Data path of a constraint relative to its object (for animation). */
export function constraintPath(c: Constraint, bone?: string) {
  const base = `constraints["${c.name.replace(/"/g, '\\"')}"]`;
  return bone ? `pose.bones["${bone.replace(/"/g, '\\"')}"].${base}` : base;
}

/** Evaluated world matrix of the constraint owner (object or pose bone). */
function ownerWorld(ref: ConstraintRef): Matrix4 | null {
  const ev = app.graph.get(ref.ob.id);
  if (!ev) return null;
  if (!ref.bone) return ev.world.clone();
  const b = ev.pose?.bones.get(ref.bone);
  return b ? ev.world.clone().multiply(b.pose) : null;
}

/** Set an object's or bone's own transform so that, before constraints, it sits at `world`. */
function setOwnerBasis(ref: ConstraintRef, world: Matrix4) {
  const ev = app.graph.get(ref.ob.id);
  if (!ev) return;
  if (!ref.bone) {
    const local = ev.parentMatrix ? ev.parentMatrix.clone().invert().multiply(world) : world.clone();
    applyMatrixToObject(ref.ob, local);
    return;
  }
  const arm = ref.ob.data ? app.doc.armatures[ref.ob.data] : undefined;
  const pb = ref.ob.pose?.[ref.bone];
  if (!arm || !pb || !ev.pose) return;
  const pose = ev.world.clone().invert().multiply(world);
  const basis = boneBaseMatrix(ev.pose.bones, arm, ref.bone).invert().multiply(pose);
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  basis.decompose(p, q, s);
  pb.location = [p.x, p.y, p.z];
  pb.scale = [s.x, s.y, s.z];
  setRotationFromQuaternion(pb, q);
}

/** Evaluate the scene now (operators that need the result of a change before continuing). */
function reevaluate() {
  app.graph.evaluate(app.doc, false);
}

const ops: Operator[] = [
  {
    idname: 'constraint.delete',
    label: 'Delete Constraint',
    description: 'Remove the constraint from the stack',
    props: [NAME_PROP, OWNER_PROP, REPORT_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      f.list.splice(f.i, 1);
      if (p.report) app.report('INFO', `Removed constraint: ${f.c.name}`);
    },
  },
  {
    idname: 'constraint.copy',
    label: 'Duplicate Constraint',
    description: 'Duplicate the constraint right below itself',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      const c = { ...cloneShared(f.c), id: uid('cn') };
      c.name = uniqueConstraintName(f.c.name, f.list);
      f.list.splice(f.i + 1, 0, c);
    },
  },
  {
    idname: 'constraint.copy_to_selected',
    label: 'Copy Constraint To Selected',
    description: 'Add a copy of the constraint to the other selected objects (or selected bones)',
    props: [NAME_PROP, OWNER_PROP],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      const lists: Constraint[][] = [];
      if (f.bone) {
        for (const [n, pb] of Object.entries(f.ob.pose ?? {})) if (pb.select && n !== f.bone) lists.push(pb.constraints);
      } else for (const o of app.selectedObjects()) if (o.id !== f.ob.id) lists.push(o.constraints);
      if (!lists.length) {
        app.report('WARNING', f.bone ? 'No other bones are selected' : 'No other objects are selected');
        return 'CANCELLED';
      }
      for (const l of lists) {
        const c = { ...cloneShared(f.c), id: uid('cn') };
        c.name = uniqueConstraintName(f.c.name, l);
        l.push(c);
      }
    },
  },
  {
    idname: 'constraint.move_up',
    label: 'Move Constraint Up',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.i === 0) return 'CANCELLED';
      f.list.splice(f.i, 1);
      f.list.splice(f.i - 1, 0, f.c);
    },
  },
  {
    idname: 'constraint.move_down',
    label: 'Move Constraint Down',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.i >= f.list.length - 1) return 'CANCELLED';
      f.list.splice(f.i, 1);
      f.list.splice(f.i + 1, 0, f.c);
    },
  },
  {
    idname: 'constraint.move_to_index',
    label: 'Move Constraint to Index',
    description: 'Change the constraint’s position in the stack',
    props: [NAME_PROP, OWNER_PROP, { id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      const to = Math.max(0, Math.min(f.list.length - 1, p.index as number));
      if (to === f.i) return 'CANCELLED';
      f.list.splice(f.i, 1);
      f.list.splice(to, 0, f.c);
    },
  },
  {
    idname: 'constraint.apply',
    label: 'Apply Constraint',
    description: 'Bake the constraint’s effect into the owner’s transform and remove it',
    props: [NAME_PROP, OWNER_PROP, REPORT_PROP],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      if (constraintTypes[f.c.type]?.boneOnly) {
        app.report('ERROR', `${f.c.name} cannot be applied`);
        return 'CANCELLED';
      }
      const ev = app.graph.get(f.ob.id);
      if (!ev) return 'CANCELLED';
      if (!f.bone) {
        // the owner without its constraints, then only this one
        const m = ev.worldBasis.clone();
        solveObjectConstraints(app.graph, app.doc, f.ob, m, ev.parentMatrix ?? null, [f.c]);
        f.list.splice(f.i, 1);
        setOwnerBasis(f, m);
      } else {
        // pose of the bone without its own constraints, then only this one
        const saved = f.list.slice();
        f.list.length = 0;
        reevaluate();
        const ev2 = app.graph.get(f.ob.id)!;
        const arm = app.doc.armatures[f.ob.data!];
        const bones = ev2.pose?.bones;
        const b = bones?.get(f.bone);
        f.list.push(...saved);
        if (!bones || !b || !arm) return 'CANCELLED';
        const world = ev2.world.clone().multiply(b.pose);
        const pchan = { name: f.bone, bones, arm, armWorld: ev2.world.clone() };
        const ctx = { doc: app.doc, graph: app.graph, ob: f.ob, frame: app.graph.frame, pchan, targetWorld: makeTargetWorld(app.graph, f.ob, pchan) };
        const info: SpaceInfo = { kind: 'BONE', armWorld: ev2.world, bones, arm, name: f.bone };
        solveConstraint(world, f.c, ctx, info);
        f.list.splice(f.list.indexOf(f.c), 1);
        setOwnerBasis(f, world);
      }
      if (p.report) app.report('INFO', `Applied constraint: ${f.c.name}`);
    },
  },
  {
    idname: 'constraint.disable_keep_transform',
    label: 'Disable and Keep Transform',
    description: 'Turn the constraint’s influence to zero while keeping the owner where it is (other constraints still apply)',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f) return 'CANCELLED';
      const target = ownerWorld(f);
      f.c.influence = 0;
      if (!target) return;
      // adjust the owner's own transform until the remaining stack lands where it was
      for (let it = 0; it < 4; it++) {
        reevaluate();
        const cur = ownerWorld(f);
        const ev = app.graph.get(f.ob.id);
        if (!cur || !ev) break;
        if (cur.elements.every((v, i) => Math.abs(v - target.elements[i]) < 1e-6)) break;
        const basis = f.bone ? ev.world.clone().multiply(basePoseOf(f) ?? new Matrix4()) : ev.worldBasis.clone();
        setOwnerBasis(f, target.clone().multiply(cur.clone().invert()).multiply(basis));
      }
    },
  },
  {
    idname: 'constraint.childof_set_inverse',
    label: 'Set Inverse',
    description: 'Keep the owner where it is now by storing the parent’s inverse transform',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.c.type !== 'CHILD_OF') return 'CANCELLED';
      f.c.set_inverse_pending = true;
      reevaluate();
    },
  },
  {
    idname: 'constraint.childof_clear_inverse',
    label: 'Clear Inverse',
    description: 'Forget the stored parent inverse: the owner follows the parent from its origin',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.c.type !== 'CHILD_OF') return 'CANCELLED';
      f.c.set_inverse_pending = false;
      f.c.inverse_matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    },
  },
  {
    idname: 'constraint.limitdistance_reset',
    label: 'Reset Distance',
    description: 'Measure the limit distance again from the current positions',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.c.type !== 'LIMIT_DISTANCE') return 'CANCELLED';
      f.c.distance = 0;
    },
  },
  {
    idname: 'constraint.stretchto_reset',
    label: 'Reset Original Length',
    description: 'Measure the rest length again from the current distance to the target',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.c.type !== 'STRETCH_TO') return 'CANCELLED';
      f.c.rest_length = 0;
    },
  },
  {
    idname: 'constraint.followpath_path_animate',
    label: 'Animate Path',
    description: 'Key the target curve’s evaluation time so the owner travels along the path over the given frames',
    props: [NAME_PROP, OWNER_PROP, { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1 }, { id: 'length', label: 'Length', type: 'int', default: 100, min: 1 }],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      const cob = f && f.c.type === 'FOLLOW_PATH' ? app.doc.objects[f.c.target as string] : undefined;
      const cu = cob?.type === 'CURVE' && cob.data ? app.doc.curves[cob.data] : undefined;
      if (!cob || !cu) {
        app.report('ERROR', 'Follow Path needs a curve target');
        return 'CANCELLED';
      }
      const start = p.frame_start as number,
        len = Math.max(1, p.length as number);
      cu.path_duration = len;
      cu.eval_time = 0;
      const act = ensureAction(app.doc, cob);
      const fc = ensureFCurve(act, 'data.eval_time', 0);
      fc.keyframe_points = [];
      insertKeyframe(fc, start, 0, { interpolation: 'LINEAR' });
      insertKeyframe(fc, start + len, len, { interpolation: 'LINEAR' });
      fc.extrapolation = 'LINEAR';
    },
  },
  {
    idname: 'constraint.add_target',
    label: 'Add Target Bone',
    description: 'Add a bone target to the Armature constraint',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      if (!f || f.c.type !== 'ARMATURE') return 'CANCELLED';
      const ts = ((f.c.targets as ArmatureTarget[]) ?? []).slice();
      // prefill with the armature the last target uses (or the owner's parent armature)
      const last = ts[ts.length - 1];
      const par = f.ob.parent ? app.doc.objects[f.ob.parent] : undefined;
      ts.push({ target: last?.target ?? (par?.type === 'ARMATURE' ? par.id : null), subtarget: '', weight: 1 });
      f.c.targets = ts;
    },
  },
  {
    idname: 'constraint.remove_target',
    label: 'Remove Target',
    description: 'Remove a bone target from the Armature constraint',
    props: [NAME_PROP, OWNER_PROP, { id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      const ts = (f?.c.targets as ArmatureTarget[]) ?? [];
      if (!f || f.c.type !== 'ARMATURE' || !ts[p.index as number]) return 'CANCELLED';
      f.c.targets = ts.filter((_, i) => i !== p.index);
    },
  },
  {
    idname: 'constraint.normalize_target_weights',
    label: 'Normalize Weights',
    description: 'Scale the target weights so they add up to one',
    props: [NAME_PROP, OWNER_PROP],
    poll: pollFound,
    exec: (_ctx, p) => {
      const f = find(p);
      const ts = (f?.c.targets as ArmatureTarget[]) ?? [];
      const total = ts.reduce((a, t) => a + Math.max(0, t.weight), 0);
      if (!f || !total) return 'CANCELLED';
      f.c.targets = ts.map((t) => ({ ...t, weight: Math.max(0, t.weight) / total }));
    },
  },
];

/** A bone's pose before its own constraints (armature space). */
function basePoseOf(f: ConstraintRef): Matrix4 | null {
  const ev = app.graph.get(f.ob.id);
  const arm = f.ob.data ? app.doc.armatures[f.ob.data] : undefined;
  const pb = f.bone ? f.ob.pose?.[f.bone] : undefined;
  if (!ev?.pose || !arm || !pb || !f.bone) return null;
  return boneBaseMatrix(ev.pose.bones, arm, f.bone).multiply(poseBoneMatrix(pb));
}

// ---------------------------------------------------------------------------
// Adding constraints

/** Constraint type property (items follow the registry, which feature modules extend). */
function typeProp(bone: boolean): PropDef {
  return {
    id: 'type',
    label: 'Type',
    type: 'enum',
    default: 'COPY_LOCATION',
    get items() {
      return availableConstraintTypes(bone).map((t) => [t.type, t.label] as [string, string]);
    },
  };
}

function typeMenu(op: string, bone: boolean) {
  return availableConstraintTypes(bone).map((t) => ({ label: t.label, op, props: { type: t.type } }));
}

const addOps: Operator[] = [
  {
    idname: 'object.constraint_add',
    label: 'Add Constraint',
    description: 'Add a constraint to the active object',
    props: [typeProp(false)],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const t = constraintTypes[p.type as string];
      if (!t || t.boneOnly) return 'CANCELLED';
      ob.constraints.push(newConstraint(t.type, uid('cn'), ob.constraints));
    },
  },
  {
    idname: 'object.constraint_add_with_targets',
    label: 'Add Constraint (with Targets)',
    description: 'Add a constraint to the active object, targeting the other selected object',
    props: [typeProp(false)],
    poll: () => !!app.activeObject,
    invoke: () => {
      openMenu(typeMenu('object.constraint_add_with_targets', false), { x: app.pointer.x, y: app.pointer.y }, { title: 'Add Constraint (with Targets)' });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const t = constraintTypes[p.type as string];
      if (!t || t.boneOnly) return 'CANCELLED';
      const c = newConstraint(t.type, uid('cn'), ob.constraints);
      const other = app.selectedObjects().find((o) => o.id !== ob.id);
      if (other) setTarget(c, other);
      ob.constraints.push(c);
    },
  },
  {
    idname: 'pose.constraint_add',
    label: 'Add Bone Constraint',
    description: 'Add a constraint to the active bone',
    props: [typeProp(true)],
    poll: () => app.activeObject?.type === 'ARMATURE' && !!constraintOwner('BONE'),
    exec: (_ctx, p) => {
      const ref = constraintOwner('BONE');
      if (!ref || !constraintTypes[p.type as string]) return 'CANCELLED';
      ref.list.push(newConstraint(p.type as string, uid('cn'), ref.list));
    },
  },
];

/** Point a new constraint at an object (Armature constraints get it as a bone target list entry). */
export function setTarget(c: Constraint, other: ObjectData, bone?: string) {
  if (c.type === 'ARMATURE') {
    if (other.type === 'ARMATURE') c.targets = [{ target: other.id, subtarget: bone ?? '', weight: 1 }];
    return;
  }
  if (!constraintHasTarget(c.type)) return;
  c.target = other.id;
  if (bone) c.subtarget = bone;
}

registerOperators([...ops, ...addOps]);
