// Geometry Node Editor in Tool context: a Modifier / Tool switch in the header, the tool group
// selector (node.new_geometry_node_group_tool makes a new one) and the Types / Modes popovers that
// choose where the tool is offered. Tool-only nodes appear in the Add menu in this context.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators, type OpContext } from '../../app/app';
import { openMenu, openPopover } from '../../ui/menu';
import { checkbox } from '../../ui/widgets';
import { dataBlockSelector } from '../../editors/properties/tabs';
import { providers } from '../../nodes/editor/context';
import { newNodeGroup, uid } from '../../data/defaults';
import { uniqueGroupName } from '../../nodes/tree';
import type { NodeGroupData } from '../../data/types';
import { GeometryNodeEditor } from '../editor';
import { TOOL_NODE_TYPES } from './nodes';
import { toolGroups } from './exec';

const editorOf = (ctx: OpContext) => (ctx.area?.editor instanceof GeometryNodeEditor ? ctx.area.editor : null);

/** A new node group used as a tool: Geometry in and out, offered for meshes in every mode. */
export function newToolGroup(name = 'Tool'): NodeGroupData {
  const g = newNodeGroup(uniqueGroupName(app.doc, name));
  g.is_modifier = false;
  g.is_tool = true;
  g.is_mode_object = g.is_mode_edit = g.is_mode_sculpt = true;
  g.is_type_mesh = true;
  app.doc.node_groups[g.id] = g;
  return g;
}

registerOperators([
  {
    idname: 'node.new_geometry_node_group_tool',
    label: 'New Tool Node Group',
    description: 'Create a node group to run as a tool from the 3D viewport’s Node Tools menu',
    poll: () => true,
    exec: (ctx) => {
      const g = newToolGroup();
      const ed = editorOf(ctx);
      if (ed) {
        ed.gnType = 'TOOL';
        ed.toolGroup = g.id;
        ed.path = [];
      }
      app.changed('doc');
    },
  },
  {
    idname: 'node.new_node_tree',
    label: 'New Node Tree',
    description: 'Create a new node group of the editor’s kind and show it',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: (ctx) => !!editorOf(ctx),
    exec: (ctx, p) => {
      const ed = editorOf(ctx)!;
      if (ed.gnType === 'TOOL') {
        const g = newToolGroup(String(p.name || 'Tool'));
        ed.toolGroup = g.id;
      } else {
        const g = newNodeGroup(uniqueGroupName(app.doc, String(p.name || 'Geometry Nodes')));
        app.doc.node_groups[g.id] = g;
        ed.pinned = g.id;
      }
      ed.path = [];
      app.changed('doc');
    },
  },
]);

const FLAGS: { key: keyof NodeGroupData; label: string }[][] = [
  [
    { key: 'is_type_mesh', label: 'Mesh' },
    { key: 'is_type_curve', label: 'Hair Curves' },
    { key: 'is_type_pointcloud', label: 'Point Cloud' },
  ],
  [
    { key: 'is_mode_object', label: 'Object Mode' },
    { key: 'is_mode_edit', label: 'Edit Mode' },
    { key: 'is_mode_sculpt', label: 'Sculpt Mode' },
  ],
];

function flagsPopover(anchor: HTMLElement, g: NodeGroupData, title: string, flags: { key: keyof NodeGroupData; label: string }[]) {
  openPopover(
    anchor,
    () =>
      h(
        'div',
        { class: 'pop-panel' },
        h('div', { class: 'pop-title' }, title),
        flags.map((f) =>
          checkbox(`gn-tool-${String(f.key)}`, f.label, (g[f.key] as boolean | undefined) ?? (f.key !== 'is_type_curve' && f.key !== 'is_type_pointcloud'), (v) => {
            (g as unknown as Record<string, unknown>)[f.key] = v;
            app.pushUndo(`Tool ${f.label}`);
            app.changed('doc');
          }),
        ),
        h('div', { class: 'prop-note' }, title === 'Types' ? 'Tools run on meshes; other types are listed for files made elsewhere' : 'The 3D viewport offers the tool in these modes'),
      ),
    { width: 230 },
  );
}

function toolHeader(ed: GeometryNodeEditor): Child {
  const doc = app.doc;
  const g = ed.toolGroup ? doc.node_groups[ed.toolGroup] : undefined;
  const pop = (title: string, flags: (typeof FLAGS)[number]) =>
    g
      ? h(
          'button',
          {
            class: 'hdr-menu',
            'data-tip': title === 'Types' ? 'Object types the tool works on' : 'Modes the tool is offered in',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              flagsPopover(e.currentTarget as HTMLElement, g, title, flags);
            },
          },
          title,
          icon('down_arrow_hlt', 'tiny'),
        )
      : null;
  return h(
    'div',
    { class: 'nd-ids gn-ids' },
    dataBlockSelector(
      'gn-tool',
      'node_tree',
      toolGroups(doc),
      g?.is_tool ? g.id : null,
      (id) => {
        ed.toolGroup = id;
        ed.path = [];
        app.changed('ui');
      },
      () => app.run('node.new_geometry_node_group_tool', {}, { area: ed.area }),
      {
        duplicate: g
          ? () => {
              const d = structuredClone(g);
              d.id = uid('ng');
              d.name = uniqueGroupName(doc, g.name);
              doc.node_groups[d.id] = d;
              ed.toolGroup = d.id;
              app.pushUndo('Copy Tool');
              app.changed('doc');
            }
          : undefined,
      },
    ),
    pop('Types', FLAGS[0]),
    pop('Modes', FLAGS[1]),
  );
}

{
  const p = providers.get('GEOMETRY')!;
  const right = p.headerRight;
  const left = p.headerLeft;
  const poll = p.menuPoll;
  p.headerLeft = (e) => {
    const ed = e as GeometryNodeEditor;
    return [
      left?.(e) ?? null,
      h(
        'button',
        {
          class: 'hdr-menu gn-context',
          'data-tip': 'What the editor shows: the active object’s Geometry Nodes modifier, or a node group used as a tool',
          onpointerdown: (ev: PointerEvent) => {
            ev.preventDefault();
            openMenu(
              [
                { label: 'Modifier', icon: 'modifier', active: ed.gnType === 'MODIFIER', action: () => ((ed.gnType = 'MODIFIER'), (ed.path = []), app.changed('ui')) },
                { label: 'Tool', icon: 'tool', active: ed.gnType === 'TOOL', action: () => ((ed.gnType = 'TOOL'), (ed.path = []), app.changed('ui')) },
              ],
              ev.currentTarget as HTMLElement,
            );
          },
        },
        ed.gnType === 'TOOL' ? 'Tool' : 'Modifier',
        icon('down_arrow_hlt', 'tiny'),
      ),
    ];
  };
  p.headerRight = (e) => ((e as GeometryNodeEditor).gnType === 'TOOL' ? toolHeader(e as GeometryNodeEditor) : (right?.(e) ?? null));
  p.menuPoll = (idname, e) => (TOOL_NODE_TYPES.includes(idname) ? (e as unknown as GeometryNodeEditor).gnType === 'TOOL' : poll ? poll(idname, e) : true);
  const empty = p.emptyMessage;
  p.emptyMessage = (e) => ((e as GeometryNodeEditor).gnType === 'TOOL' ? 'Choose a tool node group or make a new one (New)' : (empty?.(e) ?? ''));
}
