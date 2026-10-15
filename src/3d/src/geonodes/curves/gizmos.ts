// Gizmo nodes (Linear, Dial, Transform): evaluated with the modifier to record where their
// viewport handles go, and the editable values (Value nodes, modifier inputs, through simple
// math) that dragging a handle changes.
import { gn, prop } from './defs';
import { alwaysEvaluated, type ExecContext } from '../exec';
import { GeometrySet } from '../geometry';
import type { DocumentData, LinkData, ModifierBase, NodeData, NodeTreeData } from '../../data/types';
import { place } from './menu';

export type GizmoKind = 'LINEAR' | 'DIAL' | 'TRANSFORM';

export interface GizmoState {
  kind: GizmoKind;
  objectId: string;
  modifierId: string;
  nodeId: string;
  /** object space */
  position: [number, number, number];
  /** Linear: direction; Dial: up axis */
  axis: [number, number, number];
  /** Transform: orientation (XYZ Euler) */
  rotation: [number, number, number];
  radius: number;
  screenSpace: boolean;
  color: string;
  drawStyle: string;
  /** Transform: enabled parts per axis */
  use: { translate: boolean[]; rotate: boolean[]; scale: boolean[] };
}

/** Last recorded gizmo states by `objectId/modifierId/nodeId`. */
export const gizmoStates = new Map<string, GizmoState>();

function record(ctx: ExecContext, kind: GizmoKind, s: Partial<GizmoState>) {
  const parts = ctx.path.split('/');
  // only gizmos of a modifier's own tree (not inside nested groups)
  if (parts.length !== 3 || !ctx.env.ob) return;
  const [objectId, modifierId, nodeId] = parts;
  const n = ctx.node;
  gizmoStates.set(ctx.path, {
    kind,
    objectId,
    modifierId,
    nodeId,
    position: ctx.vector('Position'),
    axis: [0, 0, 1],
    rotation: [0, 0, 0],
    radius: 1,
    screenSpace: true,
    color: String(prop(n, 'color_id') ?? 'PRIMARY'),
    drawStyle: String(prop(n, 'draw_style') ?? 'ARROW'),
    use: { translate: [true, true, true], rotate: [true, true, true], scale: [true, true, true] },
    ...s,
  });
}

const empty = () => ({ Transform: GeometrySet.empty() });

gn(
  'GeometryNodeGizmoLinear',
  'input',
  {
    exec: (ctx) => {
      record(ctx, 'LINEAR', { axis: ctx.vector('Direction') });
      return empty();
    },
  },
  { multi: ['Value'] },
);

gn(
  'GeometryNodeGizmoDial',
  'input',
  {
    exec: (ctx) => {
      record(ctx, 'DIAL', { axis: ctx.vector('Up'), radius: ctx.float('Radius'), screenSpace: ctx.bool('Screen Space') });
      return empty();
    },
  },
  { multi: ['Value'] },
);

gn(
  'GeometryNodeGizmoTransform',
  'input',
  {
    exec: (ctx) => {
      const n = ctx.node;
      const flags = (p: string) => ['x', 'y', 'z'].map((a) => prop(n, `use_${p}_${a}`) !== false);
      record(ctx, 'TRANSFORM', { rotation: ctx.vector('Rotation'), use: { translate: flags('translation'), rotate: flags('rotation'), scale: flags('scale') } });
      return empty();
    },
  },
  { multi: ['Value'] },
);

for (const t of ['GeometryNodeGizmoLinear', 'GeometryNodeGizmoDial', 'GeometryNodeGizmoTransform']) alwaysEvaluated.add(t);

// ---------------------------------------------------------------------------
// Editable values behind a gizmo

/** A number (or matrix) a gizmo drag can change: read/write plus the factor from gizmo value to it. */
export interface ValueTarget {
  label: string;
  get(): number;
  set(v: number): void;
  /** change of this value per unit change of the gizmo value */
  factor: number;
  /** integer values are rounded */
  integer?: boolean;
}

export interface MatrixTarget {
  label: string;
  get(): number[];
  set(m: number[]): void;
}

const linksTo = (tree: NodeTreeData, nodeId: string, socket: string): LinkData[] => tree.links.filter((l) => l.to_node === nodeId && l.to_socket === socket && !l.is_muted);

const MATH_INVERTIBLE = new Set(['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE']);

/** Follow a link backwards to values that can be edited (depth-first, linear math only). */
function resolveLink(doc: DocumentData, tree: NodeTreeData, mod: ModifierBase | null, l: LinkData, factor: number, depth: number, out: ValueTarget[]) {
  if (depth > 32) return;
  const from = tree.nodes.find((n) => n.id === l.from_node);
  if (!from || from.mute) return;
  switch (from.type) {
    case 'NodeReroute':
      for (const x of linksTo(tree, from.id, 'Input')) resolveLink(doc, tree, mod, x, factor, depth + 1, out);
      return;
    case 'NodeGroupInput': {
      if (!mod) return;
      const id = l.from_socket;
      const it = tree.interface?.find((i) => i.in_out === 'INPUT' && i.identifier === id);
      if (!it || mod[`${id}_use_attribute`]) return;
      const m = mod as unknown as Record<string, unknown>;
      const isInt = it.socket_type.startsWith('NodeSocketInt');
      out.push({
        label: it.name,
        get: () => Number(m[id] ?? it.default_value ?? 0),
        set: (v) => (m[id] = isInt ? Math.round(v) : v),
        factor,
        integer: isInt,
      });
      return;
    }
    case 'ShaderNodeValue':
      out.push({ label: from.label || 'Value', get: () => Number(from.props['outputs.Value'] ?? 0.5), set: (v) => (from.props['outputs.Value'] = v), factor });
      return;
    case 'FunctionNodeInputInt':
      out.push({ label: from.label || 'Integer', get: () => Number(from.props.integer ?? 0), set: (v) => (from.props.integer = Math.round(v)), factor, integer: true });
      return;
    case 'ShaderNodeMath': {
      const op = String(from.props.operation ?? 'ADD');
      if (!MATH_INVERTIBLE.has(op)) return;
      const a = linksTo(tree, from.id, 'Value'),
        b = linksTo(tree, from.id, 'Value_001');
      if (a.length && b.length) return;
      const linkedB = !a.length && b.length > 0;
      const other = Number((linkedB ? from.inputs.Value : from.inputs.Value_001) ?? (op === 'MULTIPLY' || op === 'DIVIDE' ? 1 : 0));
      let f = factor;
      if (op === 'SUBTRACT' && linkedB) f = -factor;
      else if (op === 'MULTIPLY') {
        if (!other) return;
        f = factor / other;
      } else if (op === 'DIVIDE') {
        if (linkedB) return; // c / x is not linear
        f = factor * other;
      }
      for (const x of linkedB ? b : a) resolveLink(doc, tree, mod, x, f, depth + 1, out);
      return;
    }
    default:
      return;
  }
}

/** Editable numbers behind a gizmo node's Value input. */
export function valueTargets(doc: DocumentData, tree: NodeTreeData, mod: ModifierBase | null, node: NodeData): ValueTarget[] {
  const out: ValueTarget[] = [];
  for (const l of linksTo(tree, node.id, 'Value')) resolveLink(doc, tree, mod, l, 1, 0, out);
  return out;
}

/** Editable matrices behind a Transform gizmo (modifier matrix inputs). */
export function matrixTargets(tree: NodeTreeData, mod: ModifierBase | null, node: NodeData): MatrixTarget[] {
  const out: MatrixTarget[] = [];
  const visit = (l: LinkData, depth: number) => {
    const from = tree.nodes.find((n) => n.id === l.from_node);
    if (!from || from.mute || depth > 32) return;
    if (from.type === 'NodeReroute') for (const x of linksTo(tree, from.id, 'Input')) visit(x, depth + 1);
    else if (from.type === 'NodeGroupInput' && mod) {
      const id = l.from_socket;
      const it = tree.interface?.find((i) => i.in_out === 'INPUT' && i.identifier === id);
      if (!it) return;
      const m = mod as unknown as Record<string, unknown>;
      const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      out.push({
        label: it.name,
        get: () => {
          const v = m[id] ?? it.default_value;
          return Array.isArray(v) && v.length === 16 ? (v as number[]).slice() : ident.slice();
        },
        set: (mat) => (m[id] = mat.slice()),
      });
    }
  };
  for (const l of linksTo(tree, node.id, 'Value')) visit(l, 0);
  return out;
}

place('Input/Gizmo', 'GeometryNodeGizmoDial');
place('Input/Gizmo', 'GeometryNodeGizmoLinear');
place('Input/Gizmo', 'GeometryNodeGizmoTransform');
