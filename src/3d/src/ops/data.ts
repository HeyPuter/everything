// Data-block operators: materials & slots, vertex groups, shape keys, color attributes, images.
import { app, registerOperators } from '../app/app';
import { newMaterial, newImage, uid } from '../data/defaults';
import { uniqueName } from './object';
import type { MeshData, ObjectData } from '../data/types';
import { selectedVerts, isFaceSelected } from '../mesh/mesh';
import { cow } from '../data/cow';
import { mixShapeKeys, uniqueIn } from '../object/core';

function activeMesh(): { ob: ObjectData; me: MeshData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'MESH' || !ob.data) return null;
  const me = app.doc.meshes[ob.data];
  return me ? { ob, me } : null;
}

function slotOwner(ob: ObjectData) {
  const doc = app.doc;
  return ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data]) : undefined;
}

registerOperators([
  {
    idname: 'material.new',
    label: 'New Material',
    poll: () => !!app.activeObject && !!slotOwner(app.activeObject),
    exec: (ctx) => {
      const ob = app.activeObject!;
      const owner = slotOwner(ob)!;
      const ma = newMaterial(uniqueName(ctx.doc, 'Material', 'materials'));
      ctx.doc.materials[ma.id] = ma;
      if (!owner.materials.length) owner.materials.push(null);
      owner.materials[ob.active_material_index] = ma.id;
    },
  },
  {
    idname: 'object.material_slot_add',
    label: 'Add Material Slot',
    poll: () => !!app.activeObject && !!slotOwner(app.activeObject),
    exec: () => {
      const ob = app.activeObject!;
      const owner = slotOwner(ob)!;
      owner.materials.push(null);
      ob.active_material_index = owner.materials.length - 1;
    },
  },
  {
    idname: 'object.material_slot_remove',
    label: 'Remove Material Slot',
    poll: () => !!app.activeObject && (slotOwner(app.activeObject)?.materials.length ?? 0) > 0,
    exec: () => {
      const ob = app.activeObject!;
      const owner = slotOwner(ob)!;
      const i = ob.active_material_index;
      owner.materials.splice(i, 1);
      if (ob.type === 'MESH') {
        const me = owner as MeshData;
        if (me.material_index) {
          const mi = cow(me, 'material_index')!;
          for (let f = 0; f < mi.length; f++) if (mi[f] >= i && mi[f] > 0) mi[f]--;
        }
      }
      ob.active_material_index = Math.max(0, Math.min(i, owner.materials.length - 1));
    },
  },
  {
    idname: 'object.material_slot_assign',
    label: 'Assign Material Slot',
    description: 'Assign active material slot to selection',
    poll: () => app.doc.mode === 'EDIT' && !!activeMesh(),
    exec: () => {
      const { ob, me } = activeMesh()!;
      const nf = me.offsets.length - 1;
      if (!me.material_index) me.material_index = new Uint16Array(nf);
      const mi = cow(me, 'material_index')!;
      for (let f = 0; f < nf; f++) if (isFaceSelected(me, f)) mi[f] = ob.active_material_index;
    },
  },
  {
    idname: 'object.material_slot_select',
    label: 'Select by Material',
    poll: () => app.doc.mode === 'EDIT' && !!activeMesh(),
    exec: () => setSlotSelection(true),
  },
  {
    idname: 'object.material_slot_deselect',
    label: 'Deselect by Material',
    poll: () => app.doc.mode === 'EDIT' && !!activeMesh(),
    exec: () => setSlotSelection(false),
  },
  {
    idname: 'object.vertex_group_add',
    label: 'Add Vertex Group',
    poll: () => !!activeMesh(),
    exec: () => {
      const { ob, me } = activeMesh()!;
      let name = 'Group';
      let i = 0;
      while (me.vertex_groups.some((g) => g.name === name)) name = `Group.${String(++i).padStart(3, '0')}`;
      me.vertex_groups.push({ name });
      me.weights.push(new Float32Array(me.positions.length / 3));
      ob.vertex_group_active_index = me.vertex_groups.length - 1;
    },
  },
  {
    idname: 'object.vertex_group_remove',
    label: 'Remove Vertex Group',
    props: [
      { id: 'all', label: 'All', type: 'bool', default: false },
      { id: 'all_unlocked', label: 'All Unlocked', type: 'bool', default: false },
    ],
    poll: () => (activeMesh()?.me.vertex_groups.length ?? 0) > 0,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      if (p.all || p.all_unlocked) {
        const keep = me.vertex_groups.map((g) => !!p.all_unlocked && !p.all && !!g.lock_weight);
        me.vertex_groups = me.vertex_groups.filter((_, i) => keep[i]);
        me.weights = me.weights.filter((_, i) => keep[i]);
        ob.vertex_group_active_index = 0;
        return;
      }
      const i = ob.vertex_group_active_index ?? 0;
      me.vertex_groups.splice(i, 1);
      me.weights.splice(i, 1);
      ob.vertex_group_active_index = Math.max(0, i - 1);
    },
  },
  {
    idname: 'object.vertex_group_assign',
    label: 'Assign to Vertex Group',
    poll: () => app.doc.mode === 'EDIT' && (activeMesh()?.me.vertex_groups.length ?? 0) > 0,
    exec: (ctx) => {
      const { ob, me } = activeMesh()!;
      const gi = ob.vertex_group_active_index ?? 0;
      const w = new Float32Array(me.weights[gi]);
      const wt = ctx.doc.scene.tool_settings.vertex_group_weight ?? 1;
      for (const v of selectedVerts(me)) w[v] = wt;
      me.weights[gi] = w;
    },
  },
  {
    idname: 'object.vertex_group_remove_from',
    label: 'Remove from Vertex Group',
    props: [
      { id: 'use_all_groups', label: 'All Groups', type: 'bool', default: false },
      { id: 'use_all_verts', label: 'All Vertices', type: 'bool', default: false },
    ],
    poll: () => (app.doc.mode === 'EDIT' || app.doc.mode === 'OBJECT') && (activeMesh()?.me.vertex_groups.length ?? 0) > 0,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      // outside Edit Mode there is no vertex selection: act on every vertex
      const allVerts = !!p.use_all_verts || app.doc.mode !== 'EDIT';
      const verts = allVerts ? null : selectedVerts(me);
      const groups = p.use_all_groups ? me.weights.map((_, i) => i) : [ob.vertex_group_active_index ?? 0];
      const ws = me.weights.slice();
      for (const gi of groups) {
        if (!ws[gi] || me.vertex_groups[gi].lock_weight) continue;
        if (verts) {
          const w = new Float32Array(ws[gi]);
          for (const v of verts) w[v] = 0;
          ws[gi] = w;
        } else ws[gi] = new Float32Array(ws[gi].length);
      }
      me.weights = ws;
    },
  },
  {
    idname: 'object.vertex_group_select',
    label: 'Select Vertex Group',
    poll: () => app.doc.mode === 'EDIT' && (activeMesh()?.me.vertex_groups.length ?? 0) > 0,
    exec: () => {
      const { ob, me } = activeMesh()!;
      const w = me.weights[ob.vertex_group_active_index ?? 0];
      const s = new Uint8Array(me.select_vert ?? new Uint8Array(me.positions.length / 3));
      for (let v = 0; v < w.length; v++) if (w[v] > 0) s[v] = 1;
      me.select_vert = s;
    },
  },
  {
    idname: 'object.vertex_group_deselect',
    label: 'Deselect Vertex Group',
    poll: () => app.doc.mode === 'EDIT' && (activeMesh()?.me.vertex_groups.length ?? 0) > 0,
    exec: () => {
      const { ob, me } = activeMesh()!;
      const w = me.weights[ob.vertex_group_active_index ?? 0];
      const s = new Uint8Array(me.select_vert ?? new Uint8Array(me.positions.length / 3));
      for (let v = 0; v < w.length; v++) if (w[v] > 0) s[v] = 0;
      me.select_vert = s;
    },
  },
  {
    idname: 'object.shape_key_add',
    label: 'Add Shape Key',
    props: [{ id: 'from_mix', label: 'From Mix', type: 'bool', default: false }],
    poll: () => !!activeMesh(),
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      const names = me.shape_keys.map((k) => k.name);
      if (!me.shape_keys.length) {
        me.shape_keys.push({ name: 'Basis', data: new Float32Array(me.positions), value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: 'Basis' });
      } else {
        const src = p.from_mix ? mixShapeKeys(me) : new Float32Array(me.shape_keys[0].data);
        me.shape_keys.push({ name: uniqueIn(names, `Key ${me.shape_keys.length}`), data: src, value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: me.shape_keys[0].name });
      }
      me.active_shape_key_index = me.shape_keys.length - 1;
    },
  },
  {
    idname: 'object.shape_key_remove',
    label: 'Remove Shape Key',
    props: [
      { id: 'all', label: 'All', type: 'bool', default: false },
      { id: 'apply_mix', label: 'Apply Mix', type: 'bool', default: false, showIf: (p) => !!p.all },
    ],
    poll: () => (activeMesh()?.me.shape_keys.length ?? 0) > 0,
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      if (p.all) {
        // keep the current look when applying, otherwise fall back to the basis shape
        me.positions = p.apply_mix ? mixShapeKeys(me) : new Float32Array(me.shape_keys[0].data);
        me.shape_keys = [];
        me.active_shape_key_index = 0;
        return;
      }
      const i = me.active_shape_key_index;
      const removed = me.shape_keys.splice(i, 1)[0];
      if (removed) {
        const first = me.shape_keys[0];
        for (const k of me.shape_keys) if (k.relative_key === removed.name && first) k.relative_key = first.name;
        if (i === 0 && first) me.positions = new Float32Array(first.data);
      }
      me.active_shape_key_index = Math.max(0, i - 1);
    },
  },
  {
    idname: 'geometry.color_attribute_add',
    label: 'Add Color Attribute',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Color' }, { id: 'domain', label: 'Domain', type: 'enum', default: 'POINT', items: [['POINT', 'Vertex'], ['CORNER', 'Face Corner']] }, { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0, 1] }],
    poll: () => !!activeMesh(),
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      const n = p.domain === 'POINT' ? me.positions.length / 3 : me.indices.length;
      const data = new Float32Array(n * 4);
      const c = p.color as number[];
      for (let i = 0; i < n; i++) data.set([c[0], c[1], c[2], c[3] ?? 1], i * 4);
      let name = p.name as string;
      let k = 0;
      while (me.color_attributes.some((a) => a.name === name)) name = `${p.name}.${String(++k).padStart(3, '0')}`;
      me.color_attributes.push({ name, domain: p.domain as 'POINT', data });
      me.active_color_index = me.color_attributes.length - 1;
    },
  },
  {
    idname: 'geometry.color_attribute_remove',
    label: 'Remove Color Attribute',
    poll: () => (activeMesh()?.me.color_attributes.length ?? 0) > 0,
    exec: () => {
      const { me } = activeMesh()!;
      me.color_attributes.splice(me.active_color_index, 1);
      me.active_color_index = Math.max(0, me.active_color_index - 1);
    },
  },
  {
    idname: 'image.new',
    label: 'New Image',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: 'Untitled' },
      { id: 'width', label: 'Width', type: 'int', default: 1024, min: 1, max: 16384 },
      { id: 'height', label: 'Height', type: 'int', default: 1024, min: 1, max: 16384 },
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0, 1] },
      { id: 'generated_type', label: 'Generated Type', type: 'enum', default: 'BLANK', items: [['BLANK', 'Blank'], ['UV_GRID', 'UV Grid'], ['COLOR_GRID', 'Color Grid']] },
    ],
    exec: (ctx, p) => {
      const img = newImage(uniqueName(ctx.doc, p.name as string, 'images'), p.width as number, p.height as number, p.generated_type as 'BLANK', p.color as [number, number, number, number]);
      ctx.doc.images[img.id] = img;
      lastImage = img.id;
    },
  },
  {
    idname: 'image.open',
    label: 'Open Image',
    description: 'Open an image file from disk',
    undo: false,
    invoke: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.hdr,.exr';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        const id = await importImageFile(f);
        if (id) app.report('INFO', `Loaded image "${f.name}"`);
      };
      input.click();
      return 'CANCELLED';
    },
  },
]);

export let lastImage: string | null = null;

/** Import an image file into the document; returns the new image id. */
export async function importImageFile(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let width = 0,
    height = 0;
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || 'image/png' }));
    width = bmp.width;
    height = bmp.height;
  } catch {
    app.report('ERROR', `Unsupported image format: ${file.name}`);
    return null;
  }
  const doc = app.doc;
  const id = uid('im');
  doc.images[id] = { id, name: uniqueName(doc, file.name, 'images'), mime: file.type || 'image/png', bytes, width, height, source: 'FILE', colorspace: 'sRGB', filepath: file.name, revision: 0 };
  lastImage = id;
  app.pushUndo('Open Image');
  app.changed('doc');
  return id;
}

function setSlotSelection(select: boolean) {
  const { ob, me } = activeMesh()!;
  const s = new Uint8Array(me.select_vert ?? new Uint8Array(me.positions.length / 3));
  for (let f = 0; f < me.offsets.length - 1; f++) {
    if ((me.material_index?.[f] ?? 0) !== ob.active_material_index) continue;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) s[me.indices[c]] = select ? 1 : 0;
  }
  me.select_vert = s;
}
