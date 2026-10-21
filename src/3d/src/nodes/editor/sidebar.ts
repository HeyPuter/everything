// Node editor sidebar (N): Node (name, label, color), Options (properties and input values)
// and Group (interface sockets of the edited node group).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { openMenu, type MenuItem } from '../../ui/menu';
import { colorSpecials } from './colorpresets';
import { panel, textField, checkbox, colorSwatch, enumMenu, numberField, button } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import type { NodeTreeData } from '../../data/types';
import { getNodeType, nodeSockets, interfaceSocketType, SOCKET_IDNAME, SOCKET_COLORS } from '../registry';
import { TEX_MAPPING_NODES, texMapping, setTexMapping, type TexMapping, type TexAxis } from '../texmapping';
import { nodeById, addInterfaceSocket, uniqueGroupName } from '../tree';
import { addInterfacePanel, duplicateInterfaceItem, findSocketItem, interfaceEntries, moveInterfaceEntry, removeInterfaceItem, setSocketPanel, panelOfToggle, socketKey } from '../iface';
import { propWidget, socketValueWidget, nodeChanged } from './nodeui';
import { visibleProps } from './layout';
import type { NodeTypeDef } from '../types';
import { toolTab, type NodeTool, type SelectMode } from './toolbar';

interface Ed {
  sidebarTab: string;
  path: { group: string; node: string }[];
  tree(): NodeTreeData | null;
  tool: NodeTool;
  selectMode: SelectMode;
  circleRadius: number;
  currentGroupId(): string | undefined;
  provider: { viewPanels?(ed: unknown): Child; optionsPanels?(ed: unknown): Child };
}

const changed = (label: string) => nodeChanged(label, true);

const SOCKET_TYPE_ITEMS: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['SHADER', 'Shader'],
  ['STRING', 'String'],
  ['GEOMETRY', 'Geometry'],
  ['OBJECT', 'Object'],
  ['COLLECTION', 'Collection'],
  ['IMAGE', 'Image'],
  ['MATERIAL', 'Material'],
  ['ROTATION', 'Rotation'],
  ['MATRIX', 'Matrix'],
  ['MENU', 'Menu'],
  ['BUNDLE', 'Bundle'],
  ['CLOSURE', 'Closure'],
];

/** Active item (socket or panel identifier) of the Group tab's interface list. */
export const ifaceState: { activeKey: string; dragSocket: string | null } = { activeKey: '', dragSocket: null };

/** Header colors a group's nodes can take (node categories). */
const COLOR_TAGS: [string, string][] = [
  ['NONE', 'None'],
  ['attribute', 'Attribute'],
  ['color', 'Color'],
  ['converter', 'Converter'],
  ['distort', 'Distort'],
  ['filter', 'Filter'],
  ['geometry', 'Geometry'],
  ['input', 'Input'],
  ['output', 'Output'],
  ['script', 'Script'],
  ['shader', 'Shader'],
  ['texture', 'Texture'],
  ['vector', 'Vector'],
];

export function drawSidebar(ed: Ed): Child {
  const tree = ed.tree();
  const tabs = ['Node', 'Tool', ...(ed.provider.viewPanels ? ['View'] : []), ...(ed.provider.optionsPanels ? ['Options'] : []), ...(ed.path.length || tree?.interface ? ['Group'] : [])];
  if (!tabs.includes(ed.sidebarTab)) ed.sidebarTab = 'Node';
  const body = !tree
    ? h('div', { class: 'prop-note' }, 'No node tree')
    : ed.sidebarTab === 'Group'
      ? [groupProps(ed), groupTab(tree)]
      : ed.sidebarTab === 'Options'
        ? (ed.provider.optionsPanels?.(ed) ?? null)
        : ed.sidebarTab === 'Tool'
          ? toolTab(ed)
          : ed.sidebarTab === 'View'
            ? (ed.provider.viewPanels?.(ed) ?? null)
            : nodeTab(tree);
  return [
    h('div', { class: 'nd-side-body props-scroll' }, body),
    h(
      'div',
      { class: 'nd-side-tabs' },
      tabs.map((t) =>
        h(
          'button',
          {
            key: t,
            class: { 'nd-side-tab': true, on: ed.sidebarTab === t },
            onclick: () => ((ed.sidebarTab = t), app.changed('ui')),
          },
          h('span', null, t),
        ),
      ),
    ),
  ];
}

function activeNode(tree: NodeTreeData) {
  return tree.active_node ? nodeById(tree, tree.active_node) : undefined;
}

function nodeTab(tree: NodeTreeData): Child {
  const n = activeNode(tree);
  if (!n) return h('div', { class: 'prop-note' }, 'No active node');
  return [
    panel('nd-side-node', 'Node', () => [
      splitRow(
        'Name',
        textField(`nd-name-${n.id}`, n.name, (v) => {
          const name = v.trim();
          if (!name || tree.nodes.some((o) => o !== n && o.name === name)) {
            if (name) app.report('WARNING', `A node named "${name}" already exists`);
            app.changed('ui');
            return;
          }
          n.name = name;
          changed('Rename Node');
        }),
      ),
      splitRow(
        'Label',
        textField(`nd-label-${n.id}`, n.label ?? '', (v) => ((n.label = v), changed('Node Label'))),
      ),
      getNodeType(n.type)?.layout
        ? null
        : h(
            'div',
            { class: 'nd-side-row nd-side-toggles' },
            checkbox(`nd-showopt-${n.id}`, 'Show Options', !n.hide_options, (v) => ((n.hide_options = !v), changed('Toggle Node Options'))),
            n.type === 'NodeGroupInput' || n.type === 'NodeGroupOutput' ? null : checkbox(`nd-mute-${n.id}`, 'Mute', !!n.mute, (v) => ((n.mute = v), changed('Toggle Node Mute'))),
          ),
    ]),
    panel(
      'nd-side-color',
      'Color',
      () => [
        splitRow(
          'Color',
          colorSwatch(
            `nd-color-${n.id}`,
            (n.color as number[] | null) ?? [0.608, 0.608, 0.608],
            (c, final) => ((n.color = [c[0], c[1], c[2]]), (n.use_custom_color = true), nodeChanged('Node Color', final)),
            { alpha: false },
          ),
          h(
            'button',
            {
              class: 'btn nd-color-specials',
              'data-tip': 'Copy the color to the selected nodes, or use and manage color presets',
              onclick: (e: MouseEvent) => openMenu(colorSpecials(n), e.currentTarget as HTMLElement),
            },
            icon('down_arrow_hlt'),
          ),
        ),
      ],
      {
        header: h(
          'span',
          { class: 'nd-side-check' },
          checkbox(`nd-usecol-${n.id}`, '', !!n.use_custom_color, (v) => ((n.use_custom_color = v), (n.color ??= [0.608, 0.608, 0.608]), changed('Use Custom Color'))),
        ),
      },
    ),
    panel('nd-side-props', 'Properties', () => optionsBody(tree, n.id), {
      closed: false,
    }),
    TEX_MAPPING_NODES.has(n.type) && tree.type !== 'GEOMETRY' ? panel('nd-side-texmap', 'Texture Mapping', () => texMappingPanel(n), { closed: true }) : null,
  ];
}

const AXES = (['NONE', 'X', 'Y', 'Z'] as const).map((v) => ({ value: v, label: v === 'NONE' ? 'None' : v }));
const MAP_TYPES = [
  { value: 'POINT', label: 'Point' },
  { value: 'TEXTURE', label: 'Texture' },
  { value: 'VECTOR', label: 'Vector' },
  { value: 'NORMAL', label: 'Normal' },
];

/** Texture node coordinates: axis remap and location / rotation / scale (like a Mapping node inside the texture). */
function texMappingPanel(n: NodeTreeData['nodes'][number]): Child {
  const m = texMapping(n);
  const set = (part: Parameters<typeof setTexMapping>[1], label: string, final = true) => {
    setTexMapping(n, part);
    nodeChanged(label, final);
  };
  const vec = (key: 'translation' | 'rotation' | 'scale', label: string, unit?: 'distance' | 'angle') =>
    (['X', 'Y', 'Z'] as const).map((c, i) =>
      splitRow(
        i === 0 ? label : c,
        numberField({
          id: `nd-tm-${key}-${i}-${n.id}`,
          value: m[key][i],
          unit,
          set: (v, final) => {
            const next = [...m[key]] as [number, number, number];
            next[i] = v;
            set({ [key]: next }, 'Texture Mapping', final);
          },
        }),
      ),
    );
  return [
    splitRow('Type', enumMenu(`nd-tm-type-${n.id}`, MAP_TYPES, m.vector_type, (v) => set({ vector_type: v as TexMapping['vector_type'] }, 'Texture Mapping Type'))),
    splitRow('Projection X', enumMenu(`nd-tm-px-${n.id}`, AXES, m.mapping_x, (v) => set({ mapping_x: v as TexAxis }, 'Texture Projection'))),
    splitRow('Y', enumMenu(`nd-tm-py-${n.id}`, AXES, m.mapping_y, (v) => set({ mapping_y: v as TexAxis }, 'Texture Projection'))),
    splitRow('Z', enumMenu(`nd-tm-pz-${n.id}`, AXES, m.mapping_z, (v) => set({ mapping_z: v as TexAxis }, 'Texture Projection'))),
    ...(m.vector_type === 'VECTOR' || m.vector_type === 'NORMAL' ? [] : vec('translation', 'Location', 'distance')),
    ...vec('rotation', 'Rotation', 'angle'),
    ...vec('scale', 'Scale'),
  ];
}

function optionsBody(tree: NodeTreeData, id: string): Child {
  const n = nodeById(tree, id);
  if (!n) return null;
  const def = getNodeType(n.type) as NodeTypeDef | undefined;
  const props = def ? visibleProps(n, def.props, 'sidebar') : [];
  const linked = new Set(tree.links.filter((l) => l.to_node === n.id).map((l) => l.to_socket));
  const inputs = nodeSockets(n, { doc: app.doc, tree })
    .inputs.map((s) => ({
      ...s,
      label: s.shortLabel && s.label === s.shortLabel ? s.name : s.label,
    }))
    .filter((s) => !linked.has(s.identifier) && !s.hide_value && ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'STRING'].includes(s.type));
  const rows: Child[] = [];
  for (const p of props)
    rows.push(
      h(
        'div',
        { class: 'nd-side-row' },
        p.type === 'BOOLEAN'
          ? propWidget(n, p, `side-${n.id}`, { tree })
          : splitRow(
              p.name,
              propWidget(n, { ...p, noLabel: true }, `side-${n.id}`, {
                tree,
                compact: true,
              }),
            ),
      ),
    );
  if (def?.drawOptions)
    rows.push(
      def.drawOptions({
        node: n,
        tree,
        changed: (l, f) => nodeChanged(l, f ?? true),
        where: 'sidebar',
        key: `side-${n.id}`,
      }),
    );
  else if (def?.drawBody && !n.hide_options)
    rows.push(
      def.drawBody({
        node: n,
        tree,
        changed: (l, f) => nodeChanged(l, f ?? true),
        where: 'sidebar',
        key: `side-${n.id}`,
      }),
    );
  if (inputs.length) {
    rows.push(h('div', { class: 'nd-side-sub' }, 'Inputs:'));
    for (const s of inputs)
      rows.push(
        h(
          'div',
          { class: 'nd-side-row' },
          s.type === 'FLOAT' || s.type === 'INT' || s.type === 'BOOLEAN' ? socketValueWidget(n, s, `side-${n.id}`) : splitRow(s.label, socketValueWidget(n, s, `side-${n.id}`, { label: false })),
        ),
      );
  }
  if (!rows.length) rows.push(h('div', { class: 'prop-note' }, 'This node has no options'));
  return rows;
}


/** Group panel: name, description and the default width of the group's nodes. */
function groupProps(ed: Ed): Child {
  const gid = ed.currentGroupId();
  const g = gid ? app.doc.node_groups[gid] : undefined;
  if (!g) return null;
  return panel('nd-side-group', 'Group', () => [
    splitRow(
      'Name',
      textField(`nd-g-name-${g.id}`, g.name, (v) => {
        const name = v.trim();
        if (!name || name === g.name) return;
        g.name = uniqueGroupName(app.doc, name);
        changed('Rename Node Group');
      }),
    ),
    splitRow(
      'Description',
      textField(`nd-g-desc-${g.id}`, g.tree.description ?? '', (v) => ((g.tree.description = v || undefined), changed('Group Description')), { placeholder: 'Shown as the tooltip in Add menus' }),
    ),
    splitRow(
      'Color Tag',
      enumMenu(
        `nd-g-tag-${g.id}`,
        COLOR_TAGS.map(([value, label]) => ({ value, label })),
        g.tree.color_tag ?? 'NONE',
        (v) => ((g.tree.color_tag = v === 'NONE' ? undefined : v), changed('Group Color Tag')),
      ),
    ),
    splitRow(
      'Node Width',
      numberField({
        id: `nd-g-width-${g.id}`,
        value: g.tree.default_group_node_width ?? 140,
        int: true,
        min: 40,
        max: 700,
        set: (v, f) => ((g.tree.default_group_node_width = v), nodeChanged('Default Group Node Width', f)),
      }),
      h(
        'button',
        {
          class: 'btn nd-color-specials',
          disabled: !ed.path.length,
          'data-tip': 'Set Default Group Node Width\nUse the width of the group node being edited',
          onclick: () => app.run('node.default_group_width_set'),
        },
        icon('node_tree'),
      ),
    ),
    // geometry node groups: where the group is offered
    g.tree.type === 'GEOMETRY'
      ? panel(
          'nd-side-group-usage',
          'Usage',
          () => [
            splitRow('', checkbox(`nd-g-mod-${g.id}`, 'Modifier', !!g.is_modifier, (v) => ((g.is_modifier = v), changed('Group Usage')), { tip: 'Modifier\nOffer the group as a Geometry Nodes modifier' })),
            splitRow('', checkbox(`nd-g-tool-${g.id}`, 'Tool', !!g.is_tool, (v) => ((g.is_tool = v), changed('Group Usage')), { tip: 'Tool\nOffer the group as a node tool in the 3D viewport menus' })),
          ],
          { sub: true },
        )
      : null,
  ]);
}

function groupTab(tree: NodeTreeData): Child {
  const items = tree.interface ?? [];
  const entries = interfaceEntries(tree);
  const ids = entries.map((e) => (e.kind === 'socket' ? socketKey(e.item) : e.panel.identifier));
  // plain identifiers (set before keys carried the direction) resolve to their socket
  if (!ids.includes(ifaceState.activeKey)) {
    const hit = findSocketItem(tree, ifaceState.activeKey);
    ifaceState.activeKey = hit ? socketKey(hit) : (ids[0] ?? '');
  }
  const it = findSocketItem(tree, ifaceState.activeKey);
  void items;
  const activePanel = (tree.interface_panels ?? []).find((p) => p.identifier === ifaceState.activeKey);
  // new inputs go into the selected panel (or the panel of the selected socket)
  const targetPanel = activePanel?.identifier ?? (it?.in_out === 'INPUT' ? it.panel : undefined);
  const move = (d: -1 | 1) => {
    if (moveInterfaceEntry(tree, ifaceState.activeKey, d)) changed('Move Interface Item');
  };
  const add = (inOut: 'INPUT' | 'OUTPUT') => {
    const item = addInterfaceSocket(tree, inOut, inOut === 'INPUT' ? 'Input' : 'Output', tree.type === 'GEOMETRY' ? 'GEOMETRY' : 'FLOAT', tree.type === 'GEOMETRY' ? undefined : 0);
    if (inOut === 'INPUT' && targetPanel) item.panel = targetPanel;
    ifaceState.activeKey = socketKey(item);
    changed('Add Interface Socket');
  };
  const addPanel = () => {
    ifaceState.activeKey = addInterfacePanel(tree).identifier;
    changed('Add Interface Panel');
  };
  const remove = () => {
    if (removeInterfaceItem(tree, ifaceState.activeKey)) changed(activePanel ? 'Remove Interface Panel' : 'Remove Interface Socket');
  };
  const duplicate = () => {
    const copy = duplicateInterfaceItem(tree, ifaceState.activeKey, (io, name) => addInterfaceSocket(tree, io, name, 'FLOAT'));
    if (!copy) return;
    ifaceState.activeKey = socketKey(copy);
    changed('Duplicate Interface Item');
  };
  const specials = (): MenuItem[] => [
    { label: 'Duplicate Item', op: 'node.interface_item_duplicate' },
    { separator: true },
    { label: 'Add Panel Toggle', op: 'node.interface_item_new_panel_toggle' },
    { label: 'Make Panel Toggle', op: 'node.interface_item_make_panel_toggle' },
    { label: 'Unlink Panel Toggle', op: 'node.interface_item_unlink_panel_toggle' },
  ];
  const t = it ? interfaceSocketType(it.socket_type) : null;
  const panelItems = [{ value: '', label: 'None' }, ...(tree.interface_panels ?? []).map((p) => ({ value: p.identifier, label: p.name }))];
  return panel('nd-side-iface', 'Group Sockets', () => [
    h(
      'div',
      { class: 'nd-iface' },
      h(
        'div',
        { class: 'nd-iface-list' },
        entries.map((e) => {
          const id = e.kind === 'socket' ? socketKey(e.item) : e.panel.identifier;
          return h(
            'div',
            {
              key: id,
              class: { 'nd-iface-item': true, on: id === ifaceState.activeKey, panel: e.kind === 'panel', nested: e.depth > 0 },
              onclick: () => ((ifaceState.activeKey = id), app.changed('ui')),
              // inputs can be dragged into the editor as a Group Input node showing just that socket
              ...(e.kind === 'socket' && e.item.in_out === 'INPUT'
                ? {
                    draggable: 'true',
                    'data-tip': 'Drag into the editor to add a Group Input node with only this socket',
                    ondragstart: (ev: DragEvent) => {
                      ifaceState.dragSocket = e.item.identifier;
                      ev.dataTransfer?.setData('text/plain', e.item.name);
                    },
                    ondragend: () => setTimeout(() => (ifaceState.dragSocket = null), 0),
                  }
                : {}),
            },
            e.kind === 'panel'
              ? [icon('disclosure_tri_down'), h('span', null, e.panel.name)]
              : [
                  h('span', {
                    class: 'nd-iface-dot',
                    style: { background: SOCKET_COLORS[interfaceSocketType(e.item.socket_type).type] },
                  }),
                  h('span', { class: 'nd-iface-dir' }, e.item.in_out === 'INPUT' ? '→' : '←'),
                  e.item.name,
                  panelOfToggle(tree, e.item.identifier) ? h('span', { class: 'nd-iface-badge', 'data-tip': 'Panel toggle: shown as a checkbox in the panel header' }, 'toggle') : null,
                ],
          );
        }),
        entries.length ? null : h('div', { class: 'prop-note' }, 'No sockets'),
      ),
      h(
        'div',
        { class: 'nd-iface-btns' },
        button('nd-if-addin', h('span', null, icon('add'), 'In'), () => add('INPUT'), { tip: targetPanel ? 'Add Input Socket to the panel' : 'Add Input Socket' }),
        button('nd-if-addout', h('span', null, icon('add'), 'Out'), () => add('OUTPUT'), { tip: 'Add Output Socket' }),
        button('nd-if-addpanel', h('span', null, icon('add'), 'Panel'), addPanel, { tip: 'Add Panel\nA collapsible section of the group node’s inputs' }),
        button('nd-if-rem', icon('remove'), remove, {
          tip: activePanel ? 'Remove Panel (its sockets stay)' : 'Remove Socket',
          disabled: !it && !activePanel,
        }),
        button('nd-if-dup', icon('duplicate'), duplicate, {
          tip: 'Duplicate Socket',
          disabled: !it,
        }),
        h(
          'button',
          {
            class: 'btn nd-if-specials',
            'data-tip': 'More interface commands (panel toggles, duplicate)',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(specials(), e.currentTarget as HTMLElement);
            },
          },
          icon('down_arrow_hlt'),
        ),
        button('nd-if-up', icon('triangle_up'), () => move(-1), {
          tip: 'Move Up',
          disabled: !it && !activePanel,
        }),
        button('nd-if-down', icon('triangle_down'), () => move(1), {
          tip: 'Move Down',
          disabled: !it && !activePanel,
        }),
      ),
    ),
    activePanel
      ? [
          splitRow(
            'Name',
            textField(`nd-ifp-name-${activePanel.identifier}`, activePanel.name, (v) => ((activePanel.name = v || activePanel.name), changed('Rename Panel'))),
          ),
          h(
            'div',
            { class: 'nd-side-row' },
            checkbox(`nd-ifp-closed-${activePanel.identifier}`, 'Closed by Default', !!activePanel.default_closed, (v) => ((activePanel.default_closed = v || undefined), changed('Panel Default Closed'))),
          ),
        ]
      : null,
    it && it.in_out === 'INPUT' && tree.interface_panels?.length
      ? splitRow(
          'Panel',
          enumMenu(`nd-if-panel-${socketKey(it)}`, panelItems, it.panel ?? '', (v) => {
            setSocketPanel(tree, socketKey(it), v || undefined);
            changed('Socket Panel');
          }),
        )
      : null,
    it && t
      ? [
          splitRow(
            'Name',
            textField(`nd-if-name-${socketKey(it)}`, it.name, (v) => ((it.name = v || it.name), changed('Rename Socket'))),
          ),
          splitRow(
            'Description',
            textField(`nd-if-desc-${socketKey(it)}`, it.description ?? '', (v) => ((it.description = v || undefined), changed('Socket Description')), { placeholder: 'Tooltip of the socket' }),
          ),
          splitRow(
            'Type',
            enumMenu(
              `nd-if-type-${socketKey(it)}`,
              SOCKET_TYPE_ITEMS.map(([value, label]) => ({ value, label })),
              t.type,
              (v) => ((it.socket_type = SOCKET_IDNAME[v] ?? 'NodeSocketFloat'), (it.default_value = undefined), changed('Socket Type')),
            ),
          ),
          it.in_out === 'INPUT' && ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'STRING', 'ROTATION', 'MENU'].includes(t.type)
            ? h(
                'div',
                { class: 'nd-side-row' },
                checkbox(`nd-if-hidev-${socketKey(it)}`, 'Hide Value', !!it.hide_value, (v) => ((it.hide_value = v || undefined), changed('Hide Socket Value'))),
              )
            : null,
          t.type === 'FLOAT' || t.type === 'INT'
            ? [
                splitRow(
                  'Default',
                  numberField({
                    id: `nd-if-def-${socketKey(it)}`,
                    value: typeof it.default_value === 'number' ? it.default_value : 0,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.default_value = v), nodeChanged('Socket Default', f)),
                  }),
                ),
                splitRow(
                  'Min',
                  numberField({
                    id: `nd-if-min-${socketKey(it)}`,
                    value: it.min_value ?? -3.4e38,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.min_value = v), nodeChanged('Socket Min', f)),
                  }),
                ),
                splitRow(
                  'Max',
                  numberField({
                    id: `nd-if-max-${socketKey(it)}`,
                    value: it.max_value ?? 3.4e38,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.max_value = v), nodeChanged('Socket Max', f)),
                  }),
                ),
              ]
            : null,
          t.type === 'RGBA'
            ? splitRow(
                'Default',
                colorSwatch(`nd-if-col-${socketKey(it)}`, (it.default_value as number[]) ?? [0.8, 0.8, 0.8, 1], (c, f) => ((it.default_value = c), nodeChanged('Socket Default', f))),
              )
            : null,
          t.type === 'VECTOR'
            ? splitRow(
                'Default',
                h(
                  'div',
                  { class: 'col' },
                  [0, 1, 2].map((k) =>
                    numberField({
                      id: `nd-if-vec-${socketKey(it)}-${k}`,
                      label: 'XYZ'[k],
                      value: ((it.default_value as number[]) ?? [0, 0, 0])[k],
                      set: (v, f) => {
                        const a = [...((it.default_value as number[]) ?? [0, 0, 0])];
                        a[k] = v;
                        it.default_value = a;
                        nodeChanged('Socket Default', f);
                      },
                    }),
                  ),
                ),
              )
            : null,
          t.type === 'BOOLEAN'
            ? h(
                'div',
                { class: 'nd-side-row' },
                checkbox(`nd-if-bool-${socketKey(it)}`, 'Default', !!it.default_value, (v) => ((it.default_value = v), changed('Socket Default'))),
              )
            : null,
        ]
      : null,
  ]);
}
