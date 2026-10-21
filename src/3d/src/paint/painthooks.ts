// Hooks between the paint mode modules (kept separate to avoid import cycles with ui.ts).
import type { View3D } from '../editors/view3d/view3d';

export const paintHooks = {
  /** LMB in a paint mode before the brush stroke starts (live pointer only); true = handled */
  brushPointer: [] as ((v: View3D, e: PointerEvent) => boolean)[],
  /** keymaps checked before the paint mode's own keymap while they apply */
  priorityKeymaps: [] as { name: string; active: () => boolean }[],
  /** start a stroke of the active brush at a (synthetic) press; set by ui.ts */
  startStroke: null as null | ((v: View3D, e: PointerEvent) => boolean),
};
