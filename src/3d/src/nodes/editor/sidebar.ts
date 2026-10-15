// Node editor sidebar (N): Node (name, label, color), Options (properties and input values)
// and Group (interface sockets of the edited node group).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { openMenu } from '../../ui/menu';
import { colorSpecials } from './colorpresets';
import { panel, textField, checkbox, colorSwatch, enumMenu, numberField, button } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import type { NodeTreeData } from '../../data/types';
import { getNodeType, nodeSockets, interfaceSocketType, SOCKET_IDNAME, SOCKET_COLORS } from '../registry';
import { nodeById, addInterfaceSocket, uniqueGroupName } from '../tree';
import { addInterfacePanel, interfaceEntries, moveInterfaceEntry, removeInterfacePanel, setSocketPanel } from '../iface';
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
  provider: { viewPanels?(ed: unknown): Child };
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
];

let activeKey = '';

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
  const tabs = ['Node', 'Tool', ...(ed.provider.viewPanels ? ['View'] : []), 'Options', ...(ed.path.length || tree?.interface ? ['Group'] : [])];
  if (!tabs.includes(ed.sidebarTab)) ed.sidebarTab = 'Node';
  const body = !tree
    ? h('div', { class: 'prop-note' }, 'No node tree')
    : ed.sidebarTab === 'Group'
      ? [groupProps(ed), groupTab(tree)]
      : ed.sidebarTab === 'Options'
        ? optionsTab(tree)
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

function optionsTab(tree: NodeTreeData): Child {
  const n = activeNode(tree);
  if (!n) return h('div', { class: 'prop-note' }, 'No active node');
  return panel('nd-side-options', 'Properties', () => optionsBody(tree, n.id));
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
  ]);
}

function groupTab(tree: NodeTreeData): Child {
  const items = tree.interface ?? [];
  const entries = interfaceEntries(tree);
  const ids = entries.map((e) => (e.kind === 'socket' ? e.item.identifier : e.panel.identifier));
  if (!ids.includes(activeKey)) activeKey = ids[0] ?? '';
  const it = items.find((x) => x.identifier === activeKey);
  const activePanel = (tree.interface_panels ?? []).find((p) => p.identifier === activeKey);
  // new inputs go into the selected panel (or the panel of the selected socket)
  const targetPanel = activePanel?.identifier ?? (it?.in_out === 'INPUT' ? it.panel : undefined);
  const move = (d: -1 | 1) => {
    if (moveInterfaceEntry(tree, activeKey, d)) changed('Move Interface Item');
  };
  const add = (inOut: 'INPUT' | 'OUTPUT') => {
    const item = addInterfaceSocket(tree, inOut, inOut === 'INPUT' ? 'Input' : 'Output', tree.type === 'GEOMETRY' ? 'GEOMETRY' : 'FLOAT', tree.type === 'GEOMETRY' ? undefined : 0);
    if (inOut === 'INPUT' && targetPanel) item.panel = targetPanel;
    activeKey = item.identifier;
    changed('Add Interface Socket');
  };
  const addPanel = () => {
    activeKey = addInterfacePanel(tree).identifier;
    changed('Add Interface Panel');
  };
  const remove = () => {
    if (activePanel) {
      removeInterfacePanel(tree, activePanel.identifier);
      changed('Remove Interface Panel');
      return;
    }
    if (!it) return;
    tree.interface = items.filter((x) => x !== it);
    tree.links = tree.links.filter(
      (l) =>
        !(
          (l.from_socket === it.identifier && tree.nodes.find((n) => n.id === l.from_node)?.type === 'NodeGroupInput') ||
          (l.to_socket === it.identifier && tree.nodes.find((n) => n.id === l.to_node)?.type === 'NodeGroupOutput')
        ),
    );
    changed('Remove Interface Socket');
  };
  const duplicate = () => {
    if (!it) return;
    const copy = addInterfaceSocket(tree, it.in_out, it.name, interfaceSocketType(it.socket_type).type, it.default_value);
    copy.socket_type = it.socket_type;
    if (it.min_value !== undefined) copy.min_value = it.min_value;
    if (it.max_value !== undefined) copy.max_value = it.max_value;
    if (it.hide_value) copy.hide_value = true;
    if (it.panel) copy.panel = it.panel;
    // keep the copy right after the original
    const list = tree.interface!;
    list.splice(list.indexOf(copy), 1);
    list.splice(list.indexOf(it) + 1, 0, copy);
    activeKey = copy.identifier;
    changed('Duplicate Interface Item');
  };
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
          const id = e.kind === 'socket' ? e.item.identifier : e.panel.identifier;
          return h(
            'div',
            {
              key: id,
              class: { 'nd-iface-item': true, on: id === activeKey, panel: e.kind === 'panel', nested: e.depth > 0 },
              onclick: () => ((activeKey = id), app.changed('ui')),
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
          enumMenu(`nd-if-panel-${it.identifier}`, panelItems, it.panel ?? '', (v) => {
            setSocketPanel(tree, it.identifier, v || undefined);
            changed('Socket Panel');
          }),
        )
      : null,
    it && t
      ? [
          splitRow(
            'Name',
            textField(`nd-if-name-${it.identifier}`, it.name, (v) => ((it.name = v || it.name), changed('Rename Socket'))),
          ),
          splitRow(
            'Type',
            enumMenu(
              `nd-if-type-${it.identifier}`,
              SOCKET_TYPE_ITEMS.map(([value, label]) => ({ value, label })),
              t.type,
              (v) => ((it.socket_type = SOCKET_IDNAME[v] ?? 'NodeSocketFloat'), (it.default_value = undefined), changed('Socket Type')),
            ),
          ),
          it.in_out === 'INPUT' && ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'STRING', 'ROTATION', 'MENU'].includes(t.type)
            ? h(
                'div',
                { class: 'nd-side-row' },
                checkbox(`nd-if-hidev-${it.identifier}`, 'Hide Value', !!it.hide_value, (v) => ((it.hide_value = v || undefined), changed('Hide Socket Value'))),
              )
            : null,
          t.type === 'FLOAT' || t.type === 'INT'
            ? [
                splitRow(
                  'Default',
                  numberField({
                    id: `nd-if-def-${it.identifier}`,
                    value: typeof it.default_value === 'number' ? it.default_value : 0,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.default_value = v), nodeChanged('Socket Default', f)),
                  }),
                ),
                splitRow(
                  'Min',
                  numberField({
                    id: `nd-if-min-${it.identifier}`,
                    value: it.min_value ?? -3.4e38,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.min_value = v), nodeChanged('Socket Min', f)),
                  }),
                ),
                splitRow(
                  'Max',
                  numberField({
                    id: `nd-if-max-${it.identifier}`,
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
                colorSwatch(`nd-if-col-${it.identifier}`, (it.default_value as number[]) ?? [0.8, 0.8, 0.8, 1], (c, f) => ((it.default_value = c), nodeChanged('Socket Default', f))),
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
                      id: `nd-if-vec-${it.identifier}-${k}`,
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
                checkbox(`nd-if-bool-${it.identifier}`, 'Default', !!it.default_value, (v) => ((it.default_value = v), changed('Socket Default'))),
              )
            : null,
        ]
      : null,
  ]);
}
