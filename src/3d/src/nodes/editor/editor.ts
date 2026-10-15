// Node editor: canvas (grid + links) under a transformed DOM layer of nodes, with a canvas
// overlay for interactive feedback (dragged links, box select, knife). Generic over tree kinds
// through providers (context.ts); the Shader Editor provider lives in shaderprovider.ts.
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, type ChangeKind } from '../../app/app';
import type { Area, Editor } from '../../ui/screen';
import { openMenu, openSearch, type MenuItem, type SearchEntry } from '../../ui/menu';
import type { NodeData, NodeTreeData } from '../../data/types';
import { getNodeType, nodeSockets, nodeMenu, canConvert, SOCKET_COLORS, nodeLabel } from '../registry';
import { connect, ctxOf, linkStatus, nodeById, insertOnLink, removeLinks, makeNode, internalLinks, frameChildren, compatibleGroups } from '../tree';
import { layoutTree, linkCurve, sockKey, distToCurve, curveCrossesPolyline, type NodeLayout, type SocketPos, HEADER } from './layout';
import { renderNode } from './nodeui';
import { providers, type NodeEditorProvider, type TreeRoot } from './context';
import type { MenuCategory, MenuEntry, SocketType, TreeType } from '../types';
import { drawSidebar } from './sidebar';
import { groupIdnameFor } from '../common';
import { viewMenu, selectMenu, nodeMenuItems, contextMenuItems } from './menus';

export interface View {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.08,
  MAX_ZOOM = 4;

interface LinkDrag {
  /** fixed end */
  node: string;
  socket: string;
  isOutput: boolean;
  type: SocketType;
  x: number;
  y: number;
  /** pointer (node space) */
  px: number;
  py: number;
  /** link removed when picking it up from an input */
  detached?: boolean;
  target?: SocketPos & { node: string };
}

export class NodeEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Node Editor', 'Node Generic'];
  shaderType: 'OBJECT' | 'WORLD' = 'OBJECT';
  /** group editing stack (node group ids and the group node opened) */
  path: { group: string; node: string }[] = [];
  views = new Map<string, View>();
  showSidebar = false;
  sidebarTab = 'Node';
  layouts = new Map<string, NodeLayout>();
  private back: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private world: HTMLDivElement;
  private sideEl: HTMLDivElement;
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
  insertTarget: string | null = null;
  private lastKey = '';
  private resizeObs: ResizeObserver;

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
    };
    if (st.shaderType) this.shaderType = st.shaderType;
    if (st.sidebar) this.showSidebar = true;
    if (st.views) this.views = new Map(st.views);
    if (Array.isArray(st.path)) this.path = st.path;
    this.el = document.createElement('div');
    this.el.className = 'nd-editor';
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
    this.el.append(this.back, this.world, this.over, this.crumbsEl, this.emptyEl, this.sideEl);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), {
      passive: false,
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('dblclick', (e) => e.preventDefault());
    this.resizeObs = new ResizeObserver(() => this.render());
    this.resizeObs.observe(this.el);
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
      menu('Add', () => this.addMenuItems()),
      menu('Node', () => nodeMenuItems()),
      h('div', { class: 'hdr-spacer' }),
      p.headerRight?.(this) ?? null,
      h('div', { class: 'hdr-spacer' }),
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

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    app.changed('ui');
  }

  // -------------------------------------------------------------------------
  // Add menu

  addMenuItems(at?: { x: number; y: number }): MenuItem[] {
    const add = (e: MenuEntry): MenuItem => ({
      label: e.label ?? getNodeType(e.idname)?.label ?? e.idname,
      action: () => this.addNodeInteractive(e.idname, e.settings ?? {}, at),
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
    const cats = nodeMenu(this.treeType());
    const items: MenuItem[] = [{ label: 'Search...', icon: 'search', action: () => this.addSearch(at) }, { separator: true }];
    for (const c of cats) {
      const sub = conv(c);
      if (sub.length) items.push({ label: c.label, submenu: () => sub });
    }
    items.push({ separator: true });
    items.push({ label: 'Group', submenu: () => this.groupMenu(at) });
    items.push({
      label: 'Layout',
      submenu: () => [add({ idname: 'NodeFrame' }), add({ idname: 'NodeReroute' })],
    });
    return items;
  }

  private groupMenu(at?: { x: number; y: number }): MenuItem[] {
    const tree = this.tree();
    if (!tree) return [];
    const idname = groupNodeType(this.treeType());
    const current = this.path.length ? this.path[this.path.length - 1].group : undefined;
    const groups = compatibleGroupsFor(this.treeType(), current);
    const items: MenuItem[] = [];
    if (this.path.length) {
      items.push({
        label: 'Group Input',
        action: () => this.addNodeInteractive('NodeGroupInput', {}, at),
      });
      items.push({
        label: 'Group Output',
        action: () => this.addNodeInteractive('NodeGroupOutput', {}, at),
      });
      if (groups.length) items.push({ separator: true });
    }
    for (const g of groups)
      items.push({
        label: g.name,
        icon: 'node_tree',
        action: () => this.addNodeInteractive(idname, { node_tree: g.id }, at),
      });
    if (!items.length)
      items.push({
        label: 'No node groups (Ctrl G to make one)',
        disabled: true,
      });
    return items;
  }

  /** Search entries for adding nodes (including operation variants). */
  addSearchEntries(at?: { x: number; y: number }): SearchEntry[] {
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
            run: () => this.addNodeInteractive(it.idname, it.settings ?? {}, at),
          });
          // operation variants (Math ▸ Add, Vector Math ▸ Cross Product, …)
          const op = def.props.find((p) => p.id === 'operation' && p.items);
          if (op && !it.settings)
            for (const [v, l] of op.items!)
              out.push({
                label: `${def.label} ▸ ${l}`,
                path,
                run: () => this.addNodeInteractive(it.idname, { operation: v }, at),
              });
        } else walk(it, path ? `${path} ▸ ${it.label}` : it.label);
      }
    };
    for (const c of nodeMenu(this.treeType())) walk(c, c.label);
    for (const g of compatibleGroupsFor(this.treeType(), this.path[this.path.length - 1]?.group))
      out.push({
        label: g.name,
        path: 'Group',
        icon: 'node_tree',
        run: () => this.addNodeInteractive(groupNodeType(this.treeType()), { node_tree: g.id }, at),
      });
    out.push({
      label: 'Frame',
      path: 'Layout',
      run: () => this.addNodeInteractive('NodeFrame', {}, at),
    });
    out.push({
      label: 'Reroute',
      path: 'Layout',
      run: () => this.addNodeInteractive('NodeReroute', {}, at),
    });
    return out;
  }

  addSearch(at?: { x: number; y: number }) {
    openSearch(() => this.addSearchEntries(at), app.pointer.x - 150, app.pointer.y - 20, 'Search nodes…');
  }

  /** Add a node under the pointer and start moving it. */
  addNodeInteractive(idname: string, settings: Record<string, unknown>, at?: { x: number; y: number }) {
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
    tree.nodes.push(n);
    tree.active_node = n.id;
    app.pushUndo(`Add ${getNodeType(n.type)?.label ?? idname}`);
    app.changed('doc');
    this.render();
    this.startGrab([n.id], 'key', 'Move', undefined, p);
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
      items.forEach(([ic, name], i) => {
        if (i) crumbs.push(h('span', { class: 'nd-crumb-sep' }, icon('right_arrow')));
        crumbs.push(h('span', { class: 'nd-crumb' }, icon(ic), name));
      });
    }
    patch(this.crumbsEl, crumbs);
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
              active: tree.active_node === n.id,
              groupName: n.label ? undefined : groupName,
              highlightSockets: this.highlightSockets(),
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
    this.drawBack(W, H);
    this.drawOver(W, H);
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
    g.fillStyle = '#1d1d1d';
    g.fillRect(0, 0, W, H);
    const v = this.view();
    // dot grid (two levels)
    let step = 20;
    while (step * v.zoom < 14) step *= 2;
    const s = step * v.zoom;
    const ox = ((v.x % s) + s) % s,
      oy = ((v.y % s) + s) % s;
    const big = step * 5 * v.zoom;
    g.fillStyle = '#2c2c2c';
    for (let x = ox; x < W; x += s) for (let y = oy; y < H; y += s) g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    if (big > 40) {
      g.fillStyle = '#353535';
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
      let color = SOCKET_COLORS[a.socket.type] ?? '#9a9a9a';
      if (!st.valid) color = '#e33b3b';
      else if (l.is_muted) color = '#c04040';
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
    g.strokeStyle = 'rgba(0,0,0,0.55)';
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
          g.strokeStyle = 'rgba(220,60,60,0.85)';
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
      const [fx, fy] = this.toScreen(d.x, d.y);
      const t = d.target;
      const [px, py] = t ? this.toScreen(t.x, t.y) : this.toScreen(d.px, d.py);
      const c = d.isOutput ? linkCurve(fx, fy, px, py) : linkCurve(px, py, fx, fy);
      this.strokeLink(g, c, SOCKET_COLORS[d.type] ?? '#ccc', Math.max(1.5, Math.min(3, 2 * v.zoom)), true, false);
    }
    if (this.box) {
      const b = this.box;
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      const x = Math.min(b.x0, b.x1),
        y = Math.min(b.y0, b.y1);
      g.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    if (this.knife && this.knife.length > 1) {
      g.strokeStyle = 'rgba(255,90,90,0.9)';
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
      y0 = Math.min(y0, l.y);
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
    if (target.closest('.nd-sidebar')) return;
    this.el.focus({ preventScroll: true });
    const tree = this.tree();
    if (e.button === 1 || (e.button === 0 && e.altKey && !tree)) return this.panDrag(e);
    if (!tree) return;
    if (e.button === 2) {
      if (e.ctrlKey) return this.knifeDrag(e);
      return this.contextClick(e);
    }
    if (e.button !== 0) return;
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
    if (sock && !(sock.collapsed && nodeById(tree, sock.node)?.hide && !e.ctrlKey)) return this.linkDragStart(e, tree, sock);
    const n = this.hitNode(e.clientX, e.clientY);
    if (n) {
      // node resize: drag near the right edge
      const l = this.layouts.get(n.id)!;
      const [x] = this.toNode(e.clientX, e.clientY);
      if (l.kind === 'NODE' && !n.hide && Math.abs(x - (l.x + l.w)) * this.view().zoom < 5) return this.resizeDrag(e, n);
      return this.nodePress(e, tree, n);
    }
    this.boxDrag(e, tree, e.shiftKey ? 'ADD' : e.ctrlKey ? 'SUB' : 'SET');
  }

  private track(e: PointerEvent, move: (ev: PointerEvent, dist: number) => void, up: (ev: PointerEvent, moved: boolean) => void) {
    const sx = e.clientX,
      sy = e.clientY;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (d > 3) moved = true;
      move(ev, d);
    };
    const u = (ev: PointerEvent) => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', u);
      up(ev, moved);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', u);
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

  private nodePress(e: PointerEvent, tree: NodeTreeData, n: NodeData) {
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
          this.startGrab(this.selectedIds(), 'tweak', 'Move', ev);
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

  private resizeDrag(e: PointerEvent, n: NodeData) {
    e.preventDefault();
    const w0 = this.layouts.get(n.id)!.w;
    const [x0] = this.toNode(e.clientX, e.clientY);
    const def = getNodeType(n.type);
    this.el.classList.add('resizing');
    this.track(
      e,
      (ev) => {
        const [x] = this.toNode(ev.clientX, ev.clientY);
        n.width = Math.round(Math.max(def?.minWidth ?? 80, Math.min(def?.maxWidth ?? 700, w0 + x - x0)));
        this.render();
      },
      (_ev, moved) => {
        this.el.classList.remove('resizing');
        if (moved) {
          app.pushUndo('Resize Node');
          app.changed('doc');
        }
      },
    );
  }

  private boxDrag(e: PointerEvent, tree: NodeTreeData, mode: 'SET' | 'ADD' | 'SUB') {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const x0 = e.clientX - r.left,
      y0 = e.clientY - r.top;
    this.track(
      e,
      (ev) => {
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
            tree.active_node = tree.active_node ?? null;
            app.changed('ui');
          }
          this.drawOver();
          return;
        }
        this.applyBox(tree, this.box);
        this.box = null;
        app.changed('ui');
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

  /** Box select started from the keyboard (B): drag with LMB. */
  startBoxSelect() {
    const tree = this.tree();
    if (!tree) return;
    this.el.classList.add('box-pending');
    const once = (e: PointerEvent) => {
      this.el.classList.remove('box-pending');
      if (e.button !== 0 || !this.el.contains(e.target as Node)) return;
      e.stopPropagation();
      this.boxDrag(e, tree, e.shiftKey ? 'SUB' : 'ADD');
    };
    this.el.addEventListener('pointerdown', once, {
      once: true,
      capture: true,
    });
  }

  private knifeDrag(e: PointerEvent) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.knife = [[e.clientX - r.left, e.clientY - r.top]];
    this.track(
      e,
      (ev) => {
        this.knife!.push([ev.clientX - r.left, ev.clientY - r.top]);
        this.drawOver();
      },
      () => {
        const line = this.knife ?? [];
        this.knife = null;
        const tree = this.tree();
        if (tree && line.length > 1) {
          const cut = new Set<string>();
          for (const l of tree.links) {
            const a = this.layouts.get(l.from_node)?.sockets.get(sockKey(true, l.from_socket));
            const b = this.layouts.get(l.to_node)?.sockets.get(sockKey(false, l.to_socket));
            if (!a || !b) continue;
            const [x1, y1] = this.toScreen(a.x, a.y),
              [x2, y2] = this.toScreen(b.x, b.y);
            if (curveCrossesPolyline(linkCurve(x1, y1, x2, y2), line)) cut.add(l.id);
          }
          if (cut.size) {
            removeLinks(tree, cut);
            app.pushUndo('Cut Links');
            app.changed('doc');
          }
        }
        this.drawOver();
      },
    );
  }

  private contextClick(e: PointerEvent) {
    const tree = this.tree()!;
    this.track(
      e,
      () => {},
      (ev, moved) => {
        if (moved) return;
        const n = this.hitNode(ev.clientX, ev.clientY);
        if (n && !n.select) {
          this.selectOnly(tree, n);
          app.changed('ui');
        }
        openMenu(contextMenuItems(this, !!n), { x: ev.clientX, y: ev.clientY }, { title: n ? 'Node' : 'Node Editor' });
      },
    );
  }

  // -------------------------------------------------------------------------
  // links

  private linkDragStart(e: PointerEvent, tree: NodeTreeData, sock: SocketPos & { node: string }) {
    e.preventDefault();
    e.stopPropagation();
    const [px, py] = this.toNode(e.clientX, e.clientY);
    let drag: LinkDrag;
    if (!sock.isOutput) {
      const existing = tree.links.filter((l) => l.to_node === sock.node && l.to_socket === sock.socket.identifier);
      if (existing.length) {
        // pick up the link from the input
        const l = existing[existing.length - 1];
        const from = this.layouts.get(l.from_node)?.sockets.get(sockKey(true, l.from_socket));
        removeLinks(tree, new Set([l.id]));
        this.render();
        drag = {
          node: l.from_node,
          socket: l.from_socket,
          isOutput: true,
          type: from?.socket.type ?? 'FLOAT',
          x: from?.x ?? px,
          y: from?.y ?? py,
          px,
          py,
          detached: true,
        };
      } else
        drag = {
          node: sock.node,
          socket: sock.socket.identifier,
          isOutput: false,
          type: sock.socket.type,
          x: sock.x,
          y: sock.y,
          px,
          py,
        };
    } else
      drag = {
        node: sock.node,
        socket: sock.socket.identifier,
        isOutput: true,
        type: sock.socket.type,
        x: sock.x,
        y: sock.y,
        px,
        py,
      };
    this.linkDrag = drag;
    this.drawOver();
    this.track(
      e,
      (ev) => {
        const [x, y] = this.toNode(ev.clientX, ev.clientY);
        drag.px = x;
        drag.py = y;
        drag.target = this.dropTarget(ev.clientX, ev.clientY, drag) ?? undefined;
        this.drawOver();
      },
      (ev, moved) => {
        this.linkDrag = null;
        const t = drag.target;
        if (t) {
          const ctx = ctxOf(app.doc, tree);
          const ok = drag.isOutput ? connect(ctx, drag.node, drag.socket, t.node, t.socket.identifier) : connect(ctx, t.node, t.socket.identifier, drag.node, drag.socket);
          if (!ok) app.report('WARNING', 'Cannot link these sockets');
          app.pushUndo('Link');
          app.changed('doc');
        } else if (drag.detached) {
          app.pushUndo('Remove Link');
          app.changed('doc');
        } else if (moved) {
          this.render();
          this.linkDragSearch(drag, ev.clientX, ev.clientY);
        } else this.render();
      },
    );
  }

  /** Socket under the pointer (or the best socket of the node under it) for a dragged link. */
  private dropTarget(clientX: number, clientY: number, d: LinkDrag): (SocketPos & { node: string }) | null {
    const s = this.hitSocket(clientX, clientY, !d.isOutput);
    const ok = (t: SocketPos & { node: string }) =>
      t.node !== d.node && (t.socket.type === 'CUSTOM' || d.type === 'CUSTOM' || (d.isOutput ? canConvert(d.type, t.socket.type) : canConvert(t.socket.type, d.type)));
    if (s && ok(s)) return s;
    const n = this.hitNode(clientX, clientY, false);
    if (!n || n.id === d.node) return null;
    const l = this.layouts.get(n.id);
    if (!l) return null;
    const cands = [...l.sockets.values()].filter((p) => p.isOutput !== d.isOutput && !p.collapsed).map((p) => ({ ...p, node: n.id }));
    const tree = this.tree()!;
    const free = cands.filter((p) => p.isOutput || !tree.links.some((x) => x.to_node === n.id && x.to_socket === p.socket.identifier));
    return free.find((p) => p.socket.type === d.type && ok(p)) ?? free.find(ok) ?? cands.find((p) => p.socket.type === d.type && ok(p)) ?? null;
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
            for (const s of list) {
              if (s.type === 'CUSTOM') continue;
              if (!(d.isOutput ? canConvert(d.type, s.type) : canConvert(s.type, d.type))) continue;
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
    if (d.isOutput) connect(ctx, d.node, d.socket, n.id, socket);
    else connect(ctx, n.id, socket, d.node, d.socket);
    app.pushUndo(`Add ${getNodeType(n.type)?.label ?? idname}`);
    app.changed('doc');
  }

  // -------------------------------------------------------------------------
  // grab (G / tweak)

  startGrab(ids: string[], mode: 'key' | 'tweak', label = 'Move', ev?: PointerEvent, from?: { x: number; y: number }) {
    const tree = this.tree();
    if (!tree || !ids.length) return;
    // moving a frame moves its children
    const all = new Set(ids);
    const addChildren = (fid: string) => {
      for (const c of frameChildren(tree, fid)) if (!all.has(c.id)) (all.add(c.id), addChildren(c.id));
    };
    for (const id of ids) if (getNodeType(nodeById(tree, id)?.type ?? '')?.layout === 'FRAME') addChildren(id);
    // children of moved frames move with them; avoid moving a child twice
    const nodes = tree.nodes.filter((n) => all.has(n.id));
    const orig = new Map(nodes.map((n) => [n.id, [...n.location] as [number, number]]));
    const p0 = ev ? [ev.clientX, ev.clientY] : from ? [from.x, from.y] : [app.pointer.x, app.pointer.y];
    const [sx, sy] = this.toNode(p0[0], p0[1]);
    const single = nodes.length === 1 && nodes[0].type !== 'NodeFrame' && !tree.links.some((l) => l.from_node === nodes[0].id || l.to_node === nodes[0].id) ? nodes[0] : null;
    let lastClient = p0;
    const apply = (clientX: number, clientY: number, snap: boolean) => {
      lastClient = [clientX, clientY];
      const [x, y] = this.toNode(clientX, clientY);
      let dx = x - sx,
        dy = y - sy;
      if (snap) {
        dx = Math.round(dx / 20) * 20;
        dy = Math.round(dy / 20) * 20;
      }
      for (const n of nodes) {
        const o = orig.get(n.id)!;
        n.location = [o[0] + dx, o[1] - dy];
      }
      this.insertTarget = single ? this.linkAt(clientX, clientY, 12) : null;
      if (this.insertTarget && single) {
        const l = tree.links.find((x) => x.id === this.insertTarget);
        if (l && (l.from_node === single.id || l.to_node === single.id)) this.insertTarget = null;
      }
      this.refreshPositions();
    };
    const self = this;
    app.startModal({
      label,
      cursor: 'move',
      onPointerMove(e) {
        apply(e.clientX, e.clientY, e.ctrlKey);
      },
      onPointerDown(e) {
        if (e.button === 0) return 'FINISHED';
        if (e.button === 2) return 'CANCELLED';
      },
      onPointerUp(e) {
        if (mode === 'tweak' && e.button === 0) return 'FINISHED';
      },
      onKey(e) {
        if (e.type !== 'keydown') return;
        if (e.key === 'Escape') return 'CANCELLED';
        if (e.key === 'Enter' || e.key === ' ') return 'FINISHED';
        if (e.key === 'Control') apply(lastClient[0], lastClient[1], true);
      },
      cancel() {
        for (const n of nodes) n.location = orig.get(n.id)!;
        self.insertTarget = null;
        self.render();
      },
      finish() {
        if (self.insertTarget && single) insertOnLink(ctxOf(app.doc, tree), single.id, self.insertTarget);
        self.insertTarget = null;
        // dropping nodes on a frame attaches them
        for (const n of nodes) {
          if (n.parent || n.type === 'NodeFrame') continue;
          const l = self.layouts.get(n.id);
          if (!l) continue;
          for (const f of tree.nodes) {
            if (f.type !== 'NodeFrame' || all.has(f.id)) continue;
            const fl = self.layouts.get(f.id);
            if (fl && l.x >= fl.x && l.y >= fl.y && l.x + l.w <= fl.x + fl.w && l.y + l.h <= fl.y + fl.h) n.parent = f.id;
          }
        }
      },
      header: () => 'Move nodes: LMB/Enter confirm, RMB/Esc cancel, Ctrl snap',
    });
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
      views: [...this.views.entries()].slice(-32),
      path: this.path,
    };
  }

  dispose() {
    this.resizeObs.disconnect();
  }
}

// ---------------------------------------------------------------------------
// helpers

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
