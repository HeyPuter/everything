// Mesh data tab: Attributes (the mesh's named data layers) and Texture Space panels.
import { h, type Child } from '../../../ui/h';
import { icon } from '../../../ui/icons';
import { app } from '../../../app/app';
import { panel } from '../../../ui/widgets';
import { bool, vecProp } from '../../../ui/props';
import type { MeshData, CurveData } from '../../../data/types';
import { boundsTexSpace } from '../../../render/texspace';
import { extendTab, insertPanels } from './insert';

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

function attributesPanel(me: MeshData): Child {
  return panel(
    'me-attributes',
    'Attributes',
    () =>
      h(
        'div',
        { class: 'attr-table' },
        meshAttributes(me).map((a) => h('div', { key: a.name, class: 'attr-row' }, icon(a.icon), h('span', { class: 'attr-name' }, a.name), h('span', { class: 'attr-meta' }, a.domain), h('span', { class: 'attr-meta' }, a.type))),
      ),
    { closed: true },
  );
}

/** Texture Space panel shared by meshes and curves. */
export function texSpacePanel(id: string, owner: MeshData | CurveData, positions: () => ArrayLike<number>): Child {
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
