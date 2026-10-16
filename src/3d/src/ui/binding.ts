// Registry of the data behind property buttons. Data-bound widgets (ui/props.ts) register what
// they edit under their widget id; generic button interactions (copy/paste, reset, keyframes,
// drivers, data paths, eyedropper, copy to selected, multi-drag) look the binding up from the
// element under the pointer. This module has no UI dependencies so widgets can use it freely.
import type { ObjectData } from '../data/types';

export type BindingKind = 'number' | 'bool' | 'enum' | 'color' | 'text' | 'vector' | 'object';

export interface PropBinding {
  /** widget id (also the element's data-id) */
  id: string;
  owner: Record<string, unknown>;
  key: string;
  /** array element this button edits; undefined for a whole value */
  index?: number;
  label: string;
  kind: BindingKind;
  /** object + data path for animation when the caller knows it */
  anim?: { ob: ObjectData; path: string; index?: number };
  /** enum values in display order */
  items?: string[];
  min?: number;
  max?: number;
  int?: boolean;
  /** explicit default (overrides the factory lookup) */
  def?: unknown;
  /** called after the value changed (caches, redraws) */
  onChange?: () => void;
  undo?: string;
  disabled?: boolean;
}

const MAX = 4000;
const bindings = new Map<string, PropBinding>();

/** Register (or refresh) the binding of a widget. */
export function bindProp(b: PropBinding) {
  // move to the end so the oldest entries are the ones dropped
  bindings.delete(b.id);
  bindings.set(b.id, b);
  if (bindings.size > MAX) {
    let n = bindings.size - MAX * 0.75;
    for (const k of bindings.keys()) {
      if (n-- <= 0) break;
      bindings.delete(k);
    }
  }
}

export function getBinding(id: string | undefined | null): PropBinding | undefined {
  return id ? bindings.get(id) : undefined;
}

/** Binding of the widget at a DOM element (or one of its children). */
export function bindingAt(el: Element | null): PropBinding | undefined {
  const w = el?.closest?.('[data-id]') as HTMLElement | null;
  return getBinding(w?.dataset.id);
}

/** Current value addressed by a binding (one element for array buttons). */
export function bindingValue(b: PropBinding): unknown {
  const v = b.owner[b.key];
  if (b.index !== undefined && v && typeof v === 'object') return (v as ArrayLike<unknown>)[b.index];
  return v;
}

/** Hooks implemented by ui/buttons.ts (kept here to avoid import cycles with the widgets). */
export const buttonHooks = {
  /** a widget edit made with Alt held: copy the new value to the selected items */
  altEdit: (_id: string) => {},
  /** text typed into a number field that starts with "#": make a driver with that expression (true when handled) */
  hashExpression: (_id: string, _expression: string): boolean => false,
  /** a colour swatch is being dragged (drop it on another colour button) */
  colorDrag: (_rgba: number[], _e: PointerEvent) => {},
};

/** The most recently drawn widget bound to `owner[key]` (enum items, limits), if any. */
export function findBinding(owner: object, key: string): PropBinding | undefined {
  let found: PropBinding | undefined;
  for (const b of bindings.values()) if (b.owner === owner && b.key === key) found = b;
  return found;
}
