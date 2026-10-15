// Zone body evaluation. A zone body is every node reachable downstream from the zone input
// without passing the zone output. The output node runs the body through a ZoneEval: body nodes
// are evaluated fresh for each iteration (with the zone input's outputs replaced by the current
// state), while nodes outside the body are shared with (and cached by) the enclosing evaluator.
import type { NodeData, NodeTreeData } from '../../data/types';
import { findSocket } from '../../nodes/registry';
import { TreeEval } from '../evaluator';
import type { Val } from '../exec';
import { Field, constOf } from '../field';

const membersCache = new WeakMap<NodeTreeData, { key: string; map: Map<string, Set<string>> }>();

function linksKey(tree: NodeTreeData) {
  let s = '';
  for (const l of tree.links) s += `${l.from_node}>${l.to_node}${l.is_muted ? 'm' : ''};`;
  return s;
}

/** Body nodes of the zone between `inputId` and `outputId` (neither included). */
export function zoneBody(tree: NodeTreeData, inputId: string, outputId: string): Set<string> {
  const key = linksKey(tree);
  let c = membersCache.get(tree);
  if (!c || c.key !== key) membersCache.set(tree, (c = { key, map: new Map() }));
  const mk = `${inputId}|${outputId}`;
  const hit = c.map.get(mk);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  for (const l of tree.links) {
    if (l.is_muted) continue;
    (out.get(l.from_node) ?? out.set(l.from_node, []).get(l.from_node)!).push(l.to_node);
  }
  const body = new Set<string>();
  const stack = [...(out.get(inputId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === outputId || id === inputId || body.has(id)) continue;
    body.add(id);
    for (const t of out.get(id) ?? []) stack.push(t);
  }
  c.map.set(mk, body);
  return body;
}

/** Nodes drawn inside a zone frame: the body plus nodes that only feed the zone output. */
export function zoneDrawMembers(tree: NodeTreeData, inputId: string, outputId: string): Set<string> {
  const body = new Set(zoneBody(tree, inputId, outputId));
  // upstream of the output and not upstream of the input: invariant nodes placed inside the zone
  const inl = new Map<string, string[]>();
  const outl = new Map<string, string[]>();
  for (const l of tree.links) {
    (inl.get(l.to_node) ?? inl.set(l.to_node, []).get(l.to_node)!).push(l.from_node);
    (outl.get(l.from_node) ?? outl.set(l.from_node, []).get(l.from_node)!).push(l.to_node);
  }
  const upInput = new Set<string>();
  const st = [inputId];
  while (st.length) {
    const id = st.pop()!;
    for (const f of inl.get(id) ?? []) if (!upInput.has(f)) (upInput.add(f), st.push(f));
  }
  const cand: string[] = [];
  const seen = new Set<string>();
  const st2 = [...(inl.get(outputId) ?? [])];
  while (st2.length) {
    const id = st2.pop()!;
    if (seen.has(id) || id === inputId || upInput.has(id)) continue;
    seen.add(id);
    cand.push(id);
    for (const f of inl.get(id) ?? []) st2.push(f);
  }
  // a candidate belongs to the zone only when all its consumers are in the zone
  let changed = true;
  const inside = new Set([...body, ...cand]);
  while (changed) {
    changed = false;
    for (const id of cand) {
      if (!inside.has(id) || body.has(id)) continue;
      const users = outl.get(id) ?? [];
      if (users.some((u) => u !== outputId && !inside.has(u))) {
        inside.delete(id);
        changed = true;
      }
    }
  }
  return inside;
}

/** Evaluates a zone body with given zone-input outputs; nodes outside the body go to the parent. */
export class ZoneEval extends TreeEval {
  constructor(
    readonly parent: TreeEval,
    readonly body: Set<string>,
    readonly zoneInput: string,
    readonly inputOutputs: Record<string, Val>,
    path = parent.path,
  ) {
    super(parent.env, parent.tree, path, parent.groupInput, parent.groupInputSig, new Map(), parent.log, parent.depth);
  }

  override nodeOutputs(node: NodeData): Record<string, Val> {
    if (node.id === this.zoneInput) return this.inputOutputs;
    if (!this.body.has(node.id)) return this.parent.nodeOutputs(node);
    return super.nodeOutputs(node);
  }

  /** Value flowing into an input of the zone output node. */
  outputInput(output: NodeData, identifier: string): Val {
    const s = findSocket(output, identifier, false, this.sctx);
    return s ? this.inputValue(output, s) : undefined;
  }
}

/** A single value from a socket value (fields are reduced to their constant, if any). */
export function single(v: Val): Val {
  if (v instanceof Field) {
    const c = constOf(v);
    return c === undefined ? undefined : (c as Val);
  }
  return v;
}

/** Input value of a node through an evaluator (by identifier). */
export function inputOf(ev: TreeEval, node: NodeData, identifier: string): Val {
  const s = findSocket(node, identifier, false, ev.sctx);
  return s ? ev.inputValue(node, s) : undefined;
}
