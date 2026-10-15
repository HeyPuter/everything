// Extension points so modes (edit mesh, sculpt, paint, pose) plug into the viewport.
import type { Child, VNode } from '../../ui/h';
import type { View3D } from './view3d';

export interface PickOptions {
  extend?: boolean;
  deselectAll?: boolean;
  toggle?: boolean;
  deselect?: boolean;
  cycle?: boolean;
}

/** Screen-space selection region (viewport pixels). */
export type SelectRegion = { kind: 'box'; x0: number; y0: number; x1: number; y1: number } | { kind: 'circle'; x: number; y: number; r: number } | { kind: 'lasso'; pts: { x: number; y: number }[] };

export const editModeHooks = {
  pointer: [] as ((v: View3D, e: PointerEvent) => boolean)[],
  context: [] as ((v: View3D, e: PointerEvent) => boolean)[],
  wheel: [] as ((v: View3D, e: WheelEvent) => boolean)[],
  hover: [] as ((v: View3D, e: PointerEvent) => void)[],
  svg: [] as ((v: View3D) => VNode | null)[],
  pick: [] as ((v: View3D, x: number, y: number, o: PickOptions) => boolean)[],
  box: [] as ((v: View3D, x0: number, y0: number, x1: number, y1: number, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') => boolean)[],
  /** circle / lasso selection (edit modes that support shaped regions) */
  region: [] as ((v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') => boolean)[],
  attach: undefined as ((v: View3D) => void) | undefined,
  detach: undefined as ((v: View3D) => void) | undefined,
};

/**
 * Called for every 3D viewport when it is created (e.g. to attach a path tracer via
 * `v.pathTracer = …`, or extra overlays via `v.extraOverlays.push(…)`). Return an optional
 * cleanup function, called when the viewport is disposed.
 */
export const viewportExtensions: ((v: View3D) => (() => void) | void)[] = [];

/** Extra sections of the Viewport Overlays popover (e.g. per-mode display options). */
export const overlayPopoverSections: ((v: View3D) => Child)[] = [];
