// Generic mesh attributes: geometry.attribute_add / remove / convert, mesh.attribute_set on the active
// attribute (any type), mesh.select_by_attribute, and the color attribute specials (duplicate, convert,
// render color).
import { app, registerOperators, onAppReady, operators, registerOperator, type OpContext, type PropDef } from '../app/app';
import type { AttributeType, MeshAttribute, MeshData, ObjectData } from '../data/types';
import { ATTRIBUTE_TYPES, ATTRIBUTE_DOMAINS, attrWidth, newAttribute, convertAttribute, validAttributes, uniqueAttributeName, attributeTrue, attrDomainSize } from '../mesh/attributes';
import { operatorDialog } from '../ui/opdialog';
import { selectedFaceSet } from '../modes/editmesh/selset';

const meshOf = (ob: ObjectData | null | undefined): MeshData | undefined => (ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined);
const activeMesh = () => meshOf(app.activeObject);

/** The active generic attribute of the mesh (null for built-in / color / UV rows). */
export function activeAttribute(me: MeshData): MeshAttribute | null {
  return validAttributes(me).find((a) => a.name === me.active_attribute) ?? null;
}

const changed = () => app.changed('doc', 'geometry');

const domainProp: PropDef = { id: 'domain', label: 'Domain', type: 'enum', default: 'POINT', items: ATTRIBUTE_DOMAINS.map(([v, l]) => [v, l]) };
const typeProp: PropDef = { id: 'data_type', label: 'Data Type', type: 'enum', default: 'FLOAT', items: ATTRIBUTE_TYPES.map(([v, l, d]) => [v, l, d]) };

registerOperators([
  {
    idname: 'geometry.attribute_add',
    label: 'Add Attribute',
    description: 'Add a named data layer to the mesh',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Attribute' }, domainProp, typeProp],
    poll: () => !!activeMesh(),
    invoke: (_ctx, p) => {
      operatorDialog('geometry.attribute_add', p, { title: 'Add Attribute' });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const me = activeMesh()!;
      const name = uniqueAttributeName(me, String(p.name || 'Attribute'));
      const a = newAttribute(me, name, p.domain as MeshAttribute['domain'], p.data_type as AttributeType);
      me.attributes = [...validAttributes(me), a];
      me.active_attribute = name;
      changed();
    },
  },
  {
    idname: 'geometry.attribute_remove',
    label: 'Remove Attribute',
    description: 'Remove the active attribute',
    poll: () => {
      const me = activeMesh();
      return !!me && !!activeAttribute(me);
    },
    exec: () => {
      const me = activeMesh()!;
      const list = validAttributes(me);
      const i = list.findIndex((a) => a.name === me.active_attribute);
      if (i < 0) return 'CANCELLED';
      list.splice(i, 1);
      me.attributes = list;
      me.active_attribute = list[Math.min(i, list.length - 1)]?.name;
      changed();
    },
  },
  {
    idname: 'geometry.attribute_convert',
    label: 'Convert Attribute',
    description: 'Change the domain and / or data type of the active attribute',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'GENERIC',
        items: [
          ['GENERIC', 'Generic', 'Another domain and data type'],
          ['VERTEX_GROUP', 'Vertex Group', 'A vertex group from the values on vertices'],
        ],
      },
      { ...domainProp, showIf: (p) => p.mode === 'GENERIC' },
      { ...typeProp, showIf: (p) => p.mode === 'GENERIC' },
    ],
    poll: (ctx: OpContext) => {
      const me = activeMesh();
      return !!me && !!activeAttribute(me) && ctx.doc.mode !== 'EDIT';
    },
    invoke: (_ctx, p) => {
      const a = activeAttribute(activeMesh()!)!;
      operatorDialog('geometry.attribute_convert', { ...p, domain: a.domain, data_type: a.data_type }, { title: 'Convert Attribute' });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const me = activeMesh()!;
      const a = activeAttribute(me)!;
      if (p.mode === 'VERTEX_GROUP') {
        const w = convertAttribute(me, a, 'POINT', 'FLOAT').data;
        me.vertex_groups = [...me.vertex_groups, { name: a.name }];
        me.weights = [...me.weights, Float32Array.from(w as ArrayLike<number>, (x) => Math.max(0, Math.min(1, x)))];
        me.attributes = validAttributes(me).filter((x) => x !== a);
        me.active_attribute = undefined;
      } else me.attributes = validAttributes(me).map((x) => (x === a ? convertAttribute(me, a, p.domain as MeshAttribute['domain'], p.data_type as AttributeType) : x));
      changed();
    },
  },
  {
    idname: 'mesh.select_by_attribute',
    label: 'Select by Attribute',
    description: 'Select the elements where the active boolean attribute is true',
    poll: (ctx: OpContext) => {
      if (ctx.doc.mode !== 'EDIT') return false;
      const me = activeMesh();
      return !!me && activeAttribute(me)?.data_type === 'BOOLEAN';
    },
    exec: () => {
      const me = activeMesh()!;
      const a = activeAttribute(me)!;
      const sel = Uint8Array.from(me.select_vert ?? new Uint8Array(me.positions.length / 3));
      if (a.domain === 'POINT') attributeTrue(me, a, 'POINT').forEach((t, v) => t && !me.hide_vert?.[v] && (sel[v] = 1));
      else if (a.domain === 'FACE')
        attributeTrue(me, a, 'FACE').forEach((t, f) => {
          if (t) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!me.hide_vert?.[me.indices[c]]) sel[me.indices[c]] = 1;
        });
      else {
        // edges / corners: both vertices of a true element
        const w = attrWidth(a.data_type);
        const nc = me.indices.length;
        for (let f = 0; f < me.offsets.length - 1; f++)
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
            if (!a.data[c * w]) continue;
            const n = c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f];
            for (const v of a.domain === 'EDGE' ? [me.indices[c], me.indices[n]] : [me.indices[c]]) if (!me.hide_vert?.[v]) sel[v] = 1;
          }
        if (a.domain === 'EDGE' && me.loose_edges)
          for (let i = 0; i + 1 < me.loose_edges.length; i += 2) if (a.data[(nc + i / 2) * w]) for (const v of [me.loose_edges[i], me.loose_edges[i + 1]]) if (!me.hide_vert?.[v]) sel[v] = 1;
      }
      me.select_vert = sel;
      app.changed('select', 'doc');
    },
  },
  {
    idname: 'geometry.color_attribute_duplicate',
    label: 'Duplicate Color Attribute',
    description: 'Copy the active color attribute',
    poll: () => !!activeMesh()?.color_attributes[activeMesh()!.active_color_index],
    exec: () => {
      const me = activeMesh()!;
      const c = me.color_attributes[me.active_color_index];
      me.color_attributes = [...me.color_attributes, { ...c, name: uniqueAttributeName(me, c.name), data: c.data.slice() }];
      me.active_color_index = me.color_attributes.length - 1;
      changed();
    },
  },
  {
    idname: 'geometry.color_attribute_convert',
    label: 'Convert Color Attribute',
    description: 'Move the active color attribute to vertices or face corners',
    props: [{ id: 'domain', label: 'Domain', type: 'enum', default: 'POINT', items: [['POINT', 'Vertex'], ['CORNER', 'Face Corner']] }],
    poll: (ctx: OpContext) => ctx.doc.mode !== 'EDIT' && !!activeMesh()?.color_attributes[activeMesh()!.active_color_index],
    invoke: (_ctx, p) => {
      const me = activeMesh()!;
      operatorDialog('geometry.color_attribute_convert', { ...p, domain: me.color_attributes[me.active_color_index].domain === 'POINT' ? 'CORNER' : 'POINT' }, { title: 'Convert Color Attribute' });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const me = activeMesh()!;
      const c = me.color_attributes[me.active_color_index];
      if (c.domain === p.domain) return 'CANCELLED';
      // the conversion reuses the generic attribute mapping on a 4-wide float layer
      const tmp: MeshAttribute = { name: c.name, domain: c.domain, data_type: 'QUATERNION', data: c.data };
      const out = convertAttribute(me, tmp, p.domain as 'POINT', 'QUATERNION');
      me.color_attributes = me.color_attributes.map((x) => (x === c ? { ...c, domain: p.domain as 'POINT', data: out.data as Float32Array } : x));
      changed();
    },
  },
  {
    idname: 'geometry.color_attribute_render_set',
    label: 'Set Render Color',
    description: 'Use this color attribute for rendering (the first in the list)',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Color' }],
    poll: () => (activeMesh()?.color_attributes.length ?? 0) > 1,
    exec: (_ctx, p) => {
      const me = activeMesh()!;
      const i = me.color_attributes.findIndex((c) => c.name === p.name);
      if (i <= 0) return i === 0 ? 'FINISHED' : 'CANCELLED';
      const act = me.color_attributes[me.active_color_index];
      const list = [...me.color_attributes];
      const [c] = list.splice(i, 1);
      list.unshift(c);
      me.color_attributes = list;
      me.active_color_index = list.indexOf(act);
      changed();
    },
  },
]);

// mesh.attribute_set: the active generic attribute (any type), or the active color attribute as before
onAppReady(() => {
  const base = operators.get('mesh.attribute_set');
  const valueProps: PropDef[] = [
    { id: 'value_float', label: 'Value', type: 'float', default: 0 },
    { id: 'value_float_vector_2d', label: 'Value', type: 'vec2', default: [0, 0] },
    { id: 'value_float_vector_3d', label: 'Value', type: 'vec3', default: [0, 0, 0] },
    { id: 'value_int', label: 'Value', type: 'int', default: 0 },
    { id: 'value_int_vector_2d', label: 'Value', type: 'vec2', default: [0, 0] },
    { id: 'value_bool', label: 'Value', type: 'bool', default: false },
    { id: 'value_quat', label: 'Value', type: 'float', default: 1, hidden: true },
  ];
  const typeOfActive = () => {
    const me = activeMesh();
    return me ? activeAttribute(me)?.data_type : undefined;
  };
  const visibleFor: Record<string, AttributeType[]> = {
    value_float: ['FLOAT'],
    value_float_vector_2d: ['FLOAT2'],
    value_float_vector_3d: ['FLOAT_VECTOR'],
    value_int: ['INT', 'INT8'],
    value_int_vector_2d: ['INT32_2D'],
    value_bool: ['BOOLEAN'],
  };
  const props = [...(base?.props ?? []).map((d) => ({ ...d, showIf: () => !typeOfActive() })), ...valueProps.map((d) => ({ ...d, showIf: () => (visibleFor[d.id] ?? []).includes(typeOfActive()!) }))];
  registerOperator({
    ...(base ?? { idname: 'mesh.attribute_set', label: 'Set Attribute' }),
    description: 'Set the active attribute (or color attribute) on the selected elements',
    props,
    poll: (ctx) => {
      const me = activeMesh();
      if (ctx.doc.mode !== 'EDIT' || !me) return false;
      return !!activeAttribute(me) || (base?.poll ? base.poll(ctx) : false);
    },
    exec: (ctx, p) => {
      const me = activeMesh()!;
      const a = activeAttribute(me);
      if (!a) return base?.exec ? base.exec(ctx, p) : 'CANCELLED';
      const w = attrWidth(a.data_type);
      const t = a.data_type;
      const value: number[] =
        t === 'FLOAT' ? [p.value_float as number]
        : t === 'FLOAT2' ? (p.value_float_vector_2d as number[])
        : t === 'FLOAT_VECTOR' ? (p.value_float_vector_3d as number[])
        : t === 'INT' || t === 'INT8' ? [Math.trunc(p.value_int as number)]
        : t === 'INT32_2D' ? (p.value_int_vector_2d as number[]).map(Math.trunc)
        : t === 'BOOLEAN' ? [p.value_bool ? 1 : 0]
        : [];
      if (value.length !== w) return 'CANCELLED';
      const data = a.data.slice();
      const sel = me.select_vert ?? new Uint8Array(0);
      const vsel = (v: number) => !!sel[v] && !me.hide_vert?.[v];
      if (a.domain === 'POINT') for (let v = 0; v < sel.length; v++) vsel(v) && data.set(value, v * w);
      else if (a.domain === 'FACE') for (const f of selectedFaceSet(me)) data.set(value, f * w);
      else {
        const faces = selectedFaceSet(me);
        for (let f = 0; f < me.offsets.length - 1; f++)
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
            const n = c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f];
            const on = a.domain === 'CORNER' ? (faces.size ? faces.has(f) : vsel(me.indices[c])) : vsel(me.indices[c]) && vsel(me.indices[n]);
            if (on) data.set(value, c * w);
          }
        if (a.domain === 'EDGE' && me.loose_edges) {
          const nc = me.indices.length;
          for (let i = 0; i + 1 < me.loose_edges.length; i += 2) if (vsel(me.loose_edges[i]) && vsel(me.loose_edges[i + 1])) data.set(value, (nc + i / 2) * w);
        }
      }
      me.attributes = validAttributes(me).map((x) => (x === a ? { ...a, data } : x));
      changed();
    },
  });
});

export { attrDomainSize };
