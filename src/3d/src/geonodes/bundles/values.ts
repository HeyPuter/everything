// Bundle and closure values flowing through geometry node trees.
//
// A bundle is an immutable set of named, typed values (values can be bundles, so paths like
// "Settings/Size" reach nested items). A closure is a piece of node tree (the body of a Closure
// zone) packaged as a value: evaluating it runs the body with the given inputs and returns its
// outputs. Inputs and outputs are matched by name and converted between compatible types.
import type { NodeData } from '../../data/types';
import type { SocketType } from '../../nodes/types';
import type { OpaqueVal, Val } from '../exec';
import { coerce, convertVal, type TreeEval } from '../evaluator';
import type { ZoneItem } from '../zones/items';
import { ZoneEval, zoneBody } from '../zones/eval';

export interface BundleEntry {
  type: SocketType;
  value: Val;
}

/** Split a bundle path ("a/b/c") into its non-empty parts. */
export const pathParts = (path: string): string[] =>
  path
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length);

export class BundleValue implements OpaqueVal {
  readonly opaqueKind = 'BUNDLE';
  constructor(readonly items: ReadonlyMap<string, BundleEntry> = new Map()) {}

  static of(entries: [string, BundleEntry][]): BundleValue {
    return new BundleValue(new Map(entries));
  }

  get size() {
    return this.items.size;
  }

  /** Item at a path (nested bundles are entered for every part but the last). */
  get(path: string): BundleEntry | undefined {
    const parts = pathParts(path);
    let b: BundleValue | undefined = this;
    for (let i = 0; i < parts.length; i++) {
      const e: BundleEntry | undefined = b.items.get(parts[i]);
      if (!e) return undefined;
      if (i === parts.length - 1) return e;
      b = e.value instanceof BundleValue ? e.value : undefined;
      if (!b) return undefined;
    }
    return undefined;
  }

  /** A copy with an item stored at a path (missing nested bundles are created). */
  with(path: string, entry: BundleEntry): BundleValue {
    const parts = pathParts(path);
    if (!parts.length) return this;
    const [head, ...rest] = parts;
    const m = new Map(this.items);
    if (!rest.length) m.set(head, entry);
    else {
      const cur = m.get(head)?.value;
      const inner = cur instanceof BundleValue ? cur : new BundleValue();
      m.set(head, { type: 'BUNDLE', value: inner.with(rest.join('/'), entry) });
    }
    return new BundleValue(m);
  }

  /** A copy without the item at a path. */
  without(path: string): BundleValue {
    const parts = pathParts(path);
    if (!parts.length) return this;
    const [head, ...rest] = parts;
    if (!this.items.has(head)) return this;
    const m = new Map(this.items);
    if (!rest.length) m.delete(head);
    else {
      const cur = m.get(head)!.value;
      if (!(cur instanceof BundleValue)) return this;
      m.set(head, { type: 'BUNDLE', value: cur.without(rest.join('/')) });
    }
    return new BundleValue(m);
  }

  /** Items of several bundles; an item name already present keeps its first value. */
  static join(list: BundleValue[]): BundleValue {
    const m = new Map<string, BundleEntry>();
    for (const b of list) for (const [k, e] of b.items) if (!m.has(k)) m.set(k, e);
    return new BundleValue(m);
  }

  toString() {
    return `Bundle (${this.items.size} item${this.items.size === 1 ? '' : 's'})`;
  }
}

/** Value of an entry converted to a socket type (default value when not convertible). */
export function entryAs(e: BundleEntry | undefined, type: SocketType): Val {
  if (!e) return coerce(undefined, type);
  if (e.type === type) return e.value;
  const v = convertVal(e.value, e.type, type);
  return v === undefined ? coerce(undefined, type) : v;
}

export interface ClosureArg {
  name: string;
  type: SocketType;
  value: Val;
}

/** Closures evaluating closures: a guard against unbounded recursion. */
let closureDepth = 0;
export const MAX_CLOSURE_DEPTH = 64;

export class ClosureValue implements OpaqueVal {
  readonly opaqueKind = 'CLOSURE';
  constructor(
    /** evaluator of the tree holding the zone (nodes outside the body are evaluated there) */
    readonly ev: TreeEval,
    readonly input: NodeData,
    readonly output: NodeData,
    readonly inputs: ZoneItem[],
    readonly outputs: ZoneItem[],
  ) {}

  /** Run the closure body with the given arguments and read the requested outputs. */
  evaluate(args: ClosureArg[], want: { name: string; type: SocketType }[]): Val[] | null {
    if (closureDepth >= MAX_CLOSURE_DEPTH) return null;
    const vals: Record<string, Val> = {};
    for (const it of this.inputs) {
      const a = args.find((x) => x.name === it.name);
      vals[`Item_${it.id}`] = entryAs(a ? { type: a.type, value: a.value } : undefined, it.socket_type);
    }
    const body = zoneBody(this.ev.tree, this.input.id, this.output.id);
    const z = new ZoneEval(this.ev, body, this.input.id, vals);
    closureDepth++;
    try {
      return want.map((w) => {
        const it = this.outputs.find((o) => o.name === w.name);
        if (!it) return coerce(undefined, w.type);
        return entryAs({ type: it.socket_type, value: z.outputInput(this.output, `Item_${it.id}`) }, w.type);
      });
    } finally {
      closureDepth--;
    }
  }

  toString() {
    return `Closure (${this.inputs.length} in, ${this.outputs.length} out)`;
  }
}
