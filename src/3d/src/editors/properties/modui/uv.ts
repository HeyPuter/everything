// Panels of the UV modifiers.
import { h, type Child } from '../../../ui/h';
import { num, vecProp, splitRow } from '../../../ui/props';
import { enumMenu, enumRow } from '../../../ui/widgets';
import { app } from '../../../app/app';
import type { ModifierBase, ObjectData } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, sub, objRow, touch } from './kit';

type Rec = Record<string, unknown>;

/** The mesh has a single UV map: show it for reference. */
function uvMapRow(ob: ObjectData, m: ModifierBase): Child {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  const name = me?.uv_map_name || 'UVMap';
  void m;
  return splitRow('UV Map', h('span', { class: 'mod-file' }, name));
}

function boneRow(m: Rec, objKey: string, key: string, label: string): Child {
  const id = m[objKey] as string | null;
  const ob = id ? app.doc.objects[id] : undefined;
  const arm = ob?.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined;
  if (!arm) return null;
  return splitRow(label, enumMenu(`${m.id}.${key}`, [{ value: '', label: '—' }, ...arm.bones.map((b) => ({ value: b.name, label: b.name, icon: 'bone_data' }))], String(m[key] ?? ''), (v) => ((m[key] = v), touch(`Set ${label}`))));
}

modifierFields.UV_PROJECT = [];
modifierExtraUI.UV_PROJECT = (ob, m) => {
  const r = m as Rec;
  const count = Math.max(1, Math.min(10, Math.round((r.projector_count as number) ?? 1)));
  const list = ((r.projectors as (string | null)[] | undefined) ?? []).slice();
  while (list.length < count) list.push(null);
  if (list.length !== ((r.projectors as unknown[]) ?? []).length) r.projectors = list;
  const holder = r.projectors as (string | null)[];
  return [
    uvMapRow(ob, m),
    num(r, 'aspect_x', 'Aspect X', { min: 1, softMax: 1000 }),
    num(r, 'aspect_y', 'Y', { min: 1, softMax: 1000 }),
    num(r, 'scale_x', 'Scale X', { min: 0, softMax: 1000 }),
    num(r, 'scale_y', 'Y', { min: 0, softMax: 1000 }),
    sub(
      m,
      'projectors',
      'Projectors',
      () => [
        num(r, 'projector_count', 'Projectors', { int: true, min: 1, max: 10 }),
        holder.slice(0, count).map((_, i) =>
          splitRow(
            i === 0 ? 'Object' : '',
            enumMenu(
              `${m.id}.projector.${i}`,
              [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.id !== ob.id).sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ value: o.id, label: o.name, icon: o.type === 'CAMERA' ? 'outliner_ob_camera' : 'object' }))],
              String(holder[i] ?? ''),
              (v) => {
                const next = holder.slice();
                next[i] = v || null;
                r.projectors = next;
                touch('Set Projector');
              },
            ),
          ),
        ),
      ],
      { closed: false },
    ),
  ];
};

const AXES = [
  { value: 'X', label: 'X' },
  { value: 'Y', label: 'Y' },
  { value: 'Z', label: 'Z' },
];

modifierFields.UV_WARP = [];
modifierExtraUI.UV_WARP = (ob, m) => {
  const r = m as Rec;
  return [
    uvMapRow(ob, m),
    vecProp(r, 'center', 'Center', { names: ['X', 'Y'] }),
    splitRow('Axis U', enumRow(`${m.id}.axis_u`, AXES, String(r.axis_u ?? 'X'), (v) => ((r.axis_u = v), touch('Change Axis U')))),
    splitRow('V', enumRow(`${m.id}.axis_v`, AXES, String(r.axis_v ?? 'Y'), (v) => ((r.axis_v = v), touch('Change Axis V')))),
    objRow(r, 'object_from', 'Object From', (o) => o.id !== ob.id),
    boneRow(r, 'object_from', 'bone_from', 'Bone'),
    objRow(r, 'object_to', 'Object To', (o) => o.id !== ob.id),
    boneRow(r, 'object_to', 'bone_to', 'Bone'),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    sub(m, 'transform', 'Transform', () => [vecProp(r, 'offset', 'Offset', { names: ['X', 'Y'] }), vecProp(r, 'scale', 'Scale', { names: ['X', 'Y'] }), num(r, 'rotation', 'Rotation', { unit: 'angle' })]),
  ] as Child[];
};

