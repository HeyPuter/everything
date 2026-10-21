// Zones in the Geometry Node Editor: tinted frames joining zone inputs and outputs (with the nodes
// between them), item lists in the sidebar, item sockets created by linking to the empty "extend"
// socket, and re-pairing of zone nodes after duplication or paste.
import { h, type Child } from '../../ui/h';
import { app, onAppReady } from '../../app/app';
import { uid } from '../../data/defaults';
import type { NodeData, NodeTreeData } from '../../data/types';
import { providers } from '../../nodes/editor/context';
import type { NodeEditor } from '../../nodes/editor/editor';
import { getNodeType, findSocket } from '../../nodes/registry';
import { ctxOf, nodeById } from '../../nodes/tree';
import type { NodeDrawContext, SocketType } from '../../nodes/types';
import { uiList } from '../../editors/properties/uilist';
import { splitRow } from '../../ui/props';
import { enumMenu } from '../../ui/widgets';
import { ITEM_TYPES, FIELD_ITEM_TYPES, EXTEND, pairedOutput, readItems, uniqueItemName, writeItems, type ZoneItem } from './items';
import { accepts, addItem, removeItem } from './itemops';
import { ZONES, BAKE, zoneOfType, type ItemList, type ZoneKind } from './kinds';
import { zoneDrawMembers } from './eval';
import { simCaches } from './simulation';
import { bakes } from './bake';

// ---------------------------------------------------------------------------
// Item editing (shared by the sidebar and link resolution)

/** Node holding a list's items: the zone output (or the Bake node itself). */
function holderOf(tree: NodeTreeData, n: NodeData): NodeData | undefined {
  const z = zoneOfType(n.type);
  if (!z) return n.type === BAKE ? n : undefined;
  return n.type === z.input ? pairedOutput(tree, n) : n;
}

const BAKE_LIST: ItemList = {
  key: 'bake_items',
  prefix: 'Item_',
  label: 'Bake Items',
  extend: [],
};

function listsOf(n: NodeData): ItemList[] {
  if (n.type === BAKE) return [BAKE_LIST];
  return zoneOfType(n.type)?.lists ?? [];
}

// ---------------------------------------------------------------------------
// Links to "extend" sockets become new items

function extendList(n: NodeData, socket: string): ItemList | undefined {
  if (n.type === BAKE) return socket === EXTEND ? BAKE_LIST : undefined;
  const z = zoneOfType(n.type);
  if (!z) return undefined;
  const role = n.type === z.input ? 'input' : 'output';
  return z.lists.find((l) => l.extend.some((e) => e.node === role && e.socket === socket));
}

function resolveExtendLinks(tree: NodeTreeData): boolean {
  let any = false;
  for (const l of [...tree.links]) {
    const toN = nodeById(tree, l.to_node),
      fromN = nodeById(tree, l.from_node);
    if (!toN || !fromN) continue;
    const toList = extendList(toN, l.to_socket),
      fromList = extendList(fromN, l.from_socket);
    if (!toList && !fromList) continue;
    const zoneNode = toList ? toN : fromN;
    const list = (toList ?? fromList)!;
    const other = toList ? fromN : toN;
    const ctx = ctxOf(app.doc, tree);
    const s = findSocket(other, toList ? l.from_socket : l.to_socket, !!toList, ctx);
    tree.links = tree.links.filter((x) => x !== l);
    any = true;
    const holder = holderOf(tree, zoneNode);
    if (!s || !holder || s.type === 'CUSTOM' || !accepts(list, s.type)) continue;
    const it = addItem(holder, list, s.type, s.name);
    const sid = `${list.prefix}${it.id}`;
    if (toList) tree.links.push({ ...l, id: uid('link'), to_socket: sid });
    else tree.links.push({ ...l, id: uid('link'), from_socket: sid });
  }
  return any;
}

// ---------------------------------------------------------------------------
// Pairing repair (duplicated or pasted zones point at the original output)

function reachable(tree: NodeTreeData, from: string, to: string): boolean {
  const seen = new Set<string>();
  const st = [from];
  while (st.length) {
    const id = st.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of tree.links) if (l.from_node === id) st.push(l.to_node);
  }
  return false;
}

function repairPairs(tree: NodeTreeData): boolean {
  let any = false;
  for (const z of ZONES) {
    const outs = tree.nodes.filter((n) => n.type === z.output);
    const ins = tree.nodes.filter((n) => n.type === z.input);
    if (!ins.length) continue;
    const byOut = new Map<string, NodeData[]>();
    const orphans: NodeData[] = [];
    for (const i of ins) {
      const o = typeof i.props.paired_output === 'string' ? outs.find((x) => x.id === i.props.paired_output) : undefined;
      if (!o) {
        if (i.props.paired_output) orphans.push(i);
        continue;
      }
      (byOut.get(o.id) ?? byOut.set(o.id, []).get(o.id)!).push(i);
    }
    const dist = (a: NodeData, b: NodeData) => Math.hypot(a.location[0] - b.location[0], a.location[1] - b.location[1]);
    for (const [oid, list] of byOut) {
      if (list.length < 2) continue;
      const o = outs.find((x) => x.id === oid)!;
      // keep the input whose links lead to this output (else the nearest)
      list.sort((a, b) => Number(reachable(tree, b.id, oid)) - Number(reachable(tree, a.id, oid)) || dist(a, o) - dist(b, o));
      orphans.push(...list.slice(1));
    }
    if (!orphans.length) continue;
    const taken = new Set(ins.map((i) => i.props.paired_output).filter((x) => !orphans.some((o) => o.props.paired_output === x)) as string[]);
    for (const i of orphans) {
      const free = outs.filter((o) => !taken.has(o.id));
      if (!free.length) {
        i.props.paired_output = null;
        any = true;
        continue;
      }
      free.sort((a, b) => Number(reachable(tree, i.id, b.id)) - Number(reachable(tree, i.id, a.id)) || dist(i, a) - dist(i, b));
      i.props.paired_output = free[0].id;
      taken.add(free[0].id);
      any = true;
    }
  }
  return any;
}

function geometryTrees(): NodeTreeData[] {
  return Object.values(app.doc.node_groups)
    .map((g) => g.tree)
    .filter((t) => t.type === 'GEOMETRY');
}

/** Drop simulation caches and bakes of objects or modifiers that no longer exist. */
function pruneZoneCaches() {
  if (!simCaches.size && !bakes.size) return;
  const alive = (o: string, m: string) => !!app.doc.objects[o]?.modifiers.some((x) => x.id === m);
  for (const [k, c] of simCaches) if (!alive(c.objectId, c.modifierId)) simCaches.delete(k);
  for (const [k, b] of bakes) if (!alive(b.objectId, b.modifierId)) bakes.delete(k);
}

let installed = false;
export function installZoneResolver() {
  if (installed || !app) return;
  installed = true;
  app.subscribe((kinds) => {
    if (!kinds.has('doc')) return;
    pruneZoneCaches();
    let any = false;
    for (const t of geometryTrees()) {
      if (!t.nodes.some((n) => zoneOfType(n.type) || n.type === BAKE)) continue;
      if (resolveExtendLinks(t)) any = true;
      if (repairPairs(t)) any = true;
    }
    if (any) app.changed('doc');
  });
}

// ---------------------------------------------------------------------------
// Zone frames behind the nodes

interface ZoneRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: ZoneKind;
  /** padded corners of the member nodes (node space) */
  corners: [number, number][];
}

const ZONE_PAD = 14;

export function zoneRects(ed: NodeEditor, tree: NodeTreeData): ZoneRect[] {
  const out: ZoneRect[] = [];
  for (const n of tree.nodes) {
    const z = ZONES.find((k) => k.input === n.type);
    if (!z) continue;
    const o = pairedOutput(tree, n);
    if (!o) continue;
    const ids = [n.id, o.id, ...zoneDrawMembers(tree, n.id, o.id)];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const corners: [number, number][] = [];
    for (const id of ids) {
      const l = ed.layouts.get(id);
      if (!l) continue;
      x0 = Math.min(x0, l.x);
      y0 = Math.min(y0, l.y);
      x1 = Math.max(x1, l.x + l.w);
      y1 = Math.max(y1, l.y + l.h);
      const p = ZONE_PAD;
      corners.push([l.x - p, l.y - p], [l.x + l.w + p, l.y - p], [l.x + l.w + p, l.y + l.h + p], [l.x - p, l.y + l.h + p]);
    }
    if (x0 === Infinity) continue;
    out.push({ x0, y0, x1, y1, kind: z, corners });
  }
  // nested zones are drawn over the zones enclosing them
  out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return out;
}

/** Convex hull of points (counter-clockwise in screen space, monotone chain). */
export function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Closed polygon path with rounded corners. */
function roundedPolygon(g: CanvasRenderingContext2D, pts: [number, number][], r: number) {
  const n = pts.length;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n],
      b = pts[i],
      c = pts[(i + 1) % n];
    const m0: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (i === 0) g.moveTo(m0[0], m0[1]);
    g.arcTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2, r);
  }
  g.closePath();
}

function drawZones(ed: NodeEditor, g: CanvasRenderingContext2D) {
  const tree = ed.tree();
  if (!tree || !tree.nodes.some((n) => ZONES.some((z) => z.input === n.type))) return;
  const zoom = ed.view().zoom;
  for (const r of zoneRects(ed, tree)) {
    const hull = convexHull(r.corners).map(([x, y]) => ed.toScreen(x, y) as [number, number]);
    const [cr, cg, cb] = r.kind.color;
    roundedPolygon(g, hull, Math.min(12, 10 * zoom));
    g.fillStyle = `rgba(${cr},${cg},${cb},0.22)`;
    g.fill();
    g.strokeStyle = `rgba(${cr},${cg},${cb},0.4)`;
    g.lineWidth = 1;
    g.stroke();
  }
}

function installZoneDrawing() {
  const p = providers.get('GEOMETRY');
  if (!p || (p as { zonesInstalled?: boolean }).zonesInstalled) return;
  (p as { zonesInstalled?: boolean }).zonesInstalled = true;
  const prev = p.drawBackdrop;
  p.drawBackdrop = (ed, g, W, H) => {
    prev?.(ed, g, W, H);
    drawZones(ed as NodeEditor, g);
  };
}

// ---------------------------------------------------------------------------
// Sidebar: item lists of the zone (shown for both zone nodes) and of Bake nodes

const DOMAIN_ITEMS = [
  { value: 'POINT', label: 'Point' },
  { value: 'EDGE', label: 'Edge' },
  { value: 'FACE', label: 'Face' },
  { value: 'CORNER', label: 'Face Corner' },
  { value: 'CURVE', label: 'Spline' },
  { value: 'INSTANCE', label: 'Instance' },
];

const activeKey = (list: ItemList) =>
  list.key === 'input_items'
    ? 'active_input_index'
    : list.key === 'output_items'
      ? 'active_output_index'
      : list.key === 'main_items'
        ? 'active_main_index'
        : list.key === 'generation_items'
          ? 'active_generation_index'
          : 'active_index';

function itemListUI(ctx: NodeDrawContext, holder: NodeData, list: ItemList): Child {
  const items = readItems(holder, list.key);
  const ak = activeKey(list);
  const active = Math.max(0, Math.min(items.length - 1, Number(holder.props[ak] ?? 0)));
  const set = (label: string, next: ZoneItem[]) => {
    writeItems(holder, list.key, next);
    ctx.changed(label, true);
  };
  const move = (d: number) => {
    const j = active + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[active], next[j]] = [next[j], next[active]];
    holder.props[ak] = j;
    set('Move Item', next);
  };
  const types = ITEM_TYPES.filter(([t]) => accepts(list, t)).map(([value, label]) => ({ value, label }));
  const cur = items[active];
  return h(
    'div',
    { class: 'gn-zone-items' },
    h('div', { class: 'sub-label' }, list.label),
    uiList(
      `${ctx.key}:${list.key}`,
      items.map((it) => ({
        key: String(it.id),
        label: it.name,
        icon: undefined,
      })),
      active,
      (i) => {
        holder.props[ak] = i;
        ctx.changed('Select Item', false);
        app.changed('ui');
      },
      {
        add: () => {
          addItem(holder, list, list.key === 'generation_items' && !items.length ? 'GEOMETRY' : 'FLOAT', '');
          holder.props[ak] = readItems(holder, list.key).length - 1;
          ctx.changed('Add Item', true);
        },
        remove: cur
          ? () => {
              removeItem(ctx.tree, holder, list, cur.id);
              holder.props[ak] = Math.max(0, active - 1);
              ctx.changed('Remove Item', true);
            }
          : undefined,
        rename: (i, name) =>
          set(
            'Rename Item',
            items.map((x, k) =>
              k === i && name
                ? {
                    ...x,
                    name: uniqueItemName(
                      items.filter((y) => y !== x),
                      name,
                    ),
                  }
                : x,
            ),
          ),
        up: () => move(-1),
        down: () => move(1),
        rows: 3,
      },
    ),
    cur
      ? [
          splitRow(
            'Socket Type',
            enumMenu(`${ctx.key}:${list.key}:type:${cur.id}`, types, cur.socket_type, (v) =>
              set(
                'Change Item Type',
                items.map((x) => (x === cur ? { ...x, socket_type: v as SocketType } : x)),
              ),
            ),
          ),
          (list.key === 'state_items' || list.key === 'bake_items') && FIELD_ITEM_TYPES.has(cur.socket_type)
            ? splitRow(
                'Attribute Domain',
                enumMenu(`${ctx.key}:${list.key}:dom:${cur.id}`, DOMAIN_ITEMS, cur.attribute_domain ?? 'POINT', (v) =>
                  set(
                    'Change Item Domain',
                    items.map((x) => (x === cur ? { ...x, attribute_domain: v } : x)),
                  ),
                ),
              )
            : null,
          list.key === 'generation_items' && FIELD_ITEM_TYPES.has(cur.socket_type)
            ? splitRow(
                'Domain',
                enumMenu(`${ctx.key}:${list.key}:gdom:${cur.id}`, DOMAIN_ITEMS, cur.domain ?? 'POINT', (v) =>
                  set(
                    'Change Item Domain',
                    items.map((x) => (x === cur ? { ...x, domain: v } : x)),
                  ),
                ),
              )
            : null,
        ]
      : null,
  );
}

function zoneOptions(ctx: NodeDrawContext): Child {
  const holder = holderOf(ctx.tree, ctx.node);
  if (!holder) return h('div', { class: 'prop-note' }, 'This zone node is not paired with an output node');
  return h(
    'div',
    { class: 'gn-zone-options' },
    listsOf(ctx.node).map((l) => itemListUI(ctx, holder, l)),
  );
}

for (const z of ZONES)
  for (const id of [z.input, z.output]) {
    const d = getNodeType(id);
    if (d) d.drawOptions = zoneOptions;
  }
{
  const d = getNodeType(BAKE);
  if (d) {
    const prev = d.drawOptions;
    d.drawOptions = (ctx) => h('div', {}, prev?.(ctx) ?? null, zoneOptions(ctx));
  }
}

onAppReady(() => {
  installZoneResolver();
  installZoneDrawing();
});

// both nodes of a zone show the zone's name in their header
for (const z of ZONES)
  for (const id of [z.input, z.output]) {
    const d = getNodeType(id);
    if (d && !d.dynamicLabel) d.dynamicLabel = () => z.label;
  }
