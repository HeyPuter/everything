// The Outliner that operators act on: the one under the pointer, else the last one used.
import type { Outliner } from '../outliner';
import { app, type OpContext } from '../../app/app';

let current: Outliner | null = null;

/** Remember an outliner as the current one; `weak` only fills an empty slot, `only` clears just that instance. */
export function setCurrentOutliner(o: Outliner | null, weak = false, only?: Outliner) {
  if (only && current !== only) return;
  if (weak && current && current.el.isConnected) return;
  current = o;
}

export function currentOutliner(ctx?: OpContext): Outliner | null {
  const area = (ctx?.area ?? app?.hoverArea ?? app?.activeArea) as {
    type?: string;
    editor?: unknown;
  } | null;
  if (area?.type === 'OUTLINER' && area.editor) return area.editor as Outliner;
  return current && current.el.isConnected ? current : null;
}
