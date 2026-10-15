// Material slot management: reorder, clean up, copy to other objects, copy/paste material settings.
import { app, registerOperators, type OpContext } from '../app/app';
import { cloneShared } from '../data/cow';
import type { CurveData, MaterialData, MeshData, ObjectData } from '../data/types';

type SlotOwner = MeshData | CurveData;

export function slotOwner(ob: ObjectData | null | undefined): SlotOwner | undefined {
  if (!ob?.data) return undefined;
  return app.doc.meshes[ob.data] ?? app.doc.curves[ob.data];
}

const isMesh = (o: SlotOwner): o is MeshData => 'offsets' in o;

/** Slot index used by each face / spline. */
function usedSlots(owner: SlotOwner): Set<number> {
  const used = new Set<number>();
  if (isMesh(owner)) {
    const nf = owner.offsets.length - 1;
    if (!owner.material_index) {
      if (nf > 0) used.add(0);
    } else for (let f = 0; f < nf; f++) used.add(owner.material_index[f]);
  } else for (const s of owner.splines) used.add(s.material_index ?? 0);
  return used;
}

/** Apply `map[old] = new` (or -1 for removed → slot 0) to the per-element slot indices. */
function remapSlots(owner: SlotOwner, map: number[]) {
  const fix = (i: number) => Math.max(0, map[i] ?? 0);
  if (isMesh(owner)) {
    if (!owner.material_index) return;
    const mi = new Uint16Array(owner.material_index);
    for (let f = 0; f < mi.length; f++) mi[f] = fix(mi[f]);
    owner.material_index = mi;
  } else owner.splines = owner.splines.map((s) => ({ ...s, material_index: fix(s.material_index ?? 0) }));
}

/** Point elements that use a slot past the end at the last slot. */
function clampSlots(owner: SlotOwner, count: number) {
  const last = Math.max(0, count - 1);
  const used = usedSlots(owner);
  if (![...used].some((i) => i > last)) return;
  remapSlots(owner, Array.from({ length: Math.max(...used) + 1 }, (_, i) => Math.min(i, last)));
}

/** Remove the slots for which `drop(i)` holds, fixing element indices. Returns how many went. */
export function removeSlots(ob: ObjectData, owner: SlotOwner, drop: (i: number) => boolean): number {
  const map: number[] = [];
  const keep: (string | null)[] = [];
  owner.materials.forEach((m, i) => {
    if (drop(i)) map.push(-1);
    else {
      map.push(keep.length);
      keep.push(m);
    }
  });
  const removed = owner.materials.length - keep.length;
  if (!removed) return 0;
  remapSlots(owner, map);
  owner.materials = keep;
  const a = map[ob.active_material_index];
  ob.active_material_index = Math.max(0, Math.min(keep.length - 1, a >= 0 ? a : ob.active_material_index - 1));
  return removed;
}

const targets = () => {
  const out = app.selectedObjects().filter((o) => !!slotOwner(o));
  const act = app.activeObject;
  if (act && slotOwner(act) && !out.includes(act)) out.push(act);
  return out;
};
const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

let materialBuffer: Omit<MaterialData, 'id' | 'name'> | null = null;

registerOperators([
  {
    idname: 'object.material_slot_move',
    label: 'Move Material Slot',
    description: 'Move the active material slot up or down, keeping faces on their materials',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: () => (slotOwner(app.activeObject)?.materials.length ?? 0) > 1,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const owner = slotOwner(ob)!;
      const i = ob.active_material_index;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= owner.materials.length) return 'CANCELLED';
      const mats = owner.materials.slice();
      [mats[i], mats[j]] = [mats[j], mats[i]];
      owner.materials = mats;
      const map = mats.map((_, k) => (k === i ? j : k === j ? i : k));
      remapSlots(owner, map);
      ob.active_material_index = j;
    },
  },
  {
    idname: 'object.material_slot_remove_unused',
    label: 'Remove Unused Slots',
    description: 'Remove material slots that no face or spline uses',
    poll: (ctx) => objectMode(ctx) && targets().length > 0,
    exec: () => {
      let n = 0;
      for (const ob of targets()) {
        const owner = slotOwner(ob)!;
        const used = usedSlots(owner);
        n += removeSlots(ob, owner, (i) => !used.has(i));
      }
      app.report('INFO', n ? `Removed ${n} unused material slot${n > 1 ? 's' : ''}` : 'No unused material slots');
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'object.material_slot_remove_all',
    label: 'Remove All Materials',
    description: 'Remove every material slot from the selected objects',
    poll: (ctx) => objectMode(ctx) && targets().some((o) => slotOwner(o)!.materials.length > 0),
    exec: () => {
      for (const ob of targets()) {
        const owner = slotOwner(ob)!;
        removeSlots(ob, owner, () => true);
        ob.active_material_index = 0;
      }
    },
  },
  {
    idname: 'object.material_slot_copy',
    label: 'Copy Material to Selected',
    description: 'Give the other selected objects the same material slots as the active object',
    poll: (ctx) => objectMode(ctx) && !!slotOwner(app.activeObject) && targets().length > 1,
    exec: () => {
      const act = app.activeObject!;
      const src = slotOwner(act)!;
      for (const ob of targets()) {
        if (ob === act) continue;
        const owner = slotOwner(ob)!;
        if (owner === src) continue;
        owner.materials = src.materials.slice();
        // keep element indices valid for the new slot count
        clampSlots(owner, owner.materials.length);
        ob.active_material_index = Math.min(ob.active_material_index, Math.max(0, owner.materials.length - 1));
      }
    },
  },
  {
    idname: 'material.copy',
    label: 'Copy Material',
    description: 'Copy the active material’s settings and node tree to an internal clipboard',
    poll: () => {
      const owner = slotOwner(app.activeObject);
      return !!owner && !!owner.materials[app.activeObject!.active_material_index];
    },
    exec: () => {
      const ob = app.activeObject!;
      const ma = app.doc.materials[slotOwner(ob)!.materials[ob.active_material_index]!];
      if (!ma) return 'CANCELLED';
      const { id: _id, name: _name, users: _users, use_fake_user: _fake, ...rest } = cloneShared(ma);
      materialBuffer = rest;
    },
    undo: false,
  },
  {
    idname: 'material.paste',
    label: 'Paste Material',
    description: 'Replace the active material’s settings with the copied ones',
    poll: () => {
      const owner = slotOwner(app.activeObject);
      return !!materialBuffer && !!owner && !!owner.materials[app.activeObject!.active_material_index];
    },
    exec: (ctx) => {
      const ob = app.activeObject!;
      const ma = ctx.doc.materials[slotOwner(ob)!.materials[ob.active_material_index]!];
      if (!ma || !materialBuffer) return 'CANCELLED';
      Object.assign(ma, cloneShared(materialBuffer));
    },
  },
]);
