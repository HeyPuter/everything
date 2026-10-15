// DOM (virtual DOM) rendering of nodes: header, rows, sockets and inline value widgets.
// The same widget builders serve the node body, the sidebar and the Properties editor.
import { h, type Child, type VNode } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { numberField, checkbox, enumMenu, colorSwatch, textField, type Unit } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';
import type { NodeData, NodeTreeData, SocketValue } from '../../data/types';
import { getNodeType, inputValue, nodeLabel, propValue, NODE_CLASS_COLORS, SOCKET_COLORS } from '../registry';
import type { NodeDrawContext, NodePropDef, ResolvedSocket } from '../types';
import { HEADER, ROW, type NodeLayout, type Row } from './layout';
import { compatibleGroups } from '../tree';
import { importImageFile } from '../../ops/data';

/** Apply a change made through a widget: redraw and push undo on final values. */
export function nodeChanged(label: string, final = true) {
  app.changed('doc');
  if (final) app.pushUndo(label);
}

export function unitOf(sub?: string): Unit {
  switch (sub) {
    case 'ANGLE':
    case 'EULER':
      return 'angle';
    case 'DISTANCE':
    case 'TRANSLATION':
      return 'distance';
    case 'PERCENTAGE':
      return 'percentage';
    case 'FACTOR':
      return 'factor';
    case 'TIME':
      return 'time';
    case 'PIXEL':
      return 'pixel';
    default:
      return 'none';
  }
}

/** Value widget for an unlinked input socket. */
export function socketValueWidget(node: NodeData, s: ResolvedSocket, key: string, opts: { label?: boolean; vectorColumn?: boolean } = {}): Child {
  const v = inputValue(node, s);
  const set = (nv: SocketValue, final: boolean) => {
    node.inputs[s.identifier] = nv;
    nodeChanged(`Change ${s.label}`, final);
  };
  const label = opts.label === false ? undefined : s.label;
  switch (s.type) {
    case 'FLOAT':
    case 'INT':
      return numberField({
        id: `${key}:${s.identifier}`,
        label,
        value: typeof v === 'number' ? v : 0,
        int: s.type === 'INT',
        min: s.min,
        max: s.max,
        softMin: s.subtype === 'FACTOR' ? (s.min ?? 0) : undefined,
        softMax: s.subtype === 'FACTOR' ? (s.max ?? 1) : undefined,
        unit: unitOf(s.subtype),
        slider: s.subtype === 'FACTOR' || s.subtype === 'PERCENTAGE',
        set: (x, final) => set(x, final),
      });
    case 'BOOLEAN':
      return checkbox(`${key}:${s.identifier}`, label ?? '', !!v, (x) => set(x, true));
    case 'RGBA':
      return h(
        'div',
        { class: 'nd-color-row' },
        label ? h('span', { class: 'nd-label' }, label) : null,
        colorSwatch(`${key}:${s.identifier}`, (v as number[]) ?? [0, 0, 0, 1], (c, final) => set(c, final), { alpha: false }),
      );
    case 'MENU':
      return enumMenu(
        `${key}:${s.identifier}`,
        (s.items ?? []).map((it) => ({ value: it, label: it })),
        String(v ?? ''),
        (x) => set(x, true),
        { title: s.label },
      );
    case 'VECTOR':
    case 'ROTATION': {
      const arr = Array.isArray(v) ? v : [0, 0, 0];
      const unit = unitOf(s.subtype);
      return h(
        'div',
        { class: 'nd-vector' },
        label ? h('div', { class: 'nd-label' }, `${label}:`) : null,
        h(
          'div',
          { class: 'col' },
          ['X', 'Y', 'Z', 'W'].slice(0, s.dimensions ?? 3).map((c, i) =>
            numberField({
              id: `${key}:${s.identifier}:${i}`,
              label: c,
              value: arr[i] ?? 0,
              unit,
              min: s.min,
              max: s.max,
              slider: s.subtype === 'FACTOR',
              set: (x, final) => {
                const nv = [...arr];
                nv[i] = x;
                set(nv, final);
              },
            }),
          ),
        ),
      );
    }
    case 'STRING':
      return textField(`${key}:${s.identifier}`, String(v ?? ''), (x) => set(x, true), { placeholder: s.label });
    default:
      return h('span', { class: 'nd-label' }, s.label);
  }
}

function attributeNames(kind: 'UV_MAP' | 'COLOR_ATTRIBUTE'): string[] {
  const names = new Set<string>();
  for (const me of Object.values(app.doc.meshes)) {
    if (kind === 'UV_MAP') names.add((me as { uv_layer_name?: string }).uv_layer_name ?? 'UVMap');
    else for (const c of me.color_attributes ?? []) names.add(c.name);
  }
  return [...names];
}

/** Widget for a node property. */
export function propWidget(node: NodeData, p: NodePropDef, key: string, ctx: { tree?: NodeTreeData; compact?: boolean } = {}): Child {
  const v = propValue(node, p.id);
  const set = (nv: SocketValue, final = true) => {
    node.props[p.id] = nv;
    nodeChanged(`Change ${p.name}`, final);
  };
  const label = p.noLabel ? undefined : p.name;
  const id = `${key}:p:${p.id}`;
  switch (p.type) {
    case 'ENUM': {
      const items = (p.items ?? []).map(([value, l]) => ({ value, label: l }));
      if (p.expand)
        return h(
          'div',
          { class: 'enum-row nd-enum-row' },
          items.map((it) =>
            h(
              'button',
              {
                key: it.value,
                class: { on: it.value === v },
                onclick: () => set(it.value),
              },
              it.label,
            ),
          ),
        );
      const menu = enumMenu(id, items, String(v ?? ''), (x) => set(x), {
        title: p.name,
      });
      return label && !ctx.compact ? h('div', { class: 'nd-prop-split' }, h('span', { class: 'nd-label' }, `${label}:`), menu) : menu;
    }
    case 'BOOLEAN':
      return checkbox(id, p.name, !!v, (x) => set(x));
    case 'INT':
    case 'FLOAT':
      return numberField({
        id,
        label,
        value: typeof v === 'number' ? v : 0,
        int: p.type === 'INT',
        min: p.min,
        max: p.max,
        softMin: p.softMin,
        softMax: p.softMax,
        unit: unitOf(p.sub),
        set: (x, final) => set(x, final),
      });
    case 'STRING':
    case 'ATTRIBUTE':
      return textField(id, String(v ?? ''), (x) => set(x), {
        placeholder: p.name,
      });
    case 'UV_MAP':
    case 'COLOR_ATTRIBUTE': {
      const names = attributeNames(p.type);
      const cur = String(v ?? '');
      if (cur && !names.includes(cur)) names.unshift(cur);
      return enumMenu(
        id,
        [
          {
            value: '',
            label: p.type === 'UV_MAP' ? 'Default UV Map' : 'Active Color Attribute',
          },
          ...names.map((n) => ({
            value: n,
            label: n,
            icon: p.type === 'UV_MAP' ? 'uv' : 'group_vcol',
          })),
        ],
        cur,
        (x) => set(x),
        { title: p.name },
      );
    }
    case 'COLOR':
      return colorSwatch(id, (v as number[]) ?? [0.5, 0.5, 0.5, 1], (c, final) => set(c, final), { alpha: true });
    case 'VECTOR':
    case 'DIRECTION': {
      const arr = (v as number[]) ?? [0, 0, 1];
      return h(
        'div',
        { class: 'col' },
        ['X', 'Y', 'Z'].map((c, i) =>
          numberField({
            id: `${id}:${i}`,
            label: c,
            value: arr[i] ?? 0,
            min: p.type === 'DIRECTION' ? -1 : undefined,
            max: p.type === 'DIRECTION' ? 1 : undefined,
            slider: p.type === 'DIRECTION',
            set: (x, final) => {
              const nv = [...arr];
              nv[i] = x;
              set(nv, final);
            },
          }),
        ),
      );
    }
    case 'IMAGE':
      return imageSelector(node, p.id, id);
    case 'NODE_TREE': {
      const groups = compatibleGroups(app.doc, ctx.tree?.type ?? 'SHADER');
      const cur = v as string | null;
      return enumMenu(
        id,
        groups.map((g) => ({ value: g.id, label: g.name, icon: 'node_tree' })),
        cur ?? '',
        (x) => set(x),
        { title: 'Node Group' },
      );
    }
    case 'OBJECT': {
      const obs = Object.values(app.doc.objects);
      return enumMenu(id, [{ value: '', label: '—' }, ...obs.map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], String(v ?? ''), (x) => set(x || null), { title: p.name });
    }
    default:
      return null;
  }
}

/** Compact image data-block selector with an Open button. */
export function imageSelector(node: NodeData, propId: string, id: string): Child {
  const images = Object.values(app.doc.images);
  const cur = node.props[propId] as string | null | undefined;
  const img = cur ? app.doc.images[cur] : undefined;
  return h(
    'div',
    { class: 'nd-image-sel' },
    h(
      'button',
      {
        class: 'nd-ids-browse',
        'data-tip': 'Browse Image to be linked',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(
            images.length
              ? images.map((i) => ({
                  label: i.name,
                  icon: 'image',
                  active: i.id === cur,
                  action: () => ((node.props[propId] = i.id), nodeChanged('Assign Image')),
                }))
              : [{ label: 'No images', disabled: true }],
            e.currentTarget as HTMLElement,
          );
        },
      },
      icon('image'),
      icon('down_arrow_hlt', 'tiny'),
    ),
    img
      ? [
          h('span', { class: 'nd-ids-name', title: img.name }, img.name),
          h(
            'button',
            {
              class: 'nd-ids-btn',
              'data-tip': 'Unlink image',
              onclick: () => ((node.props[propId] = null), nodeChanged('Unlink Image')),
            },
            icon('x'),
          ),
        ]
      : h(
          'button',
          {
            class: 'nd-ids-open',
            'data-tip': 'Open Image\nOpen an image file from disk',
            onclick: () => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
              input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                const imgId = await importImageFile(f);
                if (!imgId) return;
                node.props[propId] = imgId;
                nodeChanged('Open Image');
              };
              input.click();
            },
          },
          icon('file_folder'),
          'Open',
        ),
  );
}

// ---------------------------------------------------------------------------
// Node rendering

export interface NodeRenderState {
  active: boolean;
  /** nodes being dragged are offset without re-rendering */
  highlightSockets?: Set<string>;
  groupName?: string;
  invalid?: boolean;
  /** text shown above a reroute (its label, or the name of the socket feeding it) */
  rerouteLabel?: string;
}

const COLLAPSE_TIP = 'Collapse (H)';

export function nodeColor(n: NodeData): string {
  const def = getNodeType(n.type);
  return NODE_CLASS_COLORS[def?.category ?? 'converter'] ?? '#3b3b3b';
}

function rowContent(node: NodeData, row: Row, key: string, tree: NodeTreeData): Child {
  const def = getNodeType(node.type);
  switch (row.kind) {
    case 'output':
      return h('div', { class: 'nd-row nd-out' }, h('span', { class: 'nd-label' }, row.socket!.label));
    case 'input': {
      const s = row.socket!;
      if (row.linked || s.hide_value) return h('div', { class: 'nd-row nd-in' }, h('span', { class: 'nd-label' }, s.label));
      return h('div', { class: { 'nd-row': true, 'nd-in': true, 'nd-in-vec': !!row.vector } }, socketValueWidget(node, s, key));
    }
    case 'prop':
      return h('div', { class: 'nd-row nd-prop' }, propWidget(node, row.prop!, key, { tree, compact: true }));
    case 'panel':
      return h(
        'div',
        {
          class: 'nd-row nd-panel',
          onpointerdown: (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const name = row.panel!.name;
            const def2 = getNodeType(node.type)!;
            const open = new Set(node.open_panels ?? def2.panels!.filter((p) => !p.closed).map((p) => p.name));
            if (open.has(name)) open.delete(name);
            else open.add(name);
            node.open_panels = [...open];
            nodeChanged(open.has(name) ? 'Open Panel' : 'Close Panel', false);
          },
        },
        icon(row.open ? 'disclosure_tri_down' : 'disclosure_tri_right'),
        h('span', { class: 'nd-label' }, row.panel!.name),
      );
    case 'body':
      return def?.drawBody
        ? h(
            'div',
            { class: 'nd-row nd-body' },
            def.drawBody({
              node,
              tree,
              changed: (l, f) => nodeChanged(l, f ?? true),
              where: 'node',
              key,
            } as NodeDrawContext),
          )
        : null;
  }
}

export function renderNode(l: NodeLayout, tree: NodeTreeData, st: NodeRenderState, linkedOut: Set<string>, linkedIn: Set<string>): VNode {
  const n = l.node;
  const def = getNodeType(n.type);
  const key = n.id;
  const custom = n.use_custom_color && n.color ? `rgb(${n.color.map((c) => Math.round(Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2) * 255)).join(',')})` : null;
  if (l.kind === 'REROUTE') {
    const s = l.sockets.get('out:Output')!;
    return h(
      'div',
      {
        key,
        class: { 'nd-reroute': true, sel: !!n.select, active: st.active },
        'data-node': n.id,
        style: {
          left: `${l.x}px`,
          top: `${l.y}px`,
          '--sc': SOCKET_COLORS[s.socket.type] ?? '#888',
        },
      },
      st.rerouteLabel ? h('span', { class: { 'nd-reroute-label': true, auto: !n.label } }, st.rerouteLabel) : null,
    );
  }
  if (l.kind === 'FRAME') {
    const size = (propValue(n, 'label_size') as number) ?? 20;
    return h(
      'div',
      {
        key,
        class: { 'nd-frame': true, sel: !!n.select, active: st.active },
        'data-node': n.id,
        style: {
          left: `${l.x}px`,
          top: `${l.y}px`,
          width: `${l.w}px`,
          height: `${l.h}px`,
          ...(custom ? { '--frame': custom } : {}),
        },
      },
      h('div', { class: 'nd-frame-label', style: { fontSize: `${size}px` } }, n.label || n.name),
    );
  }
  const title = st.groupName ?? nodeLabel(n);
  const sockets: Child[] = [];
  for (const [k, p] of l.sockets) {
    if (p.collapsed) continue;
    const linked = p.isOutput ? linkedOut.has(p.socket.identifier) : linkedIn.has(p.socket.identifier);
    sockets.push(
      h('div', {
        key: `s:${k}`,
        class: {
          'nd-sock': true,
          out: p.isOutput,
          linked,
          hl: !!st.highlightSockets?.has(k),
          ext: p.socket.type === 'CUSTOM' && p.socket.identifier === '__extend__',
          diamond: p.socket.shape === 'DIAMOND' || p.socket.shape === 'DIAMOND_DOT',
        },
        'data-sock': k,
        style: {
          left: `${p.x - l.x}px`,
          top: `${p.y - l.y}px`,
          '--sc': SOCKET_COLORS[p.socket.type] ?? '#888',
        },
      }),
    );
  }
  return h(
    'div',
    {
      key,
      class: {
        'nd-node': true,
        sel: !!n.select,
        active: st.active,
        muted: !!n.mute,
        collapsed: !!n.hide,
        invalid: !!st.invalid,
      },
      'data-node': n.id,
      style: {
        left: `${l.x}px`,
        top: `${l.y}px`,
        width: `${l.w}px`,
        height: `${l.h}px`,
        '--hdr': nodeColor(n),
        ...(custom ? { '--body': custom } : {}),
      },
    },
    h(
      'div',
      { class: 'nd-hdr', style: { height: `${HEADER}px` } },
      h(
        'span',
        {
          class: 'nd-collapse',
          'data-tip': COLLAPSE_TIP,
          onpointerdown: (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            n.hide = !n.hide;
            nodeChanged(n.hide ? 'Collapse Node' : 'Expand Node');
          },
        },
        icon(n.hide ? 'right_arrow' : 'down_arrow_hlt'),
      ),
      h('span', { class: 'nd-title' }, title),
      def?.dynamicSockets && n.props.node_tree !== undefined ? h('span', { class: 'nd-group-icon', 'data-tip': 'Node group (Tab to edit)' }, icon('node_tree')) : null,
    ),
    n.hide
      ? null
      : l.rows.map((r, i) =>
          h(
            'div',
            {
              key: `r${i}:${r.kind}:${r.socket?.identifier ?? r.prop?.id ?? r.panel?.name ?? ''}`,
              class: 'nd-rowwrap',
              style: { top: `${r.y}px`, height: `${r.h}px` },
            },
            rowContent(n, r, key, tree),
          ),
        ),
    sockets,
  );
}

export { ROW };
