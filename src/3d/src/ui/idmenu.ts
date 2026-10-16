// Extra right-click menu entries of data-block selectors (e.g. Mark as Asset), given the shown
// data-block id. Filled by feature modules; read by the selectors.
import type { MenuItem } from './menu';

export const idSelectorMenuHooks: ((id: string) => MenuItem[])[] = [];

/** A marker drawn before the name of a data-block in selectors (e.g. linked from a library). */
export interface IdDecoration {
  icon: string;
  tip: string;
  /** shown next to the name in the browse menu */
  note?: string;
  /** the name cannot be edited */
  readonly?: boolean;
}
export const idDecorationHooks: ((id: string) => IdDecoration | null)[] = [];
export const idDecoration = (id: string): IdDecoration | null => {
  for (const f of idDecorationHooks) {
    const d = f(id);
    if (d) return d;
  }
  return null;
};
