// Mesh data tab: Attributes (the mesh's named data layers) and Texture Space panels.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { panel } from '../../../ui/widgets';
import { bool, vecProp } from '../../../ui/props';
import type { MeshData, CurveData } from '../../../data/types';
import { boundsTexSpace } from '../../../render/texspace';
import { extendTab, insertPanels } from './insert';
import { uiList } from '../uilist';
import { validAttributes, ATTRIBUTE_TYPES } from '../../../mesh/attributes';

interface AttrRow {
  name: string;
  domain: string;
  type: string;
  icon: string;
}

/** Named attributes a mesh stores (built-in layers that carry user data, plus colours and UVs). */
export function meshAttributes(me: MeshData): AttrRow[] {
  const rows: AttrRow[] = [{ name: 'position', domain: 'Vertex', type: 'Vector', icon: 'snap_vertex' }];
  if (me.smooth && me.smooth.some((s) => !s)) rows.push({ name: 'sharp_face', domain: 'Face', type: 'Boolean', icon: 'snap_face' });
  if (me.sharp && me.sharp.some(Boolean)) rows.push({ name: 'sharp_edge', domain: 'Edge', type: 'Boolean', icon: 'snap_edge' });
  if (me.creases && me.creases.some(Boolean)) rows.push({ name: 'crease_edge', domain: 'Edge', type: 'Float', icon: 'snap_edge' });
  if (me.material_index && me.material_index.some(Boolean)) rows.push({ name: 'material_index', domain: 'Face', type: 'Integer', icon: 'snap_face' });
  if (me.uvs.length) rows.push({ name: me.uv_map_name || 'UVMap', domain: 'Face Corner', type: '2D Vector', icon: 'uv' });
  for (const c of me.color_attributes) rows.push({ name: c.name, domain: c.domain === 'POINT' ? 'Vertex' : 'Face Corner', type: 'Color', icon: 'group_vcol' });
  if (me.sculpt_face_set) rows.push({ name: '.sculpt_face_set', domain: 'Face', type: 'Integer', icon: 'snap_face' });
  if (me.sculpt_mask) rows.push({ name: '.sculpt_mask', domain: 'Vertex', type: 'Float', icon: 'snap_vertex' });
  return rows.filter((r) => !r.name.startsWith('.'));
}

const DOMAIN_LABEL: Record<string, string> = { POINT: 'Vertex', EDGE: 'Edge', FACE: 'Face', CORNER: 'Face Corner' };
const TYPE_LABEL: Record<string, string> = Object.fromEntries(ATTRIBUTE_TYPES.map(([v, l]) => [v, l]));

function attributesPanel(me: MeshData): Child {
  return panel('me-attributes', 'Attributes', () => {
    const generic = validAttributes(me);
    const builtin = meshAttributes(me).filter((r) => !generic.some((g) => g.name === r.name));
    const rows = [
      ...builtin.map((r) => ({ name: r.name, domain: r.domain, type: r.type, icon: r.icon, generic: false })),
      ...generic.map((g) => ({ name: g.name, domain: DOMAIN_LABEL[g.domain], type: TYPE_LABEL[g.data_type] ?? g.data_type, icon: g.domain === 'POINT' ? 'snap_vertex' : g.domain === 'EDGE' ? 'snap_edge' : g.domain === 'FACE' ? 'snap_face' : 'snap_face', generic: true })),
    ];
    const active = Math.max(0, rows.findIndex((r) => r.name === me.active_attribute));
    return uiList(
      'attrs',
      rows.map((r) => ({ key: r.name, label: r.name, icon: r.icon, rightSize: 'wide' as const, right: h('span', { class: 'ul-meta attr-meta' }, h('span', null, r.domain), h('span', null, r.type)) })),
      me.active_attribute ? active : -1,
      (i) => ((me.active_attribute = rows[i]?.name), app.changed('ui')),
      {
        add: () => app.run('geometry.attribute_add'),
        remove: () => app.run('geometry.attribute_remove'),
        rename: (i, name) => {
          const g = generic.find((x) => x.name === rows[i]?.name);
          name = name.trim();
          if (!g || !name || rows.some((r, j) => j !== i && r.name === name)) return;
          g.name = name;
          me.active_attribute = name;
          app.pushUndo('Rename Attribute');
          app.changed('doc');
        },
        specials: () => [{ label: 'Convert Attribute', op: 'geometry.attribute_convert' }],
      },
    );
  }, { closed: true });
}

/** Texture Space panel shared by meshes and curves. */
export function texSpacePanel(id: string, owner: MeshData | CurveData, positions: () => ArrayLike<number>, extra?: () => Child): Child {
  return panel(
    id,
    'Texture Space',
    () => {
      const auto = owner.use_auto_texspace !== false;
      // turning automatic off starts from the bounds it had
      const fromBounds = () => {
        const b = boundsTexSpace(positions());
        owner.texspace_location = b.location;
        owner.texspace_size = b.size;
      };
      if (!auto && !(owner.texspace_location && owner.texspace_size)) fromBounds();
      const b = auto ? boundsTexSpace(positions()) : null;
      const shown = b ? { texspace_location: b.location, texspace_size: b.size } : (owner as { texspace_location: number[]; texspace_size: number[] });
      return [
        bool(owner as { use_auto_texspace: boolean }, 'use_auto_texspace', 'Auto Texture Space', { tip: 'Fit the texture space to the bounds of the geometry', onChange: () => owner.use_auto_texspace === false && fromBounds() }),
        h('div', { class: { 'ts-fields': true, 'is-disabled': auto } }, vecProp(shown, 'texspace_location', 'Location', { unit: 'distance' }), vecProp(shown, 'texspace_size', 'Size')),
        extra?.() ?? null,
      ];
    },
    { closed: true },
  );
}

extendTab('DATA', (out) => {
  const o = app.activeObject;
  if (!o?.data || o.type !== 'MESH') return out;
  const me = app.doc.meshes[o.data];
  if (!me) return out;
  if (me.use_auto_texspace === undefined) me.use_auto_texspace = true;
  return insertPanels(out, ['me-colors', 'me-uvmaps'], 'after', [attributesPanel(me), texSpacePanel('me-texspace', me, () => me.positions)]);
});
