import { DomainError, invariant } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';

const template = ({ opId: _opId, ...op }) => structuredClone(op);

function valueAt(entity, path) {
  let value = entity;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

/** The inverse of generic ops against the entities before they apply, or null when one cannot be undone. */
export function inverseOps(ops, get) {
  const inverse = [];
  for (const op of ops) {
    if (op.do || op.del) return null;
    if (op.put) { inverse.unshift({ t: op.t, id: op.id, del: true }); continue; }
    const entity = get(op.t, op.id);
    if (!entity) return null;
    const set = {};
    const unset = [];
    for (const path of [...Object.keys(op.set ?? {}), ...(op.unset ?? [])]) {
      const previous = valueAt(entity, path);
      if (previous === undefined) unset.push(path); else set[path] = structuredClone(previous);
    }
    inverse.unshift({ t: op.t, id: op.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
  }
  return inverse;
}

/**
 * Per-session undo/redo over `apply`. Deletes and domain ops are not undoable. A redone create gets a new id, because
 * the old one is tombstoned; later entries follow the mapping.
 */
export function createHistory({ apply, get, makeId = newId, limit = 100 }) {
  const undoStack = [];
  const redoStack = [];
  const remap = new Map();
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }); };
  const resolve = (id) => { let current = id; for (let hops = 0; remap.has(current) && hops < 1000; hops++) current = remap.get(current); return current; };
  const translate = (value) => {
    if (typeof value === 'string') return remap.has(value) ? resolve(value) : value;
    if (Array.isArray(value)) return value.map(translate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item)]));
    return value;
  };
  async function run(ops, { fresh = false } = {}) {
    if (fresh) for (const op of ops) if (op.put) remap.set(resolve(op.id), makeId());
    const ready = ops.map((op) => ({ ...translate(op), opId: makeId() }));
    await apply(ready);
  }
  return {
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get label() { return undoStack.at(-1)?.label ?? null; },
    /**
     * Call before applying `ops`; returns false (and records nothing) when they cannot be undone. `inverse` supplies the
     * undo ops for a domain op whose owner knows how to reverse it.
     */
    record(label, ops, { inverse: explicit } = {}) {
      const inverse = explicit?.length ? explicit.map(template) : inverseOps(ops, (type, id) => get(type, id));
      if (!inverse) { redoStack.length = 0; notify(); return false; }
      undoStack.push({ label, forward: ops.map(template), inverse });
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      notify();
      return true;
    },
    async undo() {
      const entry = undoStack.pop();
      invariant(entry, 'nothing_to_undo', 409);
      try { await run(entry.inverse); } catch (error) { notify(); throw error instanceof DomainError ? error : new DomainError('undo_failed', 409); }
      redoStack.push(entry);
      notify();
      return entry.label;
    },
    async redo() {
      const entry = redoStack.pop();
      invariant(entry, 'nothing_to_redo', 409);
      try { await run(entry.forward, { fresh: true }); } catch (error) { notify(); throw error instanceof DomainError ? error : new DomainError('redo_failed', 409); }
      undoStack.push(entry);
      notify();
      return entry.label;
    },
    /** Drops the newest entry, for an apply that failed after `record`. */
    forget() { undoStack.pop(); notify(); },
    clear() { undoStack.length = 0; redoStack.length = 0; remap.clear(); notify(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
