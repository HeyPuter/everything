// Object relations and data sharing: mesh data transfer, UV copying, collections, instance offsets,
// lattice-deform-selected and animation-to-delta conversion.
import { Box3, Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import { newLattice, newObject, uid } from '../data/defaults';
import type { CollectionData, DocumentData, MeshData, ObjectData } from '../data/types';
import { newModifier } from '../eval/modifiers';
import { addObjectToScene, activeCollection, uniqueName } from '../ops/object';
import { openMenu } from '../ui/menu';
import { edgeTopology, faceNormals } from '../mesh/mesh';
import { sharpByAngle } from './core';
import { invalidatePaintAttributes } from '../paint/display';
import { cornerDomain, edgeDomain, transferData, transferLayout, vertexDomain, type TransferType } from './transfer';

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

function meshOf(ob: ObjectData): MeshData | undefined {
  return ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
}

function worldPositions(ob: ObjectData, me: MeshData, world: boolean): Float32Array {
  if (!world) return me.positions;
  const m = app.graph.get(ob.id)?.world ?? new Matrix4();
  const out = new Float32Array(me.positions.length);
  const v = new Vector3();
  for (let i = 0; i < out.length; i += 3) {
    v.set(me.positions[i], me.positions[i + 1], me.positions[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

const dataTypes: [string, string][] = [
  ['VGROUP_WEIGHTS', 'Vertex Group(s)'],
  ['COLOR_VERTEX', 'Color Attribute (Vertex)'],
  ['SEAM', 'UV Seam'],
  ['SHARP_EDGE', 'Sharp'],
  ['CREASE', 'Subdivision Crease'],
  ['COLOR_CORNER', 'Color Attribute (Face Corner)'],
  ['UV', 'UVs'],
  ['SMOOTH', 'Smooth'],
];

const mappingItems = (kind: 'vert' | 'edge' | 'loop' | 'poly'): [string, string][] => [
  ['TOPOLOGY', 'Topology'],
  kind === 'vert' ? ['NEAREST', 'Nearest Vertex'] : kind === 'edge' ? ['NEAREST', 'Nearest Edge'] : kind === 'loop' ? ['NEAREST_POLYNOR', 'Nearest Corner and Best Matching Face'] : ['NEAREST', 'Nearest Face'],
];

const transferProps: PropDef[] = [
  { id: 'use_reverse_transfer', label: 'Reverse Transfer', type: 'bool', default: false },
  { id: 'data_type', label: 'Data Type', type: 'enum', default: 'VGROUP_WEIGHTS', items: dataTypes },
  { id: 'use_create', label: 'Create Data', type: 'bool', default: true },
  { id: 'vert_mapping', label: 'Vertex Mapping', type: 'enum', default: 'NEAREST', items: mappingItems('vert'), showIf: (p) => vertexDomain(p.data_type as TransferType) },
  { id: 'edge_mapping', label: 'Edge Mapping', type: 'enum', default: 'NEAREST', items: mappingItems('edge'), showIf: (p) => edgeDomain(p.data_type as TransferType) },
  { id: 'loop_mapping', label: 'Face Corner Mapping', type: 'enum', default: 'NEAREST_POLYNOR', items: mappingItems('loop'), showIf: (p) => cornerDomain(p.data_type as TransferType) },
  { id: 'poly_mapping', label: 'Face Mapping', type: 'enum', default: 'NEAREST', items: mappingItems('poly'), showIf: (p) => p.data_type === 'SMOOTH' },
  { id: 'use_object_transform', label: 'Object Transform', type: 'bool', default: true },
  { id: 'use_max_distance', label: 'Only Neighbor Geometry', type: 'bool', default: false },
  { id: 'max_distance', label: 'Max Distance', type: 'float', default: 1, min: 0, subtype: 'distance', showIf: (p) => !!p.use_max_distance },
  { id: 'layers_select_src', label: 'Source Layers', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active Layer'], ['ALL', 'All Layers']], showIf: (p) => p.data_type === 'VGROUP_WEIGHTS' },
  { id: 'layers_select_dst', label: 'Destination Layers', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active Layer'], ['NAME', 'By Name'], ['INDEX', 'By Order']], showIf: (p) => p.data_type === 'VGROUP_WEIGHTS' || p.data_type === 'COLOR_VERTEX' || p.data_type === 'COLOR_CORNER' },
  {
    id: 'mix_mode',
    label: 'Mix Mode',
    type: 'enum',
    default: 'REPLACE',
    items: [
      ['REPLACE', 'Replace'],
      ['ABOVE_THRESHOLD', 'Above Threshold'],
      ['BELOW_THRESHOLD', 'Below Threshold'],
      ['MIX', 'Mix'],
      ['ADD', 'Add'],
      ['SUB', 'Subtract'],
      ['MUL', 'Multiply'],
    ],
  },
  { id: 'mix_factor', label: 'Mix Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
];

function mappingFor(p: Record<string, unknown>): 'TOPOLOGY' | 'NEAREST' {
  const t = p.data_type as TransferType;
  const m = vertexDomain(t) ? p.vert_mapping : edgeDomain(t) ? p.edge_mapping : cornerDomain(t) ? p.loop_mapping : p.poly_mapping;
  return m === 'TOPOLOGY' ? 'TOPOLOGY' : 'NEAREST';
}

/** Ordered list of the scene's collections below the scene collection (depth first). */
export function sceneCollections(doc: DocumentData): CollectionData[] {
  const out: CollectionData[] = [];
  const visit = (id: string) => {
    for (const ch of doc.collections[id]?.children ?? []) {
      if (!doc.collections[ch]) continue;
      out.push(doc.collections[ch]);
      visit(ch);
    }
  };
  visit(doc.scene.collection);
  return out;
}

/** The collection shown in the Collection properties tab. */
export function propertiesCollection(): CollectionData | undefined {
  const doc = app.doc;
  const id = activeCollection(doc);
  if (id && id !== doc.scene.collection && doc.collections[id]) return doc.collections[id];
  return Object.values(doc.collections).find((x) => x.id !== doc.scene.collection);
}

function ancestors(doc: DocumentData, id: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  out.add(id);
  while (changed) {
    changed = false;
    for (const c of Object.values(doc.collections))
      if (!out.has(c.id) && c.children.some((ch) => out.has(ch))) {
        out.add(c.id);
        changed = true;
      }
  }
  return out;
}

function descendants(doc: DocumentData, id: string): Set<string> {
  const out = new Set<string>([id]);
  const st = [id];
  while (st.length) for (const ch of doc.collections[st.pop()!]?.children ?? []) if (!out.has(ch)) (out.add(ch), st.push(ch));
  return out;
}

registerOperators([
  {
    idname: 'object.shade_smooth_by_angle',
    label: 'Shade Smooth by Angle',
    description: 'Shade smooth and mark edges sharp where faces meet at more than the angle',
    props: [
      { id: 'angle', label: 'Angle', type: 'float', default: (30 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' },
      { id: 'keep_sharp_edges', label: 'Keep Sharp Edges', type: 'bool', default: true },
    ],
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().some((o) => !!meshOf(o)),
    exec: (_ctx, p) => {
      for (const ob of app.selectedObjects()) {
        const me = meshOf(ob);
        if (!me) continue;
        me.sharp = sharpByAngle(me, p.angle as number, !!p.keep_sharp_edges, edgeTopology(me), faceNormals(me));
        me.smooth = new Uint8Array(me.offsets.length - 1).fill(1);
        // the angle now lives in the mesh: drop a smooth-by-angle modifier doing the same
        ob.modifiers = ob.modifiers.filter((m) => m.type !== 'SMOOTH_BY_ANGLE');
      }
    },
  },
  {
    idname: 'object.data_transfer',
    label: 'Transfer Mesh Data',
    description: 'Copy vertex groups, colors, UVs or edge and face flags from the active mesh to the other selected meshes',
    props: transferProps,
    poll: (ctx) => (objectMode(ctx) || ctx.doc.mode === 'WEIGHT_PAINT') && !!app.activeObject && !!meshOf(app.activeObject) && app.selectedObjects().some((o) => o !== app.activeObject && !!meshOf(o)),
    exec: (_ctx, p) => {
      const act = app.activeObject!;
      const others = app.selectedObjects().filter((o) => o !== act && meshOf(o));
      const pairs = p.use_reverse_transfer ? [[others[0], act]] : others.map((o) => [act, o]);
      const world = !!p.use_object_transform;
      const maxD = p.use_max_distance ? (p.max_distance as number) : Infinity;
      let changed = 0;
      for (const [s, d] of pairs) {
        const S = meshOf(s)!,
          D = meshOf(d)!;
        if (S === D) continue;
        changed += transferData(
          { me: S, positions: worldPositions(s, S, world), activeGroup: s.vertex_group_active_index ?? 0 },
          { me: D, positions: worldPositions(d, D, world), activeGroup: d.vertex_group_active_index ?? 0 },
          {
            data_type: p.data_type as TransferType,
            mapping: mappingFor(p),
            use_create: !!p.use_create,
            layers_select_src: p.layers_select_src as 'ACTIVE' | 'ALL',
            layers_select_dst: p.layers_select_dst as 'ACTIVE' | 'NAME' | 'INDEX',
            mix_mode: p.mix_mode as 'REPLACE',
            mix_factor: p.mix_factor as number,
            max_distance2: maxD * maxD,
          },
        );
      }
      if (!changed) {
        app.report('WARNING', 'Nothing was transferred (missing source data or matching layers)');
        return 'CANCELLED';
      }
      invalidatePaintAttributes();
    },
  },
  {
    idname: 'object.datalayout_transfer',
    label: 'Transfer Mesh Data Layout',
    description: 'Give the other selected meshes the same vertex groups or color attributes as the active mesh, without copying values',
    props: [
      { id: 'data_type', label: 'Data Type', type: 'enum', default: 'VGROUP_WEIGHTS', items: dataTypes.filter(([v]) => v === 'VGROUP_WEIGHTS' || v === 'COLOR_VERTEX' || v === 'COLOR_CORNER') },
      { id: 'use_delete', label: 'Exact Match', type: 'bool', default: false },
    ],
    poll: (ctx) => objectMode(ctx) && !!app.activeObject && !!meshOf(app.activeObject) && app.selectedObjects().some((o) => o !== app.activeObject && !!meshOf(o)),
    exec: (_ctx, p) => {
      const act = app.activeObject!;
      const S = meshOf(act)!;
      for (const o of app.selectedObjects()) {
        const D = meshOf(o);
        if (o === act || !D || D === S) continue;
        transferLayout(S, D, p.data_type as TransferType, !!p.use_delete);
      }
    },
  },
  {
    idname: 'object.join_uvs',
    label: 'Copy UV Maps',
    description: 'Copy the active mesh’s UVs to the other selected meshes with the same face layout',
    poll: (ctx) => objectMode(ctx) && !!app.activeObject && !!meshOf(app.activeObject) && app.selectedObjects().some((o) => o !== app.activeObject && !!meshOf(o)),
    exec: () => {
      const act = app.activeObject!;
      const S = meshOf(act)!;
      let skipped = 0;
      for (const o of app.selectedObjects()) {
        const D = meshOf(o);
        if (o === act || !D || D === S) continue;
        if (D.indices.length !== S.indices.length || D.offsets.length !== S.offsets.length) {
          skipped++;
          continue;
        }
        D.uvs = new Float32Array(S.uvs);
      }
      if (skipped) app.report('WARNING', `Skipped ${skipped} mesh(es) with a different face layout`);
    },
  },
  {
    idname: 'collection.objects_remove',
    label: 'Remove from Collection',
    description: 'Remove the selected objects from one of the active object’s collections',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: (ctx) => objectMode(ctx) && !!app.activeObject,
    invoke: (ctx, p) => {
      if (p.collection) return removeFromCollection(ctx, p);
      const act = app.activeObject!;
      const cols = Object.values(ctx.doc.collections).filter((c) => c.objects.includes(act.id));
      openMenu(
        cols.map((c) => ({ label: c.name, icon: c.id === ctx.doc.scene.collection ? 'scene' : 'collection', action: () => app.run('collection.objects_remove', { collection: c.id }, { invoke: false }) })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: 'Remove from Collection' },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => removeFromCollection(ctx, p),
  },
  {
    idname: 'object.hide_collection',
    label: 'Hide Other Collections',
    description: 'Show only the objects of one collection (Shift: toggle it, keep the others)',
    props: [
      { id: 'collection_index', label: 'Collection Index', type: 'int', default: -1, min: -1 },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: (ctx) => objectMode(ctx) && sceneCollections(ctx.doc).length > 0,
    invoke: (ctx, p) => {
      if ((p.collection_index as number) > 0) return hideCollections(ctx, p);
      const cols = sceneCollections(ctx.doc);
      openMenu(
        cols.map((c, i) => ({
          label: c.name,
          icon: c.hide ? 'hide_on' : 'hide_off',
          action: () => app.run('object.hide_collection', { collection_index: i + 1 }, { invoke: false }),
        })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: 'Hide Collection' },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => hideCollections(ctx, p),
  },
  {
    idname: 'object.instance_offset_from_cursor',
    label: 'Set Offset from Cursor',
    description: 'Use the 3D cursor location as the collection’s instance offset',
    poll: () => !!propertiesCollection(),
    exec: (ctx) => {
      propertiesCollection()!.instance_offset = [...ctx.doc.scene.cursor.location] as [number, number, number];
    },
  },
  {
    idname: 'object.instance_offset_from_object',
    label: 'Set Offset from Object',
    description: 'Use the active object’s location as the collection’s instance offset',
    poll: () => !!propertiesCollection() && !!app.activeObject,
    exec: () => {
      const p = new Vector3().setFromMatrixPosition(app.graph.get(app.activeObject!.id)?.world ?? new Matrix4());
      propertiesCollection()!.instance_offset = [p.x, p.y, p.z];
    },
  },
  {
    idname: 'object.instance_offset_to_cursor',
    label: 'Set Cursor to Offset',
    description: 'Move the 3D cursor to the collection’s instance offset',
    poll: () => !!propertiesCollection(),
    exec: (ctx) => {
      ctx.doc.scene.cursor.location = [...propertiesCollection()!.instance_offset] as [number, number, number];
      app.changed('view');
    },
  },
  {
    idname: 'object.lattice_add_to_selected',
    label: 'Lattice Deform Selected',
    description: 'Add a lattice that encloses the selected objects and deforms them',
    props: [
      { id: 'fit_to_selected', label: 'Fit to Selected', type: 'bool', default: true },
      { id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance', showIf: (p) => !p.fit_to_selected },
      { id: 'margin', label: 'Margin', type: 'float', default: 0, min: 0, subtype: 'distance' },
      { id: 'add_modifiers', label: 'Add Modifiers', type: 'bool', default: true },
      { id: 'resolution_u', label: 'Resolution U', type: 'int', default: 2, min: 2, max: 64 },
      { id: 'resolution_v', label: 'V', type: 'int', default: 2, min: 2, max: 64 },
      { id: 'resolution_w', label: 'W', type: 'int', default: 2, min: 2, max: 64 },
    ],
    poll: (ctx) => objectMode(ctx),
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const sel = app.selectedObjects().filter((o) => o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT');
      const box = new Box3();
      if (p.fit_to_selected && sel.length) {
        for (const o of sel) {
          const ev = app.graph.get(o.id);
          const pos = ev?.mesh?.positions;
          if (!pos) continue;
          const v = new Vector3();
          for (let i = 0; i < pos.length; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(ev!.world));
        }
      }
      if (box.isEmpty()) {
        const c = new Vector3(...doc.scene.cursor.location);
        const r = (p.radius as number) || 1;
        box.setFromCenterAndSize(c, new Vector3(r * 2, r * 2, r * 2));
      }
      box.expandByScalar(p.margin as number);
      const size = box.getSize(new Vector3());
      // flat selections still get a usable lattice thickness
      for (const k of ['x', 'y', 'z'] as const) if (size[k] < 1e-4) size[k] = 0.1;
      const center = box.getCenter(new Vector3());
      const U = p.resolution_u as number,
        V = p.resolution_v as number,
        W = p.resolution_w as number;
      const lt = newLattice(uniqueName(doc, 'Lattice', 'lattices'));
      const pts: number[] = [];
      for (let k = 0; k < W; k++) for (let j = 0; j < V; j++) for (let i = 0; i < U; i++) pts.push(i / (U - 1) - 0.5, j / (V - 1) - 0.5, k / (W - 1) - 0.5);
      Object.assign(lt, { points_u: U, points_v: V, points_w: W, points: new Float32Array(pts) });
      doc.lattices[lt.id] = lt;
      const ob = newObject('Lattice', 'LATTICE', lt.id);
      addObjectToScene(doc, ob, { location: [center.x, center.y, center.z], rotation: [0, 0, 0] });
      ob.scale = [size.x, size.y, size.z];
      if (p.add_modifiers)
        for (const o of sel) {
          const m = newModifier('LATTICE', uid('md'), o.modifiers);
          m.object = ob.id;
          o.modifiers = [...o.modifiers, m];
        }
    },
  },
  {
    idname: 'object.anim_transforms_to_deltas',
    label: 'Animated Transforms to Deltas',
    description: 'Retarget location, rotation and scale animation to the delta transforms',
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().some((o) => !!o.animation_data?.action),
    exec: (ctx) => {
      const map: Record<string, string> = { location: 'delta_location', rotation_euler: 'delta_rotation_euler', scale: 'delta_scale' };
      const reset: Record<string, (o: ObjectData) => void> = {
        location: (o) => (o.location = [0, 0, 0]),
        rotation_euler: (o) => (o.rotation_euler = [0, 0, 0]),
        scale: (o) => (o.scale = [1, 1, 1]),
      };
      let n = 0;
      const seen = new Set<string>();
      for (const ob of app.selectedObjects()) {
        const aid = ob.animation_data?.action;
        const act = aid ? ctx.doc.actions[aid] : undefined;
        if (!act) continue;
        const paths = new Set(act.fcurves.map((f) => f.data_path).filter((d) => map[d]));
        if (!seen.has(act.id)) {
          seen.add(act.id);
          if (act.fcurves.some((f) => Object.values(map).includes(f.data_path))) {
            app.report('WARNING', `"${ob.name}" already animates delta transforms`);
            continue;
          }
          act.fcurves = act.fcurves.map((f) => (map[f.data_path] ? { ...f, data_path: map[f.data_path] } : f));
        }
        for (const d of paths) reset[d](ob);
        n += paths.size;
      }
      if (!n) return 'CANCELLED';
    },
  },
]);

function removeFromCollection(ctx: OpContext, p: Record<string, unknown>) {
  const doc = ctx.doc;
  const c = doc.collections[p.collection as string] ?? Object.values(doc.collections).find((x) => x.name === p.collection);
  if (!c) return 'CANCELLED' as const;
  for (const ob of app.selectedObjects()) {
    // objects must stay linked to at least one collection
    const elsewhere = Object.values(doc.collections).some((x) => x !== c && x.objects.includes(ob.id));
    if (elsewhere) c.objects = c.objects.filter((x) => x !== ob.id);
  }
}

function hideCollections(ctx: OpContext, p: Record<string, unknown>) {
  const doc = ctx.doc;
  const cols = sceneCollections(doc);
  const target = cols[(p.collection_index as number) - 1];
  if (!target) return 'CANCELLED' as const;
  if (p.toggle) {
    target.hide = !target.hide;
    return;
  }
  const keep = new Set([...ancestors(doc, target.id), ...descendants(doc, target.id)]);
  for (const c of cols) {
    if (keep.has(c.id)) c.hide = false;
    else if (!p.extend) c.hide = true;
  }
}
