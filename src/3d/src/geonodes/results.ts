// Last evaluation results of geometry node modifiers, per object (for the spreadsheet, the
// viewport overlays, Object Info and the modifier panel).
import type { EvalMesh } from '../eval/types';
import type { GeometrySet } from './geometry';

export interface GnResult {
  modifierId: string;
  /** evaluated mesh handed to the depsgraph (identity identifies the result) */
  evalMesh: EvalMesh;
  /** full geometry set produced by the last NODES modifier of the stack */
  geometry: GeometrySet;
  /** geometry shown by an active viewer node (with its value stored as ".viewer") */
  viewer?: GeometrySet;
  viewerDomain?: string;
  warnings: Map<string, string[]>;
  /** severity per `${node path}\n${message}` (warnings when missing) */
  warningKinds?: Map<string, 'ERROR' | 'WARNING' | 'INFO'>;
  ms: number;
  executed: number;
}

export const gnResults = new Map<string, GnResult>();

/** Viewer path: which object/modifier shows the active viewer of its tree. */
export const viewerState: {
  objectId: string | null;
  modifierId: string | null;
} = { objectId: null, modifierId: null };

/** Listeners notified after a geometry nodes evaluation (UI refresh). */
export const resultListeners = new Set<() => void>();
