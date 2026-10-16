// Hooks shared by the Adjust Last Operation panel and operator dialogs (kept apart to avoid
// import cycles between them and the modules that add rows).
import type { Child } from './h';

/** Rows drawn at the top of operator dialogs and redo panels (the operator preset menu). */
export const opDialogHeaderHooks: ((idname: string, props: Record<string, unknown>, apply: (p: Record<string, unknown>) => void) => Child)[] = [];

export function opHeader(idname: string, props: Record<string, unknown>, apply: (p: Record<string, unknown>) => void): Child {
  return opDialogHeaderHooks.map((f) => f(idname, props, apply));
}
