// Nodes for node groups used as tools: the selection of the edited geometry (read and set), the
// 3D cursor, the active element, the mouse position and the viewport transform. Outside a tool
// they give neutral values and say so on the node.
import { geoNode, sock, geo, enumProp } from '../nodes/gndef';
import { ConstField, convertField } from '../field';
import { attributeField } from '../inputs';
import { storeOn } from '../nodes/geometry';
import type { ExecContext } from '../exec';
import type { Domain } from '../types';
import { placeFromLayout } from '../bundles/menu';

/** Attribute holding the selection of a tool's geometry (per vertex, adapted to other domains). */
export const TOOL_SELECTION = '.select_vert';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function toolOnly(ctx: ExecContext) {
  if (!ctx.env.tool) ctx.warn('This node only gives values when the node group runs as a tool', 'INFO');
  return ctx.env.tool;
}

/** Cache signature: tool nodes depend on the tool environment, not on the tree. */
const sig = (_n: unknown, env: { tool?: unknown }) => JSON.stringify(env.tool ?? null);

const description = (what: string) => `${what} (in node groups run as tools from the 3D viewport)`;

geoNode(
  {
    idname: 'GeometryNodeToolSelection',
    label: 'Selection',
    category: 'input',
    description: description('Which elements of the edited geometry are selected'),
    outputs: [sock('Boolean', 'BOOLEAN', { id: 'Selection', field: true }), sock('Float', 'FLOAT', { field: true })],
  },
  {
    sig,
    exec: (ctx) => {
      const t = toolOnly(ctx);
      // everything is selected outside Edit Mode
      const sel = t?.mode === 'EDIT' ? attributeField(TOOL_SELECTION, 'BOOLEAN') : new ConstField('BOOLEAN', true);
      return { Selection: sel, Float: convertField(sel, 'FLOAT') };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeToolSetSelection',
    label: 'Set Selection',
    category: 'geometry',
    description: description('Change which elements of the edited geometry are selected'),
    props: [
      enumProp('domain', 'Domain', [
        ['POINT', 'Point'],
        ['EDGE', 'Edge'],
        ['FACE', 'Face'],
        ['CURVE', 'Spline'],
      ]),
      enumProp('selection_type', 'Selection Type', [
        ['BOOLEAN', 'Boolean'],
        ['FLOAT', 'Float'],
      ]),
    ],
    inputs: [geo('Geometry'), sock('Selection', 'BOOLEAN', { d: true, field: true })],
    outputs: [geo('Geometry')],
  },
  {
    sig,
    exec: (ctx) => {
      toolOnly(ctx);
      const domain = (ctx.prop<string>('domain') || 'POINT') as Domain;
      const f = convertField(ctx.field('Selection', ctx.prop('selection_type') === 'FLOAT' ? 'FLOAT' : 'BOOLEAN'), 'BOOLEAN');
      const g = ctx.geometry('Geometry');
      return { Geometry: g.map((c) => (c.kind === 'MESH' || c.kind === 'POINTS' || c.kind === 'CURVES' ? storeOn(c, domain, TOOL_SELECTION, 'BOOLEAN', f) : c)) };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeTool3DCursor',
    label: '3D Cursor',
    category: 'input',
    description: description('The 3D cursor in the space of the edited object'),
    outputs: [sock('Location', 'VECTOR', { subtype: 'TRANSLATION' }), sock('Rotation', 'ROTATION')],
  },
  {
    sig,
    exec: (ctx) => {
      const t = toolOnly(ctx);
      return { Location: t?.cursor.location ?? [0, 0, 0], Rotation: t?.cursor.rotation ?? [0, 0, 0] };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeToolActiveElement',
    label: 'Active Element',
    category: 'input',
    description: description('Index of the active vertex, edge or face in Edit Mode'),
    props: [
      enumProp('domain', 'Domain', [
        ['POINT', 'Point'],
        ['EDGE', 'Edge'],
        ['FACE', 'Face'],
      ]),
    ],
    outputs: [sock('Index', 'INT'), sock('Exists', 'BOOLEAN')],
  },
  {
    sig,
    exec: (ctx) => {
      const a = toolOnly(ctx)?.active;
      const ok = !!a && a.domain === (ctx.prop<string>('domain') || 'POINT');
      return { Index: ok ? a!.index : 0, Exists: ok };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeToolMousePosition',
    label: 'Mouse Position',
    category: 'input',
    description: description('Pointer position in the viewport (pixels from the bottom left) and the viewport size'),
    outputs: [sock('Mouse X', 'INT'), sock('Mouse Y', 'INT'), sock('Region Width', 'INT'), sock('Region Height', 'INT')],
  },
  {
    sig,
    exec: (ctx) => {
      const m = toolOnly(ctx)?.mouse;
      return { 'Mouse X': m?.x ?? 0, 'Mouse Y': m?.y ?? 0, 'Region Width': m?.width ?? 0, 'Region Height': m?.height ?? 0 };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeViewportTransform',
    label: 'Viewport Transform',
    category: 'input',
    description: description('Projection and view matrices of the viewport'),
    outputs: [sock('Projection', 'MATRIX'), sock('View', 'MATRIX'), sock('Is Orthographic', 'BOOLEAN')],
  },
  {
    sig,
    exec: (ctx) => {
      const v = toolOnly(ctx)?.view;
      return { Projection: v?.projection ?? IDENTITY, View: v?.view ?? IDENTITY, 'Is Orthographic': v?.ortho ?? false };
    },
  },
);

/** Tool nodes in the Add menu (only offered while editing a tool). */
export const TOOL_NODE_TYPES = [
  'GeometryNodeToolSelection',
  'GeometryNodeToolSetSelection',
  'GeometryNodeTool3DCursor',
  'GeometryNodeToolActiveElement',
  'GeometryNodeToolMousePosition',
  'GeometryNodeViewportTransform',
];

placeFromLayout(TOOL_NODE_TYPES);
