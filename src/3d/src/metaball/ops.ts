// Metaball operators: adding metaballs / elements, Edit Mode selection, delete, duplicate,
// hide/reveal, and conversion of whole families to meshes.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { addObjectToScene, convertHooks, deleteObjects } from '../ops/object';
import { startTransform } from '../ops/transform';
import { newObject } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { ELEMENT_TYPES, basisOf, familyOf, metaballOf, newMetaElement, newMetaball } from './data';
import type { MetaballData, MetaElement } from './types';

export function activeMetaball(): { ob: ObjectData; mb: MetaballData } | null {
  const ob = app.activeObject;
  const mb = metaballOf(app.doc, ob);
  return ob && mb ? { ob, mb } : null;
}
export const inMetaEdit = () => app.doc.mode === 'EDIT' && !!activeMetaball();
const editPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && !!activeMetaball();

export function uniqueMetaballName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.metaballs ?? {}).map((m) => m.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Visible, selected elements. */
export const selectedElements = (mb: MetaballData) => mb.elements.filter((e) => e.select && !e.hide);

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function duplicateElements(mb: MetaballData) {
  const sel = selectedElements(mb);
  if (!sel.length) return false;
  for (const e of sel) e.select = false;
  for (const e of sel) mb.elements.push({ ...structuredClone(e), select: true });
  mb.active_element = mb.elements.length - 1;
  return true;
}

const quat = (e: MetaElement) => new Quaternion(e.rotation[1], e.rotation[2], e.rotation[3], e.rotation[0]).normalize();

const TYPE_ITEMS = ELEMENT_TYPES.map(([id, label]) => [id, label] as [string, string]);
const ACTION_ITEMS: [string, string][] = [
  ['TOGGLE', 'Toggle'],
  ['SELECT', 'Select'],
  ['DESELECT', 'Deselect'],
  ['INVERT', 'Invert'],
];

registerOperators([
  {
    idname: 'object.metaball_add',
    label: 'Add Metaball',
    description: 'Add a metaball object, or an element to the metaball being edited',
    props: [
      { id: 'type', label: 'Primitive', type: 'enum', default: 'BALL', items: TYPE_ITEMS },
      { id: 'radius', label: 'Radius', type: 'float', default: 2, min: 0, subtype: 'distance' },
      { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
      { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' || editPoll(ctx),
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const type = p.type as MetaElement['type'];
      const radius = p.radius as number;
      if (doc.mode === 'EDIT') {
        const { ob, mb } = activeMetaball()!;
        const w = app.graph.get(ob.id)?.world ?? new Matrix4();
        const loc = new Vector3(...((p.location as number[]) ?? doc.scene.cursor.location));
        const rot = (p.rotation as number[] | null) ?? (p.align === 'CURSOR' ? doc.scene.cursor.rotation_euler : [0, 0, 0]);
        // element placed at the world location/rotation, expressed in object space
        const m = new Matrix4().compose(loc, new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], 'XYZ')), new Vector3(1, 1, 1));
        const local = w.clone().invert().multiply(m);
        const t = new Vector3(),
          q = new Quaternion(),
          s = new Vector3();
        local.decompose(t, q, s);
        const scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
        const e = newMetaElement(type, [t.x, t.y, t.z], radius * scale);
        e.rotation = [q.w, q.x, q.y, q.z];
        for (const x of mb.elements) x.select = false;
        e.select = true;
        mb.elements.push(e);
        mb.active_element = mb.elements.length - 1;
        return;
      }
      doc.metaballs ??= {};
      const mb = newMetaball(uniqueMetaballName(doc, 'Mball'));
      const e = newMetaElement(type, [0, 0, 0], radius);
      e.select = true;
      mb.elements.push(e);
      mb.active_element = 0;
      doc.metaballs[mb.id] = mb;
      const ob = newObject('Mball', 'META', mb.id);
      if (p.location === null) p.location = [...doc.scene.cursor.location];
      const pp = { ...p };
      if (pp.rotation === null) delete pp.rotation;
      addObjectToScene(doc, ob, pp);
    },
  },
  {
    idname: 'mball.select_all',
    label: '(De)select All',
    description: 'Change the selection of all metaball elements',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: ACTION_ITEMS }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { mb } = activeMetaball()!;
      const vis = mb.elements.filter((e) => !e.hide);
      let a = p.action as string;
      if (a === 'TOGGLE') a = vis.some((e) => e.select) ? 'DESELECT' : 'SELECT';
      for (const e of vis) e.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !e.select;
    },
    redo: false,
  },
  {
    idname: 'mball.select_random_metaelems',
    label: 'Select Random',
    description: 'Randomly select or deselect metaball elements',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
      { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { mb } = activeMetaball()!;
      const r = rng(p.seed as number);
      for (const e of mb.elements) {
        if (e.hide) continue;
        if (r() < (p.ratio as number)) e.select = p.action === 'SELECT';
      }
    },
  },
  {
    idname: 'mball.select_similar',
    label: 'Select Similar',
    description: 'Select elements that resemble the selected ones',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'TYPE', items: [['TYPE', 'Type'], ['RADIUS', 'Radius'], ['STIFFNESS', 'Stiffness'], ['ROTATION', 'Rotation']] },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.1, min: 0, max: 1 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { mb } = activeMetaball()!;
      const src = selectedElements(mb);
      if (!src.length) return 'CANCELLED';
      const th = p.threshold as number;
      const similar = (a: MetaElement, b: MetaElement) => {
        switch (p.type) {
          case 'RADIUS':
            return Math.abs(a.radius - b.radius) <= th;
          case 'STIFFNESS':
            return Math.abs(a.stiffness - b.stiffness) <= th;
          case 'ROTATION':
            return quat(a).angleTo(quat(b)) / Math.PI <= th;
          default:
            return a.type === b.type;
        }
      };
      for (const e of mb.elements) if (!e.hide && !e.select && src.some((s) => similar(e, s))) e.select = true;
    },
  },
  {
    idname: 'mball.delete_metaelems',
    label: 'Delete',
    description: 'Delete the selected metaball elements',
    poll: editPoll,
    exec: () => {
      const { mb } = activeMetaball()!;
      const keep = mb.elements.filter((e) => !(e.select && !e.hide));
      if (keep.length === mb.elements.length) return 'CANCELLED';
      mb.elements = keep;
      mb.active_element = -1;
    },
  },
  {
    idname: 'mball.duplicate_move',
    label: 'Duplicate',
    description: 'Copy the selected metaball elements and move them',
    poll: editPoll,
    invoke: (ctx) => {
      if (!duplicateElements(activeMetaball()!.mb)) return 'CANCELLED';
      app.changed('doc', 'geometry');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate' });
      return 'RUNNING_MODAL';
    },
    exec: () => (duplicateElements(activeMetaball()!.mb) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mball.duplicate_metaelems',
    label: 'Duplicate Metaball Elements',
    description: 'Copy the selected metaball elements in place (the copies become the selection)',
    poll: editPoll,
    exec: () => (duplicateElements(activeMetaball()!.mb) ? (app.changed('doc', 'geometry'), 'FINISHED') : 'CANCELLED'),
  },
  {
    idname: 'mball.hide_metaelems',
    label: 'Hide Selected',
    description: 'Hide (un)selected metaball elements',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { mb } = activeMetaball()!;
      let n = 0;
      for (const e of mb.elements)
        if (!e.hide && (p.unselected ? !e.select : e.select)) {
          e.hide = true;
          e.select = false;
          n++;
        }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'mball.reveal_metaelems',
    label: 'Reveal Hidden',
    description: 'Show hidden metaball elements',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { mb } = activeMetaball()!;
      let n = 0;
      for (const e of mb.elements)
        if (e.hide) {
          e.hide = false;
          e.select = !!p.select;
          n++;
        }
      if (!n) return 'CANCELLED';
    },
  },
]);

// Converting any member of a metaball family converts the family's basis object, which holds
// the combined surface; the other members are removed (unless the originals are kept).
convertHooks.push((doc, objects, keepOriginal) => {
  if (!objects.some((o) => o.type === 'META')) return objects;
  const out: ObjectData[] = [];
  const drop = new Set<string>();
  for (const ob of objects) {
    if (ob.type !== 'META') {
      out.push(ob);
      continue;
    }
    const basis = basisOf(doc, ob);
    if (!out.includes(basis)) out.push(basis);
    if (!keepOriginal) for (const m of familyOf(doc, ob)) if (m.id !== basis.id) drop.add(m.id);
  }
  if (drop.size) deleteObjects(doc, drop);
  return out.filter((o) => !drop.has(o.id));
});
