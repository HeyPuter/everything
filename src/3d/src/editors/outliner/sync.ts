// Selection of outliner rows that stand for elements kept elsewhere (strips, …): display modes
// register how such rows read and write their selection and become active.
import type { Row, RowKind } from './tree';
import { currentOutliner } from './current';

export interface RowSync {
  get(r: Row): boolean;
  set(r: Row, v: boolean): void;
  activate?(r: Row): void;
}
export const rowSync: Partial<Record<RowKind, RowSync>> = {};

/** Rows of the current outliner (empty without one). */
export function currentOutlinerRows(): Row[] {
  return currentOutliner()?.rows ?? [];
}
