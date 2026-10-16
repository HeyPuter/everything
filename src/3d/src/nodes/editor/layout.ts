// Node layout in node-space units (zoom 1): rows, sizes and socket positions. Pure (no DOM), so
// the DOM renderer, the link canvas and hit-testing all agree on socket positions.
import type { DocumentData, NodeData, NodeTreeData } from '../../data/types';
import { getNodeType, nodePanels, nodeSockets, propValue } from '../registry';
import type { NodePanelDef, NodePropDef, ResolvedSocket } from '../types';

export const HEADER = 22;
export const ROW = 22;
export const PROP_ROW = 24;
export const PANEL_ROW = 20;
export const PAD_TOP = 4;
export const PAD_BOTTOM = 6;
export const REROUTE_SIZE = 16;
export const FRAME_MARGIN = 20;

export type RowKind = 'output' | 'input' | 'prop' | 'panel' | 'body';

export interface Row {
  kind: RowKind;
  y: number;
  h: number;
  socket?: ResolvedSocket;
  linked?: boolean;
  prop?: NodePropDef;
  panel?: NodePanelDef;
  open?: boolean;
  /** this input shows its value as an expanded vector (label + XYZ) */
  vector?: boolean;
}

export interface SocketPos {
  x: number;
  y: number;
  socket: ResolvedSocket;
  isOutput: boolean;
  /** hidden inside a collapsed node / panel */
  collapsed?: boolean;
}

export interface NodeLayout {
  node: NodeData;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: Row[];
  sockets: Map<string, SocketPos>;
  kind: 'NODE' | 'FRAME' | 'REROUTE';
}

export const sockKey = (isOutput: boolean, id: string) => `${isOutput ? 'out' : 'in'}:${id}`;

/** Node-space top-left of a node (y grows downward on screen). */
export function nodeOrigin(n: NodeData): [number, number] {
  return [n.location[0], -n.location[1]];
}

export function nodeWidth(n: NodeData): number {
  const def = getNodeType(n.type);
  if (def?.layout === 'REROUTE') return REROUTE_SIZE;
  const w = n.width ?? def?.width ?? 140;
  return Math.max(def?.minWidth ?? 80, Math.min(def?.maxWidth ?? 700, w));
}

function propRows(n: NodeData, p: NodePropDef): number {
  if (p.type === 'VECTOR' || p.type === 'DIRECTION') return 3;
  return 1;
}

export function visibleProps(n: NodeData, props: NodePropDef[], where: 'node' | 'sidebar' = 'node'): NodePropDef[] {
  return props.filter((p) => (where === 'node' ? p.inNode !== false : true) && (!p.visible || p.visible(n)));
}

const VALUE_TYPES = new Set(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'STRING', 'ROTATION', 'MENU']);

function inputRowHeight(s: ResolvedSocket, linked: boolean): { h: number; vector: boolean } {
  if (linked || s.hide_value || !VALUE_TYPES.has(s.type)) return { h: ROW, vector: false };
  if (s.type === 'VECTOR' || s.type === 'ROTATION') return { h: ROW * (1 + (s.dimensions ?? 3)), vector: true };
  return { h: ROW, vector: false };
}

/** Compute the layout of a node. */
export function layoutNode(doc: DocumentData, tree: NodeTreeData, n: NodeData, linkedInputs?: Set<string>): NodeLayout {
  const def = getNodeType(n.type);
  const [x, y] = nodeOrigin(n);
  const sockets = new Map<string, SocketPos>();
  if (def?.layout === 'REROUTE') {
    const s = nodeSockets(n, { doc, tree });
    const r = REROUTE_SIZE / 2;
    sockets.set(sockKey(false, 'Input'), {
      x: x,
      y: y,
      socket: s.inputs[0],
      isOutput: false,
    });
    sockets.set(sockKey(true, 'Output'), {
      x: x,
      y: y,
      socket: s.outputs[0],
      isOutput: true,
    });
    return {
      node: n,
      x: x - r,
      y: y - r,
      w: REROUTE_SIZE,
      h: REROUTE_SIZE,
      rows: [],
      sockets,
      kind: 'REROUTE',
    };
  }
  if (def?.layout === 'FRAME') return frameLayout(doc, tree, n);
  const w = nodeWidth(n);
  const { inputs, outputs } = nodeSockets(n, { doc, tree });
  const linked = linkedInputs ?? new Set(tree.links.filter((l) => l.to_node === n.id).map((l) => l.to_socket));
  const linkedOut = new Set(tree.links.filter((l) => l.from_node === n.id).map((l) => l.from_socket));
  const hidden = new Set(n.hidden_sockets ?? []);
  const showIn = inputs.filter((s) => !hidden.has(`in:${s.identifier}`) || linked.has(s.identifier));
  const showOut = outputs.filter((s) => !hidden.has(`out:${s.identifier}`) || linkedOut.has(s.identifier));
  if (n.hide) {
    // collapsed: sockets spread along the left/right edges of the header
    const place = (list: ResolvedSocket[], isOutput: boolean) => {
      const used = list.filter((s) => (isOutput ? linkedOut.has(s.identifier) : linked.has(s.identifier)));
      const shown = used.length ? used : list.slice(0, 1);
      shown.forEach((s, i) =>
        sockets.set(sockKey(isOutput, s.identifier), {
          x: x + (isOutput ? w : 0),
          y: y + HEADER / 2 + (i - (shown.length - 1) / 2) * Math.min(6, 14 / Math.max(1, shown.length)),
          socket: s,
          isOutput,
        }),
      );
      for (const s of list)
        if (!sockets.has(sockKey(isOutput, s.identifier)))
          sockets.set(sockKey(isOutput, s.identifier), {
            x: x + (isOutput ? w : 0),
            y: y + HEADER / 2,
            socket: s,
            isOutput,
            collapsed: true,
          });
    };
    place(showIn, false);
    place(showOut, true);
    return { node: n, x, y, w, h: HEADER, rows: [], sockets, kind: 'NODE' };
  }
  const rows: Row[] = [];
  let cy = HEADER + PAD_TOP;
  for (const s of showOut) {
    rows.push({
      kind: 'output',
      y: cy,
      h: ROW,
      socket: s,
      linked: linkedOut.has(s.identifier),
    });
    sockets.set(sockKey(true, s.identifier), {
      x: x + w,
      y: y + cy + ROW / 2,
      socket: s,
      isOutput: true,
    });
    cy += ROW;
  }
  const panels = nodePanels(n, { doc, tree });
  const inPanel = new Set(panels.flatMap((p) => [...p.inputs, ...(p.props ?? [])]));
  if (!n.hide_options) {
    for (const p of visibleProps(n, def?.props ?? [])) {
      if (inPanel.has(p.id)) continue;
      const h = PROP_ROW * propRows(n, p);
      rows.push({ kind: 'prop', y: cy, h, prop: p });
      cy += h;
    }
    if (def?.drawBody) {
      const h = def.bodyHeight?.(n) ?? 0;
      if (h > 0) {
        rows.push({ kind: 'body', y: cy, h });
        cy += h;
      }
    }
  }
  const addInput = (s: ResolvedSocket) => {
    const isLinked = linked.has(s.identifier);
    const { h, vector } = inputRowHeight(s, isLinked);
    rows.push({ kind: 'input', y: cy, h, socket: s, linked: isLinked, vector });
    sockets.set(sockKey(false, s.identifier), {
      x,
      y: y + cy + ROW / 2,
      socket: s,
      isOutput: false,
    });
    cy += h;
  };
  for (const s of showIn) if (!inPanel.has(s.identifier)) addInput(s);
  const open = new Set(n.open_panels ?? []);
  for (const p of panels) {
    const toggle = p.toggle ? showIn.find((s) => s.identifier === p.toggle) : undefined;
    const members = showIn.filter((s) => p.inputs.includes(s.identifier) && s !== toggle);
    const pprops = n.hide_options
      ? []
      : visibleProps(
          n,
          (def?.props ?? []).filter((x) => p.props?.includes(x.id)),
        );
    if (!members.length && !pprops.length && !toggle) continue;
    const isOpen = open.has(p.name) || (!p.closed && !n.open_panels);
    const headerY = cy;
    rows.push({ kind: 'panel', y: cy, h: PANEL_ROW, panel: p, open: isOpen, ...(toggle ? { socket: toggle, linked: linked.has(toggle.identifier) } : {}) });
    // the panel toggle's socket sits on the panel header
    if (toggle) sockets.set(sockKey(false, toggle.identifier), { x, y: y + cy + PANEL_ROW / 2, socket: toggle, isOutput: false });
    cy += PANEL_ROW;
    if (isOpen) {
      for (const pr of pprops) {
        rows.push({ kind: 'prop', y: cy, h: PROP_ROW, prop: pr });
        cy += PROP_ROW;
      }
      for (const s of members) addInput(s);
    } else
      for (const s of members)
        sockets.set(sockKey(false, s.identifier), {
          x,
          y: y + headerY + PANEL_ROW / 2,
          socket: s,
          isOutput: false,
          collapsed: true,
        });
  }
  // sockets that are hidden still need a position for their (inactive) links
  for (const s of inputs)
    if (!sockets.has(sockKey(false, s.identifier)))
      sockets.set(sockKey(false, s.identifier), {
        x,
        y: y + HEADER / 2,
        socket: s,
        isOutput: false,
        collapsed: true,
      });
  for (const s of outputs)
    if (!sockets.has(sockKey(true, s.identifier)))
      sockets.set(sockKey(true, s.identifier), {
        x: x + w,
        y: y + HEADER / 2,
        socket: s,
        isOutput: true,
        collapsed: true,
      });
  cy += PAD_BOTTOM;
  return { node: n, x, y, w, h: cy, rows, sockets, kind: 'NODE' };
}

/** Frames enclose their children (computed bounds); an empty frame keeps its own size. */
export function frameLayout(doc: DocumentData, tree: NodeTreeData, frame: NodeData, depth = 0): NodeLayout {
  const children = tree.nodes.filter((c) => c.parent === frame.id);
  const label = (propValue(frame, 'label_size') as number) ?? 20;
  const top = Math.max(FRAME_MARGIN, label + 12);
  const [fx, fy] = nodeOrigin(frame);
  if (!children.length || depth > 16 || propValue(frame, 'shrink') === false) {
    const w = frame.width ?? 150;
    const h = (frame.props.height as number) ?? 100;
    if (!children.length || propValue(frame, 'shrink') === false)
      return {
        node: frame,
        x: fx,
        y: fy,
        w,
        h,
        rows: [],
        sockets: new Map(),
        kind: 'FRAME',
      };
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of children) {
    const l = getNodeType(c.type)?.layout === 'FRAME' ? frameLayout(doc, tree, c, depth + 1) : layoutNode(doc, tree, c);
    x0 = Math.min(x0, l.x);
    y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x + l.w);
    y1 = Math.max(y1, l.y + l.h);
  }
  return {
    node: frame,
    x: x0 - FRAME_MARGIN,
    y: y0 - top,
    w: x1 - x0 + FRAME_MARGIN * 2,
    h: y1 - y0 + top + FRAME_MARGIN,
    rows: [],
    sockets: new Map(),
    kind: 'FRAME',
  };
}

/** Layout all nodes of a tree (frames first so they are drawn behind). */
export function layoutTree(doc: DocumentData, tree: NodeTreeData): Map<string, NodeLayout> {
  const out = new Map<string, NodeLayout>();
  const linkedByNode = new Map<string, Set<string>>();
  for (const l of tree.links) {
    let s = linkedByNode.get(l.to_node);
    if (!s) linkedByNode.set(l.to_node, (s = new Set()));
    s.add(l.to_socket);
  }
  for (const n of tree.nodes) {
    if (getNodeType(n.type)?.layout === 'FRAME') continue;
    out.set(n.id, layoutNode(doc, tree, n, linkedByNode.get(n.id) ?? new Set()));
  }
  const frameOf = (f: NodeData, depth = 0): NodeLayout => {
    const kids = tree.nodes.filter((c) => c.parent === f.id);
    const label = (propValue(f, 'label_size') as number) ?? 20;
    const top = Math.max(FRAME_MARGIN, label + 12);
    const [fx, fy] = nodeOrigin(f);
    if (!kids.length || propValue(f, 'shrink') === false || depth > 16)
      return {
        node: f,
        x: fx,
        y: fy,
        w: f.width ?? 150,
        h: (f.props.height as number) ?? 100,
        rows: [],
        sockets: new Map(),
        kind: 'FRAME',
      };
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of kids) {
      const l = getNodeType(c.type)?.layout === 'FRAME' ? frameOf(c, depth + 1) : out.get(c.id)!;
      if (!l) continue;
      x0 = Math.min(x0, l.x);
      y0 = Math.min(y0, l.y);
      x1 = Math.max(x1, l.x + l.w);
      y1 = Math.max(y1, l.y + l.h);
    }
    return {
      node: f,
      x: x0 - FRAME_MARGIN,
      y: y0 - top,
      w: x1 - x0 + FRAME_MARGIN * 2,
      h: y1 - y0 + top + FRAME_MARGIN,
      rows: [],
      sockets: new Map(),
      kind: 'FRAME',
    };
  };
  for (const n of tree.nodes) if (getNodeType(n.type)?.layout === 'FRAME') out.set(n.id, frameOf(n));
  return out;
}

/** Cubic bezier control points of a link between two sockets (node space). */
export function linkCurve(x1: number, y1: number, x2: number, y2: number): [number, number, number, number, number, number, number, number] {
  const d = Math.max(Math.abs(x2 - x1) * 0.5, 20 + Math.min(80, Math.abs(y2 - y1) * 0.15));
  return [x1, y1, x1 + d, y1, x2 - d, y2, x2, y2];
}

export function bezierPoint(c: number[], t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    cc = 3 * u * t * t,
    d = t * t * t;
  return [a * c[0] + b * c[2] + cc * c[4] + d * c[6], a * c[1] + b * c[3] + cc * c[5] + d * c[7]];
}

/** Whether two segments intersect. */
export function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const cross = (o: number[], p: number[], q: number[]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

/** Whether a polyline crosses a link curve (knife tool). */
export function curveCrossesPolyline(c: number[], line: [number, number][], steps = 24): boolean {
  let prev = bezierPoint(c, 0);
  for (let i = 1; i <= steps; i++) {
    const p = bezierPoint(c, i / steps);
    for (let j = 1; j < line.length; j++) if (segmentsIntersect(prev, p, line[j - 1], line[j])) return true;
    prev = p;
  }
  return false;
}

/** First point where a polyline crosses a link curve, or null. */
export function curvePolylineHit(c: number[], line: [number, number][], steps = 24): [number, number] | null {
  let prev = bezierPoint(c, 0);
  for (let i = 1; i <= steps; i++) {
    const p = bezierPoint(c, i / steps);
    for (let j = 1; j < line.length; j++) {
      const a = line[j - 1],
        b = line[j];
      if (!segmentsIntersect(prev, p, a, b)) continue;
      // intersection of the two segments
      const d = (prev[0] - p[0]) * (a[1] - b[1]) - (prev[1] - p[1]) * (a[0] - b[0]);
      if (Math.abs(d) < 1e-9) return [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2];
      const t = ((prev[0] - a[0]) * (a[1] - b[1]) - (prev[1] - a[1]) * (a[0] - b[0])) / d;
      return [prev[0] + t * (p[0] - prev[0]), prev[1] + t * (p[1] - prev[1])];
    }
    prev = p;
  }
  return null;
}

/** Whether a point is inside a polygon (even-odd rule). */
export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance from a point to a link curve (approximate). */
export function distToCurve(c: number[], px: number, py: number, steps = 24): number {
  let best = Infinity;
  let prev = bezierPoint(c, 0);
  for (let i = 1; i <= steps; i++) {
    const p = bezierPoint(c, i / steps);
    const dx = p[0] - prev[0],
      dy = p[1] - prev[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - prev[0]) * dx + (py - prev[1]) * dy) / l2));
    const qx = prev[0] + t * dx - px,
      qy = prev[1] + t * dy - py;
    best = Math.min(best, qx * qx + qy * qy);
    prev = p;
  }
  return best;
}
