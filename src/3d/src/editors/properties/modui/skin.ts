// Skin modifier: panel, skin data operators (mark root, equalize radii, resize radii) and
// Create Armature.
import { h, type VNode } from '../../../ui/h';
import { Matrix4, Vector3 } from 'three';
import { editModeHooks } from '../../view3d/hooks';
import { num, bool } from '../../../ui/props';
import { app, onAppReady, operators, registerOperator, registerOperators, type OpContext } from '../../../app/app';
import { addKeys } from '../../../app/keymap';
import type { MeshData, ObjectData } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { wideButton } from './kit';
import { defaultSkinData, skinGraph, SKIN_STRIDE } from '../../../eval/mods/skin';
import { newArmature, newObject, uid } from '../../../data/defaults';
import { defaultPoseBone } from '../../../eval/armature';
import { newModifier } from '../../../eval/modifiers';
import { startValueModal } from '../../../modes/editmesh/modal';
import { uniqueName } from '../../../ops/object';

type Rec = Record<string, unknown>;

const meshOf = (ob: ObjectData | null) => (ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined);

/** Make sure the mesh has skin data matching its vertex count (defaults otherwise). */
export function ensureSkinData(me: MeshData): Float32Array {
  const nv = me.positions.length / 3;
  if (!me.skin_vertices || me.skin_vertices.length !== nv * SKIN_STRIDE) me.skin_vertices = defaultSkinData({ ...me, looseEdges: me.loose_edges });
  return me.skin_vertices;
}

const editSkinPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && !!meshOf(app.activeObject) && !!app.activeObject!.modifiers.some((m) => m.type === 'SKIN');

/** Selected vertices of the edited mesh. */
function selectedVerts(me: MeshData): number[] {
  const out: number[] = [];
  const s = me.select_vert;
  if (s) for (let v = 0; v < s.length; v++) if (s[v] && !me.hide_vert?.[v]) out.push(v);
  return out;
}

registerOperators([
  {
    idname: 'object.skin_root_mark',
    label: 'Mark Skin Root',
    description: 'Make the selected vertices the roots of their skin parts (one root per connected part)',
    poll: editSkinPoll,
    exec: () => {
      const me = meshOf(app.activeObject)!;
      const sel = selectedVerts(me);
      if (!sel.length) return 'CANCELLED';
      const data = Float32Array.from(ensureSkinData(me));
      const g = skinGraph({ ...me, looseEdges: me.loose_edges });
      const nv = me.positions.length / 3;
      // clear other roots in the parts of the selected vertices
      const comp = new Int32Array(nv).fill(-1);
      for (const s of sel) {
        if (comp[s] >= 0) continue;
        const list = [s];
        comp[s] = s;
        for (let i = 0; i < list.length; i++)
          for (let k = g.offsets[list[i]]; k < g.offsets[list[i] + 1]; k++) {
            const w = g.adj[k];
            if (comp[w] < 0) (comp[w] = s), list.push(w);
          }
        for (const v of list) data[v * SKIN_STRIDE + 2] = 0;
      }
      const done = new Set<number>();
      for (const s of sel) {
        if (done.has(comp[s])) continue;
        done.add(comp[s]);
        data[s * SKIN_STRIDE + 2] = 1;
      }
      me.skin_vertices = data;
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'object.skin_radii_equalize',
    label: 'Equalize Skin Radii',
    description: 'Give the selected vertices the same skin radius on both axes',
    poll: editSkinPoll,
    exec: () => {
      const me = meshOf(app.activeObject)!;
      const sel = selectedVerts(me);
      if (!sel.length) return 'CANCELLED';
      const data = Float32Array.from(ensureSkinData(me));
      for (const v of sel) {
        const r = (data[v * SKIN_STRIDE] + data[v * SKIN_STRIDE + 1]) / 2;
        data[v * SKIN_STRIDE] = data[v * SKIN_STRIDE + 1] = r;
      }
      me.skin_vertices = data;
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'transform.skin_resize',
    label: 'Skin Resize',
    description: 'Scale the skin radii of the selected vertices',
    props: [{ id: 'value', label: 'Scale', type: 'vec3', default: [1, 1, 1] }],
    poll: (ctx) => ctx.doc.mode === 'EDIT' && !!meshOf(app.activeObject) && !!meshOf(app.activeObject)!.skin_vertices,
    invoke: (ctx) =>
      startValueModal(
        {
          label: 'Skin Resize',
          idname: 'transform.skin_resize',
          prop: 'value',
          initial: 1,
          min: 0,
          perPixel: 0.005,
          name: 'Scale',
          apply: (m, value) => scaleSkin(m, [value, value]),
        },
        ctx.event,
      ),
    exec: (_ctx, p) => {
      const me = meshOf(app.activeObject)!;
      const v = Array.isArray(p.value) ? (p.value as number[]) : [Number(p.value) || 1, Number(p.value) || 1];
      const data = Float32Array.from(ensureSkinData(me));
      for (const i of selectedVerts(me)) {
        data[i * SKIN_STRIDE] *= v[0];
        data[i * SKIN_STRIDE + 1] *= v[1];
      }
      me.skin_vertices = data;
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'object.skin_armature_create',
    label: 'Create Skin Armature',
    description: 'Create an armature with a bone for every skin edge, with matching vertex groups and an Armature modifier',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!meshOf(app.activeObject) && !!app.activeObject!.modifiers.some((m) => m.type === 'SKIN'),
    exec: (ctx) => {
      const ob = app.activeObject!;
      const me = meshOf(ob)!;
      const data = ensureSkinData(me);
      const g = skinGraph({ ...me, looseEdges: me.loose_edges });
      const nv = me.positions.length / 3;
      const P = me.positions;
      const doc = ctx.doc;
      const arm = newArmature(uniqueName(doc, `${ob.name}_armature`, 'armatures'));
      arm.collections = [{ name: 'Bones', is_visible: true }];
      const boneOf = new Map<number, string>(); // child vertex → bone ending there
      const groups: { name: string; verts: number[] }[] = [];
      const seen = new Uint8Array(nv);
      const order: number[] = [];
      for (let v = 0; v < nv; v++) if (data[v * SKIN_STRIDE + 2]) order.push(v);
      for (let v = 0; v < nv; v++) order.push(v);
      for (const root of order) {
        if (seen[root] || g.offsets[root + 1] === g.offsets[root]) continue;
        seen[root] = 1;
        const queue = [root];
        for (let i = 0; i < queue.length; i++) {
          const a = queue[i];
          for (let k = g.offsets[a]; k < g.offsets[a + 1]; k++) {
            const b = g.adj[k];
            if (seen[b]) continue;
            seen[b] = 1;
            queue.push(b);
            const name = `bone.${String(arm.bones.length).padStart(3, '0')}`;
            const parent = boneOf.get(a) ?? null;
            arm.bones.push({
              name,
              parent,
              head: [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]],
              tail: [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]],
              roll: 0,
              use_connect: !!parent,
              use_deform: true,
              use_inherit_rotation: true,
              inherit_scale: 'FULL',
              envelope_distance: 0.25,
              head_radius: 0.1,
              tail_radius: 0.05,
              bbone_segments: 1,
              collections: ['Bones'],
            });
            boneOf.set(b, name);
            groups.push({ name, verts: a === root && !parent ? [a, b] : [b] });
          }
        }
      }
      if (!arm.bones.length) {
        app.report('ERROR', 'The mesh has no edges to build bones from');
        return 'CANCELLED';
      }
      arm.active_bone = arm.bones[0].name;
      doc.armatures[arm.id] = arm;
      const aob = newObject(arm.name, 'ARMATURE', arm.id);
      aob.name = uniqueName(doc, arm.name);
      aob.location = [...ob.location] as [number, number, number];
      aob.rotation_mode = ob.rotation_mode;
      aob.rotation_euler = [...ob.rotation_euler] as [number, number, number];
      aob.rotation_quaternion = [...ob.rotation_quaternion] as [number, number, number, number];
      aob.scale = [...ob.scale] as [number, number, number];
      aob.pose = Object.fromEntries(arm.bones.map((b) => [b.name, defaultPoseBone()]));
      doc.objects[aob.id] = aob;
      doc.object_order.push(aob.id);
      for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(aob.id);
      // vertex groups named after the bones
      const weights = me.weights.slice(),
        vgs = me.vertex_groups.slice();
      for (const gr of groups) {
        let gi = vgs.findIndex((x) => x.name === gr.name);
        if (gi < 0) {
          vgs.push({ name: gr.name });
          weights.push(new Float32Array(nv));
          gi = vgs.length - 1;
        } else weights[gi] = Float32Array.from(weights[gi]);
        for (const v of gr.verts) weights[gi][v] = 1;
      }
      me.vertex_groups = vgs;
      me.weights = weights;
      // deform with the armature before the skin is built
      const mod = newModifier('ARMATURE', uid('md'), ob.modifiers);
      mod.object = aob.id;
      const si = ob.modifiers.findIndex((m) => m.type === 'SKIN');
      ob.modifiers.splice(Math.max(0, si), 0, mod);
    },
  },
]);

function scaleSkin(m: import('../../../modes/editmesh/meshedit').MeshEdit, v: [number, number]): boolean {
  if (!m.skin) return false;
  let any = false;
  for (let i = 0; i < m.vcount; i++) {
    if (!m.sel[i] || m.hide[i]) continue;
    m.skin[i * SKIN_STRIDE] *= v[0];
    m.skin[i * SKIN_STRIDE + 1] *= v[1];
    any = true;
  }
  return any;
}

addKeys('Mesh', [{ key: 'A', ctrl: true, op: 'transform.skin_resize', when: () => app.doc.mode === 'EDIT' && !!meshOf(app.activeObject)?.skin_vertices }]);

// adding a Skin modifier gives the mesh skin data
onAppReady(() => {
  const prev = operators.get('object.modifier_add');
  if (!prev?.exec) return;
  registerOperator({
    ...prev,
    exec: (ctx, p) => {
      const r = prev.exec!(ctx, p);
      if (r !== 'CANCELLED' && p.type === 'SKIN') {
        const me = meshOf(app.activeObject);
        if (me) ensureSkinData(me);
      }
      return r;
    },
  });
});

modifierFields.SKIN = [];
modifierExtraUI.SKIN = (ob, m) => {
  const r = m as Rec;
  const edit = app.doc.mode === 'EDIT';
  return [
    num(r, 'branch_smoothing', 'Branch Smoothing', { min: 0, max: 1, slider: true }),
    bool(r, 'use_smooth_shade', 'Smooth Shading'),
    h('div', { class: 'ui-sep' }),
    wideButton(`${m.id}.arm`, 'Create Armature', () => app.run('object.skin_armature_create', { modifier: m.id }), { disabled: edit, tip: 'Available in Object Mode' }),
    h(
      'div',
      { class: 'mod-wide' },
      wideButton(`${m.id}.root`, 'Mark Root', () => app.run('object.skin_root_mark'), { disabled: !edit, tip: 'Available in Edit Mode' }),
      wideButton(`${m.id}.eq`, 'Equalize Radii', () => app.run('object.skin_radii_equalize'), { disabled: !edit, tip: 'Available in Edit Mode' }),
    ),
    edit ? h('div', { class: 'mod-note' }, 'Ctrl A scales the skin radius of the selected vertices.') : null,
    void ob,
  ];
};

// Edit Mode: show each vertex's skin radius as a circle around it
editModeHooks.svg.push((v) => {
  if (app.doc.mode !== 'EDIT') return null;
  const ob = app.activeObject;
  const me = meshOf(ob);
  if (!ob || !me?.skin_vertices || !ob.modifiers.some((m) => m.type === 'SKIN' && m.show_viewport)) return null;
  const nv = me.positions.length / 3;
  if (nv > 4000 || me.skin_vertices.length !== nv * SKIN_STRIDE) return null;
  const world = app.graph.get(ob.id)?.world ?? new Matrix4();
  const right = new Vector3().setFromMatrixColumn(v.camera.matrixWorld, 0).normalize();
  const sx = new Vector3().setFromMatrixScale(world);
  const scale = (sx.x + sx.y + sx.z) / 3;
  const circles: VNode[] = [];
  const p = new Vector3();
  for (let i = 0; i < nv; i++) {
    if (me.hide_vert?.[i]) continue;
    p.fromArray(me.positions, i * 3).applyMatrix4(world);
    const c = v.project(p);
    if (c.z < -1 || c.z > 1) continue;
    const r = (me.skin_vertices[i * SKIN_STRIDE] + me.skin_vertices[i * SKIN_STRIDE + 1]) / 2;
    const e = v.project(p.clone().addScaledVector(right, r * scale));
    const rad = Math.hypot(e.x - c.x, e.y - c.y);
    if (rad < 1) continue;
    const sel = !!me.select_vert?.[i];
    circles.push(h('circle', { key: `sk${i}`, cx: c.x, cy: c.y, r: rad, fill: 'none', stroke: sel ? '#fca41d' : '#c1c2c3', 'stroke-width': sel ? 1.4 : 1, 'stroke-dasharray': me.skin_vertices[i * SKIN_STRIDE + 2] ? '' : '4 3', opacity: 0.8 }) as VNode);
  }
  return h('g', { key: 'skin-radii', 'pointer-events': 'none' }, circles) as VNode;
});
