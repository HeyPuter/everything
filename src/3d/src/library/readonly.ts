// Read-only linked data: the fields of linked data-blocks (and everything nested in them) are made
// non-writable, so edits fail loudly instead of silently changing data that is reloaded from its
// library file. View-layer state (selection, visibility toggles, active indices) stays writable,
// and new fields (runtime caches) can still be added. Widgets ask `isReadOnly(owner)` to draw
// themselves disabled.

const readonly = new WeakSet<object>();

/** Evaluation (animation, drivers, simulation) writes current values into linked data too. */
let writesOpen = 0;
export function withLinkedWrites<T>(fn: () => T): T {
  writesOpen++;
  try {
    return fn();
  } finally {
    writesOpen--;
  }
}

/** Is this object part of a linked (read-only) data-block? */
export function isReadOnly(o: unknown): boolean {
  return !!o && typeof o === 'object' && readonly.has(o as object);
}

/** Keys that stay writable on every linked data-block (UI and view-layer state). */
function allowed(key: string, extra: ReadonlySet<string>): boolean {
  return extra.has(key) || key === 'users' || key.startsWith('_') || key.startsWith('active') || key.endsWith('_index');
}

const NONE: ReadonlySet<string> = new Set();

function lockNested(v: unknown, depth: number) {
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || readonly.has(v) || depth > 40) return;
  readonly.add(v);
  if (Array.isArray(v)) {
    for (const x of v) lockNested(x, depth + 1);
    // lists (of ids, modifiers, …) are frozen; number vectors stay writable for evaluation
    // (animation writes animated values into them) and widgets show them disabled
    if (!v.length || !v.every((x) => typeof x === 'number' || typeof x === 'boolean')) Object.freeze(v);
    return;
  }
  for (const k of Object.keys(v)) {
    // runtime caches ("_…") stay writable
    if (k.startsWith('_')) continue;
    lockNested((v as Record<string, unknown>)[k], depth + 1);
    lockKey(v, k);
  }
}

/** Same value, or arrays with the same items (code that rewrites every collection's lists). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return false;
}

/**
 * Make a property read-only: writing the value it already has is ignored (generic code often
 * reassigns filtered lists on every data-block), writing anything else throws.
 */
function lockKey(o: object, k: string) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (!d || !('value' in d) || !d.writable) return;
  let value = d.value;
  Object.defineProperty(o, k, {
    enumerable: d.enumerable,
    configurable: false,
    get: () => value,
    set: (v: unknown) => {
      if (writesOpen > 0) value = v;
      else if (!same(v, value)) throw new TypeError(`Cannot assign to read only property '${k}' of linked data`);
    },
  });
}

/**
 * Make a linked data-block read-only. `extra` lists more top-level keys that stay writable
 * (e.g. `select` and `hide` on objects).
 */
export function lockRecord(rec: object, extra: ReadonlySet<string> = NONE) {
  if (readonly.has(rec)) return;
  readonly.add(rec);
  for (const k of Object.keys(rec)) {
    if (allowed(k, extra)) continue;
    lockNested((rec as Record<string, unknown>)[k], 1);
    lockKey(rec, k);
  }
}

/** Top-level keys that stay writable per data-block table. */
export const WRITABLE_KEYS: Record<string, ReadonlySet<string>> = {
  objects: new Set(['select', 'hide']),
  collections: new Set(['exclude', 'hide', 'holdout', 'indirect_only']),
};

/** Did an exception come from writing to read-only (linked) data? */
export function isReadOnlyError(e: unknown): boolean {
  return e instanceof TypeError && /read[ -]only|not writable|frozen|object is not extensible|Cannot add property|Cannot delete property/i.test(e.message);
}
