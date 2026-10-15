// Properties editor ▸ Material / World ▸ Surface: the node tree shown as nested properties.
// Each input row has a socket button whose menu links a new node, disconnects or removes it.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu, type MenuItem } from '../ui/menu';
import { splitRow } from '../ui/props';
import type { MaterialData, NodeData, NodeTreeData, WorldData } from '../data/types';
import { materialSurfacePanel, worldSurfacePanel } from '../editors/properties/tabs';
import { getNodeType, nodeSockets, nodeLabel, canConvert, nodeMenu, SOCKET_COLORS } from './registry';
import { activeOutput, connect, ctxOf, linkStatus, makeNode, nodeById, removeNodes } from './tree';
import { socketValueWidget, propWidget, nodeChanged } from './editor/nodeui';
import { visibleProps } from './editor/layout';
import { shaderEntryPoll } from './shader/defs';
import type { MenuCategory, ResolvedSocket, SocketType } from './types';

const expanded = new Map<string, boolean>();

function linkInto(tree: NodeTreeData, node: NodeData, socket: string) {
  return tree.links.find((l) => l.to_node === node.id && l.to_socket === socket);
}

/** Remove a node that only fed `target`, together with upstream nodes used nowhere else. */
function removeExclusive(tree: NodeTreeData, nodeId: string, depth = 0) {
  if (depth > 32) return;
  const n = nodeById(tree, nodeId);
  if (!n || getNodeType(n.type)?.category === 'output') return;
  if (tree.links.some((l) => l.from_node === nodeId)) return;
  const upstream = tree.links.filter((l) => l.to_node === nodeId).map((l) => l.from_node);
  removeNodes(tree, new Set([nodeId]));
  for (const u of upstream) removeExclusive(tree, u, depth + 1);
}

function linkMenu(tree: NodeTreeData, node: NodeData, s: ResolvedSocket, shaderType: 'OBJECT' | 'WORLD'): MenuItem[] {
  const link = linkInto(tree, node, s.identifier);
  const ctx = ctxOf(app.doc, tree);
  const place = (newNode: NodeData) => {
    newNode.location = [node.location[0] - (newNode.width ?? 140) - 80, node.location[1]];
  };
  const choose = (idname: string, settings: Record<string, unknown>, outId: string) => {
    const old = link?.from_node;
    const n = makeNode(tree, idname, [0, 0], settings as Record<string, never>);
    place(n);
    tree.nodes.push(n);
    connect(ctx, n.id, outId, node.id, s.identifier);
    if (old) removeExclusive(tree, old);
    expanded.set(`${node.id}:${s.identifier}`, true);
    nodeChanged(`Link ${getNodeType(n.type)?.label ?? idname}`);
  };
  const want: SocketType = s.type;
  const entryItems = (c: MenuCategory): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const it of c.items) {
      if (it === 'SEPARATOR') continue;
      if (!('idname' in it)) {
        const sub = entryItems(it);
        if (sub.length) out.push({ label: it.label, submenu: () => sub });
        continue;
      }
      if (!shaderEntryPoll(it.idname, shaderType)) continue;
      const def = getNodeType(it.idname);
      if (!def || def.category === 'output') continue;
      const probe = makeNode(tree, it.idname, [0, 0], (it.settings ?? {}) as Record<string, never>);
      const outs = nodeSockets(probe, ctx).outputs.filter((o) => (want === 'SHADER' ? o.type === 'SHADER' : o.type !== 'SHADER' && canConvert(o.type, want)));
      if (!outs.length) continue;
      const label = it.label ?? def.label;
      if (outs.length === 1 || want === 'SHADER')
        out.push({
          label,
          action: () => choose(it.idname, it.settings ?? {}, outs[0].identifier),
        });
      else
        out.push({
          label,
          submenu: () =>
            outs.map((o) => ({
              label: o.label,
              action: () => choose(it.idname, it.settings ?? {}, o.identifier),
            })),
        });
    }
    return out;
  };
  const items: MenuItem[] = [];
  for (const c of nodeMenu(tree.type)) {
    const sub = entryItems(c);
    if (!sub.length) continue;
    if (want === 'SHADER') {
      if (c.label === 'Shader') items.push(...sub);
    } else items.push({ label: c.label, submenu: () => sub });
  }
  if (link) {
    items.push({ separator: true });
    items.push({
      label: 'Remove',
      icon: 'x',
      action: () => {
        const from = link.from_node;
        tree.links = tree.links.filter((l) => l !== link);
        removeExclusive(tree, from);
        nodeChanged('Remove Node');
      },
    });
    items.push({
      label: 'Disconnect',
      action: () => {
        tree.links = tree.links.filter((l) => l !== link);
        nodeChanged('Disconnect');
      },
    });
  }
  return items;
}

function socketButton(tree: NodeTreeData, node: NodeData, s: ResolvedSocket, shaderType: 'OBJECT' | 'WORLD') {
  return h(
    'button',
    {
      class: 'nd-props-link',
      'data-tip': `${s.label}\nLink a node to this input`,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openMenu(linkMenu(tree, node, s, shaderType), e.currentTarget as HTMLElement, { title: s.label });
      },
    },
    h('span', {
      class: 'nd-props-dot',
      style: { '--sc': SOCKET_COLORS[s.type] ?? '#87888a' },
    }),
  );
}

function inputRows(tree: NodeTreeData, node: NodeData, shaderType: 'OBJECT' | 'WORLD', depth: number, seen: Set<string>): Child[] {
  const rows: Child[] = [];
  const def = getNodeType(node.type);
  const key = `pp:${node.id}`;
  for (const p of visibleProps(node, def?.props ?? [], 'sidebar')) {
    if (p.type === 'BOOLEAN') rows.push(splitRow('', propWidget(node, p, key, { tree })));
    else
      rows.push(
        splitRow(
          p.name,
          propWidget(node, { ...p, noLabel: true }, key, {
            tree,
            compact: true,
          }),
        ),
      );
  }
  if (def?.drawBody)
    rows.push(
      h(
        'div',
        { class: 'nd-props-body' },
        def.drawBody({
          node,
          tree,
          changed: (l, f) => nodeChanged(l, f ?? true),
          where: 'properties',
          key,
        }),
      ),
    );
  const ctx = ctxOf(app.doc, tree);
  for (const s of nodeSockets(node, ctx).inputs) {
    if (s.type === 'CUSTOM') continue;
    const link = linkInto(tree, node, s.identifier);
    const label = s.label;
    if (link && linkStatus(ctx, link).valid) {
      const from = nodeById(tree, link.from_node)!;
      const k = `${node.id}:${s.identifier}`;
      const open = expanded.get(k) ?? true;
      const fromSock = nodeSockets(from, ctx).outputs.find((o) => o.identifier === link.from_socket);
      const name = `${nodeLabel(from)}${fromSock && nodeSockets(from, ctx).outputs.length > 1 ? ` | ${fromSock.label}` : ''}`;
      rows.push(
        splitRow(
          label,
          h(
            'div',
            { class: 'nd-props-input' },
            socketButton(tree, node, s, shaderType),
            h(
              'button',
              {
                class: 'nd-props-linked',
                'data-tip': open ? 'Collapse' : 'Expand',
                onclick: () => (expanded.set(k, !open), app.changed('ui')),
              },
              icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right'),
              h('span', { class: 'nd-label' }, name),
            ),
          ),
        ),
      );
      if (open && depth < 8 && !seen.has(from.id)) {
        const next = new Set(seen).add(from.id);
        rows.push(h('div', { class: 'nd-props-sub' }, inputRows(tree, from, shaderType, depth + 1, next)));
      }
      continue;
    }
    if (s.hide_value || s.type === 'SHADER') {
      rows.push(
        splitRow(label, h('div', { class: 'nd-props-input' }, socketButton(tree, node, s, shaderType), h('span', { class: 'nd-props-value prop-note' }, s.type === 'SHADER' ? 'None' : 'Default'))),
      );
      continue;
    }
    rows.push(
      splitRow(label, h('div', { class: 'nd-props-input' }, socketButton(tree, node, s, shaderType), h('div', { class: 'nd-props-value' }, socketValueWidget(node, s, key, { label: false })))),
    );
  }
  return rows;
}

/** Draw the tree from an output node input (e.g. Material Output ▸ Surface). */
export function drawOutputInput(tree: NodeTreeData, outType: string, socket: string, label: string, shaderType: 'OBJECT' | 'WORLD'): Child {
  const out = activeOutput(tree, outType);
  if (!out) return h('div', { class: 'prop-note' }, `No ${getNodeType(outType)?.label ?? 'output'} node in the tree`);
  const s = nodeSockets(out, ctxOf(app.doc, tree)).inputs.find((x) => x.identifier === socket);
  if (!s) return null;
  const link = linkInto(tree, out, socket);
  const from = link ? nodeById(tree, link.from_node) : undefined;
  return [
    splitRow(
      label,
      h(
        'div',
        { class: 'nd-props-input' },
        socketButton(tree, out, s, shaderType),
        h(
          'button',
          {
            class: 'nd-props-linked',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(linkMenu(tree, out, s, shaderType), e.currentTarget as HTMLElement, { title: label });
            },
          },
          h('span', { class: 'nd-label' }, from ? nodeLabel(from) : 'None'),
        ),
      ),
    ),
    from ? inputRows(tree, from, shaderType, 0, new Set([out.id, from.id])) : null,
  ];
}

materialSurfacePanel.draw = (ma: MaterialData) => {
  if (!ma.use_nodes) return h('div', { class: 'prop-note' }, 'This material does not use nodes');
  const tree = ma.tree;
  const out = activeOutput(tree, 'ShaderNodeOutputMaterial');
  return [
    drawOutputInput(tree, 'ShaderNodeOutputMaterial', 'Surface', 'Surface', 'OBJECT'),
    out ? h('div', { class: 'ui-sep' }) : null,
    out ? drawOutputInput(tree, 'ShaderNodeOutputMaterial', 'Volume', 'Volume', 'OBJECT') : null,
    out ? drawOutputInput(tree, 'ShaderNodeOutputMaterial', 'Displacement', 'Displacement', 'OBJECT') : null,
  ];
};

worldSurfacePanel.draw = (w: WorldData) => {
  if (!w.use_nodes) return null;
  return drawOutputInput(w.tree, 'ShaderNodeOutputWorld', 'Surface', 'Surface', 'WORLD');
};
