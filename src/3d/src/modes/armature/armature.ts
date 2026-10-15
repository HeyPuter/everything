// Armature Edit Mode and Pose Mode: bone selection, transforms, operators, menus.
import { Matrix4, Quaternion, Vector3, Matrix3 } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import { h } from '../../ui/h';
import type { ArmatureData, Bone, ObjectData, PoseBone } from '../../data/types';
import { transformProviders, startTransform, type TElement } from '../../ops/transform';
import { defaultPoseBone, boneRestMatrix } from '../../eval/armature';
import { setRotationFromQuaternion, poseBoneMatrix } from '../../eval/transform';
import { modeMenus } from '../../editors/view3d/modemenus';
import { addKeys } from '../../app/keymap';
import type { MenuItem } from '../../ui/menu';
import { openMenu, promptText } from '../../ui/menu';
import { newConstraint } from '../../eval/constraints';
import { uid } from '../../data/defaults';
import { setGizmoCenterHook, gizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks } from '../../ops/view3d';
import { Box3 } from 'three';
import { modeHandlers } from '../../ops/modes';
import { insertKeyframesForObjects } from '../../anim/keyframes';
import { boneVisible, newBoneLike, flipSideName, bonePath, uniqueBoneName as kUniqueBoneName } from './armkernels';
import { inSelectRegion } from '../../editors/view3d/selectshapes';
import type { SelectRegion } from '../../editors/view3d/hooks';

const V = (a: number[]) => new Vector3(a[0], a[1], a[2]);

export function activeArmature(): { ob: ObjectData; arm: ArmatureData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'ARMATURE' || !ob.data) return null;
  const arm = app.doc.armatures[ob.data];
  return arm ? { ob, arm } : null;
}

const inArmEdit = () => app.doc.mode === 'EDIT' && !!activeArmature();
const inPose = () => app.doc.mode === 'POSE' && !!activeArmature();

/** Bones created by Extrude Forked: their mirrored twins follow during the next transform. */
export const forkedMirror = new Set<string>();

function world(ob: ObjectData) {
  return app.graph.get(ob.id)?.world ?? new Matrix4();
}

/** World-space head/tail of a bone: rest (edit mode) or posed. */
function bonePoints(ob: ObjectData, b: Bone, posed: boolean): [Vector3, Vector3] {
  const w = world(ob);
  if (posed) {
    const ev = app.graph.get(ob.id)?.pose?.bones.get(b.name);
    if (ev) {
      const head = new Vector3().setFromMatrixPosition(ev.pose).applyMatrix4(w);
      const tail = new Vector3(0, ev.length, 0).applyMatrix4(ev.pose).applyMatrix4(w);
      return [head, tail];
    }
  }
  return [V(b.head).applyMatrix4(w), V(b.tail).applyMatrix4(w)];
}

// ---------------------------------------------------------------------------
// picking & selection

function pickBone(v: View3D, x: number, y: number, posed: boolean): { bone: Bone; part: 'HEAD' | 'TAIL' | 'BODY'; d: number } | null {
  const a = activeArmature();
  if (!a) return null;
  let best: { bone: Bone; part: 'HEAD' | 'TAIL' | 'BODY'; d: number } | null = null;
  for (const b of a.arm.bones) {
    if (!boneVisible(a.arm, b)) continue;
    const [hw, tw] = bonePoints(a.ob, b, posed);
    const hs = v.project(hw),
      ts = v.project(tw);
    if (!posed) {
      const dh = Math.hypot(hs.x - x, hs.y - y),
        dt = Math.hypot(ts.x - x, ts.y - y);
      if (dh < 10 && (!best || dh < best.d)) best = { bone: b, part: 'HEAD', d: dh };
      if (dt < 10 && (!best || dt < best.d)) best = { bone: b, part: 'TAIL', d: dt };
    }
    const dx = ts.x - hs.x,
      dy = ts.y - hs.y,
      l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - hs.x) * dx + (y - hs.y) * dy) / l2));
    const d = Math.hypot(hs.x + dx * t - x, hs.y + dy * t - y) + 2;
    const width = Math.max(6, Math.sqrt(l2) * 0.1);
    if (d < width && (!best || d < best.d)) best = { bone: b, part: 'BODY', d };
  }
  return best;
}

function selectBone(b: Bone, part: 'HEAD' | 'TAIL' | 'BODY', on: boolean) {
  if (part === 'BODY' || part === 'HEAD') b.select_head = on;
  if (part === 'BODY' || part === 'TAIL') b.select_tail = on;
  b.select = !!(b.select_head && b.select_tail) || (part === 'BODY' && on);
}

editModeHooks.pick.push((v, x, y, o) => {
  const a = activeArmature();
  if (!a || (app.doc.mode !== 'EDIT' && app.doc.mode !== 'POSE')) return false;
  const posed = app.doc.mode === 'POSE';
  const hit = pickBone(v, x, y, posed);
  if (posed) {
    if (!o.extend) for (const pb of Object.values(a.ob.pose ?? {})) pb.select = false;
    if (hit) {
      a.ob.pose ??= {};
      const pb = (a.ob.pose[hit.bone.name] ??= defaultPoseBone());
      pb.select = o.toggle && pb.select && a.arm.active_bone === hit.bone.name ? false : true;
      a.arm.active_bone = hit.bone.name;
    }
  } else {
    // Ctrl+click: select the bones on the hierarchy path from the active bone
    const ev = window.event as PointerEvent | undefined;
    const act = a.arm.bones.find((b) => b.name === a.arm.active_bone);
    if (ev?.ctrlKey && !ev.shiftKey && hit && act && act !== hit.bone) {
      const path = bonePath(a.arm, act, hit.bone);
      if (path.length) {
        for (const b of path) b.select = b.select_head = b.select_tail = true;
        a.arm.active_bone = hit.bone.name;
        app.pushUndo('Pick Shortest Path');
        app.changed('select', 'doc');
        return true;
      }
    }
    if (!o.extend) for (const b of a.arm.bones) b.select = b.select_head = b.select_tail = false;
    if (hit) {
      const on = !(o.toggle && hit.bone.select && a.arm.active_bone === hit.bone.name);
      selectBone(hit.bone, hit.part, on);
      // connected children share the tail/head joint
      if (hit.part !== 'BODY') syncConnected(a.arm);
      a.arm.active_bone = hit.bone.name;
    }
  }
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function syncConnected(arm: ArmatureData) {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  for (const b of arm.bones)
    if (b.use_connect && b.parent) {
      const p = byName.get(b.parent);
      if (p && (p.select_tail || b.select_head)) p.select_tail = b.select_head = !!(p.select_tail || b.select_head);
    }
}

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const a = activeArmature();
  if (!a || (app.doc.mode !== 'EDIT' && app.doc.mode !== 'POSE')) return false;
  const posed = app.doc.mode === 'POSE';
  const inside = (p: { x: number; y: number; z: number }) => p.z <= 1 && inSelectRegion(r, p.x, p.y);
  const apply = (cur: boolean, hit: boolean) => (mode === 'SET' ? hit : mode === 'ADD' ? cur || hit : mode === 'SUB' ? cur && !hit : mode === 'AND' ? cur && hit : cur !== hit);
  for (const b of a.arm.bones) {
    if (!boneVisible(a.arm, b)) continue;
    const [hw, tw] = bonePoints(a.ob, b, posed);
    const hi = inside(v.project(hw)),
      ti = inside(v.project(tw));
    if (posed) {
      a.ob.pose ??= {};
      const pb = (a.ob.pose[b.name] ??= defaultPoseBone());
      pb.select = apply(!!pb.select, hi && ti);
    } else {
      b.select_head = apply(!!b.select_head, hi);
      b.select_tail = apply(!!b.select_tail, ti);
      b.select = !!(b.select_head && b.select_tail);
    }
  }
  if (!posed) syncConnected(a.arm);
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select'));
editModeHooks.region.push((v, r, mode) => regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select'));

// joints & selection overlay in edit mode (pose mode colors come from draw.ts)
editModeHooks.svg.push((v) => {
  if (!inArmEdit()) return null;
  const a = activeArmature()!;
  const parts = a.arm.bones
    .filter((b) => boneVisible(a.arm, b))
    .map((b) => {
      const [hw, tw] = bonePoints(a.ob, b, false);
      const hs = v.project(hw),
        ts = v.project(tw);
      const active = a.arm.active_bone === b.name;
      const col = (s?: boolean) => (s ? (active ? '#ffffff' : '#ff8500') : '#111');
      return h(
        'g',
        { key: b.name },
        b.select ? h('line', { x1: hs.x, y1: hs.y, x2: ts.x, y2: ts.y, stroke: active ? '#fff' : '#ff8500', 'stroke-width': 2.5, opacity: 0.8 }) : null,
        h('circle', { cx: hs.x, cy: hs.y, r: 4.5, fill: col(b.select_head), stroke: '#000', 'stroke-width': 0.8 }),
        h('circle', { cx: ts.x, cy: ts.y, r: 4.5, fill: col(b.select_tail), stroke: '#000', 'stroke-width': 0.8 }),
        a.arm.show_names ? h('text', { x: (hs.x + ts.x) / 2 + 6, y: (hs.y + ts.y) / 2, fill: '#fff', 'font-size': 11 }, b.name) : null,
      );
    });
  return h('g', { class: 'arm-edit' }, parts);
});

// ---------------------------------------------------------------------------
// transforms

transformProviders.push({
  collect() {
    const a = activeArmature();
    if (!a) return null;
    if (app.doc.mode === 'EDIT') {
      const w = world(a.ob),
        inv = w.clone().invert();
      const els: TElement[] = [];
      const joints: { b: Bone; key: 'head' | 'tail' }[] = [];
      for (const b of a.arm.bones) {
        if (!boneVisible(a.arm, b)) continue;
        if (b.select_head) joints.push({ b, key: 'head' });
        if (b.select_tail) joints.push({ b, key: 'tail' });
      }
      if (!joints.length) return null;
      const before = a.arm.bones.map((b) => ({ head: [...b.head], tail: [...b.tail] }));
      const byName = new Map(a.arm.bones.map((b) => [b.name, b]));
      const selectedJoint = (b: Bone, key: 'head' | 'tail') => joints.some((j) => j.b === b && j.key === key);
      /** move a joint and the joints connected to it */
      const place = (b: Bone, key: 'head' | 'tail', p: Vector3) => {
        b[key] = [p.x, p.y, p.z];
        if (key === 'head' && b.use_connect && b.parent) {
          const par = byName.get(b.parent);
          if (par) par.tail = [p.x, p.y, p.z];
        }
        if (key === 'tail') for (const c of a.arm.bones) if (c.parent === b.name && c.use_connect) c.head = [p.x, p.y, p.z];
      };
      const mirrorX = !!a.arm.use_mirror_x || forkedMirror.size > 0;
      for (const j of joints) {
        const p0 = V(j.b[j.key]).applyMatrix4(w);
        // X-Axis Mirror: the counterpart joint (Bone.L ↔ Bone.R) follows, mirrored
        const twinName = mirrorX && (a.arm.use_mirror_x || forkedMirror.has(j.b.name)) ? flipSideName(j.b.name) : null;
        const twin = twinName && twinName !== j.b.name ? byName.get(twinName) : undefined;
        const followTwin = twin && !selectedJoint(twin, j.key) ? twin : undefined;
        els.push({
          center: p0,
          basis: new Matrix3().setFromMatrix4(w),
          weight: 1,
          apply(m: Matrix4) {
            const p = p0.clone().applyMatrix4(m).applyMatrix4(inv);
            place(j.b, j.key, p);
            if (followTwin) place(followTwin, j.key, new Vector3(-p.x, p.y, p.z));
          },
          restore() {
            a.arm.bones.forEach((b, i) => {
              b.head = [...before[i].head] as [number, number, number];
              b.tail = [...before[i].tail] as [number, number, number];
            });
          },
        });
      }
      const actBone = a.arm.bones.find((b) => b.name === a.arm.active_bone && (b.select_head || b.select_tail));
      return { elements: els, active: actBone ? V(actBone.head).applyMatrix4(w) : undefined, label: 'Bones', finish: () => forkedMirror.clear(), cancel: () => forkedMirror.clear(), onUpdate: () => app.changed('doc') };
    }
    if (app.doc.mode === 'POSE' && a.ob.pose) {
      const ev = app.graph.get(a.ob.id);
      if (!ev?.pose) return null;
      const w = world(a.ob);
      const selected = Object.entries(a.ob.pose).filter(([name, pb]) => pb.select && a.arm.bones.some((b) => b.name === name && boneVisible(a.arm, b)));
      // only the top-most selected bones of each chain transform (children follow)
      const selNames = new Set(selected.map(([n]) => n));
      const byName = new Map(a.arm.bones.map((b) => [b.name, b]));
      const hasSelAncestor = (n: string) => {
        let p = byName.get(n)?.parent;
        while (p) {
          if (selNames.has(p)) return true;
          p = byName.get(p)?.parent;
        }
        return false;
      };
      const els: TElement[] = [];
      for (const [name, pb] of selected) {
        if (hasSelAncestor(name)) continue;
        const be = ev.pose.bones.get(name);
        if (!be) continue;
        const bone = byName.get(name)!;
        const poseWorld = w.clone().multiply(be.pose);
        // parent space of the bone (pose matrix without its own local transform)
        const parentSpace = w.clone().multiply(be.pose).multiply(localPoseMatrix(pb).invert());
        const parentInv = parentSpace.clone().invert();
        const before = structuredClone(pb);
        const p = new Vector3(),
          q = new Quaternion(),
          s = new Vector3();
        poseWorld.decompose(p, q, s);
        els.push({
          center: p,
          basis: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q)),
          weight: 1,
          apply(m: Matrix4) {
            const nw = m.clone().multiply(poseWorld);
            const local = parentInv.clone().multiply(nw);
            const lp = new Vector3(),
              lq = new Quaternion(),
              ls = new Vector3();
            local.decompose(lp, lq, ls);
            Object.assign(pb, structuredClone(before));
            if (!bone.use_connect) pb.location = [lp.x, lp.y, lp.z];
            pb.scale = [ls.x, ls.y, ls.z];
            setRotationFromQuaternion(pb as never, lq);
          },
          restore() {
            Object.assign(pb, structuredClone(before));
          },
        });
      }
      if (!els.length) return null;
      return {
        elements: els,
        label: 'Pose',
        finish() {
          if (app.doc.scene.tool_settings.use_keyframe_insert_auto) insertKeyframesForObjects([a.ob], 'Available');
        },
        cancel() {},
        onUpdate: () => app.changed('doc'),
      };
    }
    return null;
  },
});

function localPoseMatrix(pb: PoseBone): Matrix4 {
  return poseBoneMatrix(pb, new Matrix4());
}

const prevGizmoHook = gizmoCenterHook;
setGizmoCenterHook(() => {
    const a = activeArmature();
    if (a && (app.doc.mode === 'EDIT' || app.doc.mode === 'POSE')) {
      const pts: Vector3[] = [];
      for (const b of a.arm.bones) {
        const [hw, tw] = bonePoints(a.ob, b, app.doc.mode === 'POSE');
        if (app.doc.mode === 'POSE') {
          if (a.ob.pose?.[b.name]?.select) pts.push(hw);
        } else {
          if (b.select_head) pts.push(hw);
          if (b.select_tail) pts.push(tw);
        }
      }
      if (!pts.length) return null;
      const c = new Vector3();
      pts.forEach((p) => c.add(p));
      return { center: c.multiplyScalar(1 / pts.length) };
    }
    return prevGizmoHook?.() ?? null;
});

frameHooks.unshift(() => {
  const a = activeArmature();
  if (!a || (app.doc.mode !== 'EDIT' && app.doc.mode !== 'POSE')) return null;
  const box = new Box3();
  for (const b of a.arm.bones) {
    const sel = app.doc.mode === 'POSE' ? a.ob.pose?.[b.name]?.select : b.select_head || b.select_tail;
    if (!sel) continue;
    const [hw, tw] = bonePoints(a.ob, b, app.doc.mode === 'POSE');
    box.expandByPoint(hw);
    box.expandByPoint(tw);
  }
  return box.isEmpty() ? null : box;
});

// ---------------------------------------------------------------------------
// operators

const armEditPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && !!activeArmature();
const posePoll = (ctx: OpContext) => ctx.doc.mode === 'POSE' && !!activeArmature();

function uniqueBoneName(arm: ArmatureData, base: string) {
  return kUniqueBoneName(arm, base);
}

/** New bone; it joins the collections of its parent (or the active bone collection). */
function newBone(arm: ArmatureData, name: string, head: number[], tail: number[], parent: string | null = null, connect = false, template?: Bone): Bone {
  const par = parent ? arm.bones.find((x) => x.name === parent) ?? null : null;
  const b = newBoneLike(arm, name, head, tail, par, connect, template);
  if (parent && !par) b.parent = parent;
  return b;
}

function ensurePose(ob: ObjectData, arm: ArmatureData) {
  ob.pose ??= {};
  for (const b of arm.bones) ob.pose[b.name] ??= defaultPoseBone();
  for (const k of Object.keys(ob.pose)) if (!arm.bones.some((b) => b.name === k)) delete ob.pose[k];
}

function renameBone(ob: ObjectData, arm: ArmatureData, oldName: string, newName: string) {
  const name = uniqueBoneName(arm, newName);
  for (const b of arm.bones) {
    if (b.name === oldName) b.name = name;
    if (b.parent === oldName) b.parent = name;
  }
  if (ob.pose?.[oldName]) {
    ob.pose[name] = ob.pose[oldName];
    delete ob.pose[oldName];
  }
  if (arm.active_bone === oldName) arm.active_bone = name;
  // vertex groups of meshes deformed by this armature follow the rename
  for (const o of Object.values(app.doc.objects))
    if (o.type === 'MESH' && o.data && o.modifiers.some((m) => m.type === 'ARMATURE' && m.object === ob.id)) {
      const g = app.doc.meshes[o.data].vertex_groups.find((x) => x.name === oldName);
      if (g) g.name = name;
    }
  // F-curves targeting the bone
  const act = ob.animation_data?.action ? app.doc.actions[ob.animation_data.action] : undefined;
  for (const fc of act?.fcurves ?? []) {
    fc.data_path = fc.data_path.replace(`pose.bones["${oldName}"]`, `pose.bones["${name}"]`);
    if (fc.group === oldName) fc.group = name;
  }
  return name;
}

registerOperators([
  {
    idname: 'armature.bone_primitive_add',
    label: 'Add Bone',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Bone' }],
    poll: armEditPoll,
    exec: (ctx, p) => {
      const { ob, arm } = activeArmature()!;
      const inv = world(ob).clone().invert();
      const c = V(ctx.doc.scene.cursor.location).applyMatrix4(inv);
      for (const b of arm.bones) b.select = b.select_head = b.select_tail = false;
      const b = newBone(arm, p.name as string, [c.x, c.y, c.z], [c.x, c.y, c.z + 1]);
      b.select = b.select_head = b.select_tail = true;
      arm.active_bone = b.name;
      ensurePose(ob, arm);
    },
  },
  {
    idname: 'armature.extrude_move',
    label: 'Extrude',
    poll: armEditPoll,
    invoke: (ctx) => {
      const { ob, arm } = activeArmature()!;
      const tails = arm.bones.filter((b) => b.select_tail);
      const heads = arm.bones.filter((b) => b.select_head && !b.select_tail && !b.parent);
      if (!tails.length && !heads.length) return 'CANCELLED';
      const created: Bone[] = [];
      for (const t of tails) created.push(newBone(arm, t.name, t.tail, t.tail, t.name, true));
      for (const t of heads) created.push(newBone(arm, t.name, t.head, t.head, null, false));
      for (const b of arm.bones) b.select = b.select_head = b.select_tail = false;
      for (const c of created) {
        c.select_tail = true;
        c.select = false;
      }
      arm.active_bone = created[created.length - 1].name;
      ensurePose(ob, arm);
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude' });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'armature.delete',
    label: 'Delete Selected Bone(s)',
    poll: armEditPoll,
    exec: () => {
      const { ob, arm } = activeArmature()!;
      const gone = new Set(arm.bones.filter((b) => b.select).map((b) => b.name));
      if (!gone.size) return 'CANCELLED';
      for (const b of arm.bones)
        if (b.parent && gone.has(b.parent)) {
          // reparent to the deleted bone's parent
          let p: string | null = b.parent;
          while (p && gone.has(p)) p = arm.bones.find((x) => x.name === p)?.parent ?? null;
          b.parent = p;
          b.use_connect = false;
        }
      arm.bones = arm.bones.filter((b) => !gone.has(b.name));
      if (arm.active_bone && gone.has(arm.active_bone)) arm.active_bone = null;
      ensurePose(ob, arm);
    },
  },
  {
    idname: 'armature.duplicate_move',
    label: 'Duplicate',
    poll: armEditPoll,
    invoke: (ctx) => {
      const { ob, arm } = activeArmature()!;
      const sel = arm.bones.filter((b) => b.select);
      if (!sel.length) return 'CANCELLED';
      const map = new Map<string, string>();
      const copies = sel.map((b) => {
        const c = newBone(arm, b.name, b.head, b.tail, b.parent, b.use_connect, b);
        c.roll = b.roll;
        map.set(b.name, c.name);
        return c;
      });
      for (const c of copies) if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!;
      for (const b of arm.bones) b.select = b.select_head = b.select_tail = false;
      for (const c of copies) c.select = c.select_head = c.select_tail = true;
      ensurePose(ob, arm);
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate' });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'armature.parent_set',
    label: 'Make Parent',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CONNECTED', items: [['CONNECTED', 'Connected'], ['OFFSET', 'Keep Offset']] }],
    poll: armEditPoll,
    exec: (_ctx, p) => {
      const { arm } = activeArmature()!;
      const parent = arm.bones.find((b) => b.name === arm.active_bone);
      if (!parent) return 'CANCELLED';
      for (const b of arm.bones) {
        if (!b.select || b === parent) continue;
        // avoid cycles
        let q: string | null = parent.name,
          cyc = false;
        while (q) {
          if (q === b.name) cyc = true;
          q = arm.bones.find((x) => x.name === q)?.parent ?? null;
        }
        if (cyc) continue;
        b.parent = parent.name;
        b.use_connect = p.type === 'CONNECTED';
        if (b.use_connect) b.head = [...parent.tail] as [number, number, number];
      }
    },
  },
  {
    idname: 'armature.parent_clear',
    label: 'Clear Parent',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Parent'], ['DISCONNECT', 'Disconnect Bone']] }],
    poll: armEditPoll,
    exec: (_ctx, p) => {
      const { arm } = activeArmature()!;
      for (const b of arm.bones)
        if (b.select) {
          b.use_connect = false;
          if (p.type === 'CLEAR') b.parent = null;
        }
    },
  },
  {
    idname: 'armature.switch_direction',
    label: 'Switch Direction',
    poll: armEditPoll,
    exec: () => {
      const { arm } = activeArmature()!;
      for (const b of arm.bones)
        if (b.select) {
          const t = b.head;
          b.head = b.tail;
          b.tail = t;
          b.use_connect = false;
        }
    },
  },
  {
    idname: 'armature.subdivide',
    label: 'Subdivide',
    props: [{ id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 1000 }],
    poll: armEditPoll,
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      const n = (p.number_cuts as number) + 1;
      for (const b of arm.bones.filter((x) => x.select)) {
        const head = V(b.head),
          tail = V(b.tail);
        const children = arm.bones.filter((c) => c.parent === b.name);
        b.tail = head.clone().lerp(tail, 1 / n).toArray() as [number, number, number];
        let prev = b;
        for (let i = 1; i < n; i++) {
          const nb = newBone(arm, b.name, head.clone().lerp(tail, i / n).toArray(), head.clone().lerp(tail, (i + 1) / n).toArray(), prev.name, true);
          nb.select = nb.select_head = nb.select_tail = true;
          prev = nb;
        }
        for (const c of children) c.parent = prev.name;
      }
      ensurePose(ob, arm);
    },
  },
  {
    idname: 'armature.roll_clear',
    label: 'Clear Roll',
    poll: armEditPoll,
    exec: () => {
      for (const b of activeArmature()!.arm.bones) if (b.select) b.roll = 0;
    },
  },
  {
    idname: 'armature.calculate_roll',
    label: 'Recalculate Roll',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'POS_X', items: [['POS_X', 'Local +X Tangent'], ['GLOBAL_POS_Z', 'Global +Z Axis'], ['CURSOR', 'Cursor']] }],
    poll: armEditPoll,
    exec: (ctx, p) => {
      const { ob, arm } = activeArmature()!;
      for (const b of arm.bones) {
        if (!b.select) continue;
        const y = V(b.tail).sub(V(b.head)).normalize();
        let target = new Vector3(0, 0, 1);
        if (p.type === 'CURSOR') target = V(ctx.doc.scene.cursor.location).applyMatrix4(world(ob).clone().invert()).sub(V(b.head));
        // choose roll so the bone's Z axis points towards the target (projected)
        b.roll = 0;
        const m0 = boneRestMatrix(b);
        const z0 = new Vector3(0, 0, 1).transformDirection(m0);
        const t = target.clone().sub(y.clone().multiplyScalar(target.dot(y))).normalize();
        if (t.lengthSq() > 0) {
          let ang = Math.acos(Math.max(-1, Math.min(1, z0.dot(t))));
          if (z0.clone().cross(t).dot(y) < 0) ang = -ang;
          b.roll = ang;
        }
      }
    },
  },
  {
    idname: 'armature.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: armEditPoll,
    exec: (_ctx, p) => {
      const { arm } = activeArmature()!;
      let a = p.action as string;
      if (a === 'TOGGLE') a = arm.bones.some((b) => b.select_head || b.select_tail) ? 'DESELECT' : 'SELECT';
      for (const b of arm.bones) {
        if (!boneVisible(arm, b) && a !== 'DESELECT') continue;
        const v = a === 'SELECT' ? true : a === 'DESELECT' ? false : !b.select;
        b.select = b.select_head = b.select_tail = v;
      }
    },
    redo: false,
  },
  {
    idname: 'armature.rename',
    label: 'Rename Active Bone',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: (ctx) => (armEditPoll(ctx) || posePoll(ctx)) && !!activeArmature()?.arm.active_bone,
    invoke: () => {
      const { arm } = activeArmature()!;
      promptText('Rename Active Bone', arm.active_bone!, (n) => n && app.run('armature.rename', { name: n }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      if (!p.name) return 'CANCELLED';
      renameBone(ob, arm, arm.active_bone!, p.name as string);
    },
  },
  // ---- pose mode
  {
    idname: 'pose.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: posePoll,
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      ensurePose(ob, arm);
      let a = p.action as string;
      if (a === 'TOGGLE') a = Object.values(ob.pose!).some((pb) => pb.select) ? 'DESELECT' : 'SELECT';
      for (const pb of Object.values(ob.pose!)) pb.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !pb.select;
    },
    redo: false,
  },
  ...(['loc', 'rot', 'scale'] as const).map((k) => ({
    idname: `pose.${k}_clear`,
    label: `Clear Pose ${k === 'loc' ? 'Location' : k === 'rot' ? 'Rotation' : 'Scale'}`,
    poll: posePoll,
    exec: () => {
      const { ob } = activeArmature()!;
      for (const pb of Object.values(ob.pose ?? {})) {
        if (!pb.select) continue;
        if (k === 'loc') pb.location = [0, 0, 0];
        if (k === 'rot') {
          pb.rotation_quaternion = [1, 0, 0, 0];
          pb.rotation_euler = [0, 0, 0];
          pb.rotation_axis_angle = [0, 0, 1, 0];
        }
        if (k === 'scale') pb.scale = [1, 1, 1];
      }
    },
  })),
  {
    idname: 'pose.transforms_clear',
    label: 'Clear User Transforms',
    poll: posePoll,
    exec: () => {
      const { ob } = activeArmature()!;
      for (const [n, pb] of Object.entries(ob.pose ?? {})) if (pb.select) ob.pose![n] = { ...defaultPoseBone(), select: true, constraints: pb.constraints };
    },
  },
  {
    idname: 'pose.copy',
    label: 'Copy Pose',
    poll: posePoll,
    exec: () => {
      const { ob } = activeArmature()!;
      poseClipboard = Object.fromEntries(Object.entries(ob.pose ?? {}).filter(([, pb]) => pb.select).map(([n, pb]) => [n, structuredClone({ ...pb, constraints: [] })]));
      app.report('INFO', `Copied pose of ${Object.keys(poseClipboard).length} bone(s)`);
    },
    undo: false,
  },
  {
    idname: 'pose.paste',
    label: 'Paste Pose',
    props: [{ id: 'flipped', label: 'Flipped on X-Axis', type: 'bool', default: false }],
    poll: (ctx) => posePoll(ctx) && !!poseClipboard,
    exec: (_ctx, p) => {
      const { ob } = activeArmature()!;
      const swap = (n: string) => n.replace(/([._-])([LlRr])$/, (_, s, c) => s + ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[c]);
      for (const [n, src] of Object.entries(poseClipboard!)) {
        const target = p.flipped ? swap(n) : n;
        const pb = ob.pose?.[target];
        if (!pb) continue;
        pb.location = [...src.location] as [number, number, number];
        pb.scale = [...src.scale] as [number, number, number];
        pb.rotation_euler = [...src.rotation_euler] as [number, number, number];
        pb.rotation_quaternion = [...src.rotation_quaternion] as [number, number, number, number];
        if (p.flipped) {
          pb.location[0] = -pb.location[0];
          pb.rotation_quaternion = [pb.rotation_quaternion[0], pb.rotation_quaternion[1], -pb.rotation_quaternion[2], -pb.rotation_quaternion[3]];
          pb.rotation_euler = [pb.rotation_euler[0], -pb.rotation_euler[1], -pb.rotation_euler[2]];
        }
      }
    },
  },
  {
    idname: 'pose.ik_add',
    label: 'Add IK',
    description: 'Add an IK constraint to the active bone (targeting the selected object or bone)',
    props: [{ id: 'with_targets', label: 'With Targets', type: 'bool', default: true }],
    poll: posePoll,
    exec: () => {
      const { ob, arm } = activeArmature()!;
      const act = arm.active_bone ? ob.pose?.[arm.active_bone] : undefined;
      if (!act) return 'CANCELLED';
      const c = newConstraint('IK', uid('cn'));
      c.chain_count = 2;
      const other = Object.entries(ob.pose ?? {}).find(([n, pb]) => pb.select && n !== arm.active_bone);
      if (other) {
        c.target = ob.id;
        c.subtarget = other[0];
      }
      act.constraints.push(c);
    },
  },
  {
    idname: 'pose.ik_clear',
    label: 'Remove IK',
    poll: posePoll,
    exec: () => {
      for (const pb of Object.values(activeArmature()!.ob.pose ?? {})) if (pb.select) pb.constraints = pb.constraints.filter((c) => c.type !== 'IK');
    },
  },
  {
    idname: 'pose.select_hierarchy',
    label: 'Select Hierarchy',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'PARENT', items: [['PARENT', 'Parent'], ['CHILD', 'Child']] }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: posePoll,
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      const act = arm.bones.find((b) => b.name === arm.active_bone);
      if (!act) return 'CANCELLED';
      const next = p.direction === 'PARENT' ? (act.parent ? [act.parent] : []) : arm.bones.filter((b) => b.parent === act.name).map((b) => b.name);
      if (!next.length) return 'CANCELLED';
      if (!p.extend) for (const pb of Object.values(ob.pose ?? {})) pb.select = false;
      for (const n of next) ob.pose![n].select = true;
      arm.active_bone = next[0];
    },
  },
  {
    idname: 'pose.hide',
    label: 'Hide Selected',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: (ctx) => posePoll(ctx) || armEditPoll(ctx),
    exec: (ctx, p) => {
      const { ob, arm } = activeArmature()!;
      for (const b of arm.bones) {
        const sel = ctx.doc.mode === 'POSE' ? !!ob.pose?.[b.name]?.select : b.select;
        if (p.unselected ? !sel : sel) b.hide = true;
      }
    },
  },
  {
    idname: 'pose.reveal',
    label: 'Reveal Selected',
    poll: (ctx) => posePoll(ctx) || armEditPoll(ctx),
    exec: () => {
      for (const b of activeArmature()!.arm.bones) b.hide = false;
    },
  },
]);

let poseClipboard: Record<string, PoseBone> | null = null;

modeHandlers.POSE = {
  enter(ob) {
    if (ob.type !== 'ARMATURE' || !ob.data) return false;
    ensurePose(ob, app.doc.armatures[ob.data]);
    return true;
  },
  exit() {},
};

// ---------------------------------------------------------------------------
// menus & keymap

function poseMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: () => [{ label: 'Move', op: 'transform.translate', shortcut: 'G' }, { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' }, { label: 'Scale', op: 'transform.resize', shortcut: 'S' }] },
    { label: 'Clear Transform', submenu: () => [{ label: 'All', op: 'pose.transforms_clear' }, { label: 'Location', op: 'pose.loc_clear', shortcut: 'Alt G' }, { label: 'Rotation', op: 'pose.rot_clear', shortcut: 'Alt R' }, { label: 'Scale', op: 'pose.scale_clear', shortcut: 'Alt S' }] },
    { separator: true },
    { label: 'Animation', submenu: () => [{ label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' }, { label: 'Delete Keyframes', op: 'anim.keyframe_delete_v3d', shortcut: 'Alt I' }] },
    { separator: true },
    { label: 'Copy Pose', op: 'pose.copy', shortcut: 'Ctrl C' },
    { label: 'Paste Pose', op: 'pose.paste', shortcut: 'Ctrl V' },
    { label: 'Paste Pose Flipped', op: 'pose.paste', props: { flipped: true }, shortcut: 'Shift Ctrl V' },
    { separator: true },
    { label: 'Inverse Kinematics', submenu: () => [{ label: 'Add IK to Bone', op: 'pose.ik_add', shortcut: 'Shift I' }, { label: 'Clear IK', op: 'pose.ik_clear', shortcut: 'Ctrl Alt I' }] },
    { separator: true },
    { label: 'Show/Hide', submenu: () => [{ label: 'Reveal Bones', op: 'pose.reveal', shortcut: 'Alt H' }, { label: 'Hide Selected', op: 'pose.hide', shortcut: 'H' }] },
  ];
}

modeMenus.POSE = {
  header: () => [['Pose', poseMenu]],
  select: () => [{ label: 'All', op: 'pose.select_all', props: { action: 'SELECT' } }, { label: 'None', op: 'pose.select_all', props: { action: 'DESELECT' } }, { label: 'Invert', op: 'pose.select_all', props: { action: 'INVERT' } }, { separator: true }, { label: 'Parent', op: 'pose.select_hierarchy', props: { direction: 'PARENT' } }, { label: 'Child', op: 'pose.select_hierarchy', props: { direction: 'CHILD' } }],
  context: poseMenu,
};

addKeys('Pose', [
  { key: 'A', op: 'pose.select_all', props: { action: 'SELECT' }, when: inPose },
  { key: 'A', alt: true, op: 'pose.select_all', props: { action: 'DESELECT' }, when: inPose },
  { key: 'I', ctrl: true, op: 'pose.select_all', props: { action: 'INVERT' }, when: inPose },
  { key: 'G', alt: true, op: 'pose.loc_clear', when: inPose },
  { key: 'R', alt: true, op: 'pose.rot_clear', when: inPose },
  { key: 'S', alt: true, op: 'pose.scale_clear', when: inPose },
  { key: 'C', ctrl: true, op: 'pose.copy', when: inPose },
  { key: 'V', ctrl: true, op: 'pose.paste', when: inPose },
  { key: 'V', ctrl: true, shift: true, op: 'pose.paste', props: { flipped: true }, when: inPose },
  { key: 'I', shift: true, op: 'pose.ik_add', when: inPose },
  { key: 'I', ctrl: true, alt: true, op: 'pose.ik_clear', when: inPose },
  { key: 'LEFT_BRACKET', op: 'pose.select_hierarchy', props: { direction: 'PARENT' }, when: inPose },
  { key: 'RIGHT_BRACKET', op: 'pose.select_hierarchy', props: { direction: 'CHILD' }, when: inPose },
  { key: 'TAB', ctrl: true, op: 'object.posemode_toggle', when: inPose },
]);

export { openMenu, renameBone, ensurePose, pickBone, newBone, syncConnected, inArmEdit };
