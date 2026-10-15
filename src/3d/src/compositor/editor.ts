// Compositor editor (editor type COMPOSITOR): the generic node editor on the scene's compositing
// node group, with the reference header (View/Select/Add/Node, node group selector, Backdrop
// toggle and channels) and the Viewer backdrop drawn behind the nodes (zoom V / Alt V, move
// Alt + middle mouse, fit).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor, type Area } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { enumMenu } from '../ui/widgets';
import { NodeEditor } from '../nodes/editor/editor';
import { registerNodeEditorProvider } from '../nodes/editor/context';
import { viewMenu, selectMenu, nodeMenuItems } from '../nodes/editor/menus';
import { dataBlockSelector } from '../editors/properties/tabs';
import { uid } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { addNode, connect, ctxOf } from '../nodes/tree';
import { nodeSockets } from '../nodes/registry';
import { compositingGroup, compositorGroups, newCompositingGroup } from './data';
import { compositorState, onCompositorUpdate, recomposite } from './session';

export type BackdropChannels = 'COLOR_ALPHA' | 'COLOR' | 'ALPHA' | 'RED' | 'GREEN' | 'BLUE';

const CHANNELS: {
  value: BackdropChannels;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: 'COLOR_ALPHA',
    label: 'Color & Alpha',
    icon: 'image',
    description: 'Display image with RGB colors and alpha transparency',
  },
  {
    value: 'COLOR',
    label: 'Color',
    icon: 'shading_solid',
    description: 'Display image with RGB colors',
  },
  {
    value: 'ALPHA',
    label: 'Alpha',
    icon: 'shading_wire',
    description: 'Display alpha transparency channel',
  },
  {
    value: 'RED',
    label: 'Red',
    icon: 'color_red',
    description: 'Display red channel',
  },
  {
    value: 'GREEN',
    label: 'Green',
    icon: 'color_green',
    description: 'Display green channel',
  },
  {
    value: 'BLUE',
    label: 'Blue',
    icon: 'color_blue',
    description: 'Display blue channel',
  },
];

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

/** Backdrop pixels for a channel selection (cached per viewer version). */
let channelCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function backdropCanvas(src: HTMLCanvasElement, channels: BackdropChannels): HTMLCanvasElement {
  if (channels === 'COLOR_ALPHA') return src;
  const key = `${compositorState.version}|${channels}`;
  if (channelCache?.key === key) return channelCache.canvas;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const ch = channels === 'RED' ? 0 : channels === 'GREEN' ? 1 : channels === 'BLUE' ? 2 : -1;
  for (let i = 0; i < p.length; i += 4) {
    if (channels === 'ALPHA') p[i] = p[i + 1] = p[i + 2] = p[i + 3];
    else if (ch >= 0) p[i] = p[i + 1] = p[i + 2] = p[i + ch];
    p[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  channelCache = { key, canvas: c };
  return c;
}

export class CompositorEditor extends NodeEditor {
  keymaps = ['Compositor', 'Node Editor', 'Node Generic'];
  backdrop = true;
  backdropZoom = 1;
  backdropX = 0;
  backdropY = 0;
  backdropChannels: BackdropChannels = 'COLOR_ALPHA';
  private unsubUpdate: () => void;

  constructor(area: Area, state: unknown) {
    super(area, state, 'COMPOSITOR');
    const st = (state ?? {}) as {
      backdrop?: boolean;
      backdropZoom?: number;
      backdropOffset?: [number, number];
      backdropChannels?: BackdropChannels;
    };
    if (st.backdrop !== undefined) this.backdrop = st.backdrop;
    if (st.backdropZoom) this.backdropZoom = st.backdropZoom;
    if (st.backdropOffset) [this.backdropX, this.backdropY] = st.backdropOffset;
    if (st.backdropChannels) this.backdropChannels = st.backdropChannels;
    this.unsubUpdate = onCompositorUpdate(() => {
      if (this.el.isConnected) {
        this.drawBack();
        this.area.drawHeader?.();
      }
    });
    // Alt + middle mouse moves the backdrop (before the node editor's own view panning)
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button === 1 && e.altKey && this.backdrop) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.moveBackdrop(e.clientX, e.clientY, true);
        }
      },
      { capture: true },
    );
    // the viewer of a freshly opened editor
    requestAnimationFrame(() => recomposite());
  }

  /** Interactive backdrop move (until the button is released, or click/Enter to confirm). */
  moveBackdrop(x0: number, y0: number, drag: boolean) {
    const ox = this.backdropX,
      oy = this.backdropY;
    let keep = false;
    const self = this;
    app.startModal({
      label: 'Backdrop Move',
      cursor: 'move',
      onPointerMove(e) {
        self.backdropX = ox + e.clientX - x0;
        self.backdropY = oy + e.clientY - y0;
        self.drawBack();
      },
      onPointerDown(e) {
        keep = e.button === 0;
        return 'CANCELLED';
      },
      onPointerUp(e) {
        if (drag && (e.button === 1 || e.button === 0)) {
          keep = true;
          return 'CANCELLED';
        }
      },
      onKey(e) {
        if (e.type !== 'keydown') return;
        if (e.key === 'Escape') return 'CANCELLED';
        if (e.key === 'Enter' || e.key === ' ') {
          keep = true;
          return 'CANCELLED';
        }
      },
      cancel() {
        if (!keep) {
          self.backdropX = ox;
          self.backdropY = oy;
        }
        self.drawBack();
      },
      header: () => 'Move backdrop: LMB/Enter confirm, RMB/Esc cancel',
    });
  }

  zoomBackdrop(f: number) {
    this.backdropZoom = Math.max(0.01, Math.min(100, this.backdropZoom * f));
    this.drawBack();
  }

  /** Fit the viewer image into the editor. */
  fitBackdrop() {
    const v = compositorState.viewer;
    if (!v) return;
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    this.backdropZoom = Math.max(0.01, Math.min(W / v.width, H / v.height));
    this.backdropX = this.backdropY = 0;
    this.drawBack();
  }

  /** Group menu without the scene's own compositing tree (it cannot contain itself). */
  addMenuItems(at?: { x: number; y: number }): MenuItem[] {
    const items = super.addMenuItems(at);
    const root = compositingGroup(app.doc);
    if (!root) return items;
    return items.map((it) => {
      if (it.label !== 'Group' || !it.submenu) return it;
      const sub = it.submenu;
      return {
        ...it,
        submenu: () => {
          const list = (typeof sub === 'function' ? sub() : sub).filter((x) => x.label !== root.name);
          return list.length
            ? list
            : [
                {
                  label: 'No node groups (Ctrl G to make one)',
                  disabled: true,
                },
              ];
        },
      };
    });
  }

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) =>
      h(
        'button',
        {
          class: 'hdr-menu',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(items(), e.currentTarget as HTMLElement);
          },
        },
        label,
      );
    const doc = app.doc;
    const s = doc.scene;
    const group = compositingGroup(doc);
    const errors = compositorState.errors.size + (compositorState.error ? 1 : 0);
    return h(
      'div',
      { class: 'hdr-row nd-header' },
      menu('View', () => this.compositorViewMenu()),
      menu('Select', () => selectMenu()),
      menu('Add', () => this.addMenuItems()),
      menu('Node', () => nodeMenuItems(this)),
      h('div', { class: 'hdr-spacer' }),
      h(
        'div',
        { class: 'nd-ids' },
        dataBlockSelector(
          'cmp-ng',
          'node_tree',
          compositorGroups(doc),
          group?.id ?? null,
          (id) => {
            s.compositing_node_group = id;
            if (id) s.use_nodes = true;
            this.path = [];
            changed(id ? 'Assign Compositing Node Group' : 'Unlink Compositing Node Group');
          },
          () => app.run('node.new_compositing_node_group'),
          {
            duplicate: group
              ? () => {
                  const d = cloneShared(group);
                  d.id = uid('ng');
                  d.name = `${group.name}.001`;
                  doc.node_groups[d.id] = d;
                  s.compositing_node_group = d.id;
                  changed('Copy Compositing Node Group');
                }
              : undefined,
          },
        ),
      ),
      h('div', { class: 'hdr-spacer' }),
      errors
        ? h(
            'span',
            {
              class: 'cmp-errors',
              'data-tip': [compositorState.error ?? '', ...[...compositorState.errors].map(([id, msg]) => `${group?.tree.nodes.find((n) => n.id === id)?.name ?? id}: ${msg}`)]
                .filter(Boolean)
                .join('\n'),
            },
            icon('error'),
            String(errors),
          )
        : null,
      h(
        'button',
        {
          class: {
            'hdr-toggle': true,
            wide: true,
            'cmp-backdrop': true,
            on: this.backdrop,
          },
          'data-tip': 'Backdrop\nUse active Viewer Node output as backdrop',
          disabled: !group,
          onclick: () => {
            this.backdrop = !this.backdrop;
            this.drawBack();
            app.changed('ui');
          },
        },
        'Backdrop',
      ),
      enumMenu(
        'cmp-bd-channels',
        CHANNELS,
        this.backdropChannels,
        (v) => {
          this.backdropChannels = v as BackdropChannels;
          this.drawBack();
          app.changed('ui');
        },
        {
          iconOnly: true,
          tip: 'Display Channels\nChannels of the image to draw',
          title: 'Display Channels',
          disabled: !group || !this.backdrop,
        },
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: this.showSidebar },
          'data-tip': 'Sidebar (N)',
          onclick: () => this.toggleSidebar(),
        },
        icon('menu'),
      ),
    );
  }

  private compositorViewMenu(): MenuItem[] {
    const items = viewMenu(this);
    const at = items.findIndex((i) => i.label === 'Frame Selected');
    const bd: MenuItem[] = [
      {
        label: 'Backdrop Move',
        shortcut: 'Alt MMB',
        op: 'node.backimage_move',
      },
      {
        label: 'Backdrop Zoom In',
        shortcut: 'Alt V',
        op: 'node.backimage_zoom',
        props: { factor: 1.2 },
      },
      {
        label: 'Backdrop Zoom Out',
        shortcut: 'V',
        op: 'node.backimage_zoom',
        props: { factor: 1 / 1.2 },
      },
      {
        label: 'Fit Backdrop to Available Space',
        shortcut: 'Home',
        op: 'node.backimage_fit',
      },
      { separator: true },
    ];
    items.splice(at < 0 ? items.length : at, 0, ...bd);
    return items;
  }

  serialize() {
    return {
      ...super.serialize(),
      backdrop: this.backdrop,
      backdropZoom: this.backdropZoom,
      backdropOffset: [this.backdropX, this.backdropY],
      backdropChannels: this.backdropChannels,
    };
  }

  dispose() {
    this.unsubUpdate();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------

registerNodeEditorProvider({
  id: 'COMPOSITOR',
  label: 'Compositor',
  icon: 'node_compositing',
  treeType: () => 'COMPOSITOR',
  root: () => {
    const g = compositingGroup(app.doc);
    if (!g) return null;
    return {
      tree: g.tree,
      key: `cmp:${g.id}`,
      groupId: g.id,
      crumbs: [
        ['scene_data', app.doc.scene.name],
        ['node_tree', g.name],
      ],
    };
  },
  emptyMessage: () => 'Click New to create a compositing node group',
  // Ctrl Shift click / node.link_viewer: link the node's output to the viewer (cycles through outputs)
  linkViewer: (ed, n) => {
    const tree = (ed as CompositorEditor).tree();
    if (!tree || n.type === 'CompositorNodeViewer' || n.type === 'NodeGroupOutput' || n.type === 'NodeFrame') return false;
    const sctx = ctxOf(app.doc, tree);
    const outs = nodeSockets(n, sctx).outputs.filter((s) => s.type !== 'CUSTOM');
    if (!outs.length) return false;
    let viewer = tree.nodes.find((x) => x.type === 'CompositorNodeViewer' && x.id === tree.active_node) ?? tree.nodes.find((x) => x.type === 'CompositorNodeViewer');
    if (!viewer) viewer = addNode(tree, 'CompositorNodeViewer', [n.location[0] + (n.width ?? 140) + 80, n.location[1]]);
    const cur = tree.links.find((l) => l.to_node === viewer!.id && l.from_node === n.id);
    const i = cur ? (outs.findIndex((s) => s.identifier === cur.from_socket) + 1) % outs.length : 0;
    connect(sctx, n.id, outs[i].identifier, viewer.id, 'Image');
    for (const x of tree.nodes) x.select = x.id === n.id;
    tree.active_node = viewer.id;
    app.changed('doc');
    return true;
  },
  drawBackdrop: (ed, g, W, H) => {
    const e = ed as CompositorEditor;
    if (!(e instanceof CompositorEditor) || !e.backdrop) return;
    const v = compositorState.viewer;
    if (!v?.display) return;
    const src = backdropCanvas(v.display, e.backdropChannels);
    const w = v.width * e.backdropZoom,
      hh = v.height * e.backdropZoom;
    const x = Math.round(W / 2 - w / 2 + e.backdropX),
      y = Math.round(H / 2 - hh / 2 + e.backdropY);
    g.save();
    g.imageSmoothingEnabled = e.backdropZoom < 1;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x, y, w, hh);
    g.restore();
  },
});

registerEditor({
  id: 'COMPOSITOR',
  label: 'Compositor',
  icon: 'node_compositing',
  group: 'General',
  create: (a, s) => new CompositorEditor(a, s),
});

// ---------------------------------------------------------------------------
// operators

const compositorEditor = (ctx: OpContext) => {
  const ed = ctx.area?.editor;
  return ed instanceof CompositorEditor ? ed : null;
};

registerOperators([
  {
    idname: 'node.new_compositing_node_group',
    label: 'New Compositing Node Group',
    description: 'Create a new compositing node group and initialize it with default nodes',
    poll: () => true,
    exec: (ctx) => {
      newCompositingGroup(ctx.doc);
      const ed = compositorEditor(ctx);
      if (ed) ed.path = [];
      app.changed('doc');
    },
  },
  {
    idname: 'node.backimage_zoom',
    label: 'Backdrop Zoom',
    description: 'Zoom in/out the background image',
    undo: false,
    props: [{ id: 'factor', label: 'Factor', type: 'float', default: 1.2 }],
    poll: (ctx) => !!compositorEditor(ctx)?.backdrop,
    exec: (ctx, p) => compositorEditor(ctx)!.zoomBackdrop(Number(p.factor) || 1.2),
  },
  {
    idname: 'node.backimage_fit',
    label: 'Fit Backdrop to Available Space',
    description: 'Fit the background image to the available space',
    undo: false,
    poll: (ctx) => !!compositorEditor(ctx)?.backdrop && !!compositorState.viewer,
    exec: (ctx) => compositorEditor(ctx)!.fitBackdrop(),
  },
  {
    idname: 'node.backimage_move',
    label: 'Backdrop Move',
    description: 'Move node backdrop',
    undo: false,
    poll: (ctx) => !!compositorEditor(ctx)?.backdrop,
    invoke: (ctx) => {
      compositorEditor(ctx)!.moveBackdrop(app.pointer.x, app.pointer.y, false);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
]);

addKeys('Compositor', [
  { key: 'V', op: 'node.backimage_zoom', props: { factor: 1 / 1.2 } },
  { key: 'V', alt: true, op: 'node.backimage_zoom', props: { factor: 1.2 } },
  { key: 'HOME', alt: true, op: 'node.backimage_fit' },
]);
