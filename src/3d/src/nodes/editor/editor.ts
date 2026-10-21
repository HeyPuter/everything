// Node editor: canvas (grid + links) under a transformed DOM layer of nodes, with a canvas
// overlay for interactive feedback (dragged links, box select, knife). Generic over tree kinds
// through providers (context.ts); the Shader Editor provider lives in shaderprovider.ts.
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, type ChangeKind } from '../../app/app';
import type { Area, Editor } from '../../ui/screen';
import { openMenu, openPopover, openSearch, type MenuItem, type SearchEntry } from '../../ui/menu';
import { checkbox } from '../../ui/widgets';
import type { MaterialData, NodeData, NodeTreeData } from '../../data/types';
import { canPreview, nodePreview, onPreviewReady, previewTreeKey } from './preview';
import { getNodeType, nodeSockets, nodeMenu, canConvert, SOCKET_COLORS, propValue, NODE_EDITOR_COLORS, nodeEditorSettings } from '../registry';
import { connect, ctxOf, linkStatus, nodeById, insertOnLink, removeLinks, makeNode, internalLinks, frameChildren, compatibleGroups } from '../tree';
import { layoutTree, linkCurve, sockKey, distToCurve, curvePolylineHit, pointInPolygon, type NodeLayout, type SocketPos, HEADER } from './layout';
import { addReroutes, detachLinks, insertOffset, isFrame, isGroupNode, toggleLinkMute } from '../treeops';
import { renderNode } from './nodeui';
import { providers, addMenuExtras, type NodeEditorProvider, type TreeRoot } from './context';
import type { MenuCategory, MenuEntry, SocketType, TreeType } from '../types';
import { drawSidebar } from './sidebar';
import { drawToolbar, NODE_TOOLS, type NodeTool, type SelectMode } from './toolbar';
import { groupIdnameFor } from '../common';
import { viewMenu, selectMenu, nodeMenuItems, contextMenuItems } from './menus';

export interface View {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.08,
  MAX_ZOOM = 4;

/** One fixed end of a dragged link. */
interface DragEnd {
  node: string;
  socket: string;
  type: SocketType;
  x: number;
  y: number;
}

interface LinkDrag {
  /** the fixed ends are outputs (the free end looks for an input) */
  isOutput: boolean;
  ends: DragEnd[];
  /** pointer (node space) */
  px: number;
  py: number;
  /** links were picked up from sockets (dropping on nothing removes them) */
  detached?: boolean;
  /** input socket a link was picked up from (Alt swaps a displaced link back there) */
  origin?: { node: string; socket: string };
  /** Alt held: swap instead of displacing an existing link */
  swap?: boolean;
  target?: SocketPos & { node: string };
}

/** Line gestures drawn with the right mouse button. */
export type GestureMode = 'CUT' | 'MUTE' | 'REROUTE';
const GESTURE_COLOR: Record<GestureMode, string> = {
  CUT: 'rgba(252, 91, 83,0.9)',
  MUTE: 'rgba(131, 170, 253,0.95)',
  REROUTE: 'rgba(150, 231, 154,0.95)',
};

export class NodeEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Node Editor', 'Node Generic'];
  shaderType: 'OBJECT' | 'WORLD' = 'OBJECT';
  /** group editing stack (node group ids and the group node opened) */
  path: { group: string; node: string }[] = [];
  views = new Map<string, View>();
  showSidebar = false;
  sidebarTab = 'Node';
  showToolbar = true;
  /** snap nodes to the grid while moving / resizing (Ctrl inverts) */
  snap = false;
  showOverlays = true;
  overlays = { wireColors: true, rerouteLabels: true, contextPath: true, previews: true };
  /** active toolbar tool and its selection mode */
  tool: NodeTool = 'SELECT_BOX';
  selectMode: SelectMode = 'SET';
  layouts = new Map<string, NodeLayout>();
  private back: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private world: HTMLDivElement;
  private sideEl: HTMLDivElement;
  private toolbarEl: HTMLDivElement;
  private crumbsEl: HTMLDivElement;
  private emptyEl: HTMLDivElement;
  private linkDrag: LinkDrag | null = null;
  private box: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    mode: 'SET' | 'ADD' | 'SUB';
  } | null = null;
  private knife: [number, number][] | null = null;
  private lasso: [number, number][] | null = null;
  private circle: { x: number; y: number; r: number } | null = null;
  /** axis constraint guide while moving nodes (node space point the line passes through) */
  private axisGuide: { axis: 'X' | 'Y'; x: number; y: number } | null = null;
  circleRadius = 40;
  private gesture: GestureMode = 'CUT';
  insertTarget: string | null = null;
  private lastKey = '';
  private resizeObs: ResizeObserver;
  private unsubPreview: () => void;

  constructor(
    public area: Area,
    state: unknown,
    public providerId: string,
  ) {
    const st = (state ?? {}) as {
      shaderType?: 'OBJECT' | 'WORLD';
      sidebar?: boolean;
      views?: [string, View][];
      path?: { group: string; node: string }[];
      toolbar?: boolean;
      snap?: boolean;
      showOverlays?: boolean;
      overlays?: Partial<NodeEditor['overlays']>;
      tool?: NodeTool;
      selectMode?: SelectMode;
    };
    if (st.shaderType) this.shaderType = st.shaderType;
    if (st.sidebar) this.showSidebar = true;
    if (st.toolbar === false) this.showToolbar = false;
    if (st.snap) this.snap = true;
    if (st.showOverlays === false) this.showOverlays = false;
    if (st.overlays) Object.assign(this.overlays, st.overlays);
    if (st.tool && NODE_TOOLS.some((t) => t.id === st.tool)) this.tool = st.tool;
    if (st.selectMode) this.selectMode = st.selectMode;
    if (st.views) this.views = new Map(st.views);
    if (Array.isArray(st.path)) this.path = st.path;
    this.el = document.createElement('div');
    this.el.className = 'nd-editor';
    editorOfElement.set(this.el, this);
    this.el.tabIndex = -1;
    this.back = document.createElement('canvas');
    this.back.className = 'nd-back';
    this.world = document.createElement('div');
    this.world.className = 'nd-world';
    this.over = document.createElement('canvas');
    this.over.className = 'nd-over';
    this.crumbsEl = document.createElement('div');
    this.crumbsEl.className = 'nd-crumbs';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'nd-empty';
    this.sideEl = document.createElement('div');
    this.sideEl.className = 'nd-sidebar';
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'nd-toolbar';
    this.el.append(this.back, this.world, this.over, this.crumbsEl, this.emptyEl, this.toolbarEl, this.sideEl);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onHover(e));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), {
      passive: false,
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.onDouble(e);
    });
    this.resizeObs = new ResizeObserver(() => this.render());
    this.resizeObs.observe(this.el);
    this.unsubPreview = onPreviewReady(() => {
      if (this.el.isConnected) this.render();
    });
  }

  get provider(): NodeEditorProvider {
    return providers.get(this.providerId)!;
  }

  // -------------------------------------------------------------------------
  // tree resolution

  root(): TreeRoot | null {
    return this.provider.root(this);
  }

  /** The tree currently being edited (root or an opened group). */
  tree(): NodeTreeData | null {
    const r = this.root();
    if (!r) return null;
    // validate the group path against the current document (undo may change it)
    let t = r.tree;
    const valid: { group: string; node: string }[] = [];
    for (const p of this.path) {
      const g = app.doc.node_groups[p.group];
      if (!g || !t.nodes.some((n) => n.id === p.node && n.props.node_tree === p.group)) break;
      valid.push(p);
      t = g.tree;
    }
    if (valid.length !== this.path.length) this.path = valid;
    return t;
  }

  /** Id of the node group being edited (an opened group, or a root tree that is a group). */
  currentGroupId(): string | undefined {
    return this.path.length ? this.path[this.path.length - 1].group : this.root()?.groupId;
  }

  treeType(): TreeType {
    return this.provider.treeType(this);
  }

  treeKey(): string {
    const r = this.root();
    if (!r) return '';
    return this.path.length ? `g:${this.path[this.path.length - 1].group}` : r.key;
  }

  view(): View {
    const k = this.treeKey();
    let v = this.views.get(k);
    if (!v) {
      v = { x: 0, y: 0, zoom: 1 };
      this.views.set(k, v);
      requestAnimationFrame(() => this.viewAll(false));
    }
    return v;
  }

  toNode(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    const v = this.view();
    return [(clientX - r.left - v.x) / v.zoom, (clientY - r.top - v.y) / v.zoom];
  }

  toScreen(x: number, y: number): [number, number] {
    const v = this.view();
    return [x * v.zoom + v.x, y * v.zoom + v.y];
  }

  // -------------------------------------------------------------------------
  // header

  header(): Child {
    const p = this.provider;
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
    return h(
      'div',
      { class: 'hdr-row nd-header' },
      p.headerLeft?.(this) ?? null,
      menu('View', () => viewMenu(this)),
      menu('Select', () => selectMenu()),
      this.addMenuButton(),
      menu('Node', () => nodeMenuItems(this)),
      h('div', { class: 'hdr-spacer' }),
      p.headerRight?.(this) ?? null,
      h('div', { class: 'hdr-spacer' }),
      this.headerToggles(),
    );
  }

  /** The header's Add menu (typing in it searches all nodes). */
  addMenuButton(): Child {
    return h(
      'button',
      {
        class: 'hdr-menu',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(this.addMenuItems(), e.currentTarget as HTMLElement, { onType: (ch) => this.addSearch(undefined, ch) });
        },
      },
      'Add',
    );
  }

  /** Snap and sidebar toggles at the right end of the header. */
  headerToggles(): Child {
    const ov = (key: keyof NodeEditor['overlays'], label: string) =>
      checkbox(`nd-ov-${key}`, label, this.overlays[key], (v) => {
        this.overlays[key] = v;
        app.changed('ui');
      });
    return [
      h(
        'div',
        { class: 'hdr-group', key: 'overlay' },
        h('button', { class: { 'hdr-toggle': true, on: this.showOverlays }, 'data-tip': 'Show Overlays (Shift Alt Z)', onclick: () => this.toggleOverlays() }, icon('overlay')),
        h(
          'button',
          {
            class: 'hdr-icondrop',
            'data-tip': 'Overlays',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openPopover(
                e.currentTarget as HTMLElement,
                () =>
                  h(
                    'div',
                    { class: 'pop-panel' },
                    h('div', { class: 'pop-title' }, 'Node Editor Overlays'),
                    ov('wireColors', 'Wire Colors'),
                    ov('rerouteLabels', 'Reroute Auto Labels'),
                    ov('contextPath', 'Context Path'),
                    this.providerId === 'SHADER' ? ov('previews', 'Previews') : null,
                  ),
                { width: 220 },
              );
            },
          },
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
      h(
        'button',
        {
          key: 'insert-offset',
          class: { 'hdr-toggle': true, on: nodeEditorSettings.insertOffset },
          'data-tip': 'Auto-offset\nMake room automatically when a node is dropped onto a link',
          onclick: () => app.run('node.insert_offset_toggle'),
        },
        icon(nodeEditorSettings.insertOffset ? 'node_insert_on' : 'node_insert_off'),
      ),
      h(
        'button',
        {
          key: 'snap',
          class: { 'hdr-toggle': true, on: this.snap },
          'data-tip': 'Snap (Shift Tab)\nSnap nodes to the grid while moving and resizing them (Ctrl inverts)',
          onclick: () => this.toggleSnap(),
        },
        icon(this.snap ? 'snap_on' : 'snap_off'),
      ),
      h(
        'button',
        {
          key: 'sidebar',
          class: { 'hdr-toggle': true, on: this.showSidebar },
          'data-tip': 'Sidebar (N)',
          onclick: () => this.toggleSidebar(),
        },
        icon('menu'),
      ),
    ];
  }

  toggleOverlays() {
    this.showOverlays = !this.showOverlays;
    app.changed('ui');
  }

  toggleSnap() {
    this.snap = !this.snap;
    app.changed('ui');
  }

  toggleToolbar() {
    this.showToolbar = !this.showToolbar;
    app.changed('ui');
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    app.changed('ui');
  }

  // -------------------------------------------------------------------------
  // Add menu

  addMenuItems(at?: { x: number; y: number }): MenuItem[] {
    const items = this.nodeTypeItems((idname, settings) => this.addNodeInteractive(idname, settings, at), false);
    const extra = addMenuExtras.flatMap((x) => x.items(this, at));
    return [{ label: 'Search...', icon: 'search', action: () => this.addSearch(at) }, { separator: true }, ...items, ...(extra.length ? [{ separator: true }, ...extra] : [])];
  }

  /** Swap menu (Shift S): the Add menu's categories, replacing the selected nodes. */
  swapMenuItems(): MenuItem[] {
    return this.nodeTypeItems((idname, settings) => app.run('node.swap_node', { type: idname, settings: JSON.stringify(settings) }, { area: this.area }), true);
  }

  /** Node type categories, Group and Layout submenus; `pick` receives the chosen type. */
  private nodeTypeItems(pick: (idname: string, settings: Record<string, unknown>) => void, swap: boolean): MenuItem[] {
    const add = (e: MenuEntry): MenuItem => ({
      label: e.label ?? getNodeType(e.idname)?.label ?? e.idname,
      action: () => pick(e.idname, e.settings ?? {}),
    });
    const poll = (e: MenuEntry) => !this.provider.menuPoll || this.provider.menuPoll(e.idname, this);
    const conv = (c: MenuCategory): MenuItem[] => {
      const out: MenuItem[] = [];
      for (const it of c.items) {
        if (it === 'SEPARATOR') {
          if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
        } else if ('idname' in it) {
          if (poll(it)) out.push(add(it));
        } else {
          const sub = conv(it);
          if (sub.length) out.push({ label: it.label, submenu: () => sub });
        }
      }
      while (out.length && out[out.length - 1].separator) out.pop();
      return out;
    };
    const items: MenuItem[] = [];
    for (const c of nodeMenu(this.treeType())) {
      const sub = conv(c);
      if (!sub.length) continue;
      if (c.separatorBefore && items.length && !items[items.length - 1].separator) items.push({ separator: true });
      items.push({ label: c.label, submenu: () => sub });
    }
    items.push({ separator: true });
    items.push({ label: 'Group', submenu: () => this.groupMenu(pick, swap) });
    items.push({
      label: 'Layout',
      submenu: () => [add({ idname: 'NodeFrame' }), add({ idname: 'NodeReroute' })],
    });
    return items;
  }

  private groupMenu(pick: (idname: string, settings: Record<string, unknown>) => void, swap: boolean): MenuItem[] {
    const tree = this.tree();
    if (!tree) return [];
    const idname = groupNodeType(this.treeType());
    const groups = compatibleGroupsFor(this.treeType(), this.currentGroupId());
    const items: MenuItem[] = [];
    items.push(swap ? { label: 'New Group', op: 'node.swap_empty_group' } : { label: 'New Group', op: 'node.add_empty_group' });
    if (this.path.length && !swap) {
      items.push({ separator: true });
      items.push({ label: 'Group Input', action: () => pick('NodeGroupInput', {}) });
      items.push({ label: 'Group Output', action: () => pick('NodeGroupOutput', {}) });
    }
    if (groups.length && items.length) items.push({ separator: true });
    for (const g of groups)
      items.push({
        label: g.name,
        icon: 'node_tree',
        description: g.tree.description || undefined,
        action: () => pick(idname, { node_tree: g.id }),
      });
    if (!items.length)
      items.push({
        label: 'No node groups (Ctrl G to make one)',
        disabled: true,
      });
    return items;
  }

  /** Search entries for adding nodes (including operation variants). */
  addSearchEntries(at?: { x: number; y: number }, pick: (idname: string, settings: Record<string, unknown>) => void = (i, st) => this.addNodeInteractive(i, st, at)): SearchEntry[] {
    const out: SearchEntry[] = [];
    const walk = (c: MenuCategory, path: string) => {
      for (const it of c.items) {
        if (it === 'SEPARATOR') continue;
        if ('idname' in it) {
          if (this.provider.menuPoll && !this.provider.menuPoll(it.idname, this)) continue;
          const def = getNodeType(it.idname);
          if (!def) continue;
          out.push({
            label: it.label ?? def.label,
            path,
            run: () => pick(it.idname, it.settings ?? {}),
          });
          // operation variants (Math ▸ Add, Vector Math ▸ Cross Product, …)
          const op = def.props.find((p) => p.id === 'operation' && p.items);
          if (op && !it.settings)
            for (const [v, l] of op.items!)
              out.push({
                label: `${def.label} ▸ ${l}`,
                path,
                run: () => pick(it.idname, { operation: v }),
              });
        } else walk(it, path ? `${path} ▸ ${it.label}` : it.label);
      }
    };
    for (const c of nodeMenu(this.treeType())) walk(c, c.label);
    for (const g of compatibleGroupsFor(this.treeType(), this.currentGroupId()))
      out.push({
        label: g.name,
        path: 'Group',
        icon: 'node_tree',
        run: () => pick(groupNodeType(this.treeType()), { node_tree: g.id }),
      });
    out.push({
      label: 'Frame',
      path: 'Layout',
      run: () => pick('NodeFrame', {}),
    });
    out.push({
      label: 'Reroute',
      path: 'Layout',
      run: () => pick('NodeReroute', {}),
    });
    return out;
  }

  addSearch(at?: { x: number; y: number }, initial = '') {
    openSearch(() => [...this.addSearchEntries(at), ...addMenuExtras.flatMap((x) => x.search(this, at))], app.pointer.x - 150, app.pointer.y - 20, 'Search nodes…', initial);
  }

  /** Search for the node type to swap the selected nodes to. */
  swapSearch(initial = '') {
    const pick = (type: string, settings: Record<string, unknown>) => app.run('node.swap_node', { type, settings: JSON.stringify(settings) }, { area: this.area });
    openSearch(() => this.addSearchEntries(undefined, pick), app.pointer.x - 150, app.pointer.y - 20, 'Swap to…', initial);
  }

  /** Add a node under the pointer and start moving it. */
  addNodeInteractive(idname: string, settings: Record<string, unknown>, at?: { x: number; y: number }, onCancel?: () => void) {
    const tree = this.tree();
    if (!tree) {
      app.report('WARNING', 'No node tree to add to');
      return;
    }
    // the node appears under the pointer and follows it until confirmed
    void at;
    const p = { x: app.pointer.x, y: app.pointer.y };
    const [nx, ny] = this.toNode(p.x, p.y);
    const n = makeNode(tree, idname, [nx, -ny], settings as Record<string, never>);
    const w = getNodeType(n.type)?.layout === 'REROUTE' ? 0 : (n.width ?? 140) / 2;
    n.location = [nx - w, -ny + HEADER / 2];
    for (const o of tree.nodes) o.select = false;
    n.select = true;
    const prevActive = tree.active_node ?? null;
    const prevSel = tree.nodes.filter((o) => o.select).map((o) => o.id);
    tree.nodes.push(n);
    tree.active_node = n.id;
    const extra = getNodeType(n.type)?.onAdd?.(tree, n) ?? [];
    for (const x of extra) x.select = true;
    // the group's preferred node width
    const gid = n.props.node_tree as string | undefined;
    const gw = gid && isGroupNode(n) ? app.doc.node_groups[gid]?.tree.default_group_node_width : undefined;
    if (gw) n.width = gw;
    app.changed('doc');
    this.render();
    // the new node follows the pointer; cancelling removes it again
    const added = new Set([n.id, ...extra.map((x) => x.id)]);
    this.startGrab([...added], 'key', `Add ${getNodeType(n.type)?.label ?? idname}`, undefined, p, {
      onCancel: () => {
        tree.nodes = tree.nodes.filter((o) => !added.has(o.id));
        tree.links = tree.links.filter((l) => !added.has(l.from_node) && !added.has(l.to_node));
        tree.active_node = prevActive;
        for (const o of tree.nodes) o.select = prevSel.includes(o.id);
        onCancel?.();
      },
    });
  }

  // -------------------------------------------------------------------------
  // rendering

  update(kinds: Set<ChangeKind>) {
    void kinds;
    this.render();
  }

  resize() {
    this.render();
  }

  render() {
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    const tree = this.tree();
    const r = this.root();
    // crumbs
    const crumbs: Child[] = [];
    if (r) {
      const items = [...r.crumbs, ...this.path.map((p) => ['node_tree', app.doc.node_groups[p.group]?.name ?? '?'] as [string, string])];
      const rootN = r.crumbs.length;
      items.forEach(([ic, name], i) => {
        if (i) crumbs.push(h('span', { class: 'nd-crumb-sep' }, icon('right_arrow')));
        // the root tree and every opened group except the current one lead back up
        const depth = Math.max(0, i - rootN + 1);
        const up = i >= rootN - 1 && depth < this.path.length;
        crumbs.push(
          h(
            'span',
            {
              class: { 'nd-crumb': true, link: up },
              'data-tip': up ? 'Go back to this node tree' : '',
              onclick: up
                ? () => {
                    this.path = this.path.slice(0, depth);
                    app.changed('ui');
                  }
                : undefined,
            },
            icon(ic),
            name,
          ),
        );
      });
    }
    patch(this.crumbsEl, crumbs);
    this.crumbsEl.hidden = !(this.showOverlays && this.overlays.contextPath);
    patch(this.emptyEl, tree ? [] : [h('div', { class: 'nd-empty-msg' }, this.provider.emptyMessage?.(this) ?? '')]);
    this.layouts = tree ? layoutTree(app.doc, tree) : new Map();
    const key = this.treeKey();
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.linkDrag = null;
    }
    const v = this.view();
    this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    this.world.classList.toggle('low-zoom', v.zoom < 0.45);
    if (tree) {
      const nodesV: Child[] = [];
      const linkedOut = new Map<string, Set<string>>(),
        linkedIn = new Map<string, Set<string>>();
      for (const l of tree.links) {
        (linkedOut.get(l.from_node) ?? linkedOut.set(l.from_node, new Set()).get(l.from_node)!).add(l.from_socket);
        (linkedIn.get(l.to_node) ?? linkedIn.set(l.to_node, new Set()).get(l.to_node)!).add(l.to_socket);
      }
      const ordered = [...tree.nodes].sort((a, b) => {
        const fa = getNodeType(a.type)?.layout === 'FRAME' ? 0 : 1,
          fb = getNodeType(b.type)?.layout === 'FRAME' ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return (a.id === tree.active_node ? 1 : 0) - (b.id === tree.active_node ? 1 : 0);
      });
      const dim = this.socketDimmer();
      const ma = this.showOverlays && this.overlays.previews && tree.nodes.some((n) => n.show_preview) ? this.previewMaterial() : null;
      const pkey = ma ? previewTreeKey(app.doc, ma) : '';
      for (const n of ordered) {
        const l = this.layouts.get(n.id);
        if (!l) continue;
        const gid = n.props.node_tree as string | undefined;
        const groupName = gid !== undefined && getNodeType(n.type)?.dynamicSockets ? (gid && app.doc.node_groups[gid]?.name) || 'Group' : undefined;
        nodesV.push(
          renderNode(
            l,
            tree,
            {
              // the active node is highlighted only while it is selected
              active: tree.active_node === n.id && !!n.select,
              groupName: n.label ? undefined : groupName,
              highlightSockets: this.highlightSockets(),
              dimSocket: dim,
              titleTip: groupName !== undefined && gid ? app.doc.node_groups[gid]?.tree.description : undefined,
              warnings: this.provider.nodeWarnings?.(this, n),
              preview: ma && n.show_preview && !n.hide && canPreview(n, app.doc, tree) ? (nodePreview(app.doc, ma, n, pkey) ?? '') : undefined,
              rerouteLabel: l.kind === 'REROUTE' ? n.label || (this.showOverlays && this.overlays.rerouteLabels ? rerouteSource(tree, n, this.layouts) : undefined) : undefined,
            },
            linkedOut.get(n.id) ?? new Set(),
            linkedIn.get(n.id) ?? new Set(),
          ),
        );
      }
      patch(this.world, nodesV);
    } else patch(this.world, []);
    this.sideEl.hidden = !this.showSidebar;
    if (this.showSidebar) patch(this.sideEl, drawSidebar(this));
    this.toolbarEl.hidden = !this.showToolbar || !tree;
    if (!this.toolbarEl.hidden) patch(this.toolbarEl, drawToolbar(this));
    this.el.dataset.tool = this.tool;
    this.drawBack(W, H);
    this.drawOver(W, H);
  }

  /** While dragging a link: which sockets it cannot be connected to. */
  private socketDimmer(): ((p: SocketPos, nodeId: string) => boolean) | undefined {
    const d = this.linkDrag;
    if (!d) return undefined;
    const own = new Set(d.ends.map((e) => e.node));
    const type = d.ends[0].type;
    return (p, nodeId) => {
      if (p.isOutput === d.isOutput || own.has(nodeId)) return true;
      if (type === 'CUSTOM' || p.socket.type === 'CUSTOM') return false;
      return d.isOutput ? !canConvert(type, p.socket.type) : !canConvert(p.socket.type, type);
    };
  }

  private highlightSockets(): Set<string> | undefined {
    if (!this.linkDrag?.target) return undefined;
    return new Set([sockKey(this.linkDrag.target.isOutput, this.linkDrag.target.socket.identifier)]);
  }

  private sizeCanvas(c: HTMLCanvasElement, W: number, H: number) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  /** Grid and links. */
  drawBack(W = this.el.clientWidth, H = this.el.clientHeight) {
    if (!W || !H) return;
    const g = this.sizeCanvas(this.back, W, H);
    g.fillStyle = NODE_EDITOR_COLORS.back;
    g.fillRect(0, 0, W, H);
    const v = this.view();
    // dot grid (two levels)
    let step = 20;
    while (step * v.zoom < 14) step *= 2;
    const s = step * v.zoom;
    const ox = ((v.x % s) + s) % s,
      oy = ((v.y % s) + s) % s;
    const big = step * 5 * v.zoom;
    g.fillStyle = NODE_EDITOR_COLORS.grid;
    for (let x = ox; x < W; x += s) for (let y = oy; y < H; y += s) g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    if (big > 40) {
      g.fillStyle = NODE_EDITOR_COLORS.gridMajor;
      const bx = ((v.x % big) + big) % big,
        by = ((v.y % big) + big) % big;
      for (let x = bx; x < W; x += big) for (let y = by; y < H; y += big) g.fillRect(Math.round(x) - 1.5, Math.round(y) - 1.5, 3, 3);
    }
    this.provider.drawBackdrop?.(this, g, W, H);
    const tree = this.tree();
    if (!tree) return;
    const ctx = ctxOf(app.doc, tree);
    const sel = new Set(tree.nodes.filter((n) => n.select).map((n) => n.id));
    const lw = Math.max(1, Math.min(3, 1.6 * v.zoom));
    for (const l of tree.links) {
      const a = this.layouts.get(l.from_node)?.sockets.get(sockKey(true, l.from_socket));
      const b = this.layouts.get(l.to_node)?.sockets.get(sockKey(false, l.to_socket));
      if (!a || !b) continue;
      const st = linkStatus(ctx, l);
      const hl = sel.has(l.from_node) || sel.has(l.to_node);
      let color = this.showOverlays && this.overlays.wireColors ? (SOCKET_COLORS[a.socket.type] ?? '#9a9b9c') : '#9a9b9c';
      if (!st.valid) color = '#df3e36';
      else if (l.is_muted) color = '#b94640';
      const [x1, y1] = this.toScreen(a.x, a.y),
        [x2, y2] = this.toScreen(b.x, b.y);
      const c = linkCurve(x1, y1, x2, y2);
      const dashed = st.inactive || !!l.is_muted;
      this.strokeLink(g, c, color, lw, hl, dashed, l.id === this.insertTarget);
    }
  }

  private strokeLink(g: CanvasRenderingContext2D, c: number[], color: string, lw: number, hl: boolean, dashed: boolean, insert = false) {
    g.beginPath();
    g.moveTo(c[0], c[1]);
    g.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
    g.setLineDash(dashed ? [6, 4] : []);
    g.strokeStyle = 'rgba(0, 0, 0,0.55)';
    g.lineWidth = lw + 2;
    g.stroke();
    g.strokeStyle = insert ? '#ffffff' : hl ? lighten(color, 0.45) : mute(color);
    g.lineWidth = insert ? lw + 1 : lw;
    g.stroke();
    g.setLineDash([]);
  }

  /** Interactive overlay: dragged link, box, knife, muted pass-throughs. */
  drawOver(W = this.el.clientWidth, H = this.el.clientHeight) {
    if (!W || !H) return;
    const g = this.sizeCanvas(this.over, W, H);
    g.clearRect(0, 0, W, H);
    const tree = this.tree();
    const v = this.view();
    if (tree) {
      // muted nodes show their internal pass-through links
      const ctx = ctxOf(app.doc, tree);
      for (const n of tree.nodes) {
        if (!n.mute || n.hide) continue;
        const l = this.layouts.get(n.id);
        if (!l) continue;
        for (const [inp, out] of internalLinks(ctx, n)) {
          const a = l.sockets.get(sockKey(false, inp.identifier)),
            b = l.sockets.get(sockKey(true, out.identifier));
          if (!a || !b || a.collapsed || b.collapsed) continue;
          const [x1, y1] = this.toScreen(a.x, a.y),
            [x2, y2] = this.toScreen(b.x, b.y);
          g.strokeStyle = 'rgba(216, 63, 55,0.85)';
          g.lineWidth = Math.max(1, 1.5 * v.zoom);
          g.beginPath();
          g.moveTo(x1, y1);
          g.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
          g.stroke();
        }
      }
    }
    if (this.linkDrag) {
      const d = this.linkDrag;
      const t = d.target;
      const [px, py] = t ? this.toScreen(t.x, t.y) : this.toScreen(d.px, d.py);
      for (const end of d.ends) {
        const [fx, fy] = this.toScreen(end.x, end.y);
        const c = d.isOutput ? linkCurve(fx, fy, px, py) : linkCurve(px, py, fx, fy);
        this.strokeLink(g, c, SOCKET_COLORS[end.type] ?? '#cdced0', Math.max(1.5, Math.min(3, 2 * v.zoom)), true, false);
      }
    }
    if (this.box) {
      const b = this.box;
      g.fillStyle = 'rgba(255, 255, 255,0.04)';
      g.strokeStyle = 'rgba(255, 255, 255,0.7)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      const x = Math.min(b.x0, b.x1),
        y = Math.min(b.y0, b.y1);
      g.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    if (this.axisGuide) {
      const [gx, gy] = this.toScreen(this.axisGuide.x, this.axisGuide.y);
      g.strokeStyle = this.axisGuide.axis === 'X' ? 'rgba(252, 81, 72,0.8)' : 'rgba(126, 221, 105,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      if (this.axisGuide.axis === 'X') {
        g.moveTo(0, gy);
        g.lineTo(W, gy);
      } else {
        g.moveTo(gx, 0);
        g.lineTo(gx, H);
      }
      g.stroke();
    }
    if (this.lasso && this.lasso.length > 1) {
      g.fillStyle = 'rgba(255, 255, 255,0.04)';
      g.strokeStyle = 'rgba(255, 255, 255,0.7)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.beginPath();
      this.lasso.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
    if (this.circle) {
      g.strokeStyle = 'rgba(255, 255, 255,0.8)';
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.arc(this.circle.x, this.circle.y, this.circle.r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    if (this.knife && this.knife.length > 1) {
      g.strokeStyle = GESTURE_COLOR[this.gesture];
      g.setLineDash([5, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      this.knife.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.setLineDash([]);
    }
  }

  /** Fast path while dragging nodes: update layouts, element positions and the canvases. */
  refreshPositions() {
    const tree = this.tree();
    if (!tree) return;
    this.layouts = layoutTree(app.doc, tree);
    for (const el of this.world.children as HTMLCollectionOf<HTMLElement>) {
      const id = el.dataset.node;
      const l = id ? this.layouts.get(id) : undefined;
      if (!l) continue;
      el.style.left = `${l.x}px`;
      el.style.top = `${l.y}px`;
      if (l.kind === 'FRAME') {
        el.style.width = `${l.w}px`;
        el.style.height = `${l.h}px`;
      }
    }
    this.drawBack();
    this.drawOver();
  }

  // -------------------------------------------------------------------------
  // view

  bounds(ids?: Set<string>): [number, number, number, number] | null {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const l of this.layouts.values()) {
      if (ids && !ids.has(l.node.id)) continue;
      x0 = Math.min(x0, l.x);
      // a preview sits above the node
      y0 = Math.min(y0, l.node.show_preview && !l.node.hide && this.overlays.previews && this.previewMaterial() ? l.y - l.w - 4 : l.y);
      x1 = Math.max(x1, l.x + l.w);
      y1 = Math.max(y1, l.y + l.h);
    }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
  }

  viewAll(selectedOnly: boolean, smooth = true) {
    const tree = this.tree();
    if (!tree) return;
    if (!this.layouts.size) this.layouts = layoutTree(app.doc, tree);
    const ids = selectedOnly ? new Set(tree.nodes.filter((n) => n.select).map((n) => n.id)) : undefined;
    const b = this.bounds(ids && ids.size ? ids : undefined);
    const W = this.el.clientWidth - (this.showSidebar ? 260 : 0),
      H = this.el.clientHeight;
    const v = this.view();
    if (!b || !W || !H) {
      Object.assign(v, { x: W / 2, y: H / 2, zoom: 1 });
      this.render();
      return;
    }
    const pad = 40;
    const zoom = Math.max(MIN_ZOOM, Math.min(selectedOnly ? 1.6 : 1.0, Math.min((W - pad * 2) / Math.max(1, b[2] - b[0]), (H - pad * 2) / Math.max(1, b[3] - b[1]))));
    const target = {
      zoom,
      x: W / 2 - ((b[0] + b[2]) / 2) * zoom,
      y: H / 2 - ((b[1] + b[3]) / 2) * zoom,
    };
    this.animateTo(target, smooth);
  }

  /** Pan so a node is in view (keeps the zoom). */
  centerOn(n: NodeData, smooth = true) {
    const tree = this.tree();
    if (!tree) return;
    if (!this.layouts.has(n.id)) this.layouts = layoutTree(app.doc, tree);
    const l = this.layouts.get(n.id);
    if (!l) return;
    const v = this.view();
    const W = this.el.clientWidth - (this.showSidebar ? this.sideEl.offsetWidth : 0),
      H = this.el.clientHeight;
    const [ax, ay] = this.toScreen(l.x, l.y),
      [bx, by] = this.toScreen(l.x + l.w, l.y + l.h);
    if (ax >= 0 && ay >= 0 && bx <= W && by <= H) return;
    this.animateTo({ zoom: v.zoom, x: W / 2 - (l.x + l.w / 2) * v.zoom, y: H / 2 - (l.y + l.h / 2) * v.zoom }, smooth);
  }

  private animating = 0;
  animateTo(t: View, smooth = true) {
    const v = this.view();
    cancelAnimationFrame(this.animating);
    if (!smooth) {
      Object.assign(v, t);
      this.render();
      return;
    }
    const s = { ...v };
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 180);
      const e = k * k * (3 - 2 * k);
      v.x = s.x + (t.x - s.x) * e;
      v.y = s.y + (t.y - s.y) * e;
      v.zoom = s.zoom + (t.zoom - s.zoom) * e;
      this.applyView();
      if (k < 1) this.animating = requestAnimationFrame(step);
    };
    step();
  }

  applyView() {
    const v = this.view();
    this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    this.world.classList.toggle('low-zoom', v.zoom < 0.45);
    this.drawBack();
    this.drawOver();
  }

  zoomBy(f: number, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    const v = this.view();
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * f));
    v.x = cx - ((cx - v.x) * z) / v.zoom;
    v.y = cy - ((cy - v.y) * z) / v.zoom;
    v.zoom = z;
    this.applyView();
  }

  private onWheel(e: WheelEvent) {
    if ((e.target as HTMLElement).closest('.nd-sidebar')) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const v = this.view();
    const pinch = e.ctrlKey && !Number.isInteger(e.deltaY);
    if (pinch) this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else if (e.ctrlKey) {
      v.x -= e.deltaY;
      this.applyView();
    } else if (e.shiftKey) {
      v.y -= e.deltaY;
      this.applyView();
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && e.deltaMode === 0 && Math.abs(e.deltaX) > 0) {
      // trackpad two-finger pan
      v.x -= e.deltaX;
      v.y -= e.deltaY;
      this.applyView();
    } else this.zoomBy(e.deltaY > 0 ? 1 / 1.15 : 1.15, e.clientX - r.left, e.clientY - r.top);
  }

  // -------------------------------------------------------------------------
  // hit testing

  hitSocket(clientX: number, clientY: number, wantOutput?: boolean): (SocketPos & { node: string }) | null {
    const [x, y] = this.toNode(clientX, clientY);
    const v = this.view();
    const r = Math.max(7, 11 / v.zoom);
    let best: (SocketPos & { node: string }) | null = null,
      bd = r * r;
    for (const l of this.layouts.values()) {
      if (l.kind === 'FRAME') continue;
      if (x < l.x - r || x > l.x + l.w + r || y < l.y - r || y > l.y + l.h + r) continue;
      for (const s of l.sockets.values()) {
        if (s.collapsed && !l.node.hide) continue;
        if (wantOutput !== undefined && s.isOutput !== wantOutput) continue;
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = { ...s, node: l.node.id };
        }
      }
    }
    return best;
  }

  hitNode(clientX: number, clientY: number, frames = true): NodeData | null {
    const [x, y] = this.toNode(clientX, clientY);
    const tree = this.tree();
    if (!tree) return null;
    let hit: NodeData | null = null;
    for (const n of tree.nodes) {
      const l = this.layouts.get(n.id);
      if (!l) continue;
      const isFrame = l.kind === 'FRAME';
      if (isFrame && !frames) continue;
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) {
        if (!hit || !isFrame || getNodeType(hit.type)?.layout === 'FRAME') hit = isFrame && hit && getNodeType(hit.type)?.layout !== 'FRAME' ? hit : n;
      }
    }
    // nodes win over frames
    if (hit && getNodeType(hit.type)?.layout === 'FRAME') {
      for (const n of tree.nodes) {
        const l = this.layouts.get(n.id);
        if (l && l.kind !== 'FRAME' && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return n;
      }
    }
    return hit;
  }

  linkAt(clientX: number, clientY: number, maxPx = 8): string | null {
    const tree = this.tree();
    if (!tree) return null;
    const r = this.el.getBoundingClientRect();
    const px = clientX - r.left,
      py = clientY - r.top;
    let best: string | null = null,
      bd = maxPx * maxPx;
    for (const l of tree.links) {
      const a = this.layouts.get(l.from_node)?.sockets.get(sockKey(true, l.from_socket));
      const b = this.layouts.get(l.to_node)?.sockets.get(sockKey(false, l.to_socket));
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.y),
        [x2, y2] = this.toScreen(b.x, b.y);
      const d = distToCurve(linkCurve(x1, y1, x2, y2), px, py);
      if (d < bd) {
        bd = d;
        best = l.id;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // selection

  selectOnly(tree: NodeTreeData, n: NodeData | null) {
    for (const o of tree.nodes) o.select = false;
    if (n) {
      n.select = true;
      tree.active_node = n.id;
    }
  }

  selectedIds(): string[] {
    return (
      this.tree()
        ?.nodes.filter((n) => n.select)
        .map((n) => n.id) ?? []
    );
  }

  // -------------------------------------------------------------------------
  // pointer interaction

  private onDown(e: PointerEvent) {
    if (app.modal) return;
    const target = e.target as HTMLElement;
    if (target.closest('.nd-sidebar, .nd-toolbar, .nd-crumb.link')) return;
    this.el.focus({ preventScroll: true });
    const tree = this.tree();
    if (e.button === 1 || (e.button === 0 && e.altKey && !tree)) return this.panDrag(e);
    if (!tree) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.button === 2) {
      if (ctrl && e.altKey) return this.gestureDrag(e, 'MUTE');
      if (ctrl) return this.gestureDrag(e, 'CUT');
      if (e.shiftKey) return this.gestureDrag(e, 'REROUTE', true);
      return this.contextClick(e);
    }
    if (e.button !== 0) return;
    // Ctrl Alt drag: lasso select (Shift subtracts)
    if (ctrl && e.altKey) return this.lassoDrag(e, tree, e.shiftKey ? 'SUB' : 'ADD');
    // Ctrl Shift click: view the node; Shift Alt click: connect it to the tree's output
    if (e.shiftKey && (ctrl || e.altKey)) {
      const sock = this.hitSocket(e.clientX, e.clientY, true);
      const n = sock ? nodeById(tree, sock.node) : this.hitNode(e.clientX, e.clientY, false);
      if (n && !isFrame(n)) {
        e.preventDefault();
        this.selectOnly(tree, n);
        app.changed('ui');
        // clicking an output socket views that output
        app.run(ctrl ? 'node.link_viewer' : 'node.connect_to_output', { node: n.id, socket: sock?.socket.identifier ?? '' }, { area: this.area });
        return;
      }
    }
    // widgets inside nodes: activate the node, let the widget handle the event
    const widget = target.closest('.num-field, .enum-menu, .color-swatch, .checkbox, input, .text-field, button, .nd-panel, .nd-collapse, .enum-row, .nd-image-sel, .nd-ramp, .nd-curve');
    const nodeEl = target.closest('[data-node]') as HTMLElement | null;
    if (widget && nodeEl) {
      const n = nodeById(tree, nodeEl.dataset.node!);
      if (n && !n.select) {
        if (!e.shiftKey) this.selectOnly(tree, n);
        else n.select = true;
        tree.active_node = n.id;
        app.changed('ui');
      } else if (n) tree.active_node = n.id;
      return;
    }
    const sock = this.hitSocket(e.clientX, e.clientY);
    if (sock && !(sock.collapsed && nodeById(tree, sock.node)?.hide && !ctrl)) return this.linkDragStart(e, tree, sock);
    // link gesture tools draw from anywhere
    if (this.tool === 'LINKS_CUT') return this.gestureDrag(e, 'CUT');
    if (this.tool === 'LINKS_MUTE') return this.gestureDrag(e, 'MUTE');
    if (this.tool === 'ADD_REROUTE') return this.gestureDrag(e, 'REROUTE');
    const n = this.hitNode(e.clientX, e.clientY);
    if (n) {
      const edges = this.resizeEdges(n, e.clientX, e.clientY);
      if (edges) return this.resizeDrag(e, n, edges);
      return this.nodePress(e, tree, n, e.altKey);
    }
    const mode: SelectMode = e.shiftKey ? 'ADD' : ctrl ? 'SUB' : this.selectMode;
    if (this.tool === 'SELECT_LASSO') return this.lassoDrag(e, tree, mode);
    if (this.tool === 'SELECT_CIRCLE') return this.circleDrag(e, tree, mode);
    if (this.tool === 'TWEAK') return this.boxDrag(e, tree, mode, false);
    this.boxDrag(e, tree, mode);
  }

  /** Resize cursor over node and frame edges. */
  private onHover(e: PointerEvent) {
    if (e.buttons || app.modal) return;
    let cursor = '';
    const tree = this.tree();
    if (tree && !(e.target as HTMLElement).closest('.nd-sidebar, .nd-toolbar, button, .num-field, .enum-menu, input') && !this.hitSocket(e.clientX, e.clientY)) {
      const n = this.hitNode(e.clientX, e.clientY);
      const ed = n ? this.resizeEdges(n, e.clientX, e.clientY) : null;
      if (ed) {
        const h = ed.l || ed.r,
          v = ed.t || ed.b;
        cursor = h && v ? ((ed.l && ed.t) || (ed.r && ed.b) ? 'nwse-resize' : 'nesw-resize') : v ? 'ns-resize' : 'ew-resize';
      }
    }
    if (this.el.style.cursor !== cursor) this.el.style.cursor = cursor;
  }

  /** Double click: enter the group node under the pointer, or leave the group on empty space. */
  private onDouble(e: MouseEvent) {
    if (app.modal) return;
    const target = e.target as HTMLElement;
    if (target.closest('.nd-sidebar, .num-field, .enum-menu, .color-swatch, .checkbox, input, .text-field, button, .nd-panel, .nd-collapse, .enum-row, .nd-image-sel, .nd-ramp, .nd-curve')) return;
    const tree = this.tree();
    if (!tree) return;
    const n = this.hitNode(e.clientX, e.clientY, false);
    if (n && isGroupNode(n) && n.props.node_tree) {
      this.selectOnly(tree, n);
      app.run('node.group_edit', { exit: false }, { area: this.area });
    } else if (!n && this.path.length) app.run('node.group_edit', { exit: true }, { area: this.area });
  }

  /**
   * Follow a pointer drag until its button is released. With `cancel`, Esc or pressing another
   * mouse button aborts the drag instead.
   */
  private track(e: PointerEvent, move: (ev: PointerEvent, dist: number) => void, up: (ev: PointerEvent, moved: boolean) => void, cancel?: () => void) {
    const sx = e.clientX,
      sy = e.clientY;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (d > 3) moved = true;
      move(ev, d);
    };
    const stop = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', u);
      removeEventListener('pointerdown', other, true);
      removeEventListener('keydown', key, true);
    };
    const u = (ev: PointerEvent) => {
      if (ev.button !== e.button) return;
      stop();
      up(ev, moved);
    };
    const abort = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      cancel!();
    };
    const other = (ev: PointerEvent) => {
      if (ev.button !== e.button) abort(ev);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') abort(ev);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', u);
    if (cancel) {
      addEventListener('pointerdown', other, true);
      addEventListener('keydown', key, true);
    }
  }

  /**
   * Scroll the view while a drag holds the pointer near the editor edges. Panning starts only
   * once the pointer has been well inside the editor, so drags that begin near an edge don't jump.
   */
  edgePanner(onPan: () => void) {
    const M = 30,
      SPEED = 16;
    let raf = 0,
      x = 0,
      y = 0,
      armed = false;
    const bounds = () => {
      const r = this.el.getBoundingClientRect();
      const side = this.showSidebar ? this.sideEl.offsetWidth : 0;
      return { left: r.left, top: r.top, right: r.right - side, bottom: r.bottom };
    };
    const push = (d: number) => (d < M ? ((M - Math.max(0, d)) / M) * SPEED : 0);
    const step = () => {
      raf = 0;
      if (!armed) return;
      const b = bounds();
      const dx = push(x - b.left) - push(b.right - x),
        dy = push(y - b.top) - push(b.bottom - y);
      if (!dx && !dy) return;
      const v = this.view();
      v.x += dx;
      v.y += dy;
      this.applyView();
      onPan();
      raf = requestAnimationFrame(step);
    };
    return {
      update: (cx: number, cy: number) => {
        x = cx;
        y = cy;
        const b = bounds();
        if (!armed && cx > b.left + M && cx < b.right - M && cy > b.top + M && cy < b.bottom - M) armed = true;
        if (!raf) raf = requestAnimationFrame(step);
      },
      stop: () => {
        cancelAnimationFrame(raf);
        raf = 0;
      },
    };
  }

  private panDrag(e: PointerEvent) {
    e.preventDefault();
    const v = this.view();
    let lx = e.clientX,
      ly = e.clientY;
    const zoomMode = e.ctrlKey;
    const r = this.el.getBoundingClientRect();
    const cx = e.clientX - r.left,
      cy = e.clientY - r.top;
    this.el.classList.add('panning');
    this.track(
      e,
      (ev) => {
        if (zoomMode) this.zoomBy(Math.exp((ev.clientX - lx - (ev.clientY - ly)) * 0.006), cx, cy);
        else {
          v.x += ev.clientX - lx;
          v.y += ev.clientY - ly;
          this.applyView();
        }
        lx = ev.clientX;
        ly = ev.clientY;
      },
      () => this.el.classList.remove('panning'),
    );
  }

  /** Press on a node: select it; dragging moves the selection (Alt: detach its links first). */
  private nodePress(e: PointerEvent, tree: NodeTreeData, n: NodeData, detach = false) {
    e.preventDefault();
    const wasSelected = !!n.select;
    if (e.shiftKey) {
      if (wasSelected && tree.active_node === n.id) n.select = false;
      else {
        n.select = true;
        tree.active_node = n.id;
      }
    } else if (!wasSelected) this.selectOnly(tree, n);
    else tree.active_node = n.id;
    app.changed('ui');
    this.track(
      e,
      (ev, d) => {
        if (d > 3 && !app.modal) {
          if (!n.select) {
            n.select = true;
            tree.active_node = n.id;
          }
          if (detach) {
            const before = structuredClone(tree.links);
            detachLinks(ctxOf(app.doc, tree), new Set(this.selectedIds()));
            this.render();
            this.startGrab(this.selectedIds(), 'tweak', 'Detach', ev, undefined, {
              onCancel: () => {
                tree.links = before;
              },
            });
          } else this.startGrab(this.selectedIds(), 'tweak', 'Move', ev);
        }
      },
      (_ev, moved) => {
        if (!moved && !e.shiftKey && wasSelected) {
          this.selectOnly(tree, n);
          app.changed('ui');
        }
      },
    );
  }

  /** Which edges of a node are under the pointer for resizing (nodes: left/right; fixed frames: all). */
  private resizeEdges(n: NodeData, clientX: number, clientY: number): { l: boolean; r: boolean; t: boolean; b: boolean } | null {
    const l = this.layouts.get(n.id);
    if (!l || n.hide || l.kind === 'REROUTE') return null;
    const [x, y] = this.toNode(clientX, clientY);
    const tol = 5 / this.view().zoom;
    if (l.kind === 'FRAME') {
      const fixed = propValue(n, 'shrink') === false || !frameChildren(this.tree()!, n.id).length;
      if (!fixed) return null;
      const e = { l: Math.abs(x - l.x) < tol, r: Math.abs(x - (l.x + l.w)) < tol, t: Math.abs(y - l.y) < tol, b: Math.abs(y - (l.y + l.h)) < tol };
      return e.l || e.r || e.t || e.b ? e : null;
    }
    const r = Math.abs(x - (l.x + l.w)) < tol,
      left = Math.abs(x - l.x) < tol;
    return r || left ? { l: left && !r, r, t: false, b: false } : null;
  }

  private resizeDrag(e: PointerEvent, n: NodeData, edges: { l: boolean; r: boolean; t: boolean; b: boolean }) {
    e.preventDefault();
    const lay = this.layouts.get(n.id)!;
    const w0 = lay.w,
      h0 = lay.h,
      loc0 = [...n.location] as [number, number];
    const width0 = n.width,
      height0 = n.props.height,
      shrink0 = n.props.shrink;
    const [x0, y0] = this.toNode(e.clientX, e.clientY);
    const def = getNodeType(n.type);
    const frame = lay.kind === 'FRAME';
    const minW = frame ? 40 : (def?.minWidth ?? 80),
      maxW = frame ? 1e5 : (def?.maxWidth ?? 700);
    const snap = (v: number, on: boolean) => (on ? Math.round(v / 10) * 10 : v);
    this.el.classList.add('resizing');
    this.track(
      e,
      (ev) => {
        const [x, y] = this.toNode(ev.clientX, ev.clientY);
        const on = this.snap !== (ev.ctrlKey || ev.metaKey);
        if (edges.r) n.width = Math.round(Math.max(minW, Math.min(maxW, snap(w0 + x - x0, on))));
        if (edges.l) {
          const w = Math.round(Math.max(minW, Math.min(maxW, snap(w0 - (x - x0), on))));
          n.width = w;
          n.location = [loc0[0] + w0 - w, n.location[1]];
        }
        if (frame && edges.b) n.props.height = Math.round(Math.max(40, snap(h0 + y - y0, on)));
        if (frame && edges.t) {
          const hh = Math.round(Math.max(40, snap(h0 - (y - y0), on)));
          n.props.height = hh;
          n.location = [n.location[0], loc0[1] - (h0 - hh)];
        }
        if (frame && propValue(n, 'shrink') !== false) n.props.shrink = false;
        this.render();
      },
      (_ev, moved) => {
        this.el.classList.remove('resizing');
        if (moved) {
          app.pushUndo('Resize Node');
          app.changed('doc');
        }
      },
      () => {
        this.el.classList.remove('resizing');
        n.width = width0;
        n.location = loc0;
        if (frame) {
          if (height0 === undefined) delete n.props.height;
          else n.props.height = height0;
          if (shrink0 === undefined) delete n.props.shrink;
          else n.props.shrink = shrink0;
        }
        this.render();
      },
    );
  }

  private boxDrag(e: PointerEvent, tree: NodeTreeData, mode: 'SET' | 'ADD' | 'SUB', box = true) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const x0 = e.clientX - r.left,
      y0 = e.clientY - r.top;
    this.track(
      e,
      (ev) => {
        if (!box) return;
        this.box = {
          x0,
          y0,
          x1: ev.clientX - r.left,
          y1: ev.clientY - r.top,
          mode,
        };
        this.drawOver();
      },
      (_ev, moved) => {
        if (!moved || !this.box) {
          this.box = null;
          if (mode === 'SET') {
            this.selectOnly(tree, null);
            app.changed('ui');
          }
          this.drawOver();
          return;
        }
        this.applyBox(tree, this.box);
        this.box = null;
        app.changed('ui');
      },
      () => {
        this.box = null;
        this.drawOver();
      },
    );
  }

  applyBox(
    tree: NodeTreeData,
    b: {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      mode: 'SET' | 'ADD' | 'SUB';
    },
  ) {
    const r = this.el.getBoundingClientRect();
    const [ax, ay] = this.toNode(Math.min(b.x0, b.x1) + r.left, Math.min(b.y0, b.y1) + r.top);
    const [bx, by] = this.toNode(Math.max(b.x0, b.x1) + r.left, Math.max(b.y0, b.y1) + r.top);
    if (b.mode === 'SET') for (const n of tree.nodes) n.select = false;
    for (const n of tree.nodes) {
      const l = this.layouts.get(n.id);
      if (!l) continue;
      // frames are box-selected only when fully enclosed
      const inside = l.kind === 'FRAME' ? l.x >= ax && l.x + l.w <= bx && l.y >= ay && l.y + l.h <= by : l.x + l.w >= ax && l.x <= bx && l.y + l.h >= ay && l.y <= by;
      if (inside) n.select = b.mode !== 'SUB';
    }
  }

  /** Run `start` on the next left-button press in the editor (tools started from menus or keys). */
  private waitForPress(cls: string, start: (e: PointerEvent, tree: NodeTreeData) => void) {
    const tree = this.tree();
    if (!tree) return;
    this.el.classList.add(cls);
    const once = (e: PointerEvent) => {
      this.el.classList.remove(cls);
      if (e.button !== 0 || !this.el.contains(e.target as Node)) return;
      e.stopPropagation();
      start(e, tree);
    };
    this.el.addEventListener('pointerdown', once, {
      once: true,
      capture: true,
    });
  }

  /** Box select started from the keyboard (B): drag with LMB. */
  startBoxSelect(mode?: 'SET' | 'ADD' | 'SUB') {
    this.waitForPress('box-pending', (e, tree) => this.boxDrag(e, tree, mode ?? (e.shiftKey ? 'SUB' : 'ADD')));
  }

  /** Zoom to a dragged rectangle (Shift B). */
  startZoomBorder() {
    this.startBorderDrag((ax0, ay0, ax1, ay1) => {
      const [ax, ay] = this.toNode(ax0, ay0);
      const [bx, by] = this.toNode(ax1, ay1);
      const W = this.el.clientWidth,
        H = this.el.clientHeight;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(W / Math.max(1, bx - ax), H / Math.max(1, by - ay))));
      this.animateTo({ zoom, x: W / 2 - ((ax + bx) / 2) * zoom, y: H / 2 - ((ay + by) / 2) * zoom });
    });
  }

  /**
   * Wait for a press, then drag a rectangle; `done` receives its corners in client coordinates
   * (min, max). Used by Zoom to Border and the compositor's Viewer Region.
   */
  startBorderDrag(done: (x0: number, y0: number, x1: number, y1: number) => void) {
    this.waitForPress('box-pending', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const x0 = e.clientX - r.left,
        y0 = e.clientY - r.top;
      this.track(
        e,
        (ev) => {
          this.box = { x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top, mode: 'SET' };
          this.drawOver();
        },
        (_ev, moved) => {
          const b = this.box;
          this.box = null;
          this.drawOver();
          if (!moved || !b) return;
          done(Math.min(b.x0, b.x1) + r.left, Math.min(b.y0, b.y1) + r.top, Math.max(b.x0, b.x1) + r.left, Math.max(b.y0, b.y1) + r.top);
        },
        () => {
          this.box = null;
          this.drawOver();
        },
      );
    });
  }

  /** Lasso select started from a menu: drag with LMB. */
  startLasso(mode: 'SET' | 'ADD' | 'SUB') {
    this.waitForPress('box-pending', (e, tree) => this.lassoDrag(e, tree, mode));
  }

  /** Link gestures started from a menu or operator: drag with LMB. */
  startGesture(mode: GestureMode) {
    this.waitForPress('box-pending', (e) => this.gestureDrag(e, mode));
  }

  private lassoDrag(e: PointerEvent, tree: NodeTreeData, mode: 'SET' | 'ADD' | 'SUB') {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.lasso = [[e.clientX - r.left, e.clientY - r.top]];
    this.track(
      e,
      (ev) => {
        const p: [number, number] = [ev.clientX - r.left, ev.clientY - r.top];
        const q = this.lasso![this.lasso!.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 3) this.lasso!.push(p);
        this.drawOver();
      },
      (_ev, moved) => {
        const pts = this.lasso ?? [];
        this.lasso = null;
        if (moved && pts.length > 2) {
          this.applyLasso(tree, pts, mode);
          app.changed('ui');
        } else {
          // a click selects the node under the pointer
          const n = this.hitNode(e.clientX, e.clientY);
          if (n) this.selectOnly(tree, n);
          app.changed('ui');
        }
        this.drawOver();
      },
      () => {
        this.lasso = null;
        this.drawOver();
      },
    );
  }

  /** Select nodes whose centre lies in a lasso (screen-local points); frames need all corners inside. */
  applyLasso(tree: NodeTreeData, pts: [number, number][], mode: 'SET' | 'ADD' | 'SUB') {
    if (mode === 'SET') for (const n of tree.nodes) n.select = false;
    for (const n of tree.nodes) {
      const l = this.layouts.get(n.id);
      if (!l) continue;
      const corners: [number, number][] =
        l.kind === 'FRAME'
          ? [
              [l.x, l.y],
              [l.x + l.w, l.y],
              [l.x, l.y + l.h],
              [l.x + l.w, l.y + l.h],
            ]
          : [[l.x + l.w / 2, l.y + Math.min(l.h, HEADER) / 2]];
      if (corners.every(([x, y]) => pointInPolygon(...this.toScreen(x, y), pts))) n.select = mode !== 'SUB';
    }
  }

  /** Circle select (C): paint with LMB (Shift / MMB deselects), wheel resizes, RMB / Esc / Enter ends. */
  startCircleSelect(mode: 'SET' | 'ADD' | 'SUB' = 'ADD') {
    const tree = this.tree();
    if (!tree) return;
    const r = this.el.getBoundingClientRect();
    const circle = { x: app.pointer.x - r.left, y: app.pointer.y - r.top, r: this.circleRadius };
    this.circle = circle;
    this.drawOver();
    let paint: 'ADD' | 'SUB' | null = null;
    if (mode === 'SET') for (const n of tree.nodes) n.select = false;
    const apply = () => {
      if (paint) this.paintCircle(tree, circle, paint);
    };
    const self = this;
    const end = () => {
      self.circle = null;
      self.drawOver();
    };
    app.startModal({
      label: 'Circle Select',
      cursor: 'crosshair',
      onPointerMove(e) {
        circle.x = e.clientX - r.left;
        circle.y = e.clientY - r.top;
        apply();
        self.drawOver();
      },
      onPointerDown(e) {
        if (e.button === 2) return 'FINISHED';
        paint = e.button === 1 || e.shiftKey || e.ctrlKey || mode === 'SUB' ? 'SUB' : 'ADD';
        apply();
      },
      onPointerUp() {
        paint = null;
      },
      onWheel(e) {
        circle.r = Math.max(5, Math.min(400, circle.r * (e.deltaY > 0 ? 1 / 1.1 : 1.1)));
        self.circleRadius = circle.r;
        self.drawOver();
      },
      onKey(e) {
        if (e.type !== 'keydown') return;
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') return 'FINISHED';
        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') circle.r = Math.min(400, circle.r * 1.1);
        else if (e.key === '-' || e.code === 'NumpadSubtract') circle.r = Math.max(5, circle.r / 1.1);
        self.circleRadius = circle.r;
        self.drawOver();
      },
      cancel: end,
      finish: end,
      header: () => 'Circle select: LMB select, Shift / MMB deselect, wheel resize, RMB / Esc confirm',
    });
  }

  /** Circle tool: paint the selection while the button is held. */
  private circleDrag(e: PointerEvent, tree: NodeTreeData, mode: SelectMode) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const circle = { x: e.clientX - r.left, y: e.clientY - r.top, r: this.circleRadius };
    this.circle = circle;
    if (mode === 'SET') for (const n of tree.nodes) n.select = false;
    this.paintCircle(tree, circle, mode === 'SUB' ? 'SUB' : 'ADD');
    this.track(
      e,
      (ev) => {
        circle.x = ev.clientX - r.left;
        circle.y = ev.clientY - r.top;
        this.paintCircle(tree, circle, mode === 'SUB' ? 'SUB' : 'ADD');
      },
      () => {
        this.circle = null;
        this.drawOver();
      },
    );
  }

  private paintCircle(tree: NodeTreeData, circle: { x: number; y: number; r: number }, paint: 'ADD' | 'SUB') {
    for (const n of tree.nodes) {
      const l = this.layouts.get(n.id);
      if (!l) continue;
      const [ax, ay] = this.toScreen(l.x, l.y),
        [bx, by] = this.toScreen(l.x + l.w, l.y + l.h);
      const cx = Math.max(ax, Math.min(bx, circle.x)),
        cy = Math.max(ay, Math.min(by, circle.y));
      // frames are picked by their label strip
      const hit = l.kind === 'FRAME' ? circle.x >= ax && circle.x <= bx && circle.y >= ay && circle.y <= ay + 24 * this.view().zoom : Math.hypot(cx - circle.x, cy - circle.y) <= circle.r;
      if (hit) n.select = paint === 'ADD';
    }
    app.changed('ui');
    this.drawOver();
  }

  private gestureDrag(e: PointerEvent, mode: GestureMode, clickOpensMenu = false) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.gesture = mode;
    this.knife = [[e.clientX - r.left, e.clientY - r.top]];
    this.track(
      e,
      (ev) => {
        this.knife!.push([ev.clientX - r.left, ev.clientY - r.top]);
        this.drawOver();
      },
      (ev, moved) => {
        const line = this.knife ?? [];
        this.knife = null;
        this.drawOver();
        if (!moved) {
          if (clickOpensMenu) this.openContextMenu(ev);
          return;
        }
        if (line.length > 1) this.applyGesture(mode, line);
      },
      () => {
        this.knife = null;
        this.drawOver();
      },
    );
  }

  /** Apply a cut / mute / reroute gesture along a screen-local polyline. */
  applyGesture(mode: GestureMode, line: [number, number][]) {
    const tree = this.tree();
    if (!tree) return 0;
    const hits: { link: string; x: number; y: number }[] = [];
    for (const l of tree.links) {
      const a = this.layouts.get(l.from_node)?.sockets.get(sockKey(true, l.from_socket));
      const b = this.layouts.get(l.to_node)?.sockets.get(sockKey(false, l.to_socket));
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.y),
        [x2, y2] = this.toScreen(b.x, b.y);
      const p = curvePolylineHit(linkCurve(x1, y1, x2, y2), line);
      if (!p) continue;
      const v = this.view();
      hits.push({ link: l.id, x: (p[0] - v.x) / v.zoom, y: -(p[1] - v.y) / v.zoom });
    }
    if (!hits.length) return 0;
    const ids = new Set(hits.map((h) => h.link));
    if (mode === 'CUT') {
      removeLinks(tree, ids);
      app.pushUndo('Cut Links');
    } else if (mode === 'MUTE') {
      toggleLinkMute(tree, ids);
      app.pushUndo('Mute Links');
    } else {
      // reroutes are placed by their centre; nodes are positioned by their top-left corner
      const made = addReroutes(tree, hits);
      for (const n of tree.nodes) n.select = made.includes(n);
      app.pushUndo('Add Reroute');
    }
    app.changed('doc');
    return hits.length;
  }

  private contextClick(e: PointerEvent) {
    this.track(
      e,
      () => {},
      (ev, moved) => {
        if (!moved) this.openContextMenu(ev);
      },
    );
  }

  private openContextMenu(ev: PointerEvent) {
    const tree = this.tree();
    if (!tree) return;
    const n = this.hitNode(ev.clientX, ev.clientY);
    if (n && !n.select) {
      this.selectOnly(tree, n);
      app.changed('ui');
    }
    const anySelected = tree.nodes.some((x) => x.select);
    openMenu(contextMenuItems(this, anySelected), { x: ev.clientX, y: ev.clientY }, { title: anySelected ? 'Node' : 'Node Editor' });
  }

  // -------------------------------------------------------------------------
  // links

  private linkDragStart(e: PointerEvent, tree: NodeTreeData, sock: SocketPos & { node: string }) {
    e.preventDefault();
    e.stopPropagation();
    const [px, py] = this.toNode(e.clientX, e.clientY);
    const endOf = (node: string, socket: string, isOutput: boolean): DragEnd => {
      const p = this.layouts.get(node)?.sockets.get(sockKey(isOutput, socket));
      return { node, socket, type: p?.socket.type ?? 'FLOAT', x: p?.x ?? px, y: p?.y ?? py };
    };
    let drag: LinkDrag;
    const before = tree.links.slice();
    const id = sock.socket.identifier;
    if (!sock.isOutput) {
      const existing = tree.links.filter((l) => l.to_node === sock.node && l.to_socket === id);
      if (existing.length) {
        // pick up the link from the input
        const l = existing[existing.length - 1];
        removeLinks(tree, new Set([l.id]));
        this.render();
        drag = { isOutput: true, ends: [endOf(l.from_node, l.from_socket, true)], px, py, detached: true, origin: { node: sock.node, socket: id } };
      } else drag = { isOutput: false, ends: [endOf(sock.node, id, false)], px, py };
    } else {
      const existing = tree.links.filter((l) => l.from_node === sock.node && l.from_socket === id);
      if (e.ctrlKey && existing.length) {
        // Ctrl: pick up every link leaving the output, to plug them into another output
        removeLinks(tree, new Set(existing.map((l) => l.id)));
        this.render();
        drag = { isOutput: false, ends: existing.map((l) => endOf(l.to_node, l.to_socket, false)), px, py, detached: true };
      } else drag = { isOutput: true, ends: [endOf(sock.node, id, true)], px, py };
    }
    this.linkDrag = drag;
    this.render();
    let last = { x: e.clientX, y: e.clientY };
    const update = () => {
      const [x, y] = this.toNode(last.x, last.y);
      drag.px = x;
      drag.py = y;
      drag.target = this.dropTarget(last.x, last.y, drag) ?? undefined;
      this.drawOver();
    };
    const pan = this.edgePanner(update);
    this.track(
      e,
      (ev) => {
        last = { x: ev.clientX, y: ev.clientY };
        drag.swap = ev.altKey;
        pan.update(ev.clientX, ev.clientY);
        update();
      },
      (ev, moved) => {
        pan.stop();
        this.linkDrag = null;
        this.render();
        drag.swap = ev.altKey;
        const t = drag.target;
        if (t) {
          if (this.dropLink(tree, drag, t)) {
            app.pushUndo('Link');
            app.changed('doc');
          } else {
            app.report('WARNING', 'Cannot link these sockets');
            if (drag.detached) app.pushUndo('Remove Link');
            app.changed('doc');
          }
        } else if (drag.detached) {
          app.pushUndo('Remove Link');
          app.changed('doc');
        } else if (moved && drag.ends.length === 1) {
          this.render();
          this.linkDragSearch(drag, ev.clientX, ev.clientY);
        } else this.render();
      },
      () => {
        // cancelled: links picked up from sockets go back
        pan.stop();
        this.linkDrag = null;
        tree.links = before;
        this.render();
      },
    );
  }

  /** Connect a dragged link to its drop target; an input that was in use passes its link on. */
  private dropLink(tree: NodeTreeData, d: LinkDrag, t: SocketPos & { node: string }): boolean {
    const ctx = ctxOf(app.doc, tree);
    if (!d.isOutput) {
      let ok = false;
      for (const end of d.ends) ok = !!connect(ctx, t.node, t.socket.identifier, end.node, end.socket) || ok;
      return ok;
    }
    const end = d.ends[0];
    const tid = t.socket.identifier;
    const displaced = t.socket.multiInput ? undefined : tree.links.find((l) => l.to_node === t.node && l.to_socket === tid && !(l.from_node === end.node && l.from_socket === end.socket));
    const link = connect(ctx, end.node, end.socket, t.node, tid);
    if (!link) return false;
    if (!displaced) return true;
    const back = d.origin;
    if (d.swap && back && !(back.node === t.node && back.socket === tid)) {
      // Alt: the link that was there moves to where the dragged link came from
      connect(ctx, displaced.from_node, displaced.from_socket, back.node, back.socket);
      return true;
    }
    if (d.swap) return true;
    // the displaced link moves on to the next free input of the same type, if there is one
    const node = nodeById(tree, t.node);
    if (!node) return true;
    const ins = nodeSockets(node, ctx).inputs;
    const i = ins.findIndex((s) => s.identifier === tid);
    const order = [...ins.slice(i + 1), ...ins.slice(0, Math.max(0, i))];
    const free = order.find((s) => s.type === t.socket.type && !tree.links.some((l) => l.to_node === t.node && l.to_socket === s.identifier));
    if (free) connect(ctx, displaced.from_node, displaced.from_socket, t.node, free.identifier);
    return true;
  }

  /** Socket under the pointer (or the best socket of the node under it) for a dragged link. */
  private dropTarget(clientX: number, clientY: number, d: LinkDrag): (SocketPos & { node: string }) | null {
    const s = this.hitSocket(clientX, clientY, !d.isOutput);
    const own = new Set(d.ends.map((x) => x.node));
    const ok = (t: SocketPos & { node: string }) =>
      !own.has(t.node) && d.ends.every((end) => t.socket.type === 'CUSTOM' || end.type === 'CUSTOM' || (d.isOutput ? canConvert(end.type, t.socket.type) : canConvert(t.socket.type, end.type)));
    if (s && ok(s)) return s;
    const n = this.hitNode(clientX, clientY, false);
    if (!n || own.has(n.id)) return null;
    const type = d.ends[0].type;
    const l = this.layouts.get(n.id);
    if (!l) return null;
    const cands = [...l.sockets.values()].filter((p) => p.isOutput !== d.isOutput && !p.collapsed).map((p) => ({ ...p, node: n.id }));
    const tree = this.tree()!;
    const free = cands.filter((p) => p.isOutput || !tree.links.some((x) => x.to_node === n.id && x.to_socket === p.socket.identifier));
    return free.find((p) => p.socket.type === type && ok(p)) ?? free.find(ok) ?? cands.find((p) => p.socket.type === type && ok(p)) ?? null;
  }

  /** Dropping a new link on empty space: search for a node to connect (link drag search). */
  private linkDragSearch(d: LinkDrag, clientX: number, clientY: number) {
    const tree = this.tree();
    if (!tree) return;
    const entries = (): SearchEntry[] => {
      const out: SearchEntry[] = [];
      const seen = new Set<string>();
      const walk = (c: MenuCategory) => {
        for (const it of c.items) {
          if (it === 'SEPARATOR') continue;
          if (!('idname' in it)) {
            walk(it);
            continue;
          }
          if (this.provider.menuPoll && !this.provider.menuPoll(it.idname, this)) continue;
          const key = `${it.idname}|${JSON.stringify(it.settings ?? {})}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const def = getNodeType(it.idname);
          const op = !it.settings ? def?.props.find((p) => p.id === 'operation' && p.items) : undefined;
          const variants: [string, Record<string, unknown>][] = [[it.label ?? def?.label ?? it.idname, it.settings ?? {}]];
          if (op) for (const [v, l] of op.items!) variants.push([`${def!.label} ▸ ${l}`, { operation: v }]);
          for (const [vlabel, settings] of variants) {
            const probe = makeNode(tree, it.idname, [0, 0], settings as Record<string, never>);
            const { inputs, outputs } = nodeSockets(probe, {
              doc: app.doc,
              tree,
            });
            const list = d.isOutput ? inputs : outputs;
            const type = d.ends[0].type;
            for (const s of list) {
              if (s.type === 'CUSTOM') continue;
              if (!(d.isOutput ? canConvert(type, s.type) : canConvert(s.type, type))) continue;
              out.push({
                label: `${vlabel} ▸ ${s.label}`,
                run: () => this.addConnected(it.idname, settings, s.identifier, d, clientX, clientY),
              });
            }
          }
        }
      };
      for (const c of nodeMenu(this.treeType())) walk(c);
      return out;
    };
    openSearch(entries, clientX - 150, clientY - 20, 'Search for a node to connect…');
  }

  private addConnected(idname: string, settings: Record<string, unknown>, socket: string, d: LinkDrag, clientX: number, clientY: number) {
    const tree = this.tree();
    if (!tree) return;
    const [x, y] = this.toNode(clientX, clientY);
    const n = makeNode(tree, idname, [0, 0], settings as Record<string, never>);
    tree.nodes.push(n);
    const l = layoutTree(app.doc, tree).get(n.id)!;
    const sp = l.sockets.get(sockKey(!d.isOutput, socket));
    const dx = sp ? sp.x - l.x : 0,
      dy = sp ? sp.y - l.y : 0;
    n.location = [x - dx, -(y - dy)];
    for (const o of tree.nodes) o.select = false;
    n.select = true;
    tree.active_node = n.id;
    const ctx = ctxOf(app.doc, tree);
    const end = d.ends[0];
    if (d.isOutput) connect(ctx, end.node, end.socket, n.id, socket);
    else connect(ctx, n.id, socket, end.node, end.socket);
    app.pushUndo(`Add ${getNodeType(n.type)?.label ?? idname}`);
    app.changed('doc');
  }

  // -------------------------------------------------------------------------
  // grab (G / tweak)

  /**
   * Interactive transform of nodes: move (G / drag), rotate (R) or scale (S) around the
   * selection centre. Moving a single unlinked node over a link inserts it there.
   */
  startGrab(ids: string[], mode: 'key' | 'tweak', label = 'Move', ev?: PointerEvent, from?: { x: number; y: number }, opts: { kind?: 'MOVE' | 'ROTATE' | 'SCALE'; onCancel?: () => void } = {}) {
    const tree = this.tree();
    if (!tree || !ids.length) return;
    const kind = opts.kind ?? 'MOVE';
    // moving a frame moves its children
    const all = new Set(ids);
    const addChildren = (fid: string) => {
      for (const c of frameChildren(tree, fid)) if (!all.has(c.id)) (all.add(c.id), addChildren(c.id));
    };
    for (const id of ids) if (isFrame(nodeById(tree, id))) addChildren(id);
    const nodes = tree.nodes.filter((n) => all.has(n.id));
    const orig = new Map(nodes.map((n) => [n.id, [...n.location] as [number, number]]));
    // rotate / scale act on node centres (node space, y down); frames that fit their children follow them
    const sizes = new Map(nodes.map((n) => [n.id, this.layouts.get(n.id)]));
    const pivotNodes = nodes.filter((n) => !(isFrame(n) && frameChildren(tree, n.id).length && propValue(n, 'shrink') !== false));
    const centre = (n: NodeData): [number, number] => {
      const l = sizes.get(n.id);
      const o = orig.get(n.id)!;
      return [o[0] + (l?.w ?? 0) / 2, -o[1] + (l && l.kind !== 'REROUTE' ? l.h / 2 : 0)];
    };
    const pc = pivotNodes.map(centre);
    const pivot: [number, number] = pc.length ? [pc.reduce((s, p) => s + p[0], 0) / pc.length, pc.reduce((s, p) => s + p[1], 0) / pc.length] : [0, 0];
    const p0 = ev ? [ev.clientX, ev.clientY] : from ? [from.x, from.y] : [app.pointer.x, app.pointer.y];
    const [sx, sy] = this.toNode(p0[0], p0[1]);
    const single = kind === 'MOVE' && nodes.length === 1 && !isFrame(nodes[0]) && !tree.links.some((l) => l.from_node === nodes[0].id || l.to_node === nodes[0].id) ? nodes[0] : null;
    let lastClient = p0;
    let snapOn = false;
    let info = '';
    /** X / Y keys constrain a move to one axis */
    let axis: 'X' | 'Y' | null = null;
    const apply = (clientX: number, clientY: number, snap: boolean) => {
      lastClient = [clientX, clientY];
      snapOn = snap;
      const [x, y] = this.toNode(clientX, clientY);
      if (kind === 'MOVE') {
        let dx = x - sx,
          dy = y - sy;
        if (snap) {
          dx = Math.round(dx / 20) * 20;
          dy = Math.round(dy / 20) * 20;
        }
        if (axis === 'X') dy = 0;
        else if (axis === 'Y') dx = 0;
        for (const n of nodes) {
          const o = orig.get(n.id)!;
          n.location = [o[0] + dx, o[1] - dy];
        }
        info = `D: ${Math.round(dx)}  ${Math.round(-dy)}${axis ? ` along ${axis}` : ''}`;
      } else {
        let a = 0,
          f = 1;
        if (kind === 'ROTATE') {
          a = Math.atan2(y - pivot[1], x - pivot[0]) - Math.atan2(sy - pivot[1], sx - pivot[0]);
          if (snap) a = (Math.round((a * 180) / Math.PI / 5) * 5 * Math.PI) / 180;
          info = `Rot: ${Math.round((-a * 180) / Math.PI)}°`;
        } else {
          const d0 = Math.hypot(sx - pivot[0], sy - pivot[1]) || 1;
          f = Math.hypot(x - pivot[0], y - pivot[1]) / d0;
          if (snap) f = Math.round(f * 10) / 10;
          info = `Scale: ${f.toFixed(3)}`;
        }
        const c = Math.cos(a),
          s = Math.sin(a);
        for (const n of nodes) {
          const [cx, cy] = centre(n);
          const rx = cx - pivot[0],
            ry = cy - pivot[1];
          const nx = pivot[0] + (rx * c - ry * s) * f,
            ny = pivot[1] + (rx * s + ry * c) * f;
          const o = orig.get(n.id)!;
          n.location = [o[0] + nx - cx, o[1] - (ny - cy)];
        }
      }
      this.insertTarget = single ? this.linkAt(clientX, clientY, 12) : null;
      this.refreshPositions();
      if (kind === 'MOVE') this.markAttachTarget(this.attachTargets(tree, nodes, all));
    };
    const pan = this.edgePanner(() => apply(lastClient[0], lastClient[1], snapOn));
    const self = this;
    app.startModal({
      label,
      cursor: kind === 'MOVE' ? 'move' : 'crosshair',
      onPointerMove(e) {
        if (kind === 'MOVE') pan.update(e.clientX, e.clientY);
        apply(e.clientX, e.clientY, self.snap !== (e.ctrlKey || e.metaKey));
      },
      onPointerDown(e) {
        if (e.button === 0) return 'FINISHED';
        if (e.button === 2) return 'CANCELLED';
      },
      onPointerUp(e) {
        if (mode === 'tweak' && e.button === 0) return 'FINISHED';
      },
      onKey(e) {
        if (e.key === 'Control' || e.key === 'Meta') {
          apply(lastClient[0], lastClient[1], self.snap !== (e.type === 'keydown'));
          return;
        }
        if (e.type !== 'keydown') return;
        if (e.key === 'Escape') return 'CANCELLED';
        if (e.key === 'Enter' || e.key === ' ') return 'FINISHED';
        if (kind === 'MOVE' && (e.code === 'KeyX' || e.code === 'KeyY')) {
          const a = e.code === 'KeyX' ? 'X' : 'Y';
          axis = axis === a ? null : a;
          self.axisGuide = axis ? { axis, x: sx, y: sy } : null;
          apply(lastClient[0], lastClient[1], snapOn);
        }
      },
      cancel() {
        pan.stop();
        self.markAttachTarget(new Map());
        self.axisGuide = null;
        for (const n of nodes) n.location = orig.get(n.id)!;
        self.insertTarget = null;
        opts.onCancel?.();
        self.render();
      },
      finish() {
        pan.stop();
        self.axisGuide = null;
        if (self.insertTarget && single) {
          const ctx = ctxOf(app.doc, tree);
          if (insertOnLink(ctx, single.id, self.insertTarget) && nodeEditorSettings.insertOffset) insertOffset(tree, single, (n) => self.layouts.get(n.id)?.w ?? n.width ?? 140, nodeEditorSettings.insertMargin);
        }
        self.insertTarget = null;
        self.markAttachTarget(new Map());
        if (kind !== 'MOVE') return;
        // dropping nodes on a frame attaches them
        for (const [nid, fid] of self.attachTargets(tree, nodes, all)) nodeById(tree, nid)!.parent = fid;
      },
      header: () =>
        `${info}   ${kind === 'MOVE' ? 'Move' : kind === 'ROTATE' ? 'Rotate' : 'Scale'} nodes: LMB/Enter confirm, RMB/Esc cancel, Ctrl ${self.snap ? 'free' : 'snap'}${kind === 'MOVE' ? ', X/Y axis' : ''}`,
    });
  }

  /** Frames that moved, unparented nodes would be attached to when dropped (node id → frame id). */
  attachTargets(tree: NodeTreeData, nodes: NodeData[], moving: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of nodes) {
      if (n.parent || isFrame(n)) continue;
      const l = this.layouts.get(n.id);
      if (!l) continue;
      for (const f of tree.nodes) {
        if (!isFrame(f) || moving.has(f.id)) continue;
        const fl = this.layouts.get(f.id);
        if (fl && l.x >= fl.x && l.y >= fl.y && l.x + l.w <= fl.x + fl.w && l.y + l.h <= fl.y + fl.h) out.set(n.id, f.id);
      }
    }
    return out;
  }

  /** Highlight the frames that dropped nodes will join. */
  markAttachTarget(targets: Map<string, string>) {
    const ids = new Set(targets.values());
    for (const el of this.world.querySelectorAll<HTMLElement>('.nd-frame')) el.classList.toggle('attach-target', ids.has(el.dataset.node ?? ''));
  }

  // -------------------------------------------------------------------------

  onKey(e: KeyboardEvent): boolean {
    void e;
    return false;
  }

  serialize() {
    return {
      shaderType: this.shaderType,
      sidebar: this.showSidebar,
      toolbar: this.showToolbar,
      snap: this.snap,
      showOverlays: this.showOverlays,
      overlays: this.overlays,
      tool: this.tool,
      selectMode: this.selectMode,
      views: [...this.views.entries()].slice(-32),
      path: this.path,
    };
  }

  dispose() {
    this.resizeObs.disconnect();
    this.unsubPreview();
  }

  /** The material whose root tree is shown (node previews are rendered for it). */
  previewMaterial(): MaterialData | null {
    if (this.providerId !== 'SHADER' || this.shaderType !== 'OBJECT' || this.path.length) return null;
    const key = this.root()?.key ?? '';
    return key.startsWith('ma:') ? (app.doc.materials[key.slice(3)] ?? null) : null;
  }
}

// ---------------------------------------------------------------------------
// helpers

/** Node editor owning an element (drop targets find their editor without a hovered area). */
export const editorOfElement = new WeakMap<Element, NodeEditor>();

function lighten(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(x + (255 - x) * k));
  return `rgb(${c.join(',')})`;
}
function mute(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(x * 0.8 + 0x60 * 0.2));
  return `rgb(${c.join(',')})`;
}

function groupNodeType(t: TreeType) {
  return groupIdnameFor(t);
}
function compatibleGroupsFor(t: TreeType, exclude?: string) {
  return compatibleGroups(app.doc, t, exclude);
}

/** Name of the socket that feeds a reroute (following chains of reroutes). */
function rerouteSource(tree: NodeTreeData, n: NodeData, layouts: Map<string, NodeLayout>): string | undefined {
  let cur: NodeData | undefined = n;
  for (let i = 0; i < 64 && cur; i++) {
    const l = tree.links.find((x) => x.to_node === cur!.id);
    if (!l) return undefined;
    const from = nodeById(tree, l.from_node);
    if (!from) return undefined;
    if (getNodeType(from.type)?.layout !== 'REROUTE') return layouts.get(from.id)?.sockets.get(sockKey(true, l.from_socket))?.socket.label;
    if (from.label) return from.label;
    cur = from;
  }
  return undefined;
}
